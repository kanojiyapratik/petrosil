/**
 * GET /api/dashboard/trials — the trial queue, scoped to this viewer's brands.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { listTrials } from "@/domain/billing/trials";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ request, guard }) => {
  const status = new URL(request.url).searchParams.get("status") ?? undefined;

  return NextResponse.json({ requests: await listTrials(guard.siteIds, status ?? undefined) });
});
