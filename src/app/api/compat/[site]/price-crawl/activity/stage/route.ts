/**
 * POST /api/compat/{site}/price-crawl/activity/stage
 *
 * Turn chosen findings into an ordinary draft batch. The crawler still never
 * publishes anything: the batch goes through the same review and the same
 * manual commit as a spreadsheet.
 */
import { NextResponse } from "next/server";

import { compat, jsonBody, unprocessable } from "@/lib/compat/route";
import { NothingToStage, stageActivities } from "@/domain/crawl/activity";

export const dynamic = "force-dynamic";

const MAX_IDS = 2000;

export const POST = compat(async ({ request, caller }) => {
  const body = await jsonBody(request);
  const ids = body.activity_ids;

  if (!Array.isArray(ids) || ids.length === 0) {
    return unprocessable("Choose at least one finding.", "activity_ids");
  }

  if (ids.length > MAX_IDS) {
    return unprocessable(`At most ${MAX_IDS} findings at a time.`, "activity_ids");
  }

  try {
    const { batch, rows, skipped } = await stageActivities(caller.site.id, ids as number[]);

    return NextResponse.json(
      { batch_id: batch.id, rows, skipped, status: batch.status },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof NothingToStage) {
      return NextResponse.json({ message: error.message, skipped: error.skipped }, { status: 422 });
    }

    throw error;
  }
});
