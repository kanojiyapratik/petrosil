/** GET /api/public/{site}/offers/mine — the signed-in member's own offers on this brand. */
import { NextResponse } from "next/server";

import { account } from "@/lib/auth/account";
import { liveBrand } from "@/lib/public/brand";
import { myOffers } from "@/domain/offers/member";

export const dynamic = "force-dynamic";

export const GET = account(async ({ identity, params }) => {
  const brand = await liveBrand(String(params.site ?? ""));

  return NextResponse.json({ offers: await myOffers(identity.user.id, brand.id) });
});
