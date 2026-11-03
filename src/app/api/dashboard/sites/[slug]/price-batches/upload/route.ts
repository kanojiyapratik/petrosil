/**
 * POST /api/dashboard/sites/{slug}/price-batches/upload — stage a price
 * update from a spreadsheet (multipart: file, pricedate?).
 *
 * A route rather than a server action because a 10 MB sheet is far above a
 * server action's body cap, as with the AI reports and Files. Answers JSON:
 * the new draft batch, how many rows it holds and how many need a look. The
 * rules are in `domain/price/upload.ts`.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { uploadSheet } from "@/domain/price/upload";

export const dynamic = "force-dynamic";

export const POST = dashboard(async ({ request, guard, params }) => {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");

  if (!(file instanceof File) || file.name === "") {
    return NextResponse.json({ message: "Choose a file to upload." }, { status: 422 });
  }

  const date = form?.get("pricedate");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;

  const uploaded = await uploadSheet(
    guard,
    String(params.slug ?? ""),
    { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
    typeof date === "string" ? date : null,
    { ip },
  );

  return NextResponse.json(uploaded, { status: 201 });
});
