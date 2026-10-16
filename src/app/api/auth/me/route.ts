/** GET /api/auth/me — who is signed in, and what they may see. */
import { NextResponse } from "next/server";

import { identify } from "@/lib/auth/session";
import { isSuperadmin, tokenFrom } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const identity = await identify(tokenFrom(request));

  if (!identity) {
    return NextResponse.json({ message: "Sign in to continue." }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: identity.user.id,
      name: identity.user.name,
      email: identity.user.email,
      last_login_at: identity.user.lastLoginAt ? identity.user.lastLoginAt.toISOString() : null,
    },
    is_superadmin: isSuperadmin(identity),
    memberships: identity.memberships,
  });
}
