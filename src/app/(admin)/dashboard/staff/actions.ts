"use server";

/** Granting and removing access. The rules — superadmins only, never the last one — are in `domain/staff/manage.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { grantStaff, makeSuperadmin, revokeStaff } from "@/domain/staff/manage";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type StaffResult = { error?: string; saved?: string; inviteUrl?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

export async function grantAction(_state: unknown, form: FormData): Promise<StaffResult> {
  const viewer = await staff();
  const roleRaw = String(form.get("role") ?? "");
  const roleId = roleRaw === "" ? null : Number(roleRaw);

  const result = await grantStaff(
    viewer,
    {
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
      grants: form.getAll("site").map((site) => ({ site: String(site), roleId })),
    },
    { ip: await callerIp() },
  );

  revalidatePath("/dashboard/staff");

  if (!result.ok) {
    return { error: result.message };
  }

  return result.inviteUrl
    ? { saved: "Access granted. They have been mailed this link to set a password:", inviteUrl: result.inviteUrl }
    : { saved: "Access granted. They already had an account, so they sign in as before." };
}

export async function revokeAction(form: FormData) {
  const viewer = await staff();

  await revokeStaff(viewer, Number(form.get("user")), String(form.get("site") ?? "all"), { ip: await callerIp() });
  revalidatePath("/dashboard/staff");
}

export async function superadminAction(form: FormData) {
  const viewer = await staff();

  await makeSuperadmin(viewer, Number(form.get("user")), { ip: await callerIp() });
  revalidatePath("/dashboard/staff");
}
