"use server";

/** Saving and deleting a newsletter template. The rules are in `domain/content/newsletter-templates.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { deleteTemplate, saveTemplate } from "@/domain/content/newsletter-templates";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type TemplateFormResult = { error?: string; field?: string; saved?: string; warning?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function failed(error: unknown, what: string): TemplateFormResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not ${what} a newsletter template`, { error });

  return { error: "Something went wrong. Nothing was saved." };
}

export async function saveTemplateAction(_state: unknown, form: FormData): Promise<TemplateFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = text(form, "id") === "" ? undefined : Number(form.get("id"));
  let result: { id: number; unfilled: string[] };

  try {
    result = await saveTemplate(
      viewer,
      {
        id,
        site: slug,
        title: text(form, "title"),
        // Kept exactly as typed: it is HTML, and its spacing is the editor's.
        body: String(form.get("body") ?? ""),
        enabled: form.get("enabled") === "on",
      },
      { ip: await callerIp() },
    );
  } catch (error) {
    return failed(error, "save");
  }

  revalidatePath(`/dashboard/sites/${slug}/templates`, "layout");

  if (id === undefined) {
    redirect(`/dashboard/sites/${slug}/templates/${result.id}?saved=1`);
  }

  return {
    saved: "Saved.",
    warning: result.unfilled.length
      ? `Composing an issue leaves ${result.unfilled.map((name) => `{${name}}`).join(", ")} empty.`
      : undefined,
  };
}

export async function deleteTemplateAction(_state: unknown, form: FormData): Promise<TemplateFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    if (!(await deleteTemplate(viewer, Number(form.get("id")), { ip: await callerIp() }))) {
      return { error: "That template is not yours to change." };
    }
  } catch (error) {
    return failed(error, "delete");
  }

  revalidatePath(`/dashboard/sites/${slug}/templates`);
  redirect(`/dashboard/sites/${slug}/templates`);
}
