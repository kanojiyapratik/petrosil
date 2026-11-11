/**
 * POST /api/auth/confirm-email — spend the link mailed to a new address and
 * move the sign-in to it. Needs no session: the link is the proof.
 */
import { NextResponse } from "next/server";

import { jsonBody } from "@/lib/auth/account";
import { callerIp } from "@/lib/compat/auth";
import { AccountError } from "@/domain/accounts/register";
import { confirmEmailChange } from "@/domain/accounts/email-change";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await jsonBody(request);
    const { email } = await confirmEmailChange(body.token, { ip: callerIp(request) });

    return NextResponse.json({ message: "Your email address is changed.", email });
  } catch (error) {
    if (error instanceof AccountError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }

    console.error("confirm-email failed", { error });

    return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
  }
}
