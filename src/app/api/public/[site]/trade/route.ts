/**
 * GET /api/public/{site}/trade — the countries that report monthly import
 *     or export quantities, with how many months each has and the latest.
 *     Names and dates only; the figures are on each country's page.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { tradeCountries } from "@/domain/public/trade";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement }) => {
  const countries = await tradeCountries(brand.id);

  return NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, countries });
});
