/**
 * GET /api/public/{site}/directory — the brand's member companies, with the
 *     details this reader may see. Takes `q`, `tier` (premium | free),
 *     `country`, `letter`, `limit`, `offset`. `countries` counts the listed
 *     companies per country, for the old country list beside the directory.
 */
import { NextResponse } from "next/server";

import { intParam, publicApi } from "@/lib/public/route";
import { directory } from "@/domain/public/directory";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, url, entitlement }) => {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const text = (name: string) => (url.searchParams.get(name) ?? "").trim() || undefined;

  const page = await directory(brand.id, entitlement, {
    search: text("q"),
    tier: text("tier"),
    country: text("country"),
    letter: text("letter"),
    limit: intParam(url, "limit", 20, 100),
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
  });

  return NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, ...page });
});
