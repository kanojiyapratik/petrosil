/**
 * GET   /api/dashboard/locations/{id} — the location with its price history.
 * PATCH /api/dashboard/locations/{id} — show or hide it on the brand site.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { locationDetail, setVisibility } from "@/domain/dashboard/locations";
import { callerIp } from "@/lib/compat/auth";

export const dynamic = "force-dynamic";

const missing = () => NextResponse.json({ message: "No such location." }, { status: 404 });

export const GET = dashboard(async ({ request, guard, params }) => {
  const id = Number(params.id);

  if (!Number.isInteger(id) || id < 1) {
    return missing();
  }

  const weeks = Number(new URL(request.url).searchParams.get("limit") ?? 52);
  const detail = await locationDetail(guard.siteIds, id, Number.isFinite(weeks) ? weeks : 52);

  return detail ? NextResponse.json(detail) : missing();
});

export const PATCH = dashboard(async ({ request, guard, params }) => {
  const id = Number(params.id);

  if (!Number.isInteger(id) || id < 1) {
    return missing();
  }

  let body: Record<string, unknown> = {};

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (typeof body.visible !== "boolean") {
    return NextResponse.json({ message: "Send `visible` as true or false." }, { status: 422 });
  }

  const updated = await setVisibility(guard.siteIds, id, body.visible, {
    userId: guard.identity.user.id,
    ip: callerIp(request),
  });

  return updated ? NextResponse.json(updated) : missing();
});
