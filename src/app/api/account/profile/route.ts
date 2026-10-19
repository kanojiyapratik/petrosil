/**
 * GET   /api/account/profile — who I am and which brands I hold.
 * PATCH /api/account/profile — change my own details.
 */
import { NextResponse } from "next/server";

import { account, jsonBody } from "@/lib/auth/account";
import { publicProfile, updateProfile } from "@/domain/accounts/profile";

export const dynamic = "force-dynamic";

export const GET = account(async ({ identity }) =>
  NextResponse.json({
    user: publicProfile(identity.user),
    memberships: identity.memberships.map((membership) => ({
      site: membership.slug,
      role: membership.role,
      tier: membership.tier,
      expires_at: membership.expiresAt,
    })),
  }),
);

export const PATCH = account(async ({ request, identity }) =>
  NextResponse.json({
    user: await updateProfile(identity.user.id, await jsonBody(request)),
  }),
);
