"use server";

/** Spending a staff invitation: see `acceptStaffInvite`. */

import { acceptStaffInvite } from "@/domain/staff/manage";

export type SetPasswordResult = { error?: string; done?: boolean } | null;

export async function setPasswordAction(_state: unknown, form: FormData): Promise<SetPasswordResult> {
  const password = String(form.get("password") ?? "");

  if (password !== String(form.get("again") ?? "")) {
    return { error: "The two passwords are not the same." };
  }

  const result = await acceptStaffInvite(String(form.get("token") ?? ""), password);

  return result.ok ? { done: true } : { error: result.message };
}
