/**
 * The AI market-insights page.
 *
 * These notes are written by the price module, which builds its prompt from
 * movements only — never from the figures themselves. That is why this page
 * is readable by everyone while the trends table is not: the prose genuinely
 * contains nothing that was paid for, and putting it behind the paywall would
 * remove the one thing that persuades a visitor the subscription is worth
 * having. If the module's prompt ever starts quoting figures, this decision
 * has to be revisited, which is why it is written down here.
 */

import { and, count, desc, eq, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { priceSummaries } from "@/db/schema";

export type Insight = {
  id: number;
  summary: string;
  source: string;
  created_at: string;
};

export type InsightPage = {
  latest: Insight | null;
  archive: Insight[];
  total: number;
};

const shape = (row: typeof priceSummaries.$inferSelect): Insight => ({
  id: row.id,
  summary: row.summary,
  source: row.source,
  created_at: row.createdAt.toISOString(),
});

export async function insightsFor(
  siteId: number,
  options: { limit?: number; offset?: number; search?: string } = {},
  database: Database = db(),
): Promise<InsightPage> {
  const where = and(
    eq(priceSummaries.siteId, siteId),
    options.search ? sql`${priceSummaries.summary} ilike ${`%${options.search}%`}` : undefined,
  );

  const [counted] = await database.select({ n: count() }).from(priceSummaries).where(where);

  const rows = await database
    .select()
    .from(priceSummaries)
    .where(where)
    .orderBy(desc(priceSummaries.createdAt), desc(priceSummaries.id))
    .limit(Math.min(100, Math.max(1, options.limit ?? 20)))
    .offset(Math.max(0, options.offset ?? 0));

  const archive = rows.map(shape);

  // A brand with no note yet is the normal state of a site that has just been
  // set up, and of any brand between editorial runs. It answers with nulls
  // rather than an error — the old sites fell back to "the last committed
  // batch" here, and the page must never be blank-with-a-stack-trace.
  return { latest: archive[0] ?? null, archive, total: counted?.n ?? 0 };
}
