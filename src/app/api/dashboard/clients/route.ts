/** GET /api/dashboard/clients — one row per person, across every brand they hold. */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { listClients, segmentCounts, type Segment } from "@/domain/dashboard/clients";

export const dynamic = "force-dynamic";

const SEGMENTS = ["premium", "trial", "expired", "free"];

export const GET = dashboard(async ({ request, guard }) => {
  const params = new URL(request.url).searchParams;
  const segment = params.get("segment");

  const [clients, counts] = await Promise.all([
    listClients(guard.siteIds, {
      search: params.get("q") ?? undefined,
      site: params.get("site") ?? undefined,
      segment: segment && SEGMENTS.includes(segment) ? (segment as Segment) : undefined,
      page: Number(params.get("page") ?? 1) || 1,
      perPage: Number(params.get("per_page") ?? 25) || 25,
    }),
    segmentCounts(guard.siteIds),
  ]);

  return NextResponse.json({ ...clients, counts });
});
