"use server";

/** Correcting a member's details. The rules are in `domain/clients/profile.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { editMember } from "@/domain/clients/profile";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type MemberResult = { error?: string; field?: string; saved?: string } | null;

const FIELDS = ["name", "company", "designation", "phone", "country", "city", "address", "postcode", "website"] as const;

export async function editMemberAction(_state: unknown, form: FormData): Promise<MemberResult> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const id = Number(form.get("user_id"));

  try {
    const saved = await editMember(
      viewer,
      id,
      Object.fromEntries(FIELDS.map((field) => [field, String(form.get(field) ?? "")])),
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "This person's details are not yours to change." };
    }
  } catch (error) {
    if (error instanceof AccountError || error instanceof AccessError) {
      return { error: error.message, field: error instanceof AccountError ? (error.field ?? undefined) : undefined };
    }

    console.error("could not edit a member", { id, error });

    return { error: "Something went wrong. Nothing was saved." };
  }

  revalidatePath(`/dashboard/clients/${id}`);

  return { saved: "Saved." };
}
