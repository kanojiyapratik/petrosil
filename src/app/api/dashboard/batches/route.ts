/** GET /api/dashboard/batches — price updates across every brand at once. */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { listBatches } from "@/domain/dashboard/batches";
import { BATCH_SOURCES, BATCH_STATUSES, type BatchSource, type BatchStatus } from "@/db/schema";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ request, guard }) => {
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  const source = params.get("source");

  return NextResponse.json(
    await listBatches(guard.siteIds, {
      site: params.get("site") ?? undefined,
      status: status && (BATCH_STATUSES as readonly string[]).includes(status) ? (status as BatchStatus) : undefined,
      source: source && (BATCH_SOURCES as readonly string[]).includes(source) ? (source as BatchSource) : undefined,
      page: Number(params.get("page") ?? 1) || 1,
      perPage: Number(params.get("per_page") ?? 25) || 25,
    }),
  );
});
