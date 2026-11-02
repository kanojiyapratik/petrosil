/** POST /api/auth/link — a private sign-in link's secret in, a session cookie out. */
import { NextResponse } from "next/server";

import { SignInError, sessionCookie, signInWithLink } from "@/lib/auth/session";
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
    const { token, expiresAt } = await signInWithLink(body.secret, {
      ip: callerIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    const response = NextResponse.json({ ok: true });

    response.cookies.set(sessionCookie(token, expiresAt));

    return response;
  } catch (error) {
    if (error instanceof SignInError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }

    console.error("link sign-in failed", error);

    return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
  }
}
