/** POST /api/auth/logout — revokes the session server-side, not just the cookie. */
import { NextResponse } from "next/server";

import { COOKIE, signOut } from "@/lib/auth/session";
import { tokenFrom } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  await signOut(tokenFrom(request));

  const response = NextResponse.json({ ok: true });
  response.cookies.set({ name: COOKIE, value: "", path: "/", expires: new Date(0) });

  return response;
}
