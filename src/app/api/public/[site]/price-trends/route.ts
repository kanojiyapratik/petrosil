/**
 * GET /api/public/{site}/price-trends — the brand's price table.
 *
 * Public. Movement and names for everyone, figures for subscribers; the
 * entitlement block goes out with the rows so the page can put the right
 * words on the lock ("subscribe", "renew", "sign in").
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { priceTrends } from "@/domain/public/prices";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement }) => {
  const { rows, asOf } = await priceTrends(brand.id, entitlement.entitled);

  return NextResponse.json({
    site: {
      slug: brand.slug,
      name: brand.name,
      currency: brand.defaultCurrency,
      cadence: brand.priceCadence,
    },
    entitlement,
    as_of: asOf,
    locations: rows,
  });
});
