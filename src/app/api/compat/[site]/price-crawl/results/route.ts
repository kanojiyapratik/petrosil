/**
 * POST /api/compat/{site}/price-crawl/results — one pass's findings.
 *
 * The whole pass arrives in a single request rather than one call per URL: a
 * pass is a handful of pages, and reporting it atomically means a crawler
 * that dies halfway cannot leave half the list looking checked.
 *
 * An unknown, disabled or foreign URL id is answered `ignored` rather than
 * failing the request — the watch list can be edited while a pass is running.
 */
import { NextResponse } from "next/server";

import { compat, jsonBody, unprocessable } from "@/lib/compat/route";
import { isReportedStatus, recordResult, type CrawlResult } from "@/domain/crawl/recorder";
import { watchedUrls } from "@/domain/crawl/urls";
import { LocationResolver } from "@/domain/price/locations";

export const dynamic = "force-dynamic";

const MAX_RESULTS = 200;

export const POST = compat(async ({ request, caller }) => {
  const body = await jsonBody(request);
  const results = body.results;

  if (!Array.isArray(results) || results.length === 0) {
    return unprocessable("Send at least one result.", "results");
  }

  if (results.length > MAX_RESULTS) {
    return unprocessable(`A pass may report at most ${MAX_RESULTS} URLs.`, "results");
  }

  const siteId = caller.site.id;
  const enabled = new Map((await watchedUrls(siteId, true)).map((url) => [url.id, url]));
  const resolver = await LocationResolver.forSite(siteId);

  const recorded: Record<string, unknown>[] = [];

  for (const entry of results as CrawlResult[]) {
    const urlId = Number(entry?.url_id);
    const url = Number.isInteger(urlId) ? enabled.get(urlId) : undefined;

    if (!url) {
      recorded.push({ url_id: Number.isInteger(urlId) ? urlId : null, status: "ignored" });
      continue;
    }

    if (!isReportedStatus(entry.status)) {
      recorded.push({ url_id: url.id, status: "ignored", error: "unknown status" });
      continue;
    }

    const outcome = await recordResult(siteId, url, entry, resolver);
    recorded.push({ url_id: url.id, ...outcome });
  }

  return NextResponse.json({ data: recorded }, { status: 201 });
});
