/**
 * GET /api/public/{site}/trade/{id}/{import|export}?year= — one reporting
 *     country's year: each month with its partners. Quantities only for a
 *     paying reader; everyone else gets the months and `figures.reason`
 *     (sign_in | subscribe | renew), as a premium report's download does.
 */
import { NextResponse } from "next/server";

import { idFrom, intParam, publicApi } from "@/lib/public/route";
import { isTradeKind, tradeYear } from "@/domain/public/trade";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, url, entitlement, params }) => {
  const id = idFrom(params);
  const kind = String(params.kind ?? "");
  const year = intParam(url, "year", 0, 9999);
  const sheet = id && isTradeKind(kind) ? await tradeYear(brand.id, { location: id, kind, year: year || undefined }, entitlement) : null;

  return sheet
    ? NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, ...sheet })
    : NextResponse.json({ message: "No such country." }, { status: 404 });
});
