/**
 * POST /api/dashboard/trials/{id} — approve or decline a trial request.
 *
 * A request belonging to a brand this viewer cannot see answers 404, like
 * everything else scoped by brand: a 403 would confirm it exists.
 */
import { NextResponse } from "next/server";

import { dashboard } from "@/lib/auth/guard";
import { callerIp } from "@/lib/compat/auth";
import { decideTrial } from "@/domain/billing/trials";

export const dynamic = "force-dynamic";

const missing = () => NextResponse.json({ message: "No such request." }, { status: 404 });

export const POST = dashboard(async ({ request, guard, params }) => {
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

  if (body.decision !== "approve" && body.decision !== "decline") {
    return NextResponse.json(
      { message: "Send `decision` as \"approve\" or \"decline\"." },
      { status: 422 },
    );
  }

  const decided = await decideTrial(guard, id, body.decision, {
    days: typeof body.days === "number" ? body.days : undefined,
    ip: callerIp(request),
  });

  return decided ? NextResponse.json(decided) : missing();
});
