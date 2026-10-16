/** GET /api/dashboard/overview — estate KPIs, one card per brand. */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { estateOverview, recentBatches } from "@/domain/dashboard/overview";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ guard }) => {
  const [overview, batches] = await Promise.all([
    estateOverview(guard.siteIds),
    recentBatches(guard.siteIds, 10),
  ]);

  return NextResponse.json({ ...overview, recent_batches: batches });
});
