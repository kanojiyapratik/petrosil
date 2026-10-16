/**
 * Turning one crawler report into activity rows and URL state.
 *
 * The crawler is deliberately stupid: it fetches a page, has a model pull
 * `{location, date, price}` out of it, and posts that. Every judgement that
 * needs site data is made here —
 *
 *   - which locations exist (the same resolver the staging path uses, so a
 *     crawled row and a spreadsheet row can never disagree),
 *   - what this page said last time, which is what "changed" is measured
 *     against,
 *   - what this brand currently publishes for the same date, for context.
 *
 * **Nothing here writes a price.** Activity is a record of what a page said;
 * publishing still goes through a staged batch that a human commits.
 */

import { and, desc, eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { priceCrawlActivities, priceCrawlUrls } from "@/db/schema";
import { parseDate, today } from "@/domain/price/dates";
import { LocationResolver, livePrice, type LocationRow } from "@/domain/price/locations";

import { REPORTED_STATUSES, type ReportedStatus, type UrlStatus } from "./urls";

export type CrawlRow = { location?: unknown; date?: unknown; price?: unknown };

export type CrawlResult = {
  url_id?: unknown;
  status?: unknown;
  content_hash?: unknown;
  etag?: unknown;
  last_modified?: unknown;
  error?: unknown;
  notes?: unknown;
  rows?: unknown;
};

export type RecordOutcome = {
  status: UrlStatus;
  rows: number;
  activities: number;
  unmatched: number;
};

type ResolvedRow = {
  location: LocationRow | null;
  name: string;
  date: string;
  price: number;
};

export function isReportedStatus(value: unknown): value is ReportedStatus {
  return typeof value === "string" && (REPORTED_STATUSES as readonly string[]).includes(value);
}

/**
 * Records one URL's result.
 *
 * @param now injectable so "today" in a dateless row is testable.
 */
export async function recordResult(
  siteId: number,
  url: typeof priceCrawlUrls.$inferSelect,
  result: CrawlResult,
  resolver: LocationResolver,
  database: Database = db(),
  now: Date = new Date(),
): Promise<RecordOutcome> {
  const status = isReportedStatus(result.status) ? result.status : "failed";

  // A page that could not be read stores no content hash. Storing one would
  // mark the page "seen", and every later check would call it unchanged and
  // skip it — silently, for as long as nobody looked.
  if (status !== "read") {
    await updateState(database, url, status, result, null, 0, false, now);

    return { status, rows: 0, activities: 0, unmatched: 0 };
  }

  const rawRows = Array.isArray(result.rows) ? (result.rows as CrawlRow[]) : [];
  const { rows, unmatched } = resolveRows(rawRows, resolver, now);
  const activities = await activitiesFor(siteId, url, rows, database, now);

  if (activities.length > 0) {
    await database.insert(priceCrawlActivities).values(activities);
  }

  const finalStatus: UrlStatus =
    activities.length > 0 ? "updated" : rows.length > 0 ? "no_change" : "no_rows";

  await updateState(
    database,
    url,
    finalStatus,
    result,
    typeof result.content_hash === "string" ? result.content_hash : null,
    rows.length,
    activities.length > 0,
    now,
  );

  return { status: finalStatus, rows: rows.length, activities: activities.length, unmatched };
}

function resolveRows(
  rows: CrawlRow[],
  resolver: LocationResolver,
  now: Date,
): { rows: ResolvedRow[]; unmatched: number } {
  const resolved = new Map<string, ResolvedRow>();
  let unmatched = 0;

  for (const row of rows) {
    const price = toPrice(row.price);
    const rawName = typeof row.location === "string" ? row.location : String(row.location ?? "");

    // Rejected, never clamped: an unreadable price is a problem with the
    // page, and turning it into 0 would record a wrong one.
    if (price === null || price < 0 || rawName.trim() === "") {
      unmatched += 1;
      continue;
    }

    const date =
      row.date === undefined || row.date === null || row.date === ""
        ? today(now)
        : parseDate(row.date);

    if (date === null) {
      unmatched += 1;
      continue;
    }

    // A label this brand does not recognise is still recorded, under the
    // page's own wording, with no location attached. Throwing it away made a
    // page quoting "China 445" report nothing at all and look broken. Only a
    // row that resolved to a real location can be staged, so nothing
    // unmatched can reach a published price by accident.
    const match = resolver.resolve(rawName);
    const location = match.status === "matched" ? match.location : null;

    if (location === null) {
      unmatched += 1;
    }

    const key = `${location ? `id:${location.id}` : `raw:${rawName.trim().toLowerCase()}`}|${date}`;

    // One row per location per date; the first wins, as everywhere else.
    if (resolved.has(key)) {
      continue;
    }

    resolved.set(key, { location, name: location ? location.title : rawName.trim(), date, price });
  }

  return { rows: [...resolved.values()], unmatched };
}

/**
 * Only movement becomes an activity row. The crawler checks every fifteen
 * minutes; recording a price that has not moved would bury the real changes
 * in a table nobody could read.
 */
async function activitiesFor(
  siteId: number,
  url: typeof priceCrawlUrls.$inferSelect,
  rows: ResolvedRow[],
  database: Database,
  now: Date,
): Promise<(typeof priceCrawlActivities.$inferInsert)[]> {
  if (rows.length === 0) {
    return [];
  }

  const previous = await lastSeenPrices(url.id, database);
  const activities: (typeof priceCrawlActivities.$inferInsert)[] = [];

  for (const row of rows) {
    const key = row.location ? `id:${row.location.id}` : `raw:${row.name.toLowerCase()}`;
    const last = previous.get(key) ?? null;

    if (last !== null && Math.abs(last - row.price) < 0.00001) {
      continue;
    }

    const sitePrice = row.location
      ? await livePrice(row.location.id, row.date, database)
      : null;

    activities.push({
      siteId,
      urlId: url.id,
      locationId: row.location?.id ?? null,
      location: row.name,
      priceDate: row.date,
      price: String(row.price),
      previousPrice: last === null ? null : String(last),
      sitePrice: sitePrice ? sitePrice.price : null,
      changeType: last === null ? "new" : "changed",
      changePct: changePct(last, row.price),
      differsFromSite: sitePrice === null || !within(Number(sitePrice.price), row.price),
      detectedAt: now,
    });
  }

  return activities;
}

/**
 * The most recent price this URL was seen quoting, per location — keyed by
 * location id where the label resolved, and by the label itself where it did
 * not, so an unrecognised name still has a history and does not look new on
 * every single check.
 */
async function lastSeenPrices(urlId: number, database: Database): Promise<Map<string, number>> {
  const rows = await database
    .select({
      locationId: priceCrawlActivities.locationId,
      location: priceCrawlActivities.location,
      price: priceCrawlActivities.price,
    })
    .from(priceCrawlActivities)
    .where(eq(priceCrawlActivities.urlId, urlId))
    .orderBy(desc(priceCrawlActivities.id));

  const seen = new Map<string, number>();

  for (const row of rows) {
    const key = row.locationId === null ? `raw:${row.location.toLowerCase()}` : `id:${row.locationId}`;

    if (!seen.has(key) && row.price !== null) {
      seen.set(key, Number(row.price));
    }
  }

  return seen;
}

async function updateState(
  database: Database,
  url: typeof priceCrawlUrls.$inferSelect,
  status: UrlStatus,
  result: CrawlResult,
  contentHash: string | null,
  rowCount: number,
  changed: boolean,
  now: Date,
): Promise<void> {
  const values: Partial<typeof priceCrawlUrls.$inferInsert> = {
    lastStatus: status,
    lastError: clip(result.error),
    lastNotes: clip(result.notes),
    lastRowCount: rowCount,
    lastCheckedAt: now,
    updatedAt: now,
  };

  if (contentHash) {
    values.contentHash = contentHash;
  }

  // A 304 carries no fresh validators, so only overwrite what was sent.
  if (typeof result.etag === "string" && result.etag !== "") {
    values.etag = result.etag;
  }

  if (typeof result.last_modified === "string" && result.last_modified !== "") {
    values.lastModified = result.last_modified;
  }

  if (changed) {
    values.lastChangedAt = now;
  }

  await database.update(priceCrawlUrls).set(values).where(eq(priceCrawlUrls.id, url.id));
}

function clip(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value).slice(0, 2000);
}

function changePct(previous: number | null, price: number): string | null {
  if (previous === null || previous === 0) {
    return null;
  }

  return (Math.round(((price - previous) / previous) * 100 * 100) / 100).toFixed(2);
}

const within = (a: number, b: number): boolean => Math.abs(a - b) < 0.00001;

/**
 * JSON can carry `""`, `null` or `true` where a price should be, and all of
 * them must stay out rather than becoming 0. Thousands separators are the one
 * thing worth forgiving — pages print "1,520".
 */
function toPrice(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const text = value.replace(/,/g, "").trim();

  if (text === "" || Number.isNaN(Number(text))) {
    return null;
  }

  return Number(text);
}

/** Only live, unambiguous titles are offered — a retired or doubled name would come back unmatched. */
export async function trackedLocations(
  siteId: number,
  database: Database = db(),
): Promise<string[]> {
  const resolver = await LocationResolver.forSite(siteId, database);

  return resolver
    .titles()
    .filter((title) => resolver.resolve(title).status === "matched");
}

export async function urlOnSite(
  siteId: number,
  urlId: number,
  database: Database = db(),
): Promise<typeof priceCrawlUrls.$inferSelect | null> {
  const [row] = await database
    .select()
    .from(priceCrawlUrls)
    .where(and(eq(priceCrawlUrls.id, urlId), eq(priceCrawlUrls.siteId, siteId)))
    .limit(1);

  return row ?? null;
}
