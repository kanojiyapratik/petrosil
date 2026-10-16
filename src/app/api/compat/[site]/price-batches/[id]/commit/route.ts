/**
 * POST /api/compat/{site}/price-batches/{id}/commit — publish the batch.
 *
 * A batch that cannot be committed answers 409 with the reason, which is what
 * the console shows the editor. The body is `{applied, created, conflicts}`;
 * conflicts are rows the live table moved under, left unwritten on purpose.
 */
import { NextResponse } from "next/server";

import { compat, idFrom } from "@/lib/compat/route";
import { commitBatch } from "@/domain/price/batches";

export const dynamic = "force-dynamic";

export const POST = compat(async ({ caller, params, ip }) => {
  const id = idFrom(params);

  if (id === null) {
    return NextResponse.json({ message: "No such batch." }, { status: 404 });
  }

  const result = await commitBatch(caller.site.id, id, { ip, tokenId: caller.tokenId });

  return NextResponse.json(result);
});
