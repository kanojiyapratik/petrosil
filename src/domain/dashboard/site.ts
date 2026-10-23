/**
 * One brand's own figures.
 *
 * The Sites group opens a brand on its own dashboard rather than on a
 * filtered estate list, so a brand's page needs the same questions the estate
 * dashboard answers, asked about one brand: how many markets, how many prices
 * held, when they last moved, how many readers and how many of them pay.
 *
 * The access check lives here rather than in the page. In the old estate a
 * per-site editor was kept out of other brands by being given a different
 * login to a different database; here the brand is a slug in the URL, so
 * typing another brand's slug has to fail in the query, not in the markup. An
 * unknown slug and a brand the viewer has no membership on both answer null —
 * the same answer, deliberately, so the URL cannot be used to find out which
 * brands exist.
 */

import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { locations, memberships, prices, sites } from "@/db/schema";
import { freshnessFor } from "./overview";
import type { Freshness } from "@/app/(admin)/nav";

export type SiteSnapshot = {
  brand: { id: number; slug: string; name: string; cadence: string | null };
  markets: number;
  all_markets: number;
  prices: number;
  latest_price_date: string | null;
  days_since_update: number | null;
  freshness: Freshness;
  readers: number;
  paying: number;
  trialling: number;
  recent: { market: string; price: string; currency: string | null; price_date: string }[];
};

export async function siteSnapshot(
  slug: string,
  siteIds: number[],
  database: Database = db(),
  now: Date = new Date(),
): Promise<SiteSnapshot | null> {
  const [brand] = await database
    .select({ id: sites.id, slug: sites.slug, name: sites.name, cadence: sites.priceCadence })
    .from(sites)
    .where(
      siteIds.length > 0
        ? and(eq(sites.slug, slug), inArray(sites.id, siteIds))
        : eq(sites.slug, slug),
    )
    .limit(1);

  if (!brand) {
    return null;
  }

  const [marketRows, priceTotal, standings, recent] = await Promise.all([
    database
      .select({
        all: count(),
        live: sql<number>`count(*) filter (where ${locations.deletedAt} is null)`,
      })
      .from(locations)
      .where(eq(locations.siteId, brand.id)),

    database
      .select({
        n: count(),
        latest: sql<string | null>`max(${prices.priceDate})`,
      })
      .from(prices)
      .where(and(eq(prices.siteId, brand.id), isNull(prices.deletedAt))),

    // Counted with expiry in mind, exactly as the estate dashboard and the
    // customer list count them. A membership whose `expires_at` has passed is
    // lapsed however it is labelled, and three screens disagreeing about who
    // is paying would be worse than any one of them being wrong.
    database
      .select({
        readers: count(),
        paying: sql<number>`count(*) filter (
          where ${memberships.tier} = 'premium'
            and (${memberships.expiresAt} is null or ${memberships.expiresAt} >= current_date)
        )`,
        trialling: sql<number>`count(*) filter (
          where ${memberships.tier} = 'trial'
            and (${memberships.expiresAt} is null or ${memberships.expiresAt} >= current_date)
        )`,
      })
      .from(memberships)
      .where(eq(memberships.siteId, brand.id)),

    database
      .select({
        market: locations.title,
        price: prices.price,
        currency: prices.currency,
        price_date: prices.priceDate,
      })
      .from(prices)
      .innerJoin(locations, eq(locations.id, prices.locationId))
      .where(and(eq(prices.siteId, brand.id), isNull(prices.deletedAt)))
      .orderBy(desc(prices.priceDate), desc(prices.id))
      .limit(8),
  ]);

  const latest = priceTotal[0]?.latest ?? null;
  const midnight = new Date(now);

  midnight.setHours(0, 0, 0, 0);

  const days = latest
    ? Math.floor((midnight.getTime() - new Date(`${latest}T00:00:00`).getTime()) / 86_400_000)
    : null;

  return {
    brand,
    markets: Number(marketRows[0]?.live ?? 0),
    all_markets: Number(marketRows[0]?.all ?? 0),
    prices: Number(priceTotal[0]?.n ?? 0),
    latest_price_date: latest,
    days_since_update: days,
    freshness: freshnessFor(brand.cadence, days),
    readers: Number(standings[0]?.readers ?? 0),
    paying: Number(standings[0]?.paying ?? 0),
    trialling: Number(standings[0]?.trialling ?? 0),
    recent,
  };
}
