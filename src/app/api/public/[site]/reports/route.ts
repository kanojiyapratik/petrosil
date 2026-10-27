/**
 * GET /api/public/{site}/reports — the reports a reader may see listed.
 *
 * Takes `type` (report, sample …), `q`, `limit` and `offset`. Each carries
 * whether it is for subscribers; the PDF's address is never in a list.
 */
import { NextResponse } from "next/server";

import { intParam, publicApi } from "@/lib/public/route";
import { publishedReports } from "@/domain/public/reports";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, url, entitlement }) => {
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const page = await publishedReports(brand.id, {
    type: (url.searchParams.get("type") ?? "").trim() || undefined,
    search: (url.searchParams.get("q") ?? "").trim() || undefined,
    limit: intParam(url, "limit", 20, 100),
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
  });

  return NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, ...page });
});
