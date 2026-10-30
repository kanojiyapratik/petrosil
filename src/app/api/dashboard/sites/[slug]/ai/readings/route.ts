/**
 * POST /api/dashboard/sites/{slug}/ai/readings — send market reports to the
 * AI engine to be read (multipart: documents[], instructions?).
 *
 * A route rather than a server action because five 10 MB reports are far
 * above a server action's body cap — the Files upload is a route for the
 * same reason. Answers JSON: the reading, and any file that could not be read.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { readReports } from "@/domain/ai/update";

export const dynamic = "force-dynamic";

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;

export const POST = dashboard(async ({ request, guard, params }) => {
  const form = await request.formData().catch(() => null);
  const files = (form?.getAll("documents") ?? []).filter((item): item is File => item instanceof File && item.name !== "");
  const instructions = form?.get("use_instructions") ? String(form.get("instructions") ?? "") : null;

  // Said here as well as by the engine, so a sixth file is refused before
  // fifty megabytes cross to it.
  if (files.length === 0) {
    return NextResponse.json({ message: "Choose at least one report." }, { status: 422 });
  }

  if (files.length > MAX_FILES) {
    return NextResponse.json({ message: `At most ${MAX_FILES} reports at a time.` }, { status: 422 });
  }

  const big = files.find((file) => file.size > MAX_BYTES);

  if (big) {
    return NextResponse.json({ message: `${big.name} is larger than 10 MB.` }, { status: 422 });
  }

  try {
    const result = await readReports(guard, String(params.slug ?? ""), { files, instructions });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof EngineError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }

    throw error;
  }
});
