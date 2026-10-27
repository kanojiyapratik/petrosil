/**
 * GET /api/public/{site}/impex — the impex sheets a reader may see listed.
 * Takes `q`, `limit` and `offset`. The file's name is never listed.
 */
import { NextResponse } from "next/server";

import { intParam, publicApi } from "@/lib/public/route";
import { publishedSheets } from "@/domain/public/impex";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, url, entitlement }) => {
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const page = await publishedSheets(brand.id, {
    search: (url.searchParams.get("q") ?? "").trim() || undefined,
    limit: intParam(url, "limit", 20, 100),
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
  });

  return NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, ...page });
});
