/**
 * GET /api/public/{site}/articles — the published list.
 *
 * Takes `category`, `q`, `limit` and `offset`. Carries no bodies: a list does
 * not need one, and the longest pieces in the estate are tens of kilobytes.
 */
import { NextResponse } from "next/server";

import { intParam, publicApi } from "@/lib/public/route";
import { publishedArticles } from "@/domain/content/articles";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, url, entitlement }) => {
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const page = await publishedArticles(brand.id, {
    category: url.searchParams.get("category") ?? undefined,
    search: (url.searchParams.get("q") ?? "").trim() || undefined,
    limit: intParam(url, "limit", 20, 100),
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
  });

  return NextResponse.json({
    site: { slug: brand.slug, name: brand.name },
    entitlement,
    ...page,
  });
});
