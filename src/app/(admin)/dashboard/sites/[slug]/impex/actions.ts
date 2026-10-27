"use server";

/** Writing an impex sheet. The rules are in `domain/impex/editor.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { createImpex, updateImpex, withdrawImpex } from "@/domain/impex/editor";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type ImpexFormResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

const fields = (form: FormData) => ({
  title: text(form, "title"),
  description: text(form, "description"),
  status: text(form, "status"),
  authored_on: text(form, "authored_on"),
  file: text(form, "file"),
});

function failed(error: unknown, what: string, detail: Record<string, unknown>): ImpexFormResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not ${what} an impex sheet`, { ...detail, error });

  return { error: "Something went wrong. Nothing was saved." };
}

export async function createImpexAction(_state: unknown, form: FormData): Promise<ImpexFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  let id: number;

  try {
    id = (await createImpex(viewer, { site: slug, ...fields(form) }, { ip: await callerIp() })).id;
  } catch (error) {
    return failed(error, "create", { slug });
  }

  revalidatePath(`/dashboard/sites/${slug}/impex`);
  redirect(`/dashboard/sites/${slug}/impex/${id}?saved=1`);
}

export async function saveImpexAction(_state: unknown, form: FormData): Promise<ImpexFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  try {
    if (!(await updateImpex(viewer, id, fields(form), { ip: await callerIp() }))) {
      return { error: "That sheet is not yours to change." };
    }
  } catch (error) {
    return failed(error, "save", { id });
  }

  revalidatePath(`/dashboard/sites/${slug}/impex/${id}`);
  revalidatePath(`/dashboard/sites/${slug}/impex`);

  return { saved: "Saved." };
}

export async function withdrawImpexAction(_state: unknown, form: FormData): Promise<ImpexFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  try {
    if (!(await withdrawImpex(viewer, id, { ip: await callerIp() }))) {
      return { error: "That sheet is not yours to change." };
    }
  } catch (error) {
    return failed(error, "withdraw", { id });
  }

  revalidatePath(`/dashboard/sites/${slug}/impex`);
  redirect(`/dashboard/sites/${slug}/impex`);
}
