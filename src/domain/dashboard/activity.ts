/**
 * The audit trail and the login log.
 *
 * The old sites spread this across audit columns on forty tables plus a
 * `loginlogs` table per brand, so "who changed that, and when" meant knowing
 * which panel to open. Here both are one query, scoped to the brands the
 * viewer may see.
 */

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, loginAttempts, sites, users } from "@/db/schema";

export type AuditRow = {
  id: number;
  at: string;
  who: string | null;
  by_token: boolean;
  site: string | null;
  action: string;
  entity: string | null;
  entity_id: number | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
};

export async function auditTrail(
  siteIds: number[],
  options: { site?: string; action?: string; limit?: number } = {},
  database: Database = db(),
): Promise<AuditRow[]> {
  let scope = siteIds;

  if (options.site) {
    const [site] = await database.select().from(sites).where(eq(sites.slug, options.site)).limit(1);

    if (!site || (siteIds.length > 0 && !siteIds.includes(site.id))) {
      return [];
    }

    scope = [site.id];
  }

  const rows = await database
    .select({ entry: auditLog, who: users.name, slug: sites.slug })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(sites, eq(sites.id, auditLog.siteId))
    .where(
      and(
        scope.length > 0
          ? // An estate-wide entry (site_id null) is only for superadmins,
            // who carry an empty scope and never reach this branch.
            inArray(auditLog.siteId, scope)
          : undefined,
        options.action ? eq(auditLog.action, options.action) : undefined,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(Math.min(500, Math.max(1, options.limit ?? 100)));

  return rows.map(({ entry, who, slug }) => ({
    id: entry.id,
    at: entry.createdAt.toISOString(),
    who,
    // A row with no user but a token is the price module acting on its own.
    by_token: entry.userId === null && entry.tokenId !== null,
    site: slug,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entityId,
    detail: entry.detail ?? null,
    ip: entry.ip,
  }));
}

export type LoginRow = {
  id: number;
  at: string;
  email: string;
  who: string | null;
  ok: boolean;
  reason: string | null;
  ip: string | null;
};

/**
 * Sign-ins, newest first.
 *
 * Scoped like everything else: a staff member of one brand sees attempts by
 * people who hold that brand, plus the anonymous failures — which is what
 * makes the log useful for spotting someone working through a password list,
 * without turning it into a directory of other brands' subscribers.
 */
export async function loginLog(
  siteIds: number[],
  options: { onlyFailures?: boolean; limit?: number } = {},
  database: Database = db(),
): Promise<LoginRow[]> {
  const scoped =
    siteIds.length === 0
      ? undefined
      : or(
          isNull(loginAttempts.userId),
          sql`exists (
            select 1 from memberships m
            where m.user_id = ${loginAttempts.userId}
              and m.site_id in ${siteIds}
          )`,
        );

  const rows = await database
    .select({ attempt: loginAttempts, who: users.name })
    .from(loginAttempts)
    .leftJoin(users, eq(users.id, loginAttempts.userId))
    .where(and(scoped, options.onlyFailures ? eq(loginAttempts.succeeded, false) : undefined))
    .orderBy(desc(loginAttempts.id))
    .limit(Math.min(500, Math.max(1, options.limit ?? 100)));

  return rows.map(({ attempt, who }) => ({
    id: attempt.id,
    at: attempt.createdAt.toISOString(),
    email: attempt.email,
    who,
    ok: attempt.succeeded,
    reason: attempt.reason,
    ip: attempt.ip,
  }));
}
