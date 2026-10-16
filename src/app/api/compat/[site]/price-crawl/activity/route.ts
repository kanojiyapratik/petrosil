/** GET /api/compat/{site}/price-crawl/activity — what the pages have said lately. */
import { NextResponse } from "next/server";

import { compat } from "@/lib/compat/route";
import { DEFAULT_ACTIVITY, recentActivity } from "@/domain/crawl/activity";

export const dynamic = "force-dynamic";

export const GET = compat(async ({ request, caller }) => {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? DEFAULT_ACTIVITY);

  return NextResponse.json({ data: await recentActivity(caller.site.id, limit) });
});
