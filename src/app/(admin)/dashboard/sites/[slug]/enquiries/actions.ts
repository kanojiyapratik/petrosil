"use server";

/** Marking an enquiry handled, or opening it again. The rules are in `domain/enquiries/inbox.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { setEnquiryStatus } from "@/domain/enquiries/inbox";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export async function setStatusAction(form: FormData) {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const status = form.get("status") === "handled" ? "handled" : "new";
  const note = String(form.get("note") ?? "");

  await setEnquiryStatus(viewer, Number(form.get("id")), status, note, { ip: await callerIp() });

  revalidatePath("/dashboard/sites/[slug]/enquiries", "layout");
}
