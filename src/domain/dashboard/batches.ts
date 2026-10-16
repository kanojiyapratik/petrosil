/**
 * Price batches, read from the team's side.
 *
 * The compat API shows the module one brand's batches in the shape its
 * console expects. This shows a human every brand's at once, with the names
 * attached — who staged it, who committed it, which locations it touched —
 * so "what changed last Friday, and who did it" is one screen rather than
 * nine admin panels and a guess.
 */

import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  locations,
  priceBatchItems,
  priceBatches,
  sites,
  users,
  type BatchSource,
  type BatchStatus,
} from "@/db/schema";

export type BatchRow = {
  id: number;
  site: string;
  site_name: string;
  source: BatchSource;
  status: BatchStatus;
  items: number;
  needs_attention: number;
  created_at: string;
  created_by: string | null;
  committed_at: string | null;
  committed_by: string | null;
};

export type BatchQuery = {
  site?: string;
  status?: BatchStatus;
  source?: BatchSource;
  page?: number;
  perPage?: number;
};

const PER_PAGE = 25;

export async function listBatches(
  siteIds: number[],
  query: BatchQuery = {},
  database: Database = db(),
): Promise<{ rows: BatchRow[]; total: number; page: number; per_page: number }> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.trunc(query.perPage ?? PER_PAGE)));

  let scope = siteIds;

  if (query.site) {
    const [site] = await database.select().from(sites).where(eq(sites.slug, query.site)).limit(1);

    if (!site || (siteIds.length > 0 && !siteIds.includes(site.id))) {
      return { rows: [], total: 0, page, per_page: perPage };
    }

    scope = [site.id];
  }

  const where = and(
    scope.length > 0 ? inArray(priceBatches.siteId, scope) : undefined,
    query.status ? eq(priceBatches.status, query.status) : undefined,
    query.source ? eq(priceBatches.source, query.source) : undefined,
  );

  const staged = database.$with("staged").as(
    database
      .select({
        batchId: priceBatchItems.batchId,
        items: count().as("items"),
        // What an editor still has to deal with before this can be published.
        needsAttention: sql<number>`cast(count(*) filter (
          where ${priceBatchItems.isIncluded}
            and ${priceBatchItems.status} in ('ambiguous', 'unmatched', 'invalid')
        ) as int)`.as("needs_attention"),
      })
      .from(priceBatchItems)
      .groupBy(priceBatchItems.batchId),
  );

  const author = database.$with("author").as(
    database.select({ id: users.id, name: users.name }).from(users),
  );

  const [totals] = await database.select({ n: count() }).from(priceBatches).where(where);

  const rows = await database
    .with(staged, author)
    .select({
      batch: priceBatches,
      slug: sites.slug,
      siteName: sites.name,
      items: staged.items,
      needsAttention: staged.needsAttention,
      createdBy: sql<string | null>`creator.name`,
      committedBy: sql<string | null>`committer.name`,
    })
    .from(priceBatches)
    .innerJoin(sites, eq(sites.id, priceBatches.siteId))
    .leftJoin(staged, eq(staged.batchId, priceBatches.id))
    .leftJoin(sql`${author} as creator`, sql`creator.id = ${priceBatches.createdBy}`)
    .leftJoin(sql`${author} as committer`, sql`committer.id = ${priceBatches.committedBy}`)
    .where(where)
    .orderBy(desc(priceBatches.id))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return {
    rows: rows.map((row) => ({
      id: row.batch.id,
      site: row.slug,
      site_name: row.siteName,
      source: row.batch.source,
      status: row.batch.status,
      items: row.items ?? 0,
      needs_attention: row.needsAttention ?? 0,
      created_at: row.batch.createdAt.toISOString(),
      created_by: row.createdBy,
      committed_at: row.batch.committedAt ? row.batch.committedAt.toISOString() : null,
      committed_by: row.committedBy,
    })),
    total: totals?.n ?? 0,
    page,
    per_page: perPage,
  };
}

export type BatchDetail = BatchRow & {
  rows: {
    id: number;
    location: string | null;
    raw_location: string;
    price_date: string;
    old_price: number | null;
    new_price: number;
    currency: string | null;
    status: string;
    is_included: boolean;
    error_message: string | null;
  }[];
};

export async function batchDetail(
  siteIds: number[],
  batchId: number,
  database: Database = db(),
): Promise<BatchDetail | null> {
  const [found] = await database
    .select({ batch: priceBatches, slug: sites.slug })
    .from(priceBatches)
    .innerJoin(sites, eq(sites.id, priceBatches.siteId))
    .where(eq(priceBatches.id, batchId))
    .limit(1);

  if (!found || (siteIds.length > 0 && !siteIds.includes(found.batch.siteId))) {
    return null;
  }

  const [summary] = (await listBatches(siteIds, { site: found.slug, perPage: 100 }, database)).rows.filter(
    (row) => row.id === batchId,
  );

  if (!summary) {
    return null;
  }

  const items = await database
    .select({ item: priceBatchItems, title: locations.title })
    .from(priceBatchItems)
    .leftJoin(locations, eq(locations.id, priceBatchItems.locationId))
    .where(eq(priceBatchItems.batchId, batchId))
    .orderBy(asc(priceBatchItems.id));

  return {
    ...summary,
    rows: items.map(({ item, title }) => ({
      id: item.id,
      location: title,
      raw_location: item.rawLocation,
      price_date: item.priceDate,
      old_price: item.oldPrice === null ? null : Number(item.oldPrice),
      new_price: Number(item.newPrice),
      currency: item.currency,
      status: item.status,
      is_included: item.isIncluded,
      error_message: item.errorMessage,
    })),
  };
}
