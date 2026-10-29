/**
 * A subscriber's own details.
 *
 * What is *not* here matters more than what is. A person may change their
 * name, company and contact details. They may not change their email address
 * (it is their identity and would need re-confirming), their status (that is
 * staff's), or their tier — the old sites' profile update accepted the whole
 * request array, and `premium` was a column on the same table.
 */

import { eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { revokeSessions, type Identity } from "@/lib/auth/session";
import { AccountError, readCountry } from "./register";
import { checkPassword, readName, readText } from "./policy";

export type PublicProfile = {
  id: number;
  email: string;
  name: string;
  company: string | null;
  designation: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  website: string | null;
  email_verified: boolean;
  created_at: string;
};

/** Built field by field, so a column added later cannot leak by default. */
export const publicProfile = (user: typeof users.$inferSelect): PublicProfile => ({
  id: user.id,
  email: user.email,
  name: user.name,
  company: user.company,
  designation: user.designation,
  phone: user.phone,
  country: user.country,
  city: user.city,
  website: user.website,
  email_verified: user.emailVerifiedAt !== null,
  created_at: user.createdAt.toISOString(),
});

const EDITABLE = {
  company: 191,
  designation: 191,
  phone: 64,
  country: 96,
  city: 96,
  website: 191,
} as const;

export async function updateProfile(
  userId: number,
  body: Record<string, unknown>,
  database: Database = db(),
): Promise<PublicProfile> {
  const changes: Partial<typeof users.$inferInsert> = {};

  if (body.name !== undefined) {
    const name = readName(body.name);

    // Sent but blank is a mistake worth refusing: every screen that lists
    // people shows a name, and an empty one makes a row unidentifiable.
    if (!name) {
      throw new AccountError("Enter your name.", 422, "name");
    }

    changes.name = name;
  }

  for (const [field, max] of Object.entries(EDITABLE)) {
    if (body[field] !== undefined) {
      changes[field as keyof typeof EDITABLE] = field === "country" ? readCountry(body[field]) : readText(body[field], max);
    }
  }

  // An allow-list, so `email`, `status`, `tier` and anything else in the
  // request are not ignored by accident but by construction.
  if (Object.keys(changes).length > 0) {
    changes.updatedAt = new Date();

    await database.update(users).set(changes).where(eq(users.id, userId));
  }

  const [person] = await database.select().from(users).where(eq(users.id, userId)).limit(1);

  return publicProfile(person!);
}

/**
 * Change a password from inside a session.
 *
 * The current password is required even though the caller is already signed
 * in: a session cookie is something a borrowed laptop has, and the password
 * is the thing only its owner knows.
 */
export async function changePassword(
  identity: Identity,
  body: { current?: unknown; next?: unknown },
  database: Database = db(),
): Promise<void> {
  if (!(await verifyPassword(String(body.current ?? ""), identity.user.passwordHash))) {
    throw new AccountError("That is not your current password.", 401, "current");
  }

  const check = checkPassword(body.next, identity.user.email);

  if (!check.ok) {
    throw new AccountError(check.message, 422, "next");
  }

  await database
    .update(users)
    .set({ passwordHash: await hashPassword(String(body.next)), updatedAt: new Date() })
    .where(eq(users.id, identity.user.id));

  // Every other device, but not this one.
  await revokeSessions(identity.user.id, identity.sessionId, database);
}
