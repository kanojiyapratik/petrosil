/**
 * GET /api/dashboard/sites/{slug}/ai/drafts/{id}/workings — the AI draft as
 * the sheet that argues for itself: every price with the report it came from
 * and the arithmetic. The engine writes it; this checks who may have it.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { workingsSheet } from "@/domain/ai/update";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ guard, params }) => {
  const slug = String(params.slug ?? "");
  const id = Number(params.id);

  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ message: "No such draft." }, { status: 404 });
  }

  try {
    const sheet = await workingsSheet(guard, slug, id);

    return new NextResponse(new Uint8Array(sheet.body), {
      headers: {
        "content-type": sheet.type || "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${slug}-ai-draft-${id}-workings.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof EngineError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }

    throw error;
  }
});
