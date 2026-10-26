"use server";

/** Sending a report, and a sample. The rules are in `domain/reports/sending.ts`. */

import { redirect } from "next/navigation";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { sendReport, sendSample } from "@/domain/reports/sending";
import { fileStore } from "@/lib/files/store";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type SendResult = { error?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

export async function sendReportAction(_state: unknown, form: FormData): Promise<SendResult> {
  const viewer = await staff();
  const site = String(form.get("site") ?? "");

  const result = await sendReport(
    viewer,
    {
      site,
      reportId: Number(form.get("report")),
      subject: String(form.get("subject") ?? ""),
      body: String(form.get("body") ?? ""),
      userIds: form.getAll("reader").map(Number).filter(Number.isInteger),
      extra: String(form.get("extra") ?? "").split(/[\s,;]+/).filter(Boolean),
    },
    fileStore(),
    { ip: await callerIp() },
  );

  if (!result.ok) {
    return { error: result.message };
  }

  redirect(`/dashboard/sites/${site}/deliveries/${result.id}`);
}

export async function sendSampleAction(_state: unknown, form: FormData): Promise<SendResult> {
  const viewer = await staff();
  const site = String(form.get("site") ?? "");

  const result = await sendSample(
    viewer,
    {
      site,
      userId: Number(form.get("user")),
      reportIds: form.getAll("report").map(Number).filter(Number.isInteger),
    },
    fileStore(),
    { ip: await callerIp() },
  );

  if (!result.ok) {
    return { error: result.message };
  }

  redirect(`/dashboard/sites/${site}/deliveries/${result.id}`);
}
