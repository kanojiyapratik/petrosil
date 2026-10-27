/**
 * GET  /api/public/{site}/offers — live offers, with the details this reader
 *      may see. Takes `type` (buy | sell), `q`, `limit`, `offset`.
 * POST /api/public/{site}/offers — a signed-in member posts an offer. It goes
 *      live at once; staff can suspend it.
 */
import { NextResponse } from "next/server";

import { account, jsonBody } from "@/lib/auth/account";
import { intParam, publicApi } from "@/lib/public/route";
import { liveBrand } from "@/lib/public/brand";
import { callerIp } from "@/lib/compat/auth";
import { publishedOffers } from "@/domain/public/offers";
import { postOffer } from "@/domain/offers/member";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, url, entitlement }) => {
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const page = await publishedOffers(brand.id, entitlement, {
    type: url.searchParams.get("type") ?? undefined,
    search: (url.searchParams.get("q") ?? "").trim() || undefined,
    limit: intParam(url, "limit", 20, 100),
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
  });

  return NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, ...page });
});

export const POST = account(async ({ request, identity, params }) => {
  const brand = await liveBrand(String(params.site ?? ""));
  const offer = await postOffer(identity.user.id, brand.id, await jsonBody(request), { ip: callerIp(request) });

  return NextResponse.json({ offer, message: "Your offer is live." }, { status: 201 });
});
