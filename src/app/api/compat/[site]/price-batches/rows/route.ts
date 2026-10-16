/**
 * POST /api/compat/{site}/price-batches/rows
 *
 * How the editorial screen hands over the rows an editor kept. Structural
 * validation only: whether a given price or date is usable is a domain
 * question, answered per row by the stager, which records an `invalid` item
 * rather than failing the whole request. That is what lets the console show
 * an editor the three rows that did not read instead of a 422 with no detail.
 */
import { NextResponse } from "next/server";

import { compat, jsonBody, unprocessable } from "@/lib/compat/route";
import { stageRows, batchItems, type StageRow } from "@/domain/price/batches";
import { envelopeJson } from "@/lib/compat/shapes";
import { BATCH_SOURCES, type BatchSource } from "@/db/schema";

export const dynamic = "force-dynamic";

/** Sources whose rows genuinely arrive as JSON; `upload` here would be a lie. */
const ALLOWED: BatchSource[] = ["api", "editorial", "crawl"];

export const POST = compat(async ({ request, caller }) => {
  const body = await jsonBody(request);
  const rows = body.rows;

  if (!Array.isArray(rows) || rows.length === 0) {
    return unprocessable("Send at least one row.", "rows");
  }

  for (const row of rows as StageRow[]) {
    if (!row || typeof row !== "object") {
      return unprocessable("Each row must be an object.", "rows");
    }

    if (typeof row.location !== "string" || row.location.trim() === "") {
      return unprocessable("Each row needs a location.", "rows.location");
    }

    if (row.price === undefined || row.price === null) {
      return unprocessable("Each row needs a price.", "rows.price");
    }
  }

  const source = body.source === undefined || body.source === null ? "api" : String(body.source);

  if (!(BATCH_SOURCES as readonly string[]).includes(source) || !ALLOWED.includes(source as BatchSource)) {
    return unprocessable(`source must be one of: ${ALLOWED.join(", ")}.`, "source");
  }

  const { batch, items } = await stageRows({
    siteId: caller.site.id,
    rows: rows as StageRow[],
    priceDate: body.pricedate,
    source: source as BatchSource,
  });

  return NextResponse.json(envelopeJson(batch, await refresh(batch.id, items)), { status: 201 });
});

/** The stager returns the rows it wrote; re-read keeps one source of truth. */
async function refresh(batchId: number, staged: Awaited<ReturnType<typeof batchItems>>) {
  return staged.length > 0 ? batchItems(batchId) : staged;
}
