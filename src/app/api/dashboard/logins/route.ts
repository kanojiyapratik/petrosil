/** GET /api/dashboard/logins — the login log, successes and failures. */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { loginLog } from "@/domain/dashboard/activity";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ request, guard }) => {
  const params = new URL(request.url).searchParams;

  return NextResponse.json({
    data: await loginLog(guard.siteIds, {
      onlyFailures: params.get("failures") === "true",
      limit: Number(params.get("limit") ?? 100) || 100,
    }),
  });
});
