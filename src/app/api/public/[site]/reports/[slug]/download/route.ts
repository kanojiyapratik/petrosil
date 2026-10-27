/**
 * GET /api/public/{site}/reports/{slug}/download — the report's PDF, for a
 * reader who may have it. Otherwise 401 (sign in) or 403 (subscribe, renew),
 * with the reason, so the brand site can say the right thing.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { reportDownload } from "@/domain/public/reports";
import { fileStore } from "@/lib/files/store";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement, params }) => {
  const result = await reportDownload(brand.id, String(params.slug ?? ""), entitlement, fileStore());

  if (!result.ok) {
    return NextResponse.json({ message: result.message, reason: result.reason }, { status: result.status });
  }

  return new NextResponse(Buffer.from(result.file.body), {
    headers: {
      "content-type": result.file.contentType,
      "content-length": String(result.file.bytes),
      "content-disposition": `attachment; filename="${result.filename}"`,
      // A paid file: never kept by a shared cache, never sniffed into something else.
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
