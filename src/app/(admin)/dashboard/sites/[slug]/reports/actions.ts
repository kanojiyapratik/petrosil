"use server";

/**
 * Writing a report.
 *
 * Thin wrappers over `domain/reports/editor.ts`, which checks the brand, the
 * permission and that the named files are in the store. The PDF itself never
 * passes through here: a server action's body is capped far below a report,
 * so the form uploads it to `/api/dashboard/files` first and sends only the
 * stored name.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { createReport, updateReport, withdrawReport, restoreReport } from "@/domain/reports/editor";
import { orRefused } from "@/domain/staff/permissions";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type ReportFormResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** The fields the form always posts. Blank file names detach the file. */
function fields(form: FormData) {
  return {
    title: text(form, "title"),
    description: text(form, "description"),
    report_type: text(form, "report_type"),
    status: text(form, "status"),
    authored_on: text(form, "authored_on"),
    author_id: text(form, "author_id") === "" ? null : Number(text(form, "author_id")),
    file: text(form, "file"),
    thumbnail: text(form, "thumbnail"),
    meta_title: text(form, "meta_title"),
    meta_description: text(form, "meta_description"),
  };
}

function failed(error: unknown, what: string, detail: Record<string, unknown>): ReportFormResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not ${what} a report`, { ...detail, error });

  return { error: "Something went wrong. Nothing was saved." };
}

export async function createReportAction(_state: unknown, form: FormData): Promise<ReportFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  let id: number;

  try {
    id = (await createReport(viewer, { site: slug, ...fields(form) }, { ip: await callerIp() })).id;
  } catch (error) {
    return failed(error, "create", { slug });
  }

  revalidatePath(`/dashboard/sites/${slug}/reports`);

  // Outside the try: redirect() works by throwing.
  redirect(`/dashboard/sites/${slug}/reports/${id}?saved=1`);
}

export async function saveReportAction(_state: unknown, form: FormData): Promise<ReportFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  try {
    const saved = await updateReport(viewer, id, fields(form), { ip: await callerIp() });

    if (!saved) {
      return { error: "That report is not yours to change." };
    }
  } catch (error) {
    return failed(error, "save", { id });
  }

  revalidatePath(`/dashboard/sites/${slug}/reports/${id}`);
  revalidatePath(`/dashboard/sites/${slug}/reports`);

  return { saved: "Saved." };
}

/** Delete, softly, from the confirm popup: the row stays and can be restored. */
export async function deleteReportAction(form: FormData) {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  const done = await orRefused(withdrawReport(viewer, id, { ip: await callerIp() }));

  if (typeof done === "object" || !done) {
    const why = typeof done === "object" ? done.message : "That report is not yours to change.";

    redirect(`/dashboard/sites/${slug}/reports/${id}?refused=${encodeURIComponent(why)}`);
  }

  revalidatePath(`/dashboard/sites/${slug}/reports`);
  redirect(`/dashboard/sites/${slug}/reports`);
}

/** Bring a deleted report back from the Deleted list. */
export async function restoreReportAction(form: FormData) {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  const done = await orRefused(restoreReport(viewer, id, { ip: await callerIp() }));

  revalidatePath(`/dashboard/sites/${slug}/reports`);

  if (typeof done === "object" || !done) {
    const why = typeof done === "object" ? done.message : "That report could not be restored.";

    redirect(`/dashboard/sites/${slug}/reports?status=deleted&refused=${encodeURIComponent(why)}`);
  }

  redirect(`/dashboard/sites/${slug}/reports/${id}`);
}
