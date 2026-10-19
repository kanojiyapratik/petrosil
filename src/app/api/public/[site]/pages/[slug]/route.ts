/**
 * GET /api/public/{site}/pages/{slug} — a staff-edited content page.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { pageBySlug } from "@/domain/content/pages";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, params }) => {
  const page = await pageBySlug(brand.id, String(params.slug ?? ""));

  if (!page) {
    return NextResponse.json({ message: "No such page." }, { status: 404 });
  }

  return NextResponse.json({ site: { slug: brand.slug, name: brand.name }, page });
});
