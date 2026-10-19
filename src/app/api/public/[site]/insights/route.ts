/**
 * GET /api/public/{site}/insights — the AI market note and its archive.
 *
 * Open to everyone on purpose; see domain/public/insights.ts for why.
 */
import { NextResponse } from "next/server";

import { intParam, publicApi } from "@/lib/public/route";
import { insightsFor } from "@/domain/public/insights";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, url }) => {
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const page = await insightsFor(brand.id, {
    limit: intParam(url, "limit", 20, 100),
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
  });

  return NextResponse.json({
    site: { slug: brand.slug, name: brand.name },
    ...page,
  });
});
