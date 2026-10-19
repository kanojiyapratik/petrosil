/**
 * GET /api/public/{site}/locations/{id} — one market and its series.
 *
 * `weeks` bounds the window (12 by default, 520 at most). A visitor gets the
 * market, the movement and how many weeks are behind the lock, and no series.
 */
import { NextResponse } from "next/server";

import { idFrom, intParam, publicApi } from "@/lib/public/route";
import { publicLocation } from "@/domain/public/prices";

export const dynamic = "force-dynamic";

const missing = () => NextResponse.json({ message: "No such location." }, { status: 404 });

export const GET = publicApi(async ({ brand, entitlement, params, url }) => {
  const id = idFrom(params);

  if (id === null) {
    return missing();
  }

  const detail = await publicLocation(
    brand.id,
    id,
    entitlement.entitled,
    intParam(url, "weeks", 12, 520),
  );

  if (!detail) {
    return missing();
  }

  return NextResponse.json({
    site: { slug: brand.slug, name: brand.name },
    entitlement,
    ...detail,
  });
});
