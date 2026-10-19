/**
 * POST /api/auth/verify-email — spend a confirmation link.
 *
 * Every failure is one 400 with one message. Telling a caller whether a token
 * was unknown, already spent or expired tells them something about a link
 * they do not hold.
 */
import { NextResponse } from "next/server";

import { jsonBody } from "@/lib/auth/account";
import { confirmEmail } from "@/domain/accounts/register";
import { spendToken } from "@/domain/accounts/tokens";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await jsonBody(request);
    const token = await spendToken(body.token, "verify_email");

    if (!token) {
      return NextResponse.json(
        { message: "That link is no longer valid. Ask for a new one." },
        { status: 400 },
      );
    }

    await confirmEmail(token.userId);

    return NextResponse.json({ message: "Your email address is confirmed." });
  } catch (error) {
    console.error("verify-email failed", { error });

    return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
  }
}
