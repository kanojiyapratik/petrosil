"use server";

/**
 * Saving a system mail template. Thin: `saveMailTemplate` holds the brand
 * check, the two rules and the audit entry; this turns the form into its
 * arguments and reports back the placeholders the mail will not fill.
 */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { saveMailTemplate } from "@/domain/content/mail-templates";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type TemplateResult = { error?: string; saved?: string; warning?: string } | null;

export async function saveTemplate(_state: unknown, form: FormData): Promise<TemplateResult> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const result = await saveMailTemplate(
    viewer,
    {
      id: Number(form.get("id")),
      subject: String(form.get("subject") ?? ""),
      body: String(form.get("body") ?? ""),
      // An unticked checkbox posts nothing, which is "off", not "unchanged".
      enabled: form.get("enabled") === "on",
    },
    { ip: await callerIp() },
  );

  revalidatePath("/dashboard/sites/[slug]/settings/mail-templates", "page");

  if (!result.ok) {
    return { error: result.message };
  }

  return result.unknown.length > 0
    ? {
        saved: "Saved.",
        warning: `This mail never fills ${result.unknown.map((name) => `{${name}}`).join(", ")}, so readers would see it as typed.`,
      }
    : { saved: "Saved." };
}
