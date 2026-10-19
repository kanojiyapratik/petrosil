/**
 * The brand list behind the umbrella's own home page.
 *
 * Nine brands, one engine: that is the pitch the corporate site makes, and it
 * needs the nine to be describable in one request. It carries counts and
 * freshness, never a figure — this endpoint is read by anyone who loads
 * petrosil.com, so there is no entitlement to check and therefore nothing
 * price-shaped allowed in the reply.
 */

import { and, countDistinct, eq, isNull, max } from "drizzle-orm";

import { db, type Database } from "@/db";
import { locations, prices, sites } from "@/db/schema";

export type BrandCard = {
  slug: string;
  name: string;
  theme: Record<string, string>;
  currency: string;
  cadence: string | null;
  locations: number;
  latest_pricedate: string | null;
};

export async function brandCards(database: Database = db()): Promise<BrandCard[]> {
  const rows = await database
    .select({
      site: sites,
      // Distinct: the price join multiplies locations by their history, and
      // without it a brand with 13 weeks of figures claims 26 markets.
      locations: countDistinct(locations.id),
      latest: max(prices.priceDate),
    })
    .from(sites)
    .leftJoin(
      locations,
      and(eq(locations.siteId, sites.id), eq(locations.visible, true), isNull(locations.deletedAt)),
    )
    .leftJoin(prices, and(eq(prices.locationId, locations.id), isNull(prices.deletedAt)))
    .where(eq(sites.enabled, true))
    .groupBy(sites.id)
    .orderBy(sites.slug);

  return rows.map((row) => ({
    slug: row.site.slug,
    name: row.site.name,
    theme: row.site.theme,
    currency: row.site.defaultCurrency,
    cadence: row.site.priceCadence,
    locations: Number(row.locations),
    latest_pricedate: row.latest ?? null,
  }));
}
