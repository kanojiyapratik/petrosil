/**
 * The watch list: which pages the crawler checks for this brand.
 *
 * The crawler itself lives in the price module and holds no database
 * credentials. It asks this list what to fetch and posts back what it read,
 * which is what lets one deployed crawler serve every brand.
 */

import { and, asc, eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { priceCrawlUrls, siteCrawlSettings } from "@/db/schema";

export const DEFAULT_INTERVAL_MINUTES = 15;

/** What the crawler may report about a page. */
export const REPORTED_STATUSES = [
  "read",
  "unchanged",
  "gone",
  "no_rows",
  "disallowed",
  "blocked",
  "failed",
] as const;

/** What this side records, which adds the two outcomes only it can judge. */
export const URL_STATUSES = [
  ...REPORTED_STATUSES,
  "updated",
  "no_change",
] as const;

export type ReportedStatus = (typeof REPORTED_STATUSES)[number];
export type UrlStatus = (typeof URL_STATUSES)[number];

/** The same wording the console shows today, so nothing reads differently. */
const LABELS: Record<string, string> = {
  updated: "Price change found",
  no_change: "Read, nothing moved",
  unchanged: "No change on the page",
  no_rows: "No prices found on the page",
  disallowed: "Blocked by the site's robots.txt",
  blocked: "The site refused the request",
  gone: "The URL looks dead",
  failed: "Could not be read",
};

export function statusLabel(status: string | null): string {
  return (status && LABELS[status]) || "Not checked yet";
}

export type CrawlSettings = { intervalMinutes: number; instructions: string | null };

export async function crawlSettings(
  siteId: number,
  database: Database = db(),
): Promise<CrawlSettings> {
  const [row] = await database
    .select()
    .from(siteCrawlSettings)
    .where(eq(siteCrawlSettings.siteId, siteId))
    .limit(1);

  return {
    intervalMinutes: row?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    instructions: row?.instructions?.trim() ? row.instructions : null,
  };
}

export async function watchedUrls(
  siteId: number,
  onlyEnabled = false,
  database: Database = db(),
) {
  const where = onlyEnabled
    ? and(eq(priceCrawlUrls.siteId, siteId), eq(priceCrawlUrls.enabled, true))
    : eq(priceCrawlUrls.siteId, siteId);

  return database.select().from(priceCrawlUrls).where(where).orderBy(asc(priceCrawlUrls.id));
}

export type ReplaceResult = {
  watched: number;
  added: number;
  reenabled: number;
  stopped: number;
};

export class InvalidUrls extends Error {
  constructor(readonly invalid: string[]) {
    super("Some entries are not http(s) URLs. Nothing was saved.");
  }
}

/**
 * Replace the watch list from the console's textarea, or from a JSON array —
 * the console sends either.
 *
 * A URL that disappears from the list is **disabled, not deleted**: its
 * history is the point of the feature, and a typo must not cascade that away.
 * The scheme check is the gate that keeps `file://` and friends out of a
 * fetcher that will dutifully fetch whatever it is given.
 */
export async function replaceWatchedUrls(
  siteId: number,
  input: { urls?: unknown; text?: unknown; instructions?: unknown },
  database: Database = db(),
): Promise<ReplaceResult> {
  const lines = Array.isArray(input.urls)
    ? input.urls.map((line) => String(line))
    : String(input.text ?? "").split(/\r\n|\r|\n/);

  const wanted: string[] = [];
  const invalid: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();

    if (line === "") {
      continue;
    }

    if (line.length > 191 || !isHttpUrl(line)) {
      invalid.push(line);
      continue;
    }

    if (!wanted.includes(line)) {
      wanted.push(line);
    }
  }

  if (invalid.length > 0) {
    throw new InvalidUrls(invalid);
  }

  const existing = await watchedUrls(siteId, false, database);
  const byUrl = new Map(existing.map((row) => [row.url, row]));
  const result: ReplaceResult = { watched: wanted.length, added: 0, reenabled: 0, stopped: 0 };

  for (const url of wanted) {
    const row = byUrl.get(url);

    if (!row) {
      await database.insert(priceCrawlUrls).values({ siteId, url, enabled: true });
      result.added += 1;
      continue;
    }

    if (!row.enabled) {
      await database
        .update(priceCrawlUrls)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(priceCrawlUrls.id, row.id));
      result.reenabled += 1;
    }
  }

  for (const row of existing) {
    if (row.enabled && !wanted.includes(row.url)) {
      await database
        .update(priceCrawlUrls)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(priceCrawlUrls.id, row.id));
      result.stopped += 1;
    }
  }

  // The AI instructions ride along on the same form. Only touched when the
  // field was sent at all, so an older console cannot clear them by accident;
  // sent blank, they are cleared on purpose.
  if (input.instructions !== undefined) {
    const instructions = String(input.instructions ?? "").trim();

    await database
      .insert(siteCrawlSettings)
      .values({ siteId, instructions: instructions === "" ? null : instructions })
      .onConflictDoUpdate({
        target: siteCrawlSettings.siteId,
        set: { instructions: instructions === "" ? null : instructions, updatedAt: new Date() },
      });
  }

  return result;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}
