/**
 * GET /api/public/{site}/search?q= — markets and market notes on one brand.
 *
 * An empty query answers with nothing rather than with the whole brand: the
 * old sites' `search` route returned every row for a blank term, which is a
 * full table scan anyone could trigger by pressing Enter.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { priceTrends } from "@/domain/public/prices";
import { insightsFor } from "@/domain/public/insights";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement, url }) => {
  const term = (url.searchParams.get("q") ?? "").trim();

  if (term.length === 0) {
    return NextResponse.json({ query: "", locations: [], insights: [] });
  }

  const [trends, notes] = await Promise.all([
    priceTrends(brand.id, entitlement.entitled, { search: term }),
    insightsFor(brand.id, { limit: 10, search: term }),
  ]);

  return NextResponse.json({
    query: term,
    entitlement,
    locations: trends.rows,
    insights: notes.archive,
  });
});
