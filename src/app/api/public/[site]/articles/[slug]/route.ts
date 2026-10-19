/**
 * GET /api/public/{site}/articles/{slug} — one piece.
 *
 * A draft, another brand's slug and a slug that was never used all answer
 * 404, so guessing one tells nobody anything.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { publishedArticle } from "@/domain/content/articles";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement, params }) => {
  const found = await publishedArticle(
    brand.id,
    String(params.slug ?? ""),
    entitlement.entitled,
  );

  if (!found) {
    return NextResponse.json({ message: "No such article." }, { status: 404 });
  }

  return NextResponse.json({
    site: { slug: brand.slug, name: brand.name },
    entitlement,
    ...found,
  });
});
