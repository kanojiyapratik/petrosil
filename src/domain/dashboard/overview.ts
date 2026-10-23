/**
 * The estate overview: one answer to "how are we doing?", across every brand
 * the viewer is allowed to see.
 *
 * Today this takes opening up to nine admin panels. The figures here are
 * counted in the database rather than fetched from nine sites, which is the
 * whole point of one schema with a tenant column.
 */

import { and, count, countDistinct, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  locations,
  memberships,
  priceBatches,
  prices,
  sites,
  users,
} from "@/db/schema";

export type SiteCard = {
  id: number;
  slug: string;
  name: string;
  legacy_domain: string | null;
  cadence: string | null;
  enabled: boolean;
  locations: number;
  live_locations: number;
  latest_pricedate: string | null;
  days_since_update: number | null;
  freshness: "fresh" | "due" | "stale" | "none";
  users: number;
  premium: number;
  committed_batches: number;
};

export type Overview = {
  totals: {
    sites: number;
    users: number;
    premium: number;
    trial: number;
    expired: number;
    locations: number;
    live_locations: number;
    prices: number;
    committed_batches_30d: number;
  };
  sites: SiteCard[];
  weekly_updates: { week: string; commits: number }[];
};

/**
 * How long a brand may go without an update before the card goes amber.
 *
 * Exported because the rail draws the same judgement as a dot beside each
 * brand. Two places disagreeing about whether baseoil is overdue would be
 * worse than either of them being wrong.
 */
export function freshnessFor(cadence: string | null, days: number | null): SiteCard["freshness"] {
  if (days === null) {
    return "none";
  }

  // Judged against each brand's own rhythm, not one estate-wide number:
  // baseoil publishes weekly, bitumart on the 1st and the 16th.
  const due = cadence && /fortnight|1st|16th/i.test(cadence) ? 16 : 8;

  if (days <= due) {
    return "fresh";
  }

  return days <= due * 2 ? "due" : "stale";
}

export async function estateOverview(
  siteIds: number[],
  database: Database = db(),
  now: Date = new Date(),
): Promise<Overview> {
  // An empty list means superadmin — every brand. A guard that produced an
  // empty list for a staff member would be a hole, so the caller is required
  // to have refused that case before reaching here.
  const scope = siteIds.length > 0 ? inArray(sites.id, siteIds) : undefined;
  const brands = await database.select().from(sites).where(scope).orderBy(sites.slug);

  if (brands.length === 0) {
    return {
      totals: {
        sites: 0,
        users: 0,
        premium: 0,
        trial: 0,
        expired: 0,
        locations: 0,
        live_locations: 0,
        prices: 0,
        committed_batches_30d: 0,
      },
      sites: [],
      weekly_updates: [],
    };
  }

  const ids = brands.map((brand) => brand.id);
  const today = startOfDay(now);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [locationRows, priceRows, memberRows, batchRows, weekRows, priceTotal, peopleTotal] =
    await Promise.all([
      database
        .select({
          siteId: locations.siteId,
          total: count(),
          live: sql<number>`cast(count(*) filter (where ${locations.visible}) as int)`,
        })
        .from(locations)
        .where(and(inArray(locations.siteId, ids), isNull(locations.deletedAt)))
        .groupBy(locations.siteId),

      database
        .select({ siteId: prices.siteId, latest: sql<string>`max(${prices.priceDate})` })
        .from(prices)
        .where(and(inArray(prices.siteId, ids), isNull(prices.deletedAt)))
        .groupBy(prices.siteId),

      // Counted with expiry in mind, not by tier alone. A membership whose
      // `expires_at` has passed is lapsed however it is labelled — the client
      // list reads it that way, and two screens disagreeing about who is
      // paying would be worse than either being wrong.
      database
        .select({
          siteId: memberships.siteId,
          readers: sql<number>`cast(count(*) filter (where ${memberships.role} = 'subscriber') as int)`,
          premium: sql<number>`cast(count(*) filter (
            where ${memberships.role} = 'subscriber'
              and ${memberships.tier} = 'premium'
              and (${memberships.expiresAt} is null or ${memberships.expiresAt} >= ${isoDay(now)})
          ) as int)`,
          trial: sql<number>`cast(count(*) filter (
            where ${memberships.role} = 'subscriber'
              and ${memberships.tier} = 'trial'
              and (${memberships.expiresAt} is null or ${memberships.expiresAt} >= ${isoDay(now)})
          ) as int)`,
          expired: sql<number>`cast(count(*) filter (
            where ${memberships.role} = 'subscriber'
              and ${memberships.tier} in ('premium', 'trial')
              and ${memberships.expiresAt} is not null
              and ${memberships.expiresAt} < ${isoDay(now)}
          ) as int)`,
        })
        .from(memberships)
        .where(inArray(memberships.siteId, ids))
        .groupBy(memberships.siteId),

      database
        .select({ siteId: priceBatches.siteId, n: count() })
        .from(priceBatches)
        .where(
          and(
            inArray(priceBatches.siteId, ids),
            eq(priceBatches.status, "committed"),
            gte(priceBatches.committedAt, thirtyDaysAgo),
          ),
        )
        .groupBy(priceBatches.siteId),

      database
        .select({
          week: sql<string>`to_char(date_trunc('week', ${priceBatches.committedAt}), 'YYYY-MM-DD')`,
          commits: count(),
        })
        .from(priceBatches)
        .where(
          and(
            inArray(priceBatches.siteId, ids),
            eq(priceBatches.status, "committed"),
            gte(priceBatches.committedAt, new Date(today.getTime() - 84 * 24 * 60 * 60 * 1000)),
          ),
        )
        .groupBy(sql`date_trunc('week', ${priceBatches.committedAt})`)
        .orderBy(sql`date_trunc('week', ${priceBatches.committedAt})`),

      database
        .select({ n: count() })
        .from(prices)
        .where(and(inArray(prices.siteId, ids), isNull(prices.deletedAt))),

      // One person reading three brands is one person, not three.
      database
        .select({ n: countDistinct(memberships.userId) })
        .from(memberships)
        .where(inArray(memberships.siteId, ids)),
    ]);

  const byLocation = new Map(locationRows.map((row) => [row.siteId, row]));
  const byPrice = new Map(priceRows.map((row) => [row.siteId, row.latest]));
  const byBatch = new Map(batchRows.map((row) => [row.siteId, row.n]));

  const byMembership = new Map(memberRows.map((row) => [row.siteId, row]));
  const tier = (siteId: number, name: "premium" | "trial" | "expired"): number =>
    byMembership.get(siteId)?.[name] ?? 0;
  const readers = (siteId: number): number => byMembership.get(siteId)?.readers ?? 0;

  const cards: SiteCard[] = brands.map((brand) => {
    const latest = byPrice.get(brand.id) ?? null;
    const days = latest ? Math.floor((today.getTime() - new Date(`${latest}T00:00:00`).getTime()) / 86_400_000) : null;

    return {
      id: brand.id,
      slug: brand.slug,
      name: brand.name,
      legacy_domain: brand.legacyDomain,
      cadence: brand.priceCadence,
      enabled: brand.enabled,
      locations: byLocation.get(brand.id)?.total ?? 0,
      live_locations: byLocation.get(brand.id)?.live ?? 0,
      latest_pricedate: latest,
      days_since_update: days,
      freshness: freshnessFor(brand.priceCadence, days),
      users: readers(brand.id),
      premium: tier(brand.id, "premium"),
      committed_batches: byBatch.get(brand.id) ?? 0,
    };
  });

  return {
    totals: {
      sites: cards.length,
      users: peopleTotal[0]?.n ?? 0,
      premium: cards.reduce((total, card) => total + card.premium, 0),
      trial: brands.reduce((total, brand) => total + tier(brand.id, "trial"), 0),
      expired: brands.reduce((total, brand) => total + tier(brand.id, "expired"), 0),
      locations: cards.reduce((total, card) => total + card.locations, 0),
      live_locations: cards.reduce((total, card) => total + card.live_locations, 0),
      prices: priceTotal[0]?.n ?? 0,
      committed_batches_30d: cards.reduce((total, card) => total + card.committed_batches, 0),
    },
    sites: cards,
    weekly_updates: weekRows.map((row) => ({ week: row.week, commits: row.commits })),
  };
}

/** The estate's recent price commits, newest first — the dashboard's activity strip. */
export async function recentBatches(
  siteIds: number[],
  limit = 10,
  database: Database = db(),
) {
  const scope = siteIds.length > 0 ? inArray(priceBatches.siteId, siteIds) : undefined;

  const rows = await database
    .select({
      id: priceBatches.id,
      slug: sites.slug,
      name: sites.name,
      source: priceBatches.source,
      status: priceBatches.status,
      committedAt: priceBatches.committedAt,
      createdAt: priceBatches.createdAt,
      by: users.name,
    })
    .from(priceBatches)
    .innerJoin(sites, eq(sites.id, priceBatches.siteId))
    .leftJoin(users, eq(users.id, priceBatches.committedBy))
    .where(scope)
    .orderBy(desc(priceBatches.id))
    .limit(Math.min(100, Math.max(1, limit)));

  return rows.map((row) => ({
    id: row.id,
    site: row.slug,
    site_name: row.name,
    source: row.source,
    status: row.status,
    committed_at: row.committedAt ? row.committedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    committed_by: row.by,
  }));
}

const isoDay = (value: Date): string =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
