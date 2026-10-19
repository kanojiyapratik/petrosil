/**
 * What a brand site publishes: the trends table, and one location's history.
 *
 * The dashboard has its own version of these queries in
 * `domain/dashboard/locations.ts`, and they are deliberately not shared. That
 * one answers an editor ("how many rows, which batch published this, is it
 * visible"); this one answers a reader, and must never return a row the brand
 * has hidden or a figure the reader has not paid for. Folding them together
 * would mean one function with a `forPublic` flag deciding both — exactly the
 * shape that let the old sites leak a price-history link to free users.
 */

import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { locations, prices } from "@/db/schema";
import { maskTrend, type TrendRow } from "./paywall";

export type PublicTrendRow = TrendRow & { locked: boolean };

const movementOf = (current: number | null, prior: number | null): "up" | "down" | "flat" | null => {
  if (current === null || prior === null) {
    return null;
  }

  if (current > prior) {
    return "up";
  }

  return current < prior ? "down" : "flat";
};

const percent = (current: number | null, prior: number | null): number | null =>
  current !== null && prior !== null && prior !== 0
    ? Math.round(((current - prior) / prior) * 10000) / 100
    : null;

/**
 * The price-trends table. One row per published location, with the latest
 * figure and the one before it so movement can be stated even when the figure
 * itself is withheld.
 */
export async function priceTrends(
  siteId: number,
  entitled: boolean,
  options: { search?: string } = {},
  database: Database = db(),
): Promise<{ rows: PublicTrendRow[]; asOf: string | null }> {
  const published = await database
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.siteId, siteId),
        // `visible` is the old `show_on_dashboard`. A hidden location is not
        // merely blank on the site — it is absent, history and all.
        eq(locations.visible, true),
        isNull(locations.deletedAt),
        options.search ? sql`${locations.title} ilike ${`%${options.search}%`}` : undefined,
      ),
    )
    .orderBy(asc(locations.sortOrder), asc(locations.title));

  if (published.length === 0) {
    return { rows: [], asOf: null };
  }

  const ids = published.map((row) => row.id);

  // Two figures per location in one pass. Per-location queries would be 282
  // round trips across the estate, which is what made the old price-trends
  // page slow enough to need a cache.
  const recent = await database
    .select({
      locationId: prices.locationId,
      price: prices.price,
      priceDate: prices.priceDate,
      // row_number() is bigint, which this driver returns as a string, and a
      // string never equals 1.
      rank: sql<number>`cast(row_number() over (
        partition by ${prices.locationId}
        order by ${prices.priceDate} desc, ${prices.id} desc
      ) as int)`.as("rank"),
    })
    .from(prices)
    .where(
      and(eq(prices.siteId, siteId), isNull(prices.deletedAt), inArray(prices.locationId, ids)),
    );

  const latest = new Map(recent.filter((row) => row.rank === 1).map((row) => [row.locationId, row]));
  const previous = new Map(recent.filter((row) => row.rank === 2).map((row) => [row.locationId, row]));

  const rows = published.map((location) => {
    const now = latest.get(location.id);
    const before = previous.get(location.id);
    const current = now ? Number(now.price) : null;
    const prior = before ? Number(before.price) : null;

    return maskTrend(
      {
        id: location.id,
        title: location.title,
        currency: location.currency,
        unit: location.unit,
        price: current,
        previous_price: prior,
        change_pct: percent(current, prior),
        price_date: now ? now.priceDate : null,
        movement: movementOf(current, prior),
      },
      entitled,
    );
  });

  const dates = rows.map((row) => row.price_date).filter((date): date is string => date !== null);

  return { rows, asOf: dates.length > 0 ? dates.sort().at(-1)! : null };
}

export type HistoryPoint = { price_date: string; price: number; change_pct: number | null };

export type PublicLocation = {
  location: PublicTrendRow;
  locked: boolean;
  points: HistoryPoint[];
  points_available: number;
};

/**
 * One location, with its series.
 *
 * The series is withheld whole, not masked point by point: a chart of nulls
 * is nothing to look at, and the old sites made the same call by swapping the
 * "Price History" link for a `$`. The count still goes out, because "thirteen
 * weeks of history behind this" is the argument for subscribing.
 */
export async function publicLocation(
  siteId: number,
  locationId: number,
  entitled: boolean,
  weeks = 12,
  database: Database = db(),
): Promise<PublicLocation | null> {
  const [location] = await database
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.id, locationId),
        eq(locations.siteId, siteId),
        eq(locations.visible, true),
        isNull(locations.deletedAt),
      ),
    )
    .limit(1);

  // Another brand's id, a hidden location and a deleted one all answer the
  // same way, so an id cannot be used to probe what the brand holds.
  if (!location) {
    return null;
  }

  const [counted] = await database
    .select({ n: count() })
    .from(prices)
    .where(and(eq(prices.locationId, locationId), isNull(prices.deletedAt)));

  const trend = await priceTrends(siteId, entitled, {}, database);
  const row = trend.rows.find((candidate) => candidate.id === locationId);

  if (!row) {
    return null;
  }

  if (!entitled) {
    return { location: row, locked: true, points: [], points_available: counted?.n ?? 0 };
  }

  // One extra row beyond the window, so the oldest point shown can still
  // state its own change rather than reporting null at the left edge.
  const limit = Math.min(520, Math.max(1, weeks)) + 2;

  const series = await database
    .select({ price: prices.price, priceDate: prices.priceDate })
    .from(prices)
    .where(and(eq(prices.locationId, locationId), isNull(prices.deletedAt)))
    .orderBy(desc(prices.priceDate), desc(prices.id))
    .limit(limit);

  const points: HistoryPoint[] = series.map((point, index) => {
    const older = series[index + 1];

    return {
      price_date: point.priceDate,
      price: Number(point.price),
      change_pct: percent(Number(point.price), older ? Number(older.price) : null),
    };
  });

  return {
    location: row,
    locked: false,
    points: points.slice(0, Math.min(520, Math.max(1, weeks)) + 1),
    points_available: counted?.n ?? 0,
  };
}
