/**
 * POST /api/public/{site}/enquiries — a signed-in member writes to a company,
 * replies to an offer, or asks about a plan.
 *
 * Body: { kind: "company" | "offer" | "plan", to: <id>, message, subject?,
 *         years?, members? }  (years and members for a plan)
 */
import { NextResponse } from "next/server";

import { account, jsonBody } from "@/lib/auth/account";
import { submitEnquiry } from "@/domain/enquiries/submit";

export const dynamic = "force-dynamic";

export const POST = account(async ({ request, identity, params }) => {
  const result = await submitEnquiry(identity, String(params.site ?? ""), await jsonBody(request));

  return NextResponse.json(
    { ...result, message: "Sent. You will hear back by email." },
    { status: 201 },
  );
});
