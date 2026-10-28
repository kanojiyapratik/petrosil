/**
 * GET /api/public/{site}/directory/{id} — one listed company, with the
 *     details this reader may see. Anyone the directory does not list —
 *     the team, an unconfirmed or disabled account, another brand's member —
 *     answers 404, as a missing one does.
 */
import { NextResponse } from "next/server";

import { idFrom, publicApi } from "@/lib/public/route";
import { directoryEntry } from "@/domain/public/directory";

export const dynamic = "force-dynamic";

export const GET = publicApi(async ({ brand, entitlement, params }) => {
  const id = idFrom(params);
  const company = id ? await directoryEntry(brand.id, id, entitlement) : null;

  return company
    ? NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, company })
    : NextResponse.json({ message: "No such company." }, { status: 404 });
});
