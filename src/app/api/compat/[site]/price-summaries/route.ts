/**
 * POST /api/compat/{site}/price-summaries — the note the module's AI wrote
 * about a published update.
 *
 * The platform does not generate this text and does not second-guess it. The
 * one thing it insists on is that there IS text: an empty note would silently
 * blank the banner above the price table.
 */
import { NextResponse } from "next/server";

import { compat, jsonBody, unprocessable } from "@/lib/compat/route";
import { db } from "@/db";
import { priceSummaries } from "@/db/schema";
import { batchOnSite } from "@/domain/price/batches";

export const dynamic = "force-dynamic";

export const POST = compat(async ({ request, caller }) => {
  const body = await jsonBody(request);
  const summary = String(body.summary ?? "").trim();

  if (summary === "") {
    return unprocessable("A summary needs some text.", "summary");
  }

  // A batch id from another brand would quietly attach this brand's note to
  // someone else's update, so it is checked rather than trusted.
  let batchId: number | null = null;

  if (body.price_batch_id !== undefined && body.price_batch_id !== null) {
    const candidate = Number(body.price_batch_id);
    const batch = Number.isInteger(candidate) ? await batchOnSite(caller.site.id, candidate) : null;

    if (!batch) {
      return unprocessable("That batch does not belong to this site.", "price_batch_id");
    }

    batchId = batch.id;
  }

  const [row] = await db()
    .insert(priceSummaries)
    .values({
      siteId: caller.site.id,
      priceBatchId: batchId,
      source: String(body.source ?? "editorial"),
      summary,
    })
    .returning();

  return NextResponse.json(
    {
      id: row!.id,
      summary: row!.summary,
      source: row!.source,
      created_at: row!.createdAt.toISOString(),
    },
    { status: 201 },
  );
});
