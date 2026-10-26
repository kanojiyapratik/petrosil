/**
 * Granting and removing access to the admin. Superadmins only.
 *
 * Access is a membership's role: "superadmin" (every brand), "staff" (one
 * brand, optionally narrowed by a named role) or "subscriber" (a reader). A
 * reader made staff keeps their subscription; staff removed go back to being
 * a reader, subscription intact.
 *
 * Someone new gets an account with no password and a one-week link to set
 * one. The link is mailed and, because mail may not leave the machine yet,
 * handed back to the superadmin to pass on by hand.
 *
 * The estate is never left without a superadmin: removing the last one is
 * refused, whoever asks.
 */

import { randomBytes } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, memberships, roles, sites, users } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { hashPassword } from "@/lib/auth/passwords";
import { queueMail } from "@/lib/mail/outbox";
import { checkPassword, readEmail } from "@/domain/accounts/policy";
import { issueToken, peekToken, spendToken } from "@/domain/accounts/tokens";
import { revokeSessions } from "@/lib/auth/session";

type Refused = { ok: false; message: string };

const onlySuperadmins: Refused = { ok: false, message: "Only a superadmin can change who has access." };

function appUrl(): string {
  return (process.env.PUBLIC_APP_URL ?? "http://localhost:3100").replace(/\/+$/, "");
}

async function audit(
  database: Database,
  guard: Guarded,
  action: string,
  userId: number,
  detail: Record<string, unknown>,
  ip: string | null | undefined,
) {
  await database.insert(auditLog).values({
    userId: guard.identity.user.id,
    action,
    entity: "user",
    entityId: userId,
    detail,
    ip: ip ?? null,
  });
}

export async function grantStaff(
  guard: Guarded,
  input: { email: string; name: string; grants: { site: string; roleId: number | null }[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ ok: true; userId: number; inviteUrl: string | null } | Refused> {
  if (!guard.isSuperadmin) {
    return onlySuperadmins;
  }

  const email = readEmail(input.email);

  if (!email) {
    return { ok: false, message: "That is not an email address." };
  }

  if (input.grants.length === 0) {
    return { ok: false, message: "Choose at least one brand." };
  }

  const brands = await database
    .select()
    .from(sites)
    .where(inArray(sites.slug, input.grants.map((grant) => grant.site)));

  if (brands.length !== new Set(input.grants.map((grant) => grant.site)).size) {
    return { ok: false, message: "One of those brands does not exist." };
  }

  const roleIds = input.grants.map((grant) => grant.roleId).filter((id): id is number => id !== null);

  if (roleIds.length > 0) {
    const found = await database.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds));

    if (found.length !== new Set(roleIds).size) {
      return { ok: false, message: "One of those roles does not exist." };
    }
  }

  let [person] = await database
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);

  let inviteUrl: string | null = null;
  const isNew = !person;

  if (!person) {
    [person] = await database
      .insert(users)
      .values({
        email,
        name: input.name.trim().slice(0, 191) || email,
        // Unusable until the invitation sets one.
        passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
      })
      .returning();
  }

  for (const grant of input.grants) {
    const brand = brands.find((row) => row.slug === grant.site)!;
    const [existing] = await database
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, person!.id), eq(memberships.siteId, brand.id)))
      .limit(1);

    if (existing?.role === "superadmin") {
      continue;
    }

    if (existing) {
      await database
        .update(memberships)
        .set({ role: "staff", roleId: grant.roleId, updatedAt: new Date() })
        .where(eq(memberships.id, existing.id));
    } else {
      await database
        .insert(memberships)
        .values({ userId: person!.id, siteId: brand.id, role: "staff", roleId: grant.roleId, tier: "free" });
    }
  }

  // Only an account made just now is invited: anyone who already had one has
  // a password they chose, or can reset it.
  if (isNew) {
    const token = await issueToken({ userId: person!.id, purpose: "staff_invite" }, database);

    inviteUrl = `${appUrl()}/set-password?token=${token}`;

    await queueMail(
      {
        to: person!.email,
        subject: "Your access to the Petrosil admin",
        template: "staff_invite",
        payload: { url: inviteUrl, name: person!.name, brands: brands.map((brand) => brand.name).join(", ") },
        userId: person!.id,
      },
      database,
    );
  }

  await audit(database, guard, "staff.grant", person!.id, { grants: input.grants }, context.ip);

  return { ok: true, userId: person!.id, inviteUrl };
}

async function superadminCount(database: Database, except?: number): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(distinct ${memberships.userId})` })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.role, "superadmin"),
        eq(users.status, "active"),
        except !== undefined ? ne(memberships.userId, except) : undefined,
      ),
    );

  return Number(row?.n ?? 0);
}

/** Back to an ordinary reader on one brand, or on all of them. */
export async function revokeStaff(
  guard: Guarded,
  userId: number,
  site: string | "all",
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ ok: true } | Refused> {
  if (!guard.isSuperadmin) {
    return onlySuperadmins;
  }

  const grants = await database
    .select({ membership: memberships, slug: sites.slug })
    .from(memberships)
    .innerJoin(sites, eq(sites.id, memberships.siteId))
    .where(and(eq(memberships.userId, userId), inArray(memberships.role, ["staff", "superadmin"])));

  const affected = grants.filter((grant) => site === "all" || grant.slug === site);

  if (affected.length === 0) {
    return { ok: false, message: "They have no access there to remove." };
  }

  // Superadmin is estate-wide: losing it on one brand loses it everywhere.
  const wasSuperadmin = grants.some((grant) => grant.membership.role === "superadmin");

  if (wasSuperadmin && (await superadminCount(database, userId)) === 0) {
    return { ok: false, message: "They are the last superadmin. Make someone else one first." };
  }

  const ids = (wasSuperadmin ? grants : affected).map((grant) => grant.membership.id);

  await database
    .update(memberships)
    .set({ role: "subscriber", roleId: null, updatedAt: new Date() })
    .where(inArray(memberships.id, ids));

  await audit(database, guard, "staff.revoke", userId, { site }, context.ip);

  return { ok: true };
}

/** Every brand, as superadmin. */
export async function makeSuperadmin(
  guard: Guarded,
  userId: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ ok: true } | Refused> {
  if (!guard.isSuperadmin) {
    return onlySuperadmins;
  }

  const [person] = await database.select().from(users).where(eq(users.id, userId)).limit(1);

  if (!person) {
    return { ok: false, message: "No such person." };
  }

  for (const brand of await database.select({ id: sites.id }).from(sites)) {
    const [existing] = await database
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.siteId, brand.id)))
      .limit(1);

    if (existing) {
      await database
        .update(memberships)
        .set({ role: "superadmin", roleId: null, updatedAt: new Date() })
        .where(eq(memberships.id, existing.id));
    } else {
      await database.insert(memberships).values({ userId, siteId: brand.id, role: "superadmin", tier: "free" });
    }
  }

  await audit(database, guard, "staff.superadmin", userId, {}, context.ip);

  return { ok: true };
}

/** The invitation link, spent: set the password, confirm the address. */
export async function acceptStaffInvite(
  token: string,
  password: string,
  database: Database = db(),
): Promise<{ ok: true } | Refused> {
  const pending = await peekToken(token, "staff_invite", database);
  const expired: Refused = { ok: false, message: "This link has been used or has expired. Ask for a new one." };

  if (!pending) {
    return expired;
  }

  const [person] = await database.select().from(users).where(eq(users.id, pending.userId)).limit(1);

  if (!person) {
    return expired;
  }

  const check = checkPassword(password, person.email);

  if (!check.ok) {
    return { ok: false, message: check.message };
  }

  // Spending is the atomic step: two submits at once, only one wins.
  if (!(await spendToken(token, "staff_invite", database))) {
    return expired;
  }

  await database
    .update(users)
    .set({ passwordHash: await hashPassword(password), emailVerifiedAt: person.emailVerifiedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(users.id, person.id));

  await revokeSessions(person.id);

  return { ok: true };
}
