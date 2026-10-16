/** GET /api/compat/{site}/locations — what this brand tracks and currently shows. */
import { NextResponse } from "next/server";

import { compat } from "@/lib/compat/route";
import { locationsWithLatestPrice } from "@/domain/price/locations";

export const dynamic = "force-dynamic";

export const GET = compat(async ({ caller }) => {
  const data = await locationsWithLatestPrice(caller.site.id);

  return NextResponse.json({ data });
});
