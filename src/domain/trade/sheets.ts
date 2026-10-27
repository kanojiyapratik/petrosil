/**
 * Entering monthly import and export quantities, one sheet at a time.
 *
 * The old admin's way, kept because it is how the figures arrive: pick a
 * reporting country and a month, and type a quantity against each partner
 * country. An export runs from the reporting country to each partner; an
 * import runs from each partner into the reporting country. A box left empty
 * means no figure, and emptying a box removes the figure it held.
 *
 * The old form refused a month that already had figures and sent the editor
 * hunting for the edit screen; here opening a month that exists simply shows
 * its figures to change.
 */

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, sites, tradeLocations, tradeQuantities } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { dateInput } from "@/domain/billing/inputs";

/** The two kinds entered on sheets. The carried "qty" set is shown, not entered. */
export const SHEET_KINDS = ["export", "import"] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

type Sheet = { site: string; kind: unknown; location: unknown; date: unknown };

/** Which end of a flow the reporting country is on. */
const reportingEnd = (kind: SheetKind) =>
  kind === "export" ? tradeQuantities.fromLocationId : tradeQuantities.toLocationId;
const partnerEnd = (kind: SheetKind) =>
  kind === "export" ? tradeQuantities.toLocationId : tradeQuantities.fromLocationId;

function kindOf(value: unknown): SheetKind {
  if (!(SHEET_KINDS as readonly string[]).includes(String(value))) {
    throw new AccountError("Choose exports or imports.", 422, "kind");
  }

  return value as SheetKind;
}

/** "1,250.5" → "1250.500". Up to three decimals, as the column holds. */
function quantity(value: string, partner: string): string {
  const text = value.trim().replace(/,/g, "");

  if (!/^\d{1,15}(\.\d{1,3})?$/.test(text)) {
    throw new AccountError(`The figure for ${partner} is not a quantity, like 1250 or 1,250.5.`, 422, "quantities");
  }

  return Number(text).toFixed(3);
}

/** The brand, checked against what the viewer may see. */
async function brandFor(siteIds: number[], slug: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  return brand && (siteIds.length === 0 || siteIds.includes(brand.id)) ? brand : null;
}

async function placeOf(siteId: number, value: unknown, database: Database) {
  const [place] = await database
    .select()
    .from(tradeLocations)
    .where(and(eq(tradeLocations.id, Number(value)), eq(tradeLocations.siteId, siteId), isNull(tradeLocations.deletedAt)))
    .limit(1);

  if (!place) {
    throw new AccountError("Choose one of this brand's countries.", 422, "location");
  }

  return place;
}

function dateOf(value: unknown): string {
  const date = dateInput(value, "date");

  if (!date) {
    throw new AccountError("Choose the month.", 422, "date");
  }

  return date;
}

/** Everything a sheet needs checked before it is read or written. */
async function opened(guard: Guarded, input: Sheet, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, input.site)).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "trade-qty-edit", database);

  const kind = kindOf(input.kind);
  const date = dateOf(input.date);
  const location = await placeOf(brand.id, input.location, database);

  const cell = and(
    eq(tradeQuantities.siteId, brand.id),
    eq(tradeQuantities.kind, kind),
    eq(reportingEnd(kind), location.id),
    eq(tradeQuantities.qtyDate, date),
  );

  return { brand, kind, date, location, cell };
}

/**
 * Save a month's sheet. `quantities` maps each partner's id to the box's
 * text: a figure saves it, an empty box removes the figure it held, and a
 * partner not named is left as it is.
 */
export async function saveSheet(
  guard: Guarded,
  input: Sheet & { quantities: Record<string, string> },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ saved: number; cleared: number }> {
  const { brand, kind, date, location, cell } = await opened(guard, input, database);

  const ids = Object.keys(input.quantities).map(Number);
  const partners = ids.length
    ? await database
        .select()
        .from(tradeLocations)
        .where(and(inArray(tradeLocations.id, ids), eq(tradeLocations.siteId, brand.id), isNull(tradeLocations.deletedAt)))
    : [];

  if (partners.length !== ids.length || ids.includes(location.id)) {
    throw new AccountError("One of those partner countries is not this brand's.", 422, "quantities");
  }

  const byId = new Map(partners.map((partner) => [partner.id, partner]));
  const figures: { partner: number; qty: string }[] = [];
  const emptied: number[] = [];

  // Every box is read before anything is written: one bad figure saves nothing.
  for (const id of ids) {
    const text = String(input.quantities[id] ?? "");

    if (text.trim() === "") {
      emptied.push(id);
    } else {
      figures.push({ partner: id, qty: quantity(text, byId.get(id)!.title) });
    }
  }

  const ends = (partner: number) =>
    kind === "export" ? { fromLocationId: location.id, toLocationId: partner } : { fromLocationId: partner, toLocationId: location.id };

  const cleared = await database.transaction(async (tx) => {
    for (const figure of figures) {
      await tx
        .insert(tradeQuantities)
        .values({ siteId: brand.id, kind, qtyDate: date, qty: figure.qty, ...ends(figure.partner) })
        .onConflictDoUpdate({
          target: [
            tradeQuantities.siteId,
            tradeQuantities.kind,
            tradeQuantities.fromLocationId,
            tradeQuantities.toLocationId,
            tradeQuantities.qtyDate,
          ],
          set: { qty: figure.qty },
        });
    }

    const removed = emptied.length
      ? await tx
          .delete(tradeQuantities)
          .where(and(cell, inArray(partnerEnd(kind), emptied)))
          .returning({ id: tradeQuantities.id })
      : [];

    await tx.insert(auditLog).values({
      siteId: brand.id,
      userId: guard.identity.user.id,
      action: "trade.sheet",
      entity: "trade_location",
      entityId: location.id,
      detail: { kind, location: location.title, date, saved: figures.length, cleared: removed.length },
      ip: context.ip ?? null,
    });

    return removed.length;
  });

  return { saved: figures.length, cleared };
}

/** Remove every figure on one month's sheet. Answers how many went. */
export async function clearSheet(
  guard: Guarded,
  input: Sheet,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<number> {
  const { brand, kind, date, location, cell } = await opened(guard, input, database);

  const removed = await database.delete(tradeQuantities).where(cell).returning({ id: tradeQuantities.id });

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "trade.sheet.clear",
    entity: "trade_location",
    entityId: location.id,
    detail: { kind, location: location.title, date, cleared: removed.length },
    ip: context.ip ?? null,
  });

  return removed.length;
}

/* ------------------------------------------------------------------ reads */

export type SheetRow = { id: number; title: string; qty: string | null };

/** One month's sheet: every partner, with its figure or null. Null when the brand or place is not the viewer's. */
export async function sheetFor(
  siteIds: number[],
  input: { site: string; kind: SheetKind; location: number; date: string },
  database: Database = db(),
): Promise<{ location: { id: number; title: string }; date: string; rows: SheetRow[]; total: number } | null> {
  const brand = await brandFor(siteIds, input.site, database);

  if (!brand) {
    return null;
  }

  const [location] = await database
    .select()
    .from(tradeLocations)
    .where(and(eq(tradeLocations.id, input.location), eq(tradeLocations.siteId, brand.id)))
    .limit(1);

  if (!location) {
    return null;
  }

  const [places, figures] = await Promise.all([
    database
      .select({ id: tradeLocations.id, title: tradeLocations.title })
      .from(tradeLocations)
      .where(and(eq(tradeLocations.siteId, brand.id), isNull(tradeLocations.deletedAt), ne(tradeLocations.id, location.id)))
      .orderBy(tradeLocations.title),
    database
      .select({ partner: partnerEnd(input.kind), qty: tradeQuantities.qty })
      .from(tradeQuantities)
      .where(
        and(
          eq(tradeQuantities.siteId, brand.id),
          eq(tradeQuantities.kind, input.kind),
          eq(reportingEnd(input.kind), location.id),
          eq(tradeQuantities.qtyDate, input.date),
        ),
      ),
  ]);

  const byPartner = new Map(figures.map((row) => [row.partner, row.qty]));

  return {
    location: { id: location.id, title: location.title },
    date: input.date,
    rows: places.map((place) => ({ id: place.id, title: place.title, qty: byPartner.get(place.id) ?? null })),
    total: figures.reduce((sum, row) => sum + Number(row.qty ?? 0), 0),
  };
}

/** A reporting country's months on record, newest first. */
export async function monthsFor(
  siteIds: number[],
  input: { site: string; kind: SheetKind; location: number },
  database: Database = db(),
): Promise<{ date: string; total: number; partners: number }[]> {
  const brand = await brandFor(siteIds, input.site, database);

  if (!brand) {
    return [];
  }

  const rows = await database
    .select({
      date: tradeQuantities.qtyDate,
      total: sql<string>`coalesce(sum(${tradeQuantities.qty}), 0)`,
      partners: sql<number>`count(*)`,
    })
    .from(tradeQuantities)
    .where(
      and(
        eq(tradeQuantities.siteId, brand.id),
        eq(tradeQuantities.kind, input.kind),
        eq(reportingEnd(input.kind), input.location),
      ),
    )
    .groupBy(tradeQuantities.qtyDate)
    .orderBy(desc(tradeQuantities.qtyDate));

  return rows
    .filter((row) => row.date !== null)
    .map((row) => ({ date: row.date!, total: Number(row.total), partners: Number(row.partners) }));
}

/** The countries that report figures of one kind, with how many months each has. */
export async function reportingPlaces(
  siteIds: number[],
  input: { site: string; kind: SheetKind },
  database: Database = db(),
): Promise<{ id: number; title: string; months: number; latest: string | null }[]> {
  const brand = await brandFor(siteIds, input.site, database);

  if (!brand) {
    return [];
  }

  const end = reportingEnd(input.kind);
  const rows = await database
    .select({
      id: tradeLocations.id,
      title: tradeLocations.title,
      months: sql<number>`count(distinct ${tradeQuantities.qtyDate})`,
      latest: sql<string | null>`max(${tradeQuantities.qtyDate})`,
    })
    .from(tradeQuantities)
    .innerJoin(tradeLocations, eq(tradeLocations.id, end))
    .where(and(eq(tradeQuantities.siteId, brand.id), eq(tradeQuantities.kind, input.kind)))
    .groupBy(tradeLocations.id, tradeLocations.title)
    .orderBy(tradeLocations.title);

  return rows.map((row) => ({ ...row, months: Number(row.months) }));
}

/** Every country the brand can report on or trade with, for starting a new reporting country. */
export async function tradePlaceList(siteIds: number[], site: string, database: Database = db()) {
  const brand = await brandFor(siteIds, site, database);

  if (!brand) {
    return [];
  }

  return database
    .select({ id: tradeLocations.id, title: tradeLocations.title, visible: tradeLocations.visible })
    .from(tradeLocations)
    .where(and(eq(tradeLocations.siteId, brand.id), isNull(tradeLocations.deletedAt)))
    .orderBy(tradeLocations.title);
}

/* ----------------------------------------------------------------- places */

/** Add or rename a country, or hide it from the brand site. Null when it is another brand's. */
export async function saveTradePlace(
  guard: Guarded,
  input: { id?: number; site?: string; title: unknown; visible?: boolean },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ id: number; title: string; visible: boolean } | null> {
  let existing: typeof tradeLocations.$inferSelect | undefined;
  let siteId: number;

  if (input.id !== undefined) {
    [existing] = await database.select().from(tradeLocations).where(eq(tradeLocations.id, input.id)).limit(1);

    if (!existing || (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))) {
      return null;
    }

    siteId = existing.siteId;
  } else {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, String(input.site ?? ""))).limit(1);

    if (!brand) {
      throw new AccountError("We do not recognise that brand.", 422, "site");
    }

    if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
      throw new AccountError("You do not have access to that brand.", 403, "site");
    }

    siteId = brand.id;
  }

  await requirePermission(guard, siteId, "trade-qty-edit", database);

  const title = String(input.title ?? "").trim().replace(/\s+/g, " ").slice(0, 191);

  if (title === "") {
    throw new AccountError("Give the country a name.", 422, "title");
  }

  const [clash] = await database
    .select({ id: tradeLocations.id })
    .from(tradeLocations)
    .where(
      and(
        eq(tradeLocations.siteId, siteId),
        sql`lower(${tradeLocations.title}) = ${title.toLowerCase()}`,
        existing ? ne(tradeLocations.id, existing.id) : undefined,
      ),
    )
    .limit(1);

  if (clash) {
    throw new AccountError("This brand already has a country by that name.", 409, "title");
  }

  const values = { title, visible: input.visible ?? true };
  const [row] = existing
    ? await database.update(tradeLocations).set(values).where(eq(tradeLocations.id, existing.id)).returning()
    : await database.insert(tradeLocations).values({ ...values, siteId }).returning();

  await database.insert(auditLog).values({
    siteId,
    userId: guard.identity.user.id,
    action: existing ? "trade.place.update" : "trade.place.create",
    entity: "trade_location",
    entityId: row!.id,
    detail: existing ? { was: existing.title, now: title, visible: values.visible } : { title },
    ip: context.ip ?? null,
  });

  return { id: row!.id, title: row!.title, visible: row!.visible };
}
