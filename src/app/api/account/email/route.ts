/**
 * POST /api/account/email — ask to move my sign-in to a new address.
 *
 * Body: { email, password, site? }. Needs the current password, and mails a
 * link to the new address; nothing changes until that link is used. The
 * reply is the same whether or not the new address already has an account.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { sites } from "@/db/schema";
import { account, jsonBody } from "@/lib/auth/account";
import { requestEmailChange } from "@/domain/accounts/email-change";

export const dynamic = "force-dynamic";

export const POST = account(async ({ request, identity }) => {
  const body = await jsonBody(request);
  const [brand] = body.site
    ? await db()
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.slug, String(body.site)), eq(sites.enabled, true)))
        .limit(1)
    : [undefined];

  await requestEmailChange(identity, { email: body.email, password: body.password }, { siteId: brand?.id ?? null });

  return NextResponse.json(
    { message: "Check the inbox of your new address: the change happens when you use the link we sent there." },
    { status: 202 },
  );
});
