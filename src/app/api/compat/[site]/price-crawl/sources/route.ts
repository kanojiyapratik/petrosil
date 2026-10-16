/**
 * GET /api/compat/{site}/price-crawl/sources
 *
 * Everything the crawler needs to start a pass, in one call: the URLs to
 * check, the validators and hash from last time so most checks can end in a
 * 304, and the location names the model should look for.
 */
import { NextResponse } from "next/server";

import { compat } from "@/lib/compat/route";
import { crawlSettings, watchedUrls } from "@/domain/crawl/urls";
import { trackedLocations } from "@/domain/crawl/recorder";

export const dynamic = "force-dynamic";

export const GET = compat(async ({ caller }) => {
  const siteId = caller.site.id;
  const [settings, urls, locations] = await Promise.all([
    crawlSettings(siteId),
    watchedUrls(siteId, true),
    trackedLocations(siteId),
  ]);

  return NextResponse.json({
    interval_minutes: settings.intervalMinutes,
    instructions: settings.instructions,
    locations,
    urls: urls.map((url) => ({
      id: url.id,
      url: url.url,
      label: url.label,
      etag: url.etag,
      last_modified: url.lastModified,
      content_hash: url.contentHash,
    })),
  });
});
