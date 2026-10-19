/**
 * POST /api/auth/register — sign up on one brand.
 *
 * Answers 202 and the same body whether or not the address already has an
 * account. See domain/accounts/register.ts for why.
 */
import { NextResponse } from "next/server";

import { jsonBody } from "@/lib/auth/account";
import { AccountError, register } from "@/domain/accounts/register";

export const dynamic = "force-dynamic";

const SAME_EITHER_WAY = {
  message: "Check your email — we have sent you a link to confirm your address.",
};

export async function POST(request: Request): Promise<NextResponse> {
  try {
    await register(await jsonBody(request));

    return NextResponse.json(SAME_EITHER_WAY, { status: 202 });
  } catch (error) {
    if (error instanceof AccountError) {
      return NextResponse.json(
        error.field
          ? { message: error.message, errors: { [error.field]: [error.message] } }
          : { message: error.message },
        { status: error.status },
      );
    }

    console.error("register failed", { error });

    return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
  }
}
