/**
 * POST /api/dashboard/files — upload one file (multipart: site, folder, file).
 *
 * A route rather than a server action because a server action's request body
 * is capped far below a report PDF. Sent from the Files screen's form, it
 * answers with a redirect back to that screen; sent with
 * `accept: application/json`, it answers JSON.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { callerIp } from "@/lib/compat/auth";
import { uploadFile } from "@/domain/files/access";
import { fileStore } from "@/lib/files/store";

export const dynamic = "force-dynamic";

export const POST = dashboard(async ({ request, guard }) => {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const site = String(form?.get("site") ?? "");
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");

  const result =
    file instanceof File
      ? await uploadFile(
          guard,
          {
            site,
            folder: String(form?.get("folder") ?? ""),
            name: file.name,
            type: file.type,
            body: new Uint8Array(await file.arrayBuffer()),
          },
          fileStore(),
          { ip: callerIp(request) },
        )
      : ({ ok: false, message: "Choose a file to upload." } as const);

  if (wantsJson) {
    return NextResponse.json(result, { status: result.ok ? 201 : 422 });
  }

  const back = new URL(`/dashboard/sites/${encodeURIComponent(site)}/files`, request.url);

  back.searchParams.set(result.ok ? "uploaded" : "error", result.ok ? result.name : result.message);

  return NextResponse.redirect(back, 303);
});
