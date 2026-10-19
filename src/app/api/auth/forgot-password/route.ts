/**
 * POST /api/auth/forgot-password — ask for a reset link.
 *
 * Always 202, always the same body. An address with no account simply has
 * nothing queued for it.
 */
import { NextResponse } from "next/server";

import { jsonBody } from "@/lib/auth/account";
import { requestPasswordReset } from "@/domain/accounts/register";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await jsonBody(request);

  try {
    await requestPasswordReset(body);
  } catch (error) {
    // Logged, never surfaced: an error here would say that something about
    // this address was worth failing over.
    console.error("forgot-password failed", { error });
  }

  return NextResponse.json(
    { message: "If that address has an account, a link to set a new password is on its way." },
    { status: 202 },
  );
}
