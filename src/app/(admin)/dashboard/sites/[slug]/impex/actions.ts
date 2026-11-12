"use server";

/** Writing an impex sheet. The rules are in `domain/impex/editor.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { createImpex, updateImpex, withdrawImpex, restoreImpex } from "@/domain/impex/editor";
import { orRefused } from "@/domain/staff/permissions";
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
  author_id: text(form, "author_id") === "" ? null : Number(text(form, "author_id")),
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

/** Delete, softly, from the confirm popup: the row stays and can be restored. */
export async function deleteImpexAction(form: FormData) {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  const done = await orRefused(withdrawImpex(viewer, id, { ip: await callerIp() }));

  if (typeof done === "object" || !done) {
    const why = typeof done === "object" ? done.message : "That impex sheet is not yours to change.";

    redirect(`/dashboard/sites/${slug}/impex/${id}?refused=${encodeURIComponent(why)}`);
  }

  revalidatePath(`/dashboard/sites/${slug}/impex`);
  redirect(`/dashboard/sites/${slug}/impex`);
}

/** Bring a deleted impex sheet back from the Deleted list. */
export async function restoreImpexAction(form: FormData) {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  const done = await orRefused(restoreImpex(viewer, id, { ip: await callerIp() }));

  revalidatePath(`/dashboard/sites/${slug}/impex`);

  if (typeof done === "object" || !done) {
    const why = typeof done === "object" ? done.message : "That impex sheet could not be restored.";

    redirect(`/dashboard/sites/${slug}/impex?status=deleted&refused=${encodeURIComponent(why)}`);
  }

  redirect(`/dashboard/sites/${slug}/impex/${id}`);
}
