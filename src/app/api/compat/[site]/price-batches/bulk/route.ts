/**
 * POST /api/compat/{site}/price-batches/bulk — set, adjust or copy prices
 * across many locations.
 *
 * Nothing is written: the result is an ordinary draft batch, reviewed and
 * committed like any other. That is the point of routing a sweeping change
 * through here rather than a direct update.
 */
import { NextResponse } from "next/server";

import { compat, jsonBody, unprocessable } from "@/lib/compat/route";
import { BulkError, stageBulkEdit } from "@/domain/price/bulk";
import { batchItems } from "@/domain/price/batches";
import { envelopeJson } from "@/lib/compat/shapes";

export const dynamic = "force-dynamic";

export const POST = compat(async ({ request, caller }) => {
  const body = await jsonBody(request);

  try {
    const { batch, items } = await stageBulkEdit(caller.site.id, body);

    return NextResponse.json(envelopeJson(batch, items.length ? await batchItems(batch.id) : items), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof BulkError) {
      return unprocessable(error.message, error.field);
    }

    throw error;
  }
});
