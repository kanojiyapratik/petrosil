/** POST /api/compat/{site}/price-batches/{id}/discard — throw away a draft. */
import { NextResponse } from "next/server";

import { compat, idFrom } from "@/lib/compat/route";
import { discardBatch } from "@/domain/price/batches";
import { batchJson } from "@/lib/compat/shapes";

export const dynamic = "force-dynamic";

export const POST = compat(async ({ caller, params }) => {
  const id = idFrom(params);

  if (id === null) {
    return NextResponse.json({ message: "No such batch." }, { status: 404 });
  }

  const batch = await discardBatch(caller.site.id, id);

  return NextResponse.json({ batch: batchJson(batch) });
});
