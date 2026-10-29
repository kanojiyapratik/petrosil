/**
 * Staff correcting a member's details: the old directory editor.
 *
 * The fields a member may change themselves, plus the address and postcode
 * the directory shows. Not the email: it is their sign-in, and changing it
 * needs the new address confirmed. Not their standing: tier and expiry are
 * the membership editor's, status the account controls'.
 *
 * Staff may edit a member who reads one of their brands. Another staff
 * member's record is a superadmin's to change, so brand staff cannot rename
 * a colleague.
 */

import { and, eq, inArray } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, memberships, users } from "@/db/schema";
import { AccessError, type Guarded } from "@/lib/auth/guard";
import { AccountError, readCountry } from "@/domain/accounts/register";
import { readName, readText } from "@/domain/accounts/policy";
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
});

/** Null when the member is not this editor's to change. */
export async function editMember(
  guard: Guarded,
  userId: number,
  body: Partial<Record<Editable | "name", unknown>>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<MemberDetails | null> {
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
    const brands = guard.isSuperadmin
      ? [null]
      : (
          await database
            .select({ siteId: memberships.siteId })
            .from(memberships)
            .where(and(eq(memberships.userId, userId), inArray(memberships.siteId, guard.siteIds)))
        ).map((row) => row.siteId);

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
