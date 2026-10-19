/**
 * POST /api/account/trial — ask for a free trial on one brand.
 */
import { NextResponse } from "next/server";

import { account, jsonBody } from "@/lib/auth/account";
import { requestTrial } from "@/domain/billing/trials";

export const dynamic = "force-dynamic";

export const POST = account(async ({ request, identity }) => {
  const result = await requestTrial(identity, await jsonBody(request));

  return NextResponse.json(
    { ...result, message: "Thank you — our team will be in touch shortly." },
    { status: 201 },
  );
});
