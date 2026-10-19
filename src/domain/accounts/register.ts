/**
 * Registering, confirming an address, and the forgotten-password round trip.
 *
 * One rule shapes every function here: **nothing an unauthenticated caller
 * can do may reveal whether an address has an account.** The old sites had a
 * `checkemail` endpoint that answered precisely that, and a register form
 * that said "already taken", so the subscriber list was enumerable by anyone
 * with a word list. Here the known and unknown cases take different actions
 * and return identical replies.
 */

import { and, eq, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { memberships, sites, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { queueMail } from "@/lib/mail/outbox";
import { issueToken } from "./tokens";
import { checkPassword, readEmail, readName, readText } from "./policy";

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 422,
    readonly field?: string,
  ) {
    super(message);
  }
}

export type RegisterInput = {
  site?: unknown;
  email?: unknown;
  password?: unknown;
  name?: unknown;
  company?: unknown;
  designation?: unknown;
  phone?: unknown;
  country?: unknown;
  city?: unknown;
};

/**
 * The reply is the same either way, so callers get nothing back worth
 * branching on. The work differs: a new address becomes an account with a
 * confirmation link, a known one gets the brand added to the account it
 * already has and a mail saying so.
 */
export async function register(
  input: RegisterInput,
  database: Database = db(),
): Promise<void> {
  const email = readEmail(input.email);
  const name = readName(input.name);

  if (!email) {
    throw new AccountError("Enter an email address we can reach you at.", 422, "email");
  }

  if (!name) {
    throw new AccountError("Enter your name.", 422, "name");
  }

  const password = checkPassword(input.password, email);

  if (!password.ok) {
    throw new AccountError(password.message, 422, "password");
  }

  const [brand] = await database
    .select()
    .from(sites)
    .where(and(eq(sites.slug, String(input.site ?? "")), eq(sites.enabled, true)))
    .limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  const [found] = await database
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);

  if (found) {
    // Not an error, and not a password change. Someone registering again is
    // usually someone who forgot they had an account; the brand they asked
    // for is added so "one login, two brands" holds, and the mail points
    // them at signing in or resetting.
    await grant(found.id, brand.id, database);

    await queueMail(
      {
        to: found.email,
        subject: `You already have a ${brand.name} account`,
        template: "account_exists",
        payload: { site: brand.slug, siteName: brand.name },
        siteId: brand.id,
        userId: found.id,
      },
      database,
    );

    return;
  }

  const [person] = await database
    .insert(users)
    .values({
      // Folded on the way in: the sign-in path looks up lower(email), and
      // case-duplicate rows are exactly what the migration had to clean up.
      email,
      name,
      company: readText(input.company, 191),
      designation: readText(input.designation, 191),
      phone: readText(input.phone, 64),
      country: readText(input.country, 96),
      city: readText(input.city, 96),
      passwordHash: await hashPassword(String(input.password)),
    })
    .returning();

  await grant(person!.id, brand.id, database);

  const token = await issueToken(
    { userId: person!.id, purpose: "verify_email", siteId: brand.id },
    database,
  );

  await queueMail(
    {
      to: person!.email,
      subject: `Confirm your email address for ${brand.name}`,
      template: "verify_email",
      payload: { token, site: brand.slug, siteName: brand.name, name: person!.name },
      siteId: brand.id,
      userId: person!.id,
    },
    database,
  );
}

/** A free reader on that brand, and never a downgrade of what they already hold. */
async function grant(userId: number, siteId: number, database: Database): Promise<void> {
  const [existing] = await database
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.siteId, siteId)))
    .limit(1);

  if (existing) {
    return;
  }

  await database
    .insert(memberships)
    .values({ userId, siteId, role: "subscriber", tier: "free" });
}

/* -------------------------------------------------------- confirming an address */

export async function confirmEmail(userId: number, database: Database = db()): Promise<void> {
  await database
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/* ------------------------------------------------------- forgotten password */

/**
 * Issues a reset link when the address has an active account, and does
 * nothing at all when it does not. The caller answers the same either way,
 * which is the whole point.
 */
export async function requestPasswordReset(
  input: { email?: unknown; site?: unknown },
  database: Database = db(),
): Promise<void> {
  const email = readEmail(input.email);

  if (!email) {
    return;
  }

  const [person] = await database
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);

  // A disabled account gets no link either: a reset must not be a way back
  // into an account staff switched off.
  if (!person || person.status !== "active") {
    return;
  }

  const [brand] = input.site
    ? await database
        .select()
        .from(sites)
        .where(and(eq(sites.slug, String(input.site)), eq(sites.enabled, true)))
        .limit(1)
    : [undefined];

  const token = await issueToken(
    { userId: person.id, purpose: "reset_password", siteId: brand?.id ?? null },
    database,
  );

  await queueMail(
    {
      to: person.email,
      subject: "Set a new password",
      template: "reset_password",
      payload: { token, name: person.name, site: brand?.slug ?? null },
      siteId: brand?.id ?? null,
      userId: person.id,
    },
    database,
  );
}
