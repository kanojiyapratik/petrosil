/**
 * POST /api/auth/reset-password — spend a reset link and set a new password.
 *
 * The rules live in `resetPassword`, which the brand site's reset page uses
 * too, so the two cannot drift apart.
 */
import { NextResponse } from "next/server";

import { jsonBody } from "@/lib/auth/account";
import { AccountError, resetPassword } from "@/domain/accounts/register";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await jsonBody(request);

    await resetPassword({ token: body.token, password: body.password });

    return NextResponse.json({ message: "Your password is set. You can sign in now." });
  } catch (error) {
    if (error instanceof AccountError) {
      return NextResponse.json(
        error.field
          ? { message: error.message, errors: { [error.field]: [error.message] } }
          : { message: error.message },
        { status: error.status },
      );
    }

    console.error("reset-password failed", { error });

    return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
  }
}
