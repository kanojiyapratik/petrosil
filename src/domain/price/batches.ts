/**
 * Staging, reviewing and committing a batch of prices.
 *
 * This is the part of the platform the price module talks to most, and the
 * part where being "nearly right" is most expensive: a wrong status here
 * either publishes a figure nobody reviewed or silently overwrites published
 * history. The rules below are ported one for one from the Laravel services
 * (ApiRowsBatchBuilder, PriceDiffer, PriceBatchCommitter, PriceBatchRoller),
 * and the tests pin them.
 *
 * The two that matter most:
 *   - published history is immutable. An existing price on a past date is
 *     `locked`, never `changed`. Backfilling an EMPTY past date is still fine.
 *   - the lock is re-derived at commit time, not trusted from staging. A row
 *     staged as `changed` while its date was today is history once midnight
 *     passes, and must not be written.
 */

import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  ITEM_STATUSES,
  auditLog,
  locations,
  priceBatchItems,
  priceBatches,
  prices,
  type BatchSource,
  type ItemStatus,
} from "@/db/schema";

import { parseDate, today } from "./dates";
import { LocationResolver, livePrice, livePriceForUpdate, priceEquals } from "./locations";

export type StageRow = { location?: unknown; price?: unknown; date?: unknown };

export type Batch = typeof priceBatches.$inferSelect;
export type BatchItem = typeof priceBatchItems.$inferSelect;

/** Statuses that stop a batch being committed while they are still included. */
const BLOCKING: ItemStatus[] = ["ambiguous", "unmatched", "invalid"];

/** Statuses the commit actually writes. */
const WRITABLE: ItemStatus[] = ["changed", "new"];

/**
 * Statuses whose price, date or location an editor may still change. Same
 * four as the Laravel sites allow, in both their API and their own screens:
 * `locked` and `unchanged` have nothing to edit, and an `invalid` row — a
 * date or price that could not be read at all — is excluded rather than
 * patched, so nobody half-fixes a row the file got wrong.
 */
const VALUE_EDITABLE: ItemStatus[] = ["changed", "new", "ambiguous", "unmatched"];

export class BatchError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/* --------------------------------------------------------------- staging */

export type DiffResult = {
  status: ItemStatus;
  priceId: number | null;
  oldPrice: string | null;
};

/**
 * Compare a proposed price against what is published for that location and date.
 * `now` is injectable so the date-lock rule can be tested without waiting for
 * midnight.
 */
export async function diff(
  locationId: number,
  priceDate: string,
  newPrice: number,
  database: Database = db(),
  now: Date = new Date(),
): Promise<DiffResult> {
  const existing = await livePrice(locationId, priceDate, database);

  if (existing === null) {
    return { status: "new", priceId: null, oldPrice: null };
  }

  let status: ItemStatus;

  if (priceEquals(existing.price, newPrice)) {
    status = "unchanged";
  } else if (priceDate < today(now)) {
    status = "locked";
  } else {
    status = "changed";
  }

  return { status, priceId: existing.id, oldPrice: existing.price };
}

export type StageOptions = {
  siteId: number;
  rows: StageRow[];
  priceDate?: unknown;
  source?: BatchSource;
  userId?: number | null;
  now?: Date;
};

/**
 * Stages rows as a draft batch. A row that cannot be read does not fail the
 * request — it is staged as `invalid` or `unmatched` and shown to the editor,
 * which is how the console surfaces a bad spreadsheet instead of swallowing it.
 */
export async function stageRows(
  options: StageOptions,
  database: Database = db(),
): Promise<{ batch: Batch; items: BatchItem[] }> {
  const { siteId, rows, source = "api", userId = null, now = new Date() } = options;

  const defaultDate =
    options.priceDate === undefined || options.priceDate === null || options.priceDate === ""
      ? null
      : parseDate(options.priceDate);

  const resolver = await LocationResolver.forSite(siteId, database);

  const [batch] = await database
    .insert(priceBatches)
    .values({ siteId, source, status: "draft", createdBy: userId })
    .returning();

  if (!batch) {
    throw new Error("the batch could not be created");
  }

  const items: BatchItem[] = [];

  for (const row of rows) {
    items.push(await stageOne(database, batch.id, siteId, row, defaultDate, resolver, now));
  }

  return { batch, items };
}

async function stageOne(
  database: Database,
  batchId: number,
  siteId: number,
  row: StageRow,
  defaultDate: string | null,
  resolver: LocationResolver,
  now: Date,
): Promise<BatchItem> {
  const rawLocation = typeof row.location === "string" ? row.location : String(row.location ?? "");
  const date =
    row.date === undefined || row.date === null || row.date === ""
      ? defaultDate
      : parseDate(row.date);

  const numeric = toNumber(row.price);

  const base = {
    batchId,
    rawLocation,
    // The old code parked unreadable rows on the epoch rather than null, so the
    // column could stay NOT NULL and the row could still be shown. Same here.
    priceDate: date ?? "1970-01-01",
    newPrice: String(numeric ?? 0),
  };

  if (date === null) {
    return insertItem(database, { ...base, status: "invalid", errorMessage: "Could not read the date." });
  }

  if (numeric === null || numeric < 0) {
    return insertItem(database, {
      ...base,
      status: "invalid",
      errorMessage: "Price must be a number, zero or more.",
    });
  }

  const match = resolver.resolve(rawLocation);

  if (match.status === "unmatched") {
    return insertItem(database, {
      ...base,
      status: "unmatched",
      errorMessage: "No location matches this name.",
    });
  }

  if (match.status === "ambiguous") {
    return insertItem(database, {
      ...base,
      status: "ambiguous",
      errorMessage: "This name matches more than one location.",
    });
  }

  const location = match.location;
  const result = await diff(location.id, date, numeric, database, now);

  return insertItem(database, {
    ...base,
    locationId: location.id,
    currency: location.currency,
    priceId: result.priceId,
    oldPrice: result.oldPrice,
    status: result.status,
  });
}

async function insertItem(
  database: Database,
  values: typeof priceBatchItems.$inferInsert,
): Promise<BatchItem> {
  const [row] = await database.insert(priceBatchItems).values(values).returning();

  if (!row) {
    throw new Error("the batch item could not be created");
  }

  return row;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }

  return null;
}

/* ---------------------------------------------------------- editing a row */

export type ItemPatch = {
  new_price?: unknown;
  pricedate?: unknown;
  location_id?: unknown;
  is_included?: unknown;
};

/**
 * The one editing endpoint the console uses: change a price, a date, which
 * location a row means, or whether it is included. Any change to the value or
 * the date re-runs the diff, so the status can never describe an older edit.
 */
export async function updateItem(
  siteId: number,
  itemId: number,
  patch: ItemPatch,
  database: Database = db(),
  now: Date = new Date(),
): Promise<BatchItem> {
  const item = await itemOnSite(siteId, itemId, database);

  if (!item) {
    throw new BatchError("No such batch item.", 404);
  }

  const batch = await batchOnSite(siteId, item.batchId, database);

  if (!batch || batch.status !== "draft") {
    throw new BatchError("Only a draft batch can be edited.");
  }

  const values: Partial<typeof priceBatchItems.$inferInsert> = { updatedAt: new Date() };
  let revalue = false;

  // Changing what a row would publish is only allowed where it makes sense.
  // A `locked` or `unchanged` row has nothing to edit, and an editor who
  // wants it out of the batch excludes it — which is why `is_included` is
  // never gated.
  const wantsValueEdit =
    patch.new_price !== undefined ||
    patch.pricedate !== undefined ||
    (patch.location_id !== undefined && patch.location_id !== null && patch.location_id !== "");

  if (wantsValueEdit && !VALUE_EDITABLE.includes(item.status)) {
    throw new BatchError("That row cannot be edited.");
  }

  if (patch.is_included !== undefined) {
    values.isIncluded = Boolean(patch.is_included);
  }

  if (patch.new_price !== undefined) {
    const numeric = toNumber(patch.new_price);

    if (numeric === null || numeric < 0) {
      throw new BatchError("Price must be a number, zero or more.", 422);
    }

    values.newPrice = String(numeric);
    revalue = true;
  }

  if (patch.pricedate !== undefined) {
    const date = parseDate(patch.pricedate);

    if (date === null) {
      throw new BatchError("Could not read the date.", 422);
    }

    values.priceDate = date;
    revalue = true;
  }

  if (patch.location_id !== undefined) {
    const locationId = Number(patch.location_id);
    const [location] = await database
      .select()
      .from(locations)
      .where(
        and(
          eq(locations.id, locationId),
          eq(locations.siteId, siteId),
          isNull(locations.deletedAt),
        ),
      )
      .limit(1);

    if (!location) {
      throw new BatchError("No such location on this site.", 422);
    }

    values.locationId = location.id;
    values.currency = location.currency;
    values.errorMessage = null;
    revalue = true;
  }

  const locationId = (values.locationId ?? item.locationId) as number | null;

  if (revalue && locationId) {
    const result = await diff(
      locationId,
      (values.priceDate ?? item.priceDate) as string,
      Number(values.newPrice ?? item.newPrice),
      database,
      now,
    );

    values.status = result.status;
    values.priceId = result.priceId;
    values.oldPrice = result.oldPrice;
    values.errorMessage = null;
  }

  const [updated] = await database
    .update(priceBatchItems)
    .set(values)
    .where(eq(priceBatchItems.id, item.id))
    .returning();

  return updated!;
}

/* ------------------------------------------------------------- committing */

export type CommitResult = { applied: number; created: number; conflicts: number };

/**
 * Writes the batch. Every included `new` or `changed` row is re-checked
 * against the live table inside one transaction, with the row locked: if the
 * live price moved after staging, the item becomes `conflict` and is not
 * written, rather than overwriting an edit nobody saw.
 */
export async function commitBatch(
  siteId: number,
  batchId: number,
  actor: { userId?: number | null; ip?: string | null; tokenId?: number | null } = {},
  database: Database = db(),
  now: Date = new Date(),
): Promise<CommitResult> {
  const batch = await batchOnSite(siteId, batchId, database);

  if (!batch) {
    throw new BatchError("No such batch.", 404);
  }

  if (batch.status !== "draft") {
    throw new BatchError("Only a draft batch can be committed.");
  }

  const [blocking] = await database
    .select({ n: count() })
    .from(priceBatchItems)
    .where(
      and(
        eq(priceBatchItems.batchId, batch.id),
        eq(priceBatchItems.isIncluded, true),
        inArray(priceBatchItems.status, BLOCKING),
      ),
    );

  if ((blocking?.n ?? 0) > 0) {
    throw new BatchError(
      `${blocking!.n} row(s) still need attention. Resolve or exclude them first.`,
    );
  }

  const result: CommitResult = { applied: 0, created: 0, conflicts: 0 };

  await database.transaction(async (tx) => {
    const items = await tx
      .select()
      .from(priceBatchItems)
      .where(
        and(
          eq(priceBatchItems.batchId, batch.id),
          eq(priceBatchItems.isIncluded, true),
          inArray(priceBatchItems.status, WRITABLE),
        ),
      )
      .orderBy(asc(priceBatchItems.id));

    for (const item of items) {
      const outcome =
        item.status === "new"
          ? await insertPrice(tx as unknown as Database, siteId, item, actor, now)
          : await updatePrice(tx as unknown as Database, item, actor, now);

      if (outcome === "conflict") {
        result.conflicts += 1;
      } else if (outcome === "created") {
        result.created += 1;
      } else {
        result.applied += 1;
      }
    }

    await tx
      .update(priceBatches)
      .set({
        status: "committed",
        committedBy: actor.userId ?? null,
        committedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(priceBatches.id, batch.id));

    await tx.insert(auditLog).values({
      siteId,
      userId: actor.userId ?? null,
      tokenId: actor.tokenId ?? null,
      action: "price_batch.commit",
      entity: "price_batch",
      entityId: batch.id,
      detail: { ...result, source: batch.source },
      ip: actor.ip ?? null,
    });
  });

  return result;
}

async function updatePrice(
  tx: Database,
  item: BatchItem,
  actor: { userId?: number | null },
  now: Date,
): Promise<"applied" | "conflict"> {
  if (item.priceId === null) {
    await flag(tx, item, "conflict", "The price row no longer exists.");
    return "conflict";
  }

  const [live] = await tx
    .select()
    .from(prices)
    .where(and(eq(prices.id, item.priceId), isNull(prices.deletedAt)))
    .limit(1)
    .for("update");

  if (!live) {
    await flag(tx, item, "conflict", "The price row no longer exists.");
    return "conflict";
  }

  if (!priceEquals(live.price, item.oldPrice)) {
    await flag(tx, item, "conflict", `Price changed to ${live.price} after this batch was staged.`);
    return "conflict";
  }

  // Re-derived here on purpose: see the note at the top of the file.
  if (item.priceDate < today(now)) {
    await flag(
      tx,
      item,
      "locked",
      `This date (${item.priceDate}) has passed since the batch was staged; published history cannot be overwritten.`,
    );
    return "conflict";
  }

  await tx
    .update(prices)
    .set({ price: item.newPrice, updatedAt: new Date() })
    .where(eq(prices.id, live.id));

  return "applied";
}

async function insertPrice(
  tx: Database,
  siteId: number,
  item: BatchItem,
  actor: { userId?: number | null },
  now: Date,
): Promise<"created" | "conflict"> {
  if (item.locationId === null) {
    await flag(tx, item, "conflict", "This row has no location.");
    return "conflict";
  }

  // A price may have appeared for this location and date since staging —
  // another batch committing first, or an editor adding one by hand. Lock
  // before looking, so two concurrent commits cannot both pass this check.
  const existing = await livePriceForUpdate(tx, item.locationId, item.priceDate);

  if (existing) {
    await flag(
      tx,
      item,
      "conflict",
      `A price of ${existing.price} was added for this date after the batch was staged.`,
    );
    return "conflict";
  }

  const [created] = await tx
    .insert(prices)
    .values({
      siteId,
      locationId: item.locationId,
      price: item.newPrice,
      currency: item.currency,
      priceDate: item.priceDate,
    })
    .returning();

  await tx
    .update(priceBatchItems)
    .set({ priceId: created!.id, updatedAt: new Date() })
    .where(eq(priceBatchItems.id, item.id));

  return "created";
}

async function flag(
  tx: Database,
  item: BatchItem,
  status: ItemStatus,
  message: string,
): Promise<void> {
  await tx
    .update(priceBatchItems)
    .set({ status, errorMessage: message, updatedAt: new Date() })
    .where(eq(priceBatchItems.id, item.id));
}

/* --------------------------------------------------- rollback and discard */

/**
 * Undo a committed batch: every row it created is soft-deleted, every row it
 * changed goes back to the value it had. A row that moved again since the
 * commit is left alone and counted as skipped — the same conservative rule the
 * Laravel roller used, because the later edit is the newer intent.
 */
export async function rollbackBatch(
  siteId: number,
  batchId: number,
  actor: { userId?: number | null; ip?: string | null; tokenId?: number | null } = {},
  database: Database = db(),
): Promise<{ reverted: number; removed: number; skipped: number }> {
  const batch = await batchOnSite(siteId, batchId, database);

  if (!batch) {
    throw new BatchError("No such batch.", 404);
  }

  if (batch.status !== "committed") {
    throw new BatchError("Only a committed batch can be rolled back.");
  }

  const result = { reverted: 0, removed: 0, skipped: 0 };

  await database.transaction(async (tx) => {
    const items = await tx
      .select()
      .from(priceBatchItems)
      .where(
        and(
          eq(priceBatchItems.batchId, batch.id),
          eq(priceBatchItems.isIncluded, true),
          inArray(priceBatchItems.status, WRITABLE),
        ),
      )
      .orderBy(desc(priceBatchItems.id));

    for (const item of items) {
      if (item.priceId === null) {
        result.skipped += 1;
        continue;
      }

      const [live] = await tx
        .select()
        .from(prices)
        .where(and(eq(prices.id, item.priceId), isNull(prices.deletedAt)))
        .limit(1)
        .for("update");

      if (!live || !priceEquals(live.price, item.newPrice)) {
        result.skipped += 1;
        continue;
      }

      if (item.status === "new") {
        await tx
          .update(prices)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(prices.id, live.id));
        result.removed += 1;
      } else {
        await tx
          .update(prices)
          .set({ price: item.oldPrice!, updatedAt: new Date() })
          .where(eq(prices.id, live.id));
        result.reverted += 1;
      }
    }

    await tx
      .update(priceBatches)
      .set({ status: "rolled_back", updatedAt: new Date() })
      .where(eq(priceBatches.id, batch.id));

    await tx.insert(auditLog).values({
      siteId,
      userId: actor.userId ?? null,
      tokenId: actor.tokenId ?? null,
      action: "price_batch.rollback",
      entity: "price_batch",
      entityId: batch.id,
      detail: { ...result },
      ip: actor.ip ?? null,
    });
  });

  return result;
}

export async function discardBatch(
  siteId: number,
  batchId: number,
  database: Database = db(),
): Promise<Batch> {
  const batch = await batchOnSite(siteId, batchId, database);

  if (!batch) {
    throw new BatchError("No such batch.", 404);
  }

  if (batch.status !== "draft") {
    throw new BatchError("Only a draft batch can be discarded.");
  }

  const [updated] = await database
    .update(priceBatches)
    .set({ status: "discarded", updatedAt: new Date() })
    .where(eq(priceBatches.id, batch.id))
    .returning();

  return updated!;
}

/* ------------------------------------------------------------ reading them */

export async function batchOnSite(
  siteId: number,
  batchId: number,
  database: Database = db(),
): Promise<Batch | null> {
  const [row] = await database
    .select()
    .from(priceBatches)
    .where(and(eq(priceBatches.id, batchId), eq(priceBatches.siteId, siteId)))
    .limit(1);

  return row ?? null;
}

export async function itemOnSite(
  siteId: number,
  itemId: number,
  database: Database = db(),
): Promise<BatchItem | null> {
  const [row] = await database
    .select({ item: priceBatchItems })
    .from(priceBatchItems)
    .innerJoin(priceBatches, eq(priceBatches.id, priceBatchItems.batchId))
    .where(and(eq(priceBatchItems.id, itemId), eq(priceBatches.siteId, siteId)))
    .limit(1);

  return row?.item ?? null;
}

export async function batchItems(
  batchId: number,
  database: Database = db(),
): Promise<BatchItem[]> {
  return database
    .select()
    .from(priceBatchItems)
    .where(eq(priceBatchItems.batchId, batchId))
    .orderBy(asc(priceBatchItems.id));
}

export async function listBatches(
  siteId: number,
  page = 1,
  perPage = 25,
  database: Database = db(),
): Promise<{ rows: (Batch & { itemsCount: number })[]; total: number }> {
  const [totals] = await database
    .select({ n: count() })
    .from(priceBatches)
    .where(eq(priceBatches.siteId, siteId));

  const rows = await database
    .select({
      batch: priceBatches,
      itemsCount: sql<number>`cast(count(${priceBatchItems.id}) as int)`,
    })
    .from(priceBatches)
    .leftJoin(priceBatchItems, eq(priceBatchItems.batchId, priceBatches.id))
    .where(eq(priceBatches.siteId, siteId))
    .groupBy(priceBatches.id)
    .orderBy(desc(priceBatches.id))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return {
    rows: rows.map((row) => ({ ...row.batch, itemsCount: row.itemsCount })),
    total: totals?.n ?? 0,
  };
}

export { ITEM_STATUSES };
