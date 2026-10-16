/**
 * PATCH /api/dashboard/clients/{id}/membership — change what a client gets
 * on one brand: their tier, when it expires, or whether the account works.
 *
 * This is "extend access" and "approve the trial", the two things the team
 * does by hand today. Every change is audited; granting staff access is
 * deliberately not possible here.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { updateMembership } from "@/domain/dashboard/clients";
import { callerIp } from "@/lib/compat/auth";

export const dynamic = "force-dynamic";

export const PATCH = dashboard(async ({ request, guard, params }) => {
  const id = Number(params.id);

  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ message: "No such client." }, { status: 404 });
  }

  let body: Record<string, unknown> = {};

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const site = typeof body.site === "string" ? body.site : "";

  if (site === "") {
    return NextResponse.json({ message: "Say which brand this change is for." }, { status: 422 });
  }

  const result = await updateMembership(
    guard.siteIds,
    id,
    site,
    {
      tier: typeof body.tier === "string" ? body.tier : undefined,
      expires_at:
        body.expires_at === undefined
          ? undefined
          : body.expires_at === null
            ? null
            : String(body.expires_at),
      status: typeof body.status === "string" ? body.status : undefined,
    },
    { userId: guard.identity.user.id, ip: callerIp(request) },
  );

  if (!result.ok) {
    return result.reason === "not_found"
      ? NextResponse.json({ message: "No such client on that brand." }, { status: 404 })
      : NextResponse.json({ message: "That change is not allowed." }, { status: 422 });
  }

  return NextResponse.json({ ok: true });
});
