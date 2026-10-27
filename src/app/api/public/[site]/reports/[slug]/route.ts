/**
 * GET /api/public/{site}/reports/{slug} — one report, and whether this
 * reader may download it (and if not, why: sign in, subscribe, renew).
 *
 * A draft, a withdrawn report and another brand's slug all answer 404.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { publishedReport } from "@/domain/public/reports";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement, params }) => {
  const report = await publishedReport(brand.id, String(params.slug ?? ""), entitlement);

  if (!report) {
    return NextResponse.json({ message: "No such report." }, { status: 404 });
  }

  return NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, report });
});
