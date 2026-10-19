/**
 * GET /api/public/{site}/plans — what this brand sells, and for how long.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { plansFor } from "@/domain/billing/orders";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement }) =>
  NextResponse.json({
    site: { slug: brand.slug, name: brand.name, currency: brand.defaultCurrency },
    entitlement,
    plans: await plansFor(brand.id),
  }),
);
