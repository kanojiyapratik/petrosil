"use server";

/** Saving and deleting roles. Superadmins only; see `domain/staff/roles.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { deleteRole, saveRole } from "@/domain/staff/roles";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type RoleResult = { error?: string; saved?: string } | null;

export async function saveRoleAction(_state: unknown, form: FormData): Promise<RoleResult> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const id = Number(form.get("id"));
  const result = await saveRole(
    viewer,
    {
      id: Number.isInteger(id) && id > 0 ? id : null,
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? "").trim() || null,
      permissions: form.getAll("permission").map(String),
    },
    { ip: await callerIp() },
  );

  revalidatePath("/dashboard/roles");

  return result.ok ? { saved: "Saved." } : { error: result.message };
}

export async function deleteRoleAction(_state: unknown, form: FormData): Promise<RoleResult> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const result = await deleteRole(viewer, Number(form.get("id")), { ip: await callerIp() });

  revalidatePath("/dashboard/roles");

  return result.ok ? { saved: "Deleted." } : { error: result.message };
}
