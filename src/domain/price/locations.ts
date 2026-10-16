/**
 * Locations, and turning a name on a page or in a spreadsheet into one of them.
 *
 * The resolver is a port of the sites' LocationResolver: match on the title
 * with whitespace collapsed and case folded, nothing cleverer. Fuzzy matching
 * was never there and must not appear now — a near-match that silently picks
 * the wrong location would publish a wrong price, which is the one outcome
 * this whole pipeline exists to prevent. A name that does not match comes back
 * UNMATCHED and an editor deals with it.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { locations, prices } from "@/db/schema";

export type LocationRow = typeof locations.$inferSelect;

export type LocationMatch =
  | { status: "matched"; location: LocationRow }
  | { status: "ambiguous"; candidates: LocationRow[] }
  | { status: "unmatched" };

export function normaliseName(name: unknown): string {
  if (typeof name !== "string") {
    return "";
  }

  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Resolves names against one site's locations. Built once per batch: the whole
 * list is small (9 to 123 rows per brand) and the alternative is a query per row.
 */
export class LocationResolver {
  private readonly index = new Map<string, LocationRow[]>();

  private constructor(rows: LocationRow[]) {
    for (const row of rows) {
      const key = normaliseName(row.title);
      const bucket = this.index.get(key);

      if (bucket) {
        bucket.push(row);
      } else {
        this.index.set(key, [row]);
      }
    }
  }

  static async forSite(siteId: number, database: Database = db()): Promise<LocationResolver> {
    const rows = await database
      .select()
      .from(locations)
      .where(and(eq(locations.siteId, siteId), isNull(locations.deletedAt)));

    return new LocationResolver(rows);
  }

  resolve(name: unknown): LocationMatch {
    const key = normaliseName(name);

    if (key === "") {
      return { status: "unmatched" };
    }

    const candidates = this.index.get(key);

    if (!candidates || candidates.length === 0) {
      return { status: "unmatched" };
    }

    if (candidates.length > 1) {
      return { status: "ambiguous", candidates };
    }

    return { status: "matched", location: candidates[0]! };
  }

  /** Every live location title, in the order the API publishes them. */
  titles(): string[] {
    return [...this.index.values()].flat().map((row) => row.title).sort((a, b) => a.localeCompare(b));
  }
}

export type LocationWithLatest = {
  id: number;
  title: string;
  latest_price: number | null;
  latest_pricedate: string | null;
  currency: string | null;
};

/**
 * The payload the price module reads to know what this brand tracks and what
 * it currently shows. Newest date wins; if two live rows somehow share a date,
 * the newest row wins, which is what the Laravel version did with its
 * `orderBy('id','desc')`.
 */
export async function locationsWithLatestPrice(
  siteId: number,
  database: Database = db(),
): Promise<LocationWithLatest[]> {
  const rows = await database
    .select()
    .from(locations)
    .where(and(eq(locations.siteId, siteId), isNull(locations.deletedAt)))
    .orderBy(locations.title);

  if (rows.length === 0) {
    return [];
  }

  const latest = await database
    .selectDistinctOn([prices.locationId], {
      locationId: prices.locationId,
      price: prices.price,
      priceDate: prices.priceDate,
      currency: prices.currency,
    })
    .from(prices)
    .where(
      and(
        inArray(
          prices.locationId,
          rows.map((row) => row.id),
        ),
        isNull(prices.deletedAt),
      ),
    )
    .orderBy(prices.locationId, desc(prices.priceDate), desc(prices.id));

  const byLocation = new Map(latest.map((row) => [row.locationId, row]));

  return rows.map((row) => {
    const price = byLocation.get(row.id);

    return {
      id: row.id,
      title: row.title,
      latest_price: price ? Number(price.price) : null,
      latest_pricedate: price ? price.priceDate : null,
      // The site's own currency for the location wins; the price row's copy is
      // the fallback for rows migrated before locations carried one.
      currency: row.currency ?? price?.currency ?? null,
    };
  });
}

/** The live price for one location and date, or null. */
export async function livePrice(
  locationId: number,
  priceDate: string,
  database: Database = db(),
): Promise<typeof prices.$inferSelect | null> {
  const [row] = await database
    .select()
    .from(prices)
    .where(
      and(
        eq(prices.locationId, locationId),
        eq(prices.priceDate, priceDate),
        isNull(prices.deletedAt),
      ),
    )
    .orderBy(desc(prices.id))
    .limit(1);

  return row ?? null;
}

/** Same row, locked for the duration of the enclosing transaction. */
export async function livePriceForUpdate(
  tx: Database,
  locationId: number,
  priceDate: string,
): Promise<typeof prices.$inferSelect | null> {
  const [row] = await tx
    .select()
    .from(prices)
    .where(
      and(
        eq(prices.locationId, locationId),
        eq(prices.priceDate, priceDate),
        isNull(prices.deletedAt),
      ),
    )
    .orderBy(desc(prices.id))
    .limit(1)
    .for("update");

  return row ?? null;
}

/** Guards every cross-site lookup: an id alone is never enough. */
export async function locationOnSite(
  siteId: number,
  locationId: number,
  database: Database = db(),
): Promise<LocationRow | null> {
  const [row] = await database
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

  return row ?? null;
}

export const priceEquals = (a: unknown, b: unknown): boolean =>
  Math.abs(Number(a) - Number(b)) < 0.00001;

export { sql };
