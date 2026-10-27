/**
 * GET /api/public/{site}/impex/{slug}/download — the sheet's file, for a
 * reader who may have it; otherwise 401 or 403 with the reason.
 */
import { NextResponse } from "next/server";

import { publicApi } from "@/lib/public/route";
import { impexDownload } from "@/domain/public/impex";
import { fileStore } from "@/lib/files/store";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement, params }) => {
  const result = await impexDownload(brand.id, String(params.slug ?? ""), entitlement, fileStore());

  if (!result.ok) {
    return NextResponse.json({ message: result.message, reason: result.reason }, { status: result.status });
  }

  return new NextResponse(Buffer.from(result.file.body), {
    headers: {
      "content-type": result.file.contentType,
      "content-length": String(result.file.bytes),
      "content-disposition": `attachment; filename="${result.filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
