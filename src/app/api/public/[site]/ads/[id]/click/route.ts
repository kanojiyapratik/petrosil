/**
 * GET /api/public/{site}/ads/{id}/click — count the click, then on to the ad's link.
 */
import { NextResponse } from "next/server";

import { idFrom, publicApi } from "@/lib/public/route";
import { followAd } from "@/domain/public/ads";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, params }) => {
  const id = idFrom(params);
  const target = id ? await followAd(brand.id, id) : null;

  if (!target) {
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  }

  return NextResponse.redirect(target, 302);
});
