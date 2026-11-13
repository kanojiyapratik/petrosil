/**
 * POST /api/compat/{site}/trade-feeds/results — one trade pass's findings.
 *
 * Each month the engine read is staged for review; a feed set to publish on
 * its own is published when every partner matched, and its market insight
 * is asked for once the response has gone.
 */
import { NextResponse, after } from "next/server";

import { compat, jsonBody, unprocessable } from "@/lib/compat/route";
import { recordFeedResults, writeInsight } from "@/domain/trade/feeds";

export const dynamic = "force-dynamic";

const MAX_RESULTS = 200;

export const POST = compat(async ({ request, caller }) => {
  const body = await jsonBody(request);
  const results = body.results;

  if (!Array.isArray(results) || results.length === 0) {
    return unprocessable("Send at least one result.", "results");
  }

  if (results.length > MAX_RESULTS) {
    return unprocessable(`A pass may report at most ${MAX_RESULTS} results.`, "results");
  }

  const siteId = caller.site.id;
  const outcomes = await recordFeedResults(siteId, results);
  const published = outcomes.filter((o) => o.status === "published").map((o) => Number(o.update_id));

  if (published.length) {
    after(async () => {
      for (const id of published) {
        await writeInsight(siteId, id, "engine").catch((error) => console.error("trade insight failed", { id, error }));
      }
    });
  }

  return NextResponse.json({ data: outcomes }, { status: 201 });
});
