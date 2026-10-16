/** POST /api/auth/login — email and password in, a session cookie out. */
import { NextResponse } from "next/server";

import { SignInError, sessionCookie, signIn } from "@/lib/auth/session";
import { callerIp } from "@/lib/compat/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const { identity, token, expiresAt } = await signIn(
      { email: body.email, password: body.password },
      { ip: callerIp(request), userAgent: request.headers.get("user-agent") },
    );

    const response = NextResponse.json({
      user: {
        id: identity.user.id,
        name: identity.user.name,
        email: identity.user.email,
      },
      memberships: identity.memberships,
    });

    response.cookies.set(sessionCookie(token, expiresAt));

    return response;
  } catch (error) {
    if (error instanceof SignInError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }

    console.error("sign-in failed", error);

    return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
  }
}
