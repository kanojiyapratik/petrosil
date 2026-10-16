/**
 * POST /api/compat/{site}/price-batches/upload — a spreadsheet, relayed by
 * the console exactly as the editor picked it.
 *
 * Multipart, with `file` and an optional `pricedate`, which is what the
 * module's SiteClient sends. The console never parses the sheet: the brand is
 * what knows its own location names.
 */
import { NextResponse } from "next/server";

import { compat, unprocessable } from "@/lib/compat/route";
import { batchItems } from "@/domain/price/batches";
import { SheetError, stageUpload, MAX_BYTES } from "@/domain/price/sheet";
import { envelopeJson } from "@/lib/compat/shapes";

export const dynamic = "force-dynamic";

const ALLOWED = ["xlsx", "xls", "csv"];

export const POST = compat(async ({ request, caller }) => {
  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return unprocessable("Send the sheet as multipart form data with a `file` field.", "file");
  }

  const file = form.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return unprocessable("Choose a file to upload.", "file");
  }

  const extension = (file.name.split(".").pop() ?? "").toLowerCase();

  if (!ALLOWED.includes(extension)) {
    return unprocessable("The file must be a file of type: xlsx, xls, csv.", "file");
  }

  if (file.size > MAX_BYTES) {
    return unprocessable("The file may not be greater than 10 MB.", "file");
  }

  const priceDate = form.get("pricedate");

  try {
    const { batch, items } = await stageUpload({
      siteId: caller.site.id,
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
      priceDate: typeof priceDate === "string" ? priceDate : undefined,
    });

    return NextResponse.json(envelopeJson(batch, items.length ? await batchItems(batch.id) : items), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof SheetError) {
      // The site's own wording is the useful part: the console shows it to
      // the editor verbatim.
      return NextResponse.json({ message: error.message }, { status: error.status });
    }

    throw error;
  }
});
