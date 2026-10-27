/**
 * Locations and their price history, for the team's own screens.
 *
 * The compat API answers the module's question ("what do you track, what is
 * the latest figure"). This answers the editor's: how many rows does this
 * location have, when did it last move, is it published, and what does its
 * history look like.
 */

import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, currencies, locations, priceBatchItems, priceBatches, prices, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { normaliseName } from "@/domain/price/locations";

export type LocationRow = {
  id: number;
  site: string;
  site_name: string;
  title: string;
  currency: string | null;
  visible: boolean;
  price_rows: number;
  latest_price: number | null;
  latest_pricedate: string | null;
  previous_price: number | null;
  change_pct: number | null;
};

export type LocationQuery = { site?: string; search?: string; visible?: boolean };

/** Null when the viewer may not see the brand they asked for. */
async function scopeFor(
  siteIds: number[],
  slug: string | undefined,
  database: Database,
): Promise<number[] | null> {
  if (!slug) {
    return siteIds;
  }

  const [site] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!site || (siteIds.length > 0 && !siteIds.includes(site.id))) {
    return null;
  }

  return [site.id];
}

export async function listLocations(
  siteIds: number[],
  query: LocationQuery = {},
  database: Database = db(),
): Promise<LocationRow[]> {
  const scope = await scopeFor(siteIds, query.site, database);

  if (scope === null) {
    return [];
  }

  const rows = await database
    .select({ location: locations, slug: sites.slug, siteName: sites.name })
    .from(locations)
    .innerJoin(sites, eq(sites.id, locations.siteId))
    .where(
      and(
        scope.length > 0 ? inArray(locations.siteId, scope) : undefined,
        isNull(locations.deletedAt),
        query.search ? sql`${locations.title} ilike ${`%${query.search}%`}` : undefined,
        query.visible === undefined ? undefined : eq(locations.visible, query.visible),
      ),
    )
    .orderBy(sites.slug, locations.title);

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.location.id);

  // Counts and the two most recent figures, in two queries rather than one
  // per location — 282 locations across the estate would be 282 round trips.
  const [counts, recent] = await Promise.all([
    database
      .select({ locationId: prices.locationId, n: count() })
      .from(prices)
      .where(and(inArray(prices.locationId, ids), isNull(prices.deletedAt)))
      .groupBy(prices.locationId),

    database
      .select({
        locationId: prices.locationId,
        price: prices.price,
        priceDate: prices.priceDate,
        // Cast: row_number() is a bigint, which this driver hands back as a
        // string, and a string never equals 1.
        rank: sql<number>`cast(row_number() over (
          partition by ${prices.locationId}
          order by ${prices.priceDate} desc, ${prices.id} desc
        ) as int)`.as("rank"),
      })
      .from(prices)
      .where(and(inArray(prices.locationId, ids), isNull(prices.deletedAt))),
  ]);

  const byCount = new Map(counts.map((row) => [row.locationId, row.n]));
  const latest = new Map(recent.filter((row) => row.rank === 1).map((row) => [row.locationId, row]));
  const previous = new Map(recent.filter((row) => row.rank === 2).map((row) => [row.locationId, row]));

  return rows.map(({ location, slug, siteName }) => {
    const now = latest.get(location.id);
    const before = previous.get(location.id);
    const current = now ? Number(now.price) : null;
    const prior = before ? Number(before.price) : null;

    return {
      id: location.id,
      site: slug,
      site_name: siteName,
      title: location.title,
      currency: location.currency,
      visible: location.visible,
      price_rows: byCount.get(location.id) ?? 0,
      latest_price: current,
      latest_pricedate: now ? now.priceDate : null,
      previous_price: prior,
      change_pct:
        current !== null && prior !== null && prior !== 0
          ? Math.round(((current - prior) / prior) * 10000) / 100
          : null,
    };
  });
}

export type HistoryPoint = {
  price_date: string;
  price: number;
  change_pct: number | null;
  batch_id: number | null;
  source: string | null;
};

/**
 * One location with its history, newest first — the chart and the table the
 * price-history screen shows, plus which batch published each figure, which
 * is how an editor traces a wrong number back to where it came from.
 */
export async function locationDetail(
  siteIds: number[],
  locationId: number,
  limit = 52,
  database: Database = db(),
): Promise<{ location: LocationRow; history: HistoryPoint[] } | null> {
  const [found] = await database
    .select({ location: locations, slug: sites.slug })
    .from(locations)
    .innerJoin(sites, eq(sites.id, locations.siteId))
    .where(and(eq(locations.id, locationId), isNull(locations.deletedAt)))
    .limit(1);

  // Not this viewer's brand answers the same as "no such location", so the
  // reply cannot be used to map another brand's ids.
  if (!found || (siteIds.length > 0 && !siteIds.includes(found.location.siteId))) {
    return null;
  }

  const [row] = await listLocations(siteIds, { site: found.slug }, database).then((rows) =>
    rows.filter((candidate) => candidate.id === locationId),
  );

  if (!row) {
    return null;
  }

  const points = await database
    .select({
      price: prices.price,
      priceDate: prices.priceDate,
      batchId: priceBatchItems.batchId,
      source: priceBatches.source,
    })
    .from(prices)
    .leftJoin(priceBatchItems, eq(priceBatchItems.priceId, prices.id))
    .leftJoin(priceBatches, eq(priceBatches.id, priceBatchItems.batchId))
    .where(and(eq(prices.locationId, locationId), isNull(prices.deletedAt)))
    .orderBy(desc(prices.priceDate), desc(prices.id))
    .limit(Math.min(520, Math.max(1, limit)));

  const history: HistoryPoint[] = points.map((point, index) => {
    const older = points[index + 1];
    const current = Number(point.price);
    const prior = older ? Number(older.price) : null;

    return {
      price_date: point.priceDate,
      price: current,
      change_pct:
        prior !== null && prior !== 0 ? Math.round(((current - prior) / prior) * 10000) / 100 : null,
      batch_id: point.batchId,
      source: point.source,
    };
  });

  return { location: row, history };
}

/**
 * Show or hide a location on its brand site.
 *
 * The old sites called this `show_on_dashboard`; hiding is how a retired
 * assessment stops being published without deleting its history. Audited,
 * because "who hid that price?" has been asked before.
 */
export async function setVisibility(
  siteIds: number[],
  locationId: number,
  visible: boolean,
  actor: { userId: number; ip?: string | null },
  database: Database = db(),
): Promise<LocationRow | null> {
  const [found] = await database
    .select()
    .from(locations)
    .where(and(eq(locations.id, locationId), isNull(locations.deletedAt)))
    .limit(1);

  if (!found || (siteIds.length > 0 && !siteIds.includes(found.siteId))) {
    return null;
  }

  if (found.visible !== visible) {
    await database
      .update(locations)
      .set({ visible, updatedAt: new Date() })
      .where(eq(locations.id, locationId));

    await database.insert(auditLog).values({
      siteId: found.siteId,
      userId: actor.userId,
      action: visible ? "location.show" : "location.hide",
      entity: "location",
      entityId: locationId,
      detail: { title: found.title, was: found.visible, now: visible },
      ip: actor.ip ?? null,
    });
  }

  const detail = await locationDetail(siteIds, locationId, 1, database);

  return detail?.location ?? null;
}

export { asc };

/* -------------------------------------------------------- adding, renaming */

export type LocationInput = {
  id?: number;
  /** The brand, on a new location only. */
  site?: string;
  title: unknown;
  currency: unknown;
  unit?: unknown;
  visible?: boolean;
  sort_order?: unknown;
};

/**
 * Add a location or change one. Null when it is another brand's.
 *
 * The name is how the price module, the crawler and the upload sheets find
 * a location, compared with case and spacing ignored. Two names equal that
 * way would make both ambiguous, so a new or changed name may not match
 * another of the brand's like that. A rename is recorded with the old name:
 * prices sent under it will now come back unmatched until the sender changes.
 */
export async function saveLocation(
  guard: Guarded,
  input: LocationInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<typeof locations.$inferSelect | null> {
  let existing: typeof locations.$inferSelect | undefined;
  let siteId: number;

  if (input.id !== undefined) {
    [existing] = await database
      .select()
      .from(locations)
      .where(and(eq(locations.id, input.id), isNull(locations.deletedAt)))
      .limit(1);

    if (!existing || (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))) {
      return null;
    }

    siteId = existing.siteId;
    await requirePermission(guard, siteId, "location-edit", database);
  } else {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, String(input.site ?? ""))).limit(1);

    if (!brand) {
      throw new AccountError("We do not recognise that brand.", 422, "site");
    }

    if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
      throw new AccountError("You do not have access to that brand.", 403, "site");
    }

    siteId = brand.id;
    await requirePermission(guard, siteId, "location-create", database);
  }

  const title = String(input.title ?? "").trim().replace(/\s+/g, " ").slice(0, 191);

  if (title === "") {
    throw new AccountError("Give the location a name.", 422, "title");
  }

  const [clash] = await database
    .select({ id: locations.id, title: locations.title })
    .from(locations)
    .where(
      and(
        eq(locations.siteId, siteId),
        sql`lower(regexp_replace(trim(${locations.title}), '\s+', ' ', 'g')) = ${normaliseName(title)}`,
        existing ? sql`${locations.id} <> ${existing.id}` : undefined,
      ),
    )
    .limit(1);

  if (clash) {
    throw new AccountError(
      `"${clash.title}" already has that name, as the price module reads it. Two locations named alike make both ambiguous.`,
      409,
      "title",
    );
  }

  const code = String(input.currency ?? "").trim().toUpperCase();
  const [currency] = await database
    .select()
    .from(currencies)
    .where(and(eq(currencies.code, code), eq(currencies.enabled, true)))
    .limit(1);

  if (!currency) {
    throw new AccountError("Choose one of the currencies that is switched on.", 422, "currency");
  }

  const unit = String(input.unit ?? "").trim().slice(0, 32) || null;
  const sortOrder = Number.isInteger(Number(input.sort_order)) ? Number(input.sort_order) : (existing?.sortOrder ?? 0);
  const values = { title, currency: currency.code, unit, visible: input.visible ?? true, sortOrder, updatedAt: new Date() };

  const [row] = existing
    ? await database.update(locations).set(values).where(eq(locations.id, existing.id)).returning()
    : await database.insert(locations).values({ ...values, siteId }).returning();

  await database.insert(auditLog).values({
    siteId,
    userId: guard.identity.user.id,
    action: existing ? "location.update" : "location.create",
    entity: "location",
    entityId: row!.id,
    detail: existing
      ? {
          ...(existing.title !== title ? { renamed: { from: existing.title, to: title } } : {}),
          ...(existing.currency !== values.currency ? { currency: { from: existing.currency, to: values.currency } } : {}),
          ...(existing.visible !== values.visible ? { visible: values.visible } : {}),
        }
      : { title, currency: values.currency, unit },
    ip: context.ip ?? null,
  });

  return row!;
}

/** The fields the location form edits, scoped like every dashboard read. */
export async function locationForEdit(siteIds: number[], id: number, database: Database = db()) {
  const [row] = await database
    .select()
    .from(locations)
    .where(and(eq(locations.id, id), isNull(locations.deletedAt)))
    .limit(1);

  if (!row || (siteIds.length > 0 && !siteIds.includes(row.siteId))) {
    return null;
  }

  return { id: row.id, title: row.title, currency: row.currency, unit: row.unit, visible: row.visible, sort_order: row.sortOrder };
}

export type LocationForEdit = NonNullable<Awaited<ReturnType<typeof locationForEdit>>>;

/** The currencies a location may be priced in: those switched on. */
export async function enabledCurrencies(database: Database = db()) {
  return database
    .select({ code: currencies.code, title: currencies.title })
    .from(currencies)
    .where(eq(currencies.enabled, true))
    .orderBy(currencies.code);
}
