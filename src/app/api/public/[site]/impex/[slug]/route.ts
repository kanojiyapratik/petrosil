/** GET /api/public/{site}/impex/{slug} — one sheet, and whether this reader may download it. */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { publishedSheet } from "@/domain/public/impex";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement, params }) => {
  const sheet = await publishedSheet(brand.id, String(params.slug ?? ""), entitlement);

  if (!sheet) {
    return NextResponse.json({ message: "No such sheet." }, { status: 404 });
  }

  return NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, sheet });
});
