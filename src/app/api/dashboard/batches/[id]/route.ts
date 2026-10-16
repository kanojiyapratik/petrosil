/** GET /api/dashboard/batches/{id} — one batch with every row it staged. */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { batchDetail } from "@/domain/dashboard/batches";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ guard, params }) => {
  const id = Number(params.id);
  const detail = Number.isInteger(id) && id > 0 ? await batchDetail(guard.siteIds, id) : null;

  return detail ? NextResponse.json(detail) : NextResponse.json({ message: "No such batch." }, { status: 404 });
});
