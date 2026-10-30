/**
 * Entering prices by hand: the old admin's per-market grid.
 *
 * One date, a box for every market the brand assesses. The old form had two
 * faults this one does not repeat. On seven of the nine sites it began by
 * soft-deleting every price on the date and recreating only the rows posted,
 * so a partial fill wiped the markets the editor left alone — the source of
 * the recurring mismatch files. And on all nine it rewrote published history
 * with no check at all.
 *
 * Here an empty box, or a box still holding the figure already published,
 * means "leave it", and the figures that do change go through a price batch
 * like every other writer: staged, diffed and committed at once. So the
 * module's rule holds — a published price on a past date is `locked` and is
 * not overwritten, while filling an empty past date is fine — and every entry
 * is a batch that shows on the Price updates screen and can be rolled back.
 */

import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, locations, priceBatches, priceBatchItems, prices, sites, type ItemStatus } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";

import { BatchError, commitBatch, diff, discardBatch, rollbackBatch } from "./batches";
import { parseDate, today } from "./dates";

type Opened = { site: string; date: unknown };

export type EntryRow = {
  id: number;
  title: string;
  currency: string | null;
  unit: string | null;
  visible: boolean;
  /** What is published on the chosen date, if anything. */
  onDate: string | null;
  /** The newest published figure before the chosen date, as a guide. */
  before: { price: string; date: string } | null;
};

export type EntrySheet = {
  brand: { id: number; slug: string; name: string };
  date: string;
  /** True for a past date: published figures on it cannot be changed here. */
  past: boolean;
  rows: EntryRow[];
};

export type EntryResult = {
  batchId: number | null;
  created: number;
  changed: number;
  /** Past-date figures that differed from what is published, and were left alone. */
  locked: { title: string; published: string; entered: string }[];
  /** Figures that moved between opening the grid and saving it, and were left alone. */
  conflicts: number;
};

/** "1,250.50" → 1250.5. Up to four decimals, as the column holds. */
function figure(value: string, title: string): number {
  const text = value.trim().replace(/,/g, "");

  if (!/^\d{1,10}(\.\d{1,4})?$/.test(text)) {
    throw new AccountError(`The price for ${title} is not a figure, like 1250 or 1,250.50.`, 422, "prices");
  }

  return Number(text);
}

function dateOf(value: unknown, now: Date): string {
  const date = parseDate(value);

  if (!date) {
    throw new AccountError("Choose the price date.", 422, "date");
  }

  // The old grid took any date. A price dated tomorrow is published today as
  // tomorrow's, which is never what anyone meant.
  if (date > today(now)) {
    throw new AccountError("That date has not happened yet.", 422, "date");
  }

  return date;
}

async function opened(guard: Guarded, input: Opened, permissions: string[], database: Database, now: Date) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, input.site)).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  for (const permission of permissions) {
    await requirePermission(guard, brand.id, permission, database);
  }

  return { brand, date: dateOf(input.date, now) };
}

/** The grid for one date: every live market, what it shows on that date, and its figure before. */
export async function entrySheet(
  guard: Guarded,
  input: Opened,
  database: Database = db(),
  now: Date = new Date(),
): Promise<EntrySheet> {
  const { brand, date } = await opened(guard, input, ["price-batch-view"], database, now);

  const markets = await database
    .select()
    .from(locations)
    .where(and(eq(locations.siteId, brand.id), isNull(locations.deletedAt)))
    .orderBy(locations.sortOrder, locations.title);

  const ids = markets.map((market) => market.id);
  const onDate = new Map<number, string>();
  const before = new Map<number, { price: string; date: string }>();

  if (ids.length) {
    // Newest row wins where two share a cell — the differ's rule.
    const same = await database
      .selectDistinctOn([prices.locationId], { locationId: prices.locationId, price: prices.price })
      .from(prices)
      .where(and(inArray(prices.locationId, ids), eq(prices.priceDate, date), isNull(prices.deletedAt)))
      .orderBy(prices.locationId, desc(prices.id));

    for (const row of same) {
      onDate.set(row.locationId, row.price);
    }

    const earlier = await database
      .selectDistinctOn([prices.locationId], { locationId: prices.locationId, price: prices.price, date: prices.priceDate })
      .from(prices)
      .where(and(inArray(prices.locationId, ids), lt(prices.priceDate, date), isNull(prices.deletedAt)))
      .orderBy(prices.locationId, desc(prices.priceDate), desc(prices.id));

    for (const row of earlier) {
      before.set(row.locationId, { price: row.price, date: row.date });
    }
  }

  return {
    brand: { id: brand.id, slug: brand.slug, name: brand.name },
    date,
    past: date < today(now),
    rows: markets.map((market) => ({
      id: market.id,
      title: market.title,
      currency: market.currency ?? brand.defaultCurrency ?? null,
      unit: market.unit,
      visible: market.visible,
      onDate: onDate.get(market.id) ?? null,
      before: before.get(market.id) ?? null,
    })),
  };
}

/**
 * Save the grid. `figures` maps each market's id to its box's text. Every box
 * is read before anything is written, so one bad figure saves nothing.
 */
export async function enterPrices(
  guard: Guarded,
  input: Opened & { figures: Record<string, string> },
  context: { ip?: string | null } = {},
  database: Database = db(),
  now: Date = new Date(),
): Promise<EntryResult> {
  const { brand, date } = await opened(guard, input, ["price-batch-create", "price-batch-commit"], database, now);

  const ids = Object.keys(input.figures).map(Number);
  const markets = ids.length
    ? await database
        .select()
        .from(locations)
        .where(and(inArray(locations.id, ids), eq(locations.siteId, brand.id), isNull(locations.deletedAt)))
    : [];

  if (markets.length !== ids.length) {
    throw new AccountError("One of those markets is not this brand's.", 422, "prices");
  }

  const entered: { market: (typeof markets)[number]; price: number }[] = [];

  for (const market of markets) {
    const text = String(input.figures[market.id] ?? "");

    if (text.trim() !== "") {
      entered.push({ market, price: figure(text, market.title) });
    }
  }

  const result: EntryResult = { batchId: null, created: 0, changed: 0, locked: [], conflicts: 0 };

  // Diffed before a batch exists: a grid saved with nothing changed leaves no empty batch behind.
  const staged: { market: (typeof markets)[number]; price: number; status: ItemStatus; priceId: number | null; oldPrice: string | null }[] = [];

  for (const { market, price } of entered) {
    const found = await diff(market.id, date, price, database, now);

    if (found.status === "unchanged") {
      continue;
    }

    if (found.status === "locked") {
      result.locked.push({ title: market.title, published: found.oldPrice!, entered: String(price) });
      continue;
    }

    staged.push({ market, price, ...found });
  }

  if (staged.length === 0) {
    return result;
  }

  const userId = guard.identity.user.id;
  const [batch] = await database
    .insert(priceBatches)
    .values({ siteId: brand.id, source: "manual", status: "draft", createdBy: userId })
    .returning();

  await database.insert(priceBatchItems).values(
    staged.map((row) => ({
      batchId: batch!.id,
      rawLocation: row.market.title,
      locationId: row.market.id,
      currency: row.market.currency ?? brand.defaultCurrency ?? null,
      priceDate: date,
      priceId: row.priceId,
      oldPrice: row.oldPrice,
      newPrice: String(row.price),
      status: row.status,
    })),
  );

  try {
    const committed = await commitBatch(brand.id, batch!.id, { userId, ip: context.ip ?? null }, database, now);

    result.batchId = batch!.id;
    result.created = committed.created;
    result.changed = committed.applied;
    result.conflicts = committed.conflicts;
  } catch (error) {
    // Nothing reaches the live table without a commit; the draft goes too, so
    // a failed save does not sit in the update list waiting for someone.
    await discardBatch(brand.id, batch!.id, database).catch(() => undefined);

    if (error instanceof BatchError) {
      throw new AccountError(error.message, 409, "prices");
    }

    throw error;
  }

  return result;
}

/**
 * Undo a committed price update from the admin, under the same rule the
 * module uses: what it created is removed, what it changed goes back, and a
 * figure that moved again since is left alone. Without it a typo entered on
 * an empty past date would be history at once, with no way back from here.
 */
export async function rollBackUpdate(
  guard: Guarded,
  input: { site: string; batchId: number },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ reverted: number; removed: number; skipped: number }> {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, input.site)).limit(1);

  if (!brand || (!guard.isSuperadmin && !guard.siteIds.includes(brand.id))) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "price-batch-rollback", database);

  try {
    return await rollbackBatch(brand.id, input.batchId, { userId: guard.identity.user.id, ip: context.ip ?? null }, database);
  } catch (error) {
    if (error instanceof BatchError) {
      throw new AccountError(error.message, error.status === 404 ? 404 : 409, "batch");
    }

    throw error;
  }
}

/**
 * Publishing a draft update from the admin — the AI's, a crawl's or an
 * upload's. Until the AI tools moved into the admin this button lived only
 * on the price console. `commitBatch` holds the rules: rows still needing
 * attention block it, and a live price that moved since staging becomes a
 * conflict rather than being overwritten.
 */
export async function commitUpdate(
  guard: Guarded,
  input: { site: string; batchId: number },
  context: { ip?: string | null } = {},
  database: Database = db(),
) {
  const brand = await brandForBatch(guard, input.site, "price-batch-commit", database);

  try {
    return await commitBatch(brand.id, input.batchId, { userId: guard.identity.user.id, ip: context.ip ?? null }, database);
  } catch (error) {
    if (error instanceof BatchError) {
      throw new AccountError(error.message, error.status === 404 ? 404 : 409, "batch");
    }

    throw error;
  }
}

/** Throwing a draft update away. Nothing it held was ever published. */
export async function discardUpdate(
  guard: Guarded,
  input: { site: string; batchId: number },
  context: { ip?: string | null } = {},
  database: Database = db(),
) {
  const brand = await brandForBatch(guard, input.site, "price-batch-create", database);

  try {
    const batch = await discardBatch(brand.id, input.batchId, database);

    await database.insert(auditLog).values({
      siteId: brand.id,
      userId: guard.identity.user.id,
      action: "price_batch.discard",
      entity: "price_batch",
      entityId: input.batchId,
      ip: context.ip ?? null,
    });

    return batch;
  } catch (error) {
    if (error instanceof BatchError) {
      throw new AccountError(error.message, error.status === 404 ? 404 : 409, "batch");
    }

    throw error;
  }
}

async function brandForBatch(guard: Guarded, slug: string, permission: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand || (!guard.isSuperadmin && !guard.siteIds.includes(brand.id))) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, permission, database);

  return brand;
}
