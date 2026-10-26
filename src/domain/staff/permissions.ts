/**
 * Whether a person may do one thing on one brand.
 *
 * - A superadmin may do anything, anywhere.
 * - Staff may act only on brands they were granted.
 * - On such a brand, staff with no named role keep what staff have always
 *   had here: everything. A named role narrows that to exactly its
 *   permissions.
 *
 * The old sites had 93 permissions and checked them on some screens: the
 * price grid, report sending and the settings screen had no gate at all.
 * `requirePermission` is called where the work is done, so a refusal holds
 * whichever screen or request asked.
 */

import { and, eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { memberships, rolePermissions } from "@/db/schema";
import { AccessError, type Guarded } from "@/lib/auth/guard";
import { labelFor } from "@/domain/dashboard/permissions";

type Who = Pick<Guarded, "identity" | "siteIds" | "isSuperadmin">;

export async function can(guard: Who, siteId: number, permission: string, database: Database = db()): Promise<boolean> {
  if (guard.isSuperadmin) {
    return true;
  }

  if (!guard.siteIds.includes(siteId)) {
    return false;
  }

  const [grant] = await database
    .select({ roleId: memberships.roleId })
    .from(memberships)
    .where(and(eq(memberships.userId, guard.identity.user.id), eq(memberships.siteId, siteId)))
    .limit(1);

  if (!grant?.roleId) {
    return true;
  }

  const [held] = await database
    .select({ id: rolePermissions.id })
    .from(rolePermissions)
    .where(and(eq(rolePermissions.roleId, grant.roleId), eq(rolePermissions.permission, permission)))
    .limit(1);

  return held !== undefined;
}

/** Throws a 403 unless `can`. The message names what was missing. */
export async function requirePermission(
  guard: Who,
  siteId: number,
  permission: string,
  database: Database = db(),
): Promise<void> {
  if (!(await can(guard, siteId, permission, database))) {
    throw new AccessError(`Your role does not allow this: ${labelFor(permission).toLowerCase()}.`, 403);
  }
}

/** For server actions: a refusal as a message to show, anything else rethrown. */
export function refusal(error: unknown): string {
  if (error instanceof AccessError) {
    return error.message;
  }

  throw error;
}
