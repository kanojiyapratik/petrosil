/**
 * The brands the rail draws, and nothing more.
 *
 * The admin's left rail shows one entry per brand with a dot for whether that
 * brand's prices are current. `estateOverview` can answer that, but it counts
 * locations, prices, memberships, batches and weekly commits to do it — far
 * too much work to repeat on every admin screen, which is where the rail
 * renders.
 *
 * So: two cheap queries, and the same freshness rule the dashboard uses,
 * imported rather than restated. A rail that said baseoil was fine while the
 * dashboard called it overdue would be worse than either being wrong.
 */

import { and, asc, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { prices, sites } from "@/db/schema";
import { freshnessFor } from "./overview";
import type { NavBrand } from "@/app/(admin)/nav";

/** Empty `siteIds` means superadmin: every brand. */
export async function railBrands(
  siteIds: number[],
  database: Database = db(),
  now: Date = new Date(),
): Promise<NavBrand[]> {
  const brands = await database
    .select({ id: sites.id, slug: sites.slug, name: sites.name, cadence: sites.priceCadence })
    .from(sites)
    .where(siteIds.length > 0 ? inArray(sites.id, siteIds) : undefined)
    .orderBy(asc(sites.slug));

  if (brands.length === 0) {
    return [];
  }

  const latest = await database
    .select({ siteId: prices.siteId, latest: sql<string>`max(${prices.priceDate})` })
    .from(prices)
    .where(
      and(
        inArray(
          prices.siteId,
          brands.map((brand) => brand.id),
        ),
        isNull(prices.deletedAt),
      ),
    )
    .groupBy(prices.siteId);

  const byBrand = new Map(latest.map((row) => [row.siteId, row.latest]));
  const midnight = new Date(now);

  midnight.setHours(0, 0, 0, 0);

  return brands.map((brand) => {
    const newest = byBrand.get(brand.id) ?? null;
    // A brand with no prices at all reads as "none", not as overdue: there is
    // nothing late, there is nothing.
    const days = newest
      ? Math.floor((midnight.getTime() - new Date(`${newest}T00:00:00`).getTime()) / 86_400_000)
      : null;

    return {
      slug: brand.slug,
      name: brand.name,
      freshness: freshnessFor(brand.cadence, days),
    };
  });
}
