/**
 * POST /api/account/password — change my password.
 *
 * Needs the current one, and signs out every other device on success.
 */
import { NextResponse } from "next/server";

import { account, jsonBody } from "@/lib/auth/account";
import { changePassword } from "@/domain/accounts/profile";

export const dynamic = "force-dynamic";

export const POST = account(async ({ request, identity }) => {
  const body = await jsonBody(request);

  await changePassword(identity, { current: body.current, next: body.next });

  return NextResponse.json({
    message: "Your password is changed. Your other devices have been signed out.",
  });
});
