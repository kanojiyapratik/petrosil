/** GET /api/dashboard/audit — who did what, when, on which brand. */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { auditTrail } from "@/domain/dashboard/activity";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ request, guard }) => {
  const params = new URL(request.url).searchParams;

  return NextResponse.json({
    data: await auditTrail(guard.siteIds, {
      site: params.get("site") ?? undefined,
      action: params.get("action") ?? undefined,
      limit: Number(params.get("limit") ?? 100) || 100,
    }),
  });
});
