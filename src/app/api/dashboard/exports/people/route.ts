/**
 * GET /api/dashboard/exports/people?site={slug}&segment={list} — one brand's
 * readers as a CSV download. The lists and the rules are in
 * `domain/clients/export.ts`.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { callerIp } from "@/lib/compat/auth";
import { peopleCsv } from "@/domain/clients/export";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ request, guard }) => {
  const url = new URL(request.url);
  const made = await peopleCsv(
    guard,
    { site: url.searchParams.get("site") ?? "", segment: url.searchParams.get("segment") ?? "all" },
    { ip: callerIp(request) },
  );

  return new NextResponse(made.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${made.filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
