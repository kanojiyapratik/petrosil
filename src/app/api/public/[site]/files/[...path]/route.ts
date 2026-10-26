/**
 * GET /api/public/{site}/files/{folder}/{name} — a public picture: an article
 * thumbnail, an ad, a page image. Report PDFs and trade sheets are never served
 * here; see `domain/files/access.ts`.
 */
import { NextResponse } from "next/server";

import { readPublicFile } from "@/domain/files/access";
import { fileStore } from "@/lib/files/store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ site: string; path: string[] }> }) {
  const { site, path } = await context.params;
  const file = await readPublicFile(site, path.join("/"), fileStore());

  if (!file) {
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  }

  return new NextResponse(Buffer.from(file.body), {
    headers: {
      "content-type": file.contentType,
      "content-length": String(file.bytes),
      // A stored name never changes its content: an upload gets a new name.
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
