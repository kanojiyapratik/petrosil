/**
 * GET /api/public/{site}/plans — what this brand sells, and for how long,
 * offered to this visitor: the rupee plans in the Indian subcontinent, the
 * dollar plans everywhere else (?country= when the page knows better than us).
 */
import { NextResponse } from "next/server";

import { publicApi, visitorCountry } from "@/lib/public/route";
import { plansFor } from "@/domain/billing/orders";
import { currencyFor, offeredTo, preferredCurrency } from "@/domain/billing/pricing";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ request, url, brand, viewer, entitlement }) => {
  const country = await visitorCountry(request, url, viewer);
  const plans = await plansFor(brand.id);

  return NextResponse.json({
    site: { slug: brand.slug, name: brand.name, currency: brand.defaultCurrency },
    visitor: { country, currency: preferredCurrency(country) },
    entitlement,
    plans: plans
      .filter((plan) => offeredTo(country, plan.currencies))
      .map((plan) => ({ ...plan, currency: currencyFor(country, plan.currencies) })),
  });
});
