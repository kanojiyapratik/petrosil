"use server";

/**
 * Writing, copying, saving and test-sending an issue. Thin: the rules — whose
 * issue it is, that only a draft is editable, what fills a template — live in
 * `domain/content/newsletters.ts`.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import {
  composeNewsletter,
  copyNewsletter,
  saveNewsletter,
  sendTestNewsletter,
} from "@/domain/content/newsletters";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type IssueResult = { error?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

export async function composeAction(_state: unknown, form: FormData): Promise<IssueResult> {
  const viewer = await staff();
  const site = String(form.get("site") ?? "");
  const made = await composeNewsletter(
    viewer,
    { site, templateId: Number(form.get("template")), title: String(form.get("title") ?? "") },
    { ip: await callerIp() },
  );

  if (!made.ok) {
    return { error: made.message };
  }

  // Outside any try: redirect() works by throwing.
  redirect(`/dashboard/sites/${site}/newsletters/${made.id}`);
}

export async function copyAction(form: FormData) {
  const viewer = await staff();
  const site = String(form.get("site") ?? "");
  const made = await copyNewsletter(viewer, Number(form.get("id")), { ip: await callerIp() });

  if (made.ok) {
    redirect(`/dashboard/sites/${site}/newsletters/${made.id}`);
  }
}

export async function saveAction(_state: unknown, form: FormData): Promise<IssueResult> {
  const viewer = await staff();
  const result = await saveNewsletter(
    viewer,
    { id: Number(form.get("id")), title: String(form.get("title") ?? ""), body: String(form.get("body") ?? "") },
    { ip: await callerIp() },
  );

  revalidatePath("/dashboard/sites/[slug]/newsletters", "layout");

  return result.ok ? { saved: "Saved." } : { error: result.message };
}

export async function testSendAction(_state: unknown, form: FormData): Promise<IssueResult> {
  const viewer = await staff();
  const result = await sendTestNewsletter(viewer, Number(form.get("id")));

  return result.ok
    ? { saved: `Queued to ${result.to}. It leaves with the next mail run, once a mail key is set.` }
    : { error: result.message };
}
