/**
 * Named roles: a name and the permissions it grants. Superadmins only.
 *
 * Only permissions in the catalogue may be granted: a permission nothing
 * checks is not a permission. The old role editor grouped its checkboxes by
 * a hard-coded list that left out the five newest, so they could not be
 * granted at all; the screen here draws from the catalogue itself.
 */

import { and, eq, ne, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, memberships, rolePermissions, roles } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { PERMISSION_KEYS } from "@/domain/dashboard/permissions";

type Result = { ok: true; id: number } | { ok: false; message: string };

export async function saveRole(
  guard: Guarded,
  input: { id?: number | null; name: string; description?: string | null; permissions: string[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<Result> {
  if (!guard.isSuperadmin) {
    return { ok: false, message: "Only a superadmin can change roles." };
  }

  const name = input.name.trim();

  if (!name) {
    return { ok: false, message: "A role needs a name." };
  }

  const known = new Set(PERMISSION_KEYS);
  const unknown = input.permissions.filter((permission) => !known.has(permission));

  if (unknown.length > 0) {
    return { ok: false, message: `Not a permission this platform checks: ${unknown.join(", ")}.` };
  }

  const [clash] = await database
    .select({ id: roles.id })
    .from(roles)
    .where(and(sql`lower(${roles.name}) = ${name.toLowerCase()}`, input.id ? ne(roles.id, input.id) : undefined))
    .limit(1);

  if (clash) {
    return { ok: false, message: "There is already a role with that name." };
  }

  const permissions = [...new Set(input.permissions)].sort();

  const id = await database.transaction(async (tx) => {
    let roleId = input.id ?? null;

    if (roleId) {
      const [existing] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);

      if (!existing) {
        return null;
      }

      await tx.update(roles).set({ name: name.slice(0, 96), description: input.description ?? null }).where(eq(roles.id, roleId));
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    } else {
      const [made] = await tx
        .insert(roles)
        .values({ name: name.slice(0, 96), description: input.description ?? null })
        .returning({ id: roles.id });

      roleId = made!.id;
    }

    if (permissions.length > 0) {
      await tx.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: roleId!, permission })));
    }

    await tx.insert(auditLog).values({
      userId: guard.identity.user.id,
      action: input.id ? "role.save" : "role.create",
      entity: "role",
      entityId: roleId,
      detail: { name, permissions },
      ip: context.ip ?? null,
    });

    return roleId;
  });

  return id ? { ok: true, id } : { ok: false, message: "That role no longer exists." };
}

export async function deleteRole(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!guard.isSuperadmin) {
    return { ok: false, message: "Only a superadmin can change roles." };
  }

  const [held] = await database
    .select({ n: sql<number>`count(*)` })
    .from(memberships)
    .where(eq(memberships.roleId, id));

  if (Number(held?.n ?? 0) > 0) {
    return { ok: false, message: "Someone holds this role. Give them another one first." };
  }

  await database.delete(roles).where(eq(roles.id, id));
  await database.insert(auditLog).values({
    userId: guard.identity.user.id,
    action: "role.delete",
    entity: "role",
    entityId: id,
    detail: {},
    ip: context.ip ?? null,
  });

  return { ok: true };
}
