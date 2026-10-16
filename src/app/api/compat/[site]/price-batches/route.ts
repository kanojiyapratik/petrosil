/** GET /api/compat/{site}/price-batches — the batch list the console paginates. */
import { NextResponse } from "next/server";

import { compat } from "@/lib/compat/route";
import { listBatches } from "@/domain/price/batches";
import { batchJson } from "@/lib/compat/shapes";

export const dynamic = "force-dynamic";

const PER_PAGE = 25;

export const GET = compat(async ({ request, caller }) => {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const { rows, total } = await listBatches(caller.site.id, page, PER_PAGE);

  return NextResponse.json({
    data: rows.map((row) => ({ ...batchJson(row), items_count: row.itemsCount })),
    meta: {
      current_page: page,
      last_page: Math.max(1, Math.ceil(total / PER_PAGE)),
      per_page: PER_PAGE,
      total,
    },
  });
});
