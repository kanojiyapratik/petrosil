/**
 * GET /api/dashboard/files/{id} — any file in a brand the viewer works on,
 * paid ones included. Opened in the browser where it can be (PDF, images),
 * downloaded otherwise.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { openFile } from "@/domain/files/access";
import { fileStore } from "@/lib/files/store";

export const dynamic = "force-dynamic";

const INLINE = /^(application\/pdf|image\/(jpeg|png|gif|webp)|video\/)/;

export const GET = dashboard(async ({ guard, params }) => {
  const file = await openFile(guard, Number(params.id), fileStore());

  if (!file) {
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  }

  // SVG and HTML-ish types are downloaded, never rendered: they can carry script.
  const disposition = INLINE.test(file.contentType) ? "inline" : "attachment";

  return new NextResponse(Buffer.from(file.body), {
    headers: {
      "content-type": file.contentType,
      "content-length": String(file.bytes),
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
