/**
 * Signing in, staying signed in, and signing out.
 *
 * Deliberately not Auth.js: the model here is one person with a membership
 * row per brand, every query has to be scoped by brand anyway, and the parts
 * that matter — the throttle, the scoping, re-hashing a migrated password —
 * are all ours either way. An explicit session table is a hundred lines we
 * can test without a browser, and it revokes server-side, which a
 * self-contained JWT cannot.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { loginAttempts, memberships, sessions, sites, users } from "@/db/schema";

import { hashPassword, isLegacyHash, verifyPassword } from "./passwords";

export const COOKIE = "petrosil_session";
export const SESSION_DAYS = 14;

/** Failed sign-ins allowed from one email, or one IP, before the door shuts. */
export const MAX_FAILURES = 8;
export const WINDOW_MINUTES = 15;

export type Membership = { siteId: number; slug: string; role: string; tier: string; expiresAt: string | null };

export type Identity = {
  user: typeof users.$inferSelect;
  sessionId: number;
  memberships: Membership[];
};

export class SignInError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 429,
    readonly reason: string,
  ) {
    super(message);
  }
}

const hash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/* ----------------------------------------------------------- signing in */

export async function signIn(
  credentials: { email: unknown; password: unknown },
  context: { ip?: string | null; userAgent?: string | null } = {},
  database: Database = db(),
): Promise<{ identity: Identity; token: string; expiresAt: Date }> {
  const email = String(credentials.email ?? "").trim().toLowerCase();
  const password = String(credentials.password ?? "");
  const ip = context.ip ?? null;

  if (email === "" || password === "") {
    await record(database, { email, ip, succeeded: false, reason: "missing" });
    throw new SignInError("Enter your email address and password.", 401, "missing");
  }

  if (await throttled(email, ip, database)) {
    // Deliberately says nothing about whether the account exists.
    throw new SignInError(
      "Too many attempts. Wait a few minutes and try again.",
      429,
      "throttled",
    );
  }

  const [user] = await database
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);

  // Both branches answer the same way: a different message for "no such
  // account" would turn this endpoint into a list of who holds a subscription.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    await record(database, { email, ip, userId: user?.id ?? null, succeeded: false, reason: "bad_credentials" });
    throw new SignInError("That email address and password do not match.", 401, "bad_credentials");
  }

  if (user.status !== "active") {
    await record(database, { email, ip, userId: user.id, succeeded: false, reason: "disabled" });
    throw new SignInError("That account is not active. Contact support.", 401, "disabled");
  }

  // A migrated `$2y$` hash at Laravel's cost 10 is upgraded the first time we
  // see the plaintext, which is the only moment we ever can.
  if (isLegacyHash(user.passwordHash)) {
    await database
      .update(users)
      .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  const [session] = await database
    .insert(sessions)
    .values({
      userId: user.id,
      tokenHash: hash(token),
      ip,
      userAgent: context.userAgent?.slice(0, 255) ?? null,
      expiresAt,
    })
    .returning();

  await database.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await record(database, { email, ip, userId: user.id, succeeded: true, reason: null });

  return {
    identity: { user, sessionId: session!.id, memberships: await membershipsFor(user.id, database) },
    token,
    expiresAt,
  };
}

async function throttled(email: string, ip: string | null, database: Database): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);

  const [byEmail] = await database
    .select({ n: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(sql`lower(${loginAttempts.email})`, email),
        eq(loginAttempts.succeeded, false),
        gt(loginAttempts.createdAt, since),
      ),
    );

  if ((byEmail?.n ?? 0) >= MAX_FAILURES) {
    return true;
  }

  if (!ip) {
    return false;
  }

  // An attacker spreading attempts across many accounts from one address is
  // the case the per-email counter alone would miss.
  const [byIp] = await database
    .select({ n: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.ip, ip),
        eq(loginAttempts.succeeded, false),
        gt(loginAttempts.createdAt, since),
      ),
    );

  return (byIp?.n ?? 0) >= MAX_FAILURES * 3;
}

async function record(
  database: Database,
  attempt: { email: string; ip: string | null; userId?: number | null; succeeded: boolean; reason: string | null },
): Promise<void> {
  await database.insert(loginAttempts).values({
    email: attempt.email.slice(0, 191),
    ip: attempt.ip,
    userId: attempt.userId ?? null,
    succeeded: attempt.succeeded,
    reason: attempt.reason,
  });
}

/* --------------------------------------------------------- staying in */

export async function identify(
  token: string | null | undefined,
  database: Database = db(),
): Promise<Identity | null> {
  if (!token) {
    return null;
  }

  const [row] = await database
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash(token)), isNull(sessions.revokedAt)))
    .limit(1);

  if (!row || row.session.expiresAt.getTime() < Date.now() || row.user.status !== "active") {
    return null;
  }

  // Not awaited: last-seen bookkeeping must never fail the request it records.
  void database
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, row.session.id))
    .catch(() => {});

  return {
    user: row.user,
    sessionId: row.session.id,
    memberships: await membershipsFor(row.user.id, database),
  };
}

export async function signOut(token: string | null | undefined, database: Database = db()): Promise<void> {
  if (!token) {
    return;
  }

  await database
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, hash(token)));
}

/**
 * Throw out every session this account holds.
 *
 * Called after a password reset: whoever took the password may also be
 * holding a stolen cookie, and a reset that leaves old sessions alive fixes
 * nothing. `keep` spares the session making the change, so someone changing
 * their own password from a settings screen is not signed out of it.
 */
export async function revokeSessions(
  userId: number,
  keep: number | null = null,
  database: Database = db(),
): Promise<void> {
  await database
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        keep === null ? undefined : sql`${sessions.id} <> ${keep}`,
      ),
    );
}

export async function membershipsFor(userId: number, database: Database = db()): Promise<Membership[]> {
  const rows = await database
    .select({
      siteId: memberships.siteId,
      slug: sites.slug,
      role: memberships.role,
      tier: memberships.tier,
      expiresAt: memberships.expiresAt,
    })
    .from(memberships)
    .innerJoin(sites, eq(sites.id, memberships.siteId))
    .where(eq(memberships.userId, userId))
    .orderBy(sites.slug);

  return rows;
}

/** Recent sign-ins, for the dashboard's login log. */
export async function recentLogins(limit = 50, database: Database = db()) {
  return database
    .select()
    .from(loginAttempts)
    .orderBy(desc(loginAttempts.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
}

export const sessionCookie = (token: string, expiresAt: Date) => ({
  name: COOKIE,
  value: token,
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  // Set over plain HTTP in development only; Railway terminates TLS.
  secure: process.env.NODE_ENV === "production",
  expires: expiresAt,
});
