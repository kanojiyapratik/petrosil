/**
 * GET  /api/compat/{site}/price-crawl/urls — the watch list the console shows,
 *      stopped entries included.
 * PUT  /api/compat/{site}/price-crawl/urls — replace it.
 */
import { NextResponse } from "next/server";

import { compat, jsonBody } from "@/lib/compat/route";
import {
  InvalidUrls,
  crawlSettings,
  replaceWatchedUrls,
  statusLabel,
  watchedUrls,
} from "@/domain/crawl/urls";

export const dynamic = "force-dynamic";

export const GET = compat(async ({ caller }) => {
  const [settings, urls] = await Promise.all([
    crawlSettings(caller.site.id),
    watchedUrls(caller.site.id),
  ]);

  return NextResponse.json({
    interval_minutes: settings.intervalMinutes,
    instructions: settings.instructions,
    data: urls.map((url) => ({
      id: url.id,
      url: url.url,
      label: url.label,
      enabled: url.enabled,
      last_status: url.lastStatus,
      last_status_text: statusLabel(url.lastStatus),
      last_error: url.lastError,
      last_notes: url.lastNotes,
      last_row_count: url.lastRowCount,
      last_checked_at: url.lastCheckedAt ? url.lastCheckedAt.toISOString() : null,
      last_changed_at: url.lastChangedAt ? url.lastChangedAt.toISOString() : null,
    })),
  });
});

export const PUT = compat(async ({ request, caller }) => {
  const body = await jsonBody(request);

  if (body.urls === undefined && body.text === undefined) {
    return NextResponse.json(
      { message: "Send the list as `text` or as `urls`." },
      { status: 422 },
    );
  }

  try {
    return NextResponse.json(await replaceWatchedUrls(caller.site.id, body));
  } catch (error) {
    if (error instanceof InvalidUrls) {
      // Nothing was saved: a half-applied watch list is worse than none.
      return NextResponse.json({ message: error.message, invalid: error.invalid }, { status: 422 });
    }

    throw error;
  }
});
