/** POST /api/compat/{site}/price-batches/{id}/rollback — undo a committed batch. */
import { NextResponse } from "next/server";

import { compat, idFrom } from "@/lib/compat/route";
import { rollbackBatch } from "@/domain/price/batches";

export const dynamic = "force-dynamic";

export const POST = compat(async ({ caller, params, ip }) => {
  const id = idFrom(params);

  if (id === null) {
    return NextResponse.json({ message: "No such batch." }, { status: 404 });
  }

  const result = await rollbackBatch(caller.site.id, id, { ip, tokenId: caller.tokenId });

  return NextResponse.json(result);
});
