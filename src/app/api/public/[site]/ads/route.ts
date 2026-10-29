/**
 * GET /api/public/{site}/ads — every slot with an ad running, or one (?slot=).
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { liveAds } from "@/domain/public/ads";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, url }) =>
  NextResponse.json({ slots: await liveAds(brand, { slot: url.searchParams.get("slot") }) }),
);
