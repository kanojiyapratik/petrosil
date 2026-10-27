"use server";

/** Marking an enquiry handled, or opening it again. The rules are in `domain/enquiries/inbox.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { setEnquiryStatus } from "@/domain/enquiries/inbox";
import { orRefused } from "@/domain/staff/permissions";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export async function setStatusAction(form: FormData) {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const id = Number(form.get("id"));
  const status = form.get("status") === "handled" ? "handled" : "new";
  const note = String(form.get("note") ?? "");

  const done = await orRefused(setEnquiryStatus(viewer, id, status, note, { ip: await callerIp() }));

  revalidatePath("/dashboard/sites/[slug]/enquiries", "layout");

  if (!done.ok) {
    const site = encodeURIComponent(String(form.get("site") ?? ""));

    redirect(`/dashboard/sites/${site}/enquiries/${id}?refused=${encodeURIComponent(done.message)}`);
  }
}
