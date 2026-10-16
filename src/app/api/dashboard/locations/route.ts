/** GET /api/dashboard/locations — every tracked location the viewer may see. */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { listLocations } from "@/domain/dashboard/locations";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ request, guard }) => {
  const params = new URL(request.url).searchParams;
  const visible = params.get("visible");

  return NextResponse.json({
    data: await listLocations(guard.siteIds, {
      site: params.get("site") ?? undefined,
      search: params.get("q") ?? undefined,
      visible: visible === null ? undefined : visible === "true",
    }),
  });
});
