"use server";

/**
 * Writing and removing a notice.
 *
 * Thin, as everywhere: `saveAnnouncement` holds both rules worth having — a
 * notice must say something, and a window that ends before it starts is
 * refused rather than saved into invisibility — and does the brand check and
 * the audit entry. This only turns a form into its arguments.
 */

import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { removeAnnouncement, saveAnnouncement } from "@/domain/content/pages";
import { callerIp } from "../actions";

export type NoticeResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function saveNotice(_state: unknown, form: FormData): Promise<NoticeResult> {
  const viewer = await staff();
  const id = Number(form.get("id"));

  const result = await saveAnnouncement(
    viewer,
    {
      id: Number.isInteger(id) && id > 0 ? id : null,
      site: text(form, "site"),
      body: text(form, "body"),
      link: text(form, "link") || null,
      starts_at: text(form, "starts_at") || null,
      ends_at: text(form, "ends_at") || null,
      // An unticked checkbox posts nothing, which is "off", not "unchanged".
      enabled: form.get("enabled") === "on",
    },
    { ip: await callerIp() },
  );

  revalidatePath("/dashboard/announcements");

  if (!result.ok) {
    return { error: result.message, field: result.field };
  }

  return { saved: id > 0 ? "Saved." : "Notice added." };
}

export async function removeNotice(form: FormData) {
  const viewer = await staff();

  await removeAnnouncement(viewer, Number(form.get("id")), { ip: await callerIp() });

  revalidatePath("/dashboard/announcements");
}
