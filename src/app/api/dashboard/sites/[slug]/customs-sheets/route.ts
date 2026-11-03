/**
 * POST /api/dashboard/sites/{slug}/customs-sheets — one month of customs
 * import data (multipart: sheet, product_label, period_month YYYY-MM).
 *
 * A route rather than a server action: a customs sheet can be 20 MB. The
 * rules are in `domain/trade/customs.ts`. Answers the new sheet's id, its
 * shipment count, and whether it replaced one.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { uploadCustomsSheet } from "@/domain/trade/customs";
import { MAX_BYTES } from "@/domain/trade/customs-sheet";

export const dynamic = "force-dynamic";

export const POST = dashboard(async ({ request, guard, params }) => {
  const form = await request.formData().catch(() => null);
  const file = form?.get("sheet");

  if (!(file instanceof File) || file.name === "") {
    return NextResponse.json({ message: "Choose the customs sheet to upload." }, { status: 422 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ message: "The file may not be larger than 20 MB." }, { status: 422 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;

  const made = await uploadCustomsSheet(
    guard,
    String(params.slug ?? ""),
    {
      productLabel: String(form?.get("product_label") ?? ""),
      periodMonth: String(form?.get("period_month") ?? ""),
      file: { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
    },
    { ip },
  );

  return NextResponse.json(made, { status: 201 });
});
