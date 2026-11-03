/**
 * Staff correcting a member's details: the old directory editor.
 *
 * The fields a member may change themselves, plus the address and postcode
 * the directory shows. Not the email: it is their sign-in, so it has its own
 * step (changeMemberEmail, below). Not their standing: tier and expiry are
 * the membership editor's, status the account controls'.
 *
 * Staff may edit a member who reads one of their brands. Another staff
 * member's record is a superadmin's to change, so brand staff cannot rename
 * a colleague.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, authTokens, memberships, users } from "@/db/schema";
import { AccessError, type Guarded } from "@/lib/auth/guard";
import { AccountError, readCountry } from "@/domain/accounts/register";
import { readEmail, readName, readText } from "@/domain/accounts/policy";
import { can } from "@/domain/staff/permissions";

const EDITABLE = {
  company: 191,
  designation: 191,
  phone: 64,
  country: 96,
  city: 96,
  website: 191,
  address: 2000,
  postcode: 32,
  state: 96,
  // The migration cuts the old text at 6,000 characters; the same cap here.
  about: 6000,
} as const;

type Editable = keyof typeof EDITABLE;

export type MemberDetails = {
  id: number;
  name: string;
} & Record<Editable, string | null>;

const details = (row: typeof users.$inferSelect): MemberDetails => ({
  id: row.id,
  name: row.name,
  company: row.company,
  designation: row.designation,
  phone: row.phone,
  country: row.country,
  city: row.city,
  website: row.website,
  address: row.address,
  postcode: row.postcode,
  state: row.state,
  about: row.about,
});

/**
 * The member, when they are this editor's to change; null when not. Throws
 * when they are, but the editor's role does not allow changing people.
 */
async function memberToChange(guard: Guarded, userId: number, database: Database): Promise<typeof users.$inferSelect | null> {
  const [person] = await database.select().from(users).where(eq(users.id, userId)).limit(1);

  if (!person) {
    return null;
  }

  if (!guard.isSuperadmin) {
    const held = await database.select().from(memberships).where(eq(memberships.userId, userId));

    // A colleague's record is a superadmin's to change.
    if (held.some((row) => row.role === "staff" || row.role === "superadmin")) {
      return null;
    }

    const shared = held.filter((row) => guard.siteIds.includes(row.siteId));

    if (shared.length === 0) {
      return null;
    }

    let allowed = false;

    for (const row of shared) {
      allowed = allowed || (await can(guard, row.siteId, "user-edit", database));
    }

    if (!allowed) {
      throw new AccessError("Your role does not allow this: change people.", 403);
    }
  }

  return person;
}

/** The editor's brands among the member's, for the audit trail: [null] for a superadmin's change. */
async function trailBrands(guard: Guarded, userId: number, database: Database): Promise<(number | null)[]> {
  if (guard.isSuperadmin) {
    return [null];
  }

  const rows = await database
    .select({ siteId: memberships.siteId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), inArray(memberships.siteId, guard.siteIds)));

  return rows.map((row) => row.siteId);
}

/** Null when the member is not this editor's to change. */
export async function editMember(
  guard: Guarded,
  userId: number,
  body: Partial<Record<Editable | "name", unknown>>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<MemberDetails | null> {
  const person = await memberToChange(guard, userId, database);

  if (!person) {
    return null;
  }

  const changes: Partial<typeof users.$inferInsert> = {};

  if (body.name !== undefined) {
    const name = readName(body.name);

    if (!name) {
      throw new AccountError("A member needs a name.", 422, "name");
    }

    changes.name = name;
  }

  for (const [field, max] of Object.entries(EDITABLE) as [Editable, number][]) {
    if (body[field] !== undefined) {
      changes[field] = field === "country" ? readCountry(body[field]) : readText(body[field], max);
    }
  }

  const changed = Object.fromEntries(
    Object.entries(changes)
      .filter(([field, value]) => person[field as keyof typeof person] !== value)
      .map(([field, value]) => [field, { from: person[field as keyof typeof person], to: value }]),
  );

  if (Object.keys(changed).length > 0) {
    await database.update(users).set({ ...changes, updatedAt: new Date() }).where(eq(users.id, userId));

    // Recorded against each of the member's brands the editor works on, so it
    // shows in those brands' trails.
    const brands = await trailBrands(guard, userId, database);

    await database.insert(auditLog).values(
      brands.map((siteId) => ({
        siteId,
        userId: guard.identity.user.id,
        action: "member.edit",
        entity: "user",
        entityId: userId,
        detail: { changed },
        ip: context.ip ?? null,
      })),
    );
  }

  const [after] = await database.select().from(users).where(eq(users.id, userId)).limit(1);

  return details(after!);
}

/**
 * Staff changing a member's email address: their sign-in.
 *
 * Its own step, not a field of the details form, because of what goes with
 * it. The new address must be no one else's (two people on one sign-in would
 * be one account). Any reset or confirmation link already mailed to the old
 * address stops working, so whoever still reads that inbox cannot use one to
 * get in. Staff change it on the member's word, as the old admin let them, so
 * the account's confirmed standing is kept and they sign in with the new
 * address straight away.
 *
 * Null when the member is not this editor's to change.
 */
export async function changeMemberEmail(
  guard: Guarded,
  userId: number,
  value: unknown,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ id: number; email: string } | null> {
  const person = await memberToChange(guard, userId, database);

  if (!person) {
    return null;
  }

  const email = readEmail(value);

  if (!email) {
    throw new AccountError("Enter a valid email address.", 422, "email");
  }

  if (email === person.email) {
    throw new AccountError("That is already their email address.", 422, "email");
  }

  const [taken] = await database.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  if (taken) {
    throw new AccountError("Another account already signs in with that address.", 409, "email");
  }

  try {
    await database.transaction(async (tx) => {
      await tx.update(users).set({ email, updatedAt: new Date() }).where(eq(users.id, userId));
      await tx
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(authTokens.userId, userId), isNull(authTokens.usedAt)));

      const brands = await trailBrands(guard, userId, tx as unknown as Database);

      await tx.insert(auditLog).values(
        brands.map((siteId) => ({
          siteId,
          userId: guard.identity.user.id,
          action: "member.email",
          entity: "user",
          entityId: userId,
          detail: { changed: { email: { from: person.email, to: email } } },
          ip: context.ip ?? null,
        })),
      );
    });
  } catch (error) {
    // Someone else took the address between the check and the write.
    const failure = error as { code?: string; cause?: { code?: string } };

    if (failure.code === "23505" || failure.cause?.code === "23505") {
      throw new AccountError("Another account already signs in with that address.", 409, "email");
    }

    throw error;
  }

  return { id: userId, email };
}
