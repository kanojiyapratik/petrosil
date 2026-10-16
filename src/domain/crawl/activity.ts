/**
 * What the watched pages have said lately, and turning a selection of it into
 * an ordinary draft batch.
 *
 * The crawler never publishes. Its findings become a normal batch that goes
 * through the same preview, the same statuses and the same manual commit as
 * an uploaded spreadsheet — which is the whole reason a crawled price can
 * never reach a brand site unreviewed.
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import { db, type Database } from "@/db";
import { priceCrawlActivities, priceCrawlUrls } from "@/db/schema";
import { stageRows, type Batch } from "@/domain/price/batches";

export const MAX_ACTIVITY = 200;
export const DEFAULT_ACTIVITY = 50;

export type ActivityJson = {
  id: number;
  url_id: number | null;
  url: string | null;
  location_id: number | null;
  location: string;
  price_date: string | null;
  price: number;
  previous_price: number | null;
  site_price: number | null;
  change_type: string | null;
  change_pct: number | null;
  differs_from_site: boolean;
  detected_at: string | null;
};

export async function recentActivity(
  siteId: number,
  limit = DEFAULT_ACTIVITY,
  database: Database = db(),
): Promise<ActivityJson[]> {
  const capped = Math.min(MAX_ACTIVITY, Math.max(1, Math.trunc(limit) || DEFAULT_ACTIVITY));

  const rows = await database
    .select({ activity: priceCrawlActivities, url: priceCrawlUrls.url })
    .from(priceCrawlActivities)
    .leftJoin(priceCrawlUrls, eq(priceCrawlUrls.id, priceCrawlActivities.urlId))
    .where(eq(priceCrawlActivities.siteId, siteId))
    .orderBy(desc(priceCrawlActivities.detectedAt), desc(priceCrawlActivities.id))
    .limit(capped);

  return rows.map(({ activity, url }) => ({
    id: activity.id,
    url_id: activity.urlId,
    url: url ?? null,
    location_id: activity.locationId,
    location: activity.location,
    price_date: activity.priceDate,
    price: Number(activity.price),
    previous_price: activity.previousPrice === null ? null : Number(activity.previousPrice),
    site_price: activity.sitePrice === null ? null : Number(activity.sitePrice),
    change_type: activity.changeType,
    change_pct: activity.changePct === null ? null : Number(activity.changePct),
    differs_from_site: activity.differsFromSite,
    detected_at: activity.detectedAt ? activity.detectedAt.toISOString() : null,
  }));
}

export class NothingToStage extends Error {
  constructor(
    message: string,
    readonly skipped: number,
  ) {
    super(message);
  }
}

export type StageOutcome = { batch: Batch; rows: number; skipped: number };

/**
 * Stage the chosen findings as a `crawl` batch.
 *
 * A finding whose label this brand does not recognise is recorded for reading
 * but cannot be staged: it would only ever land in the batch screen as
 * `unmatched` and could never be committed, so it is skipped and counted.
 */
export async function stageActivities(
  siteId: number,
  activityIds: number[],
  database: Database = db(),
  now: Date = new Date(),
): Promise<StageOutcome> {
  const ids = activityIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);

  const found =
    ids.length === 0
      ? []
      : await database
          .select()
          .from(priceCrawlActivities)
          .where(
            and(eq(priceCrawlActivities.siteId, siteId), inArray(priceCrawlActivities.id, ids)),
          )
          .orderBy(priceCrawlActivities.id);

  if (found.length === 0) {
    throw new NothingToStage("Those findings no longer exist.", 0);
  }

  const rows = found
    .filter((row) => row.locationId !== null)
    .map((row) => ({ location: row.location, date: row.priceDate, price: row.price }));

  const skipped = found.length - rows.length;

  if (rows.length === 0) {
    throw new NothingToStage(
      "None of those findings match a location on this site, so there is nothing to stage.",
      skipped,
    );
  }

  const { batch } = await stageRows({ siteId, rows, source: "crawl", now }, database);

  // Which batch a finding went into, so the console can stop offering it twice.
  await database
    .update(priceCrawlActivities)
    .set({ stagedBatchId: batch.id })
    .where(
      and(
        eq(priceCrawlActivities.siteId, siteId),
        inArray(
          priceCrawlActivities.id,
          found.filter((row) => row.locationId !== null).map((row) => row.id),
        ),
      ),
    );

  return { batch, rows: rows.length, skipped };
}

/**
 * Forget what the watched pages have said so far.
 *
 * Findings pile up from diagnostic runs and from sources that turned out to
 * publish something other than prices. Nothing here touches a price. The
 * URLs' content hashes go too, so the next check reads every page again
 * rather than calling them unchanged against a history that no longer exists.
 */
export async function clearActivity(
  siteId: number,
  database: Database = db(),
): Promise<{ removed: number }> {
  const removed = await database
    .delete(priceCrawlActivities)
    .where(eq(priceCrawlActivities.siteId, siteId))
    .returning({ id: priceCrawlActivities.id });

  await database
    .update(priceCrawlUrls)
    .set({ contentHash: null, lastRowCount: 0, updatedAt: new Date() })
    .where(eq(priceCrawlUrls.siteId, siteId));

  return { removed: removed.length };
}
