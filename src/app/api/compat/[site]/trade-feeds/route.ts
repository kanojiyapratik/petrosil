/**
 * GET /api/compat/{site}/trade-feeds
 *
 * The brand's enabled trade feeds, each with the months its sheet is
 * missing: what the engine's trade pass fetches from the government sources.
 */
import { NextResponse } from "next/server";

import { compat } from "@/lib/compat/route";
import { feedsDue } from "@/domain/trade/feeds";

export const dynamic = "force-dynamic";

export const GET = compat(async ({ caller }) => {
  return NextResponse.json({ feeds: await feedsDue(caller.site.id) });
});
