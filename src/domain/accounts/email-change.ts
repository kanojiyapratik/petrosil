/**
 * A member moving their own sign-in to a new email address.
 *
 * Two steps, because the address is their identity:
 *
 * 1. Asking. Needs the current password (a signed-in laptop is something a
 *    borrower has; the password is what only the owner knows) and mails a
 *    one-shot link to the NEW address. Nothing changes yet.
 * 2. Confirming. Pressing the button behind that link moves the sign-in.
 *    Only someone who reads the new inbox can do it, so a typo cannot lock a
 *    member out and nobody can claim an address that is not theirs.
 *
 * The rule from registering holds here too: the reply never says whether
 * the new address already has an account. When it does, nothing changes and
 * that inbox gets a note saying so, the way a second registration does.
 *
 * Staff changing it for a member on their word is a different path
 * (changeMemberEmail in domain/clients/profile.ts) and does not mail a link.
 */

import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, authTokens, sites, users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/passwords";
import type { Identity } from "@/lib/auth/session";
import { queueMail } from "@/lib/mail/outbox";
import { readEmail } from "./policy";
import { AccountError } from "./register";
import { issueToken, peekToken, spendToken } from "./tokens";

const expired = () => new AccountError("That link is no longer valid. Sign in and ask again.", 400);

const taken = () =>
  new AccountError("That address now has an account of its own, so your email address was not changed.", 409);

async function brandFor(siteId: number | null | undefined, database: Database) {
  if (!siteId) {
    return null;
  }

  const [brand] = await database.select({ id: sites.id, slug: sites.slug, name: sites.name }).from(sites).where(eq(sites.id, siteId)).limit(1);

  return brand ?? null;
}

/**
 * Step 1. Resolves the same way whether or not the new address is free; the
 * mail that goes to it differs.
 */
export async function requestEmailChange(
  identity: Identity,
  body: { password?: unknown; email?: unknown },
  context: { siteId?: number | null } = {},
  database: Database = db(),
): Promise<void> {
  if (!(await verifyPassword(String(body.password ?? ""), identity.user.passwordHash))) {
    throw new AccountError("That is not your current password.", 401, "password");
  }

  const email = readEmail(body.email);

  if (!email) {
    throw new AccountError("Enter a valid email address.", 422, "email");
  }

  if (email === identity.user.email) {
    throw new AccountError("That is already your email address.", 422, "email");
  }

  const brand = await brandFor(context.siteId, database);
  const brandPart = { site: brand?.slug ?? null, siteName: brand?.name ?? null };
  const [other] = await database.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  if (other) {
    await queueMail(
      {
        to: email,
        subject: "Your email address was not changed",
        template: "change_email_taken",
        payload: brandPart,
        siteId: brand?.id ?? null,
        userId: other.id,
      },
      database,
    );

    return;
  }

  // Only the newest request counts: an earlier link, perhaps to a mistyped
  // address, stops working the moment a new one is asked for.
  await database
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.userId, identity.user.id), eq(authTokens.purpose, "change_email"), isNull(authTokens.usedAt)));

  const token = await issueToken(
    { userId: identity.user.id, purpose: "change_email", siteId: brand?.id ?? null, newEmail: email },
    database,
  );

  await queueMail(
    {
      to: email,
      subject: brand ? `Confirm your new email address for ${brand.name}` : "Confirm your new email address",
      template: "change_email",
      payload: { token, name: identity.user.name, ...brandPart },
      siteId: brand?.id ?? null,
      userId: identity.user.id,
    },
    database,
  );
}

/**
 * Step 2: spend the link and move the sign-in. The new address counts as
 * confirmed (opening that inbox is what proved it), every other link still
 * out for the account stops working, and the old address is told.
 */
export async function confirmEmailChange(
  token: unknown,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ email: string }> {
  const pending = await peekToken(token, "change_email", database);

  if (!pending?.newEmail) {
    throw expired();
  }

  const email = pending.newEmail;
  const [person] = await database.select().from(users).where(eq(users.id, pending.userId)).limit(1);

  if (!person || person.status !== "active") {
    throw expired();
  }

  const [other] = await database.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  if (other && other.id !== person.id) {
    throw taken();
  }

  try {
    await database.transaction(async (tx) => {
      const scoped = tx as unknown as Database;

      // The atomic step: two presses arriving together, only one moves anything.
      if (!(await spendToken(token, "change_email", scoped))) {
        throw expired();
      }

      await tx.update(users).set({ email, emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, person.id));

      // A reset link sitting in the old inbox must not be a way back in.
      await tx
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(authTokens.userId, person.id), isNull(authTokens.usedAt)));

      await tx.insert(auditLog).values({
        siteId: pending.siteId,
        userId: person.id,
        action: "member.email",
        entity: "user",
        entityId: person.id,
        detail: { changed: { email: { from: person.email, to: email } }, by: "member" },
        ip: context.ip ?? null,
      });
    });
  } catch (error) {
    // Someone registered the address between the check and the write.
    const failure = error as { code?: string; cause?: { code?: string } };

    if (failure.code === "23505" || failure.cause?.code === "23505") {
      throw taken();
    }

    throw error;
  }

  const brand = await brandFor(pending.siteId, database);

  await queueMail(
    {
      to: person.email,
      subject: "Your email address has been changed",
      template: "email_changed",
      payload: { name: person.name, newEmail: email, site: brand?.slug ?? null, siteName: brand?.name ?? null },
      siteId: brand?.id ?? null,
      userId: person.id,
    },
    database,
  );

  return { email };
}

/** The address a member has asked to move to and not yet confirmed, if any. */
export async function pendingEmailChange(userId: number, database: Database = db()): Promise<string | null> {
  const [row] = await database
    .select({ newEmail: authTokens.newEmail })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, "change_email"),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(authTokens.id))
    .limit(1);

  return row?.newEmail ?? null;
}
