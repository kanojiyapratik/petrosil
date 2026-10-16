/** GET /api/dashboard/clients/{id} — the client-360 drawer. */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { clientDetail } from "@/domain/dashboard/clients";

export const dynamic = "force-dynamic";

export const GET = dashboard(async ({ guard, params }) => {
  const id = Number(params.id);

  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ message: "No such client." }, { status: 404 });
  }

  const client = await clientDetail(guard.siteIds, id);

  // A client of a brand this person cannot see answers the same as one who
  // does not exist: the reply must not confirm that they do.
  if (!client) {
    return NextResponse.json({ message: "No such client." }, { status: 404 });
  }

  return NextResponse.json(client);
});
