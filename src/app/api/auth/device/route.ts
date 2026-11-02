/**
 * POST /api/auth/device — the sign-in page's one-click button.
 *
 * Uses the secret a private sign-in link left in this browser. A form post,
 * not JSON, so the button works as plain HTML. `?forget=1` drops the cookie.
 */
import { NextResponse } from "next/server";

import { DEVICE_COOKIE, SignInError, deviceCookie, sessionCookie, signInWithLink } from "@/lib/auth/session";
import { callerIp } from "@/lib/compat/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const secret = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DEVICE_COOKIE}=`))
    ?.slice(DEVICE_COOKIE.length + 1);
  // A path, not a full URL: behind Railway's proxy request.url names the
  // container (0.0.0.0:8080), and a browser sent there gets an error page.
  const back = (path: string) => new NextResponse(null, { status: 303, headers: { location: path } });

  if (url.searchParams.get("forget") === "1") {
    const response = back("/sign-in");

    response.cookies.set({ ...deviceCookie(""), maxAge: 0 });

    return response;
  }

  try {
    const { token, expiresAt } = await signInWithLink(secret ? decodeURIComponent(secret) : undefined, {
      ip: callerIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    const response = back("/dashboard");

    response.cookies.set(sessionCookie(token, expiresAt));

    return response;
  } catch (error) {
    // A revoked link: the button goes, the ordinary form stays.
    const response = back(error instanceof SignInError && error.status === 429 ? "/sign-in?link=busy" : "/sign-in");

    response.cookies.set({ ...deviceCookie(""), maxAge: 0 });

    return response;
  }
}
