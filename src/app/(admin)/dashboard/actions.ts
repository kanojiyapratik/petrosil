"use server";

/**
 * Everything the admin screens change.
 *
 * Each one is a thin wrapper: it works out who is asking, hands the decision
 * to the same domain function the API route calls, and lets that function do
 * the scoping and the audit entry. No rule lives here — a second copy of
 * "may this person hide that location" is how the old console ended up
 * leaking one brand's rows into another's screen.
 */

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { setVisibility } from "@/domain/dashboard/locations";
import { updateMembership } from "@/domain/dashboard/clients";
import { decideTrial } from "@/domain/billing/trials";

/** The caller's address, for the audit entry. Proxy header first, as in prod. */
export async function callerIp(): Promise<string | null> {
  const bag = await headers();
  const forwarded = bag.get("x-forwarded-for");

  return forwarded?.split(",")[0]?.trim() || bag.get("x-real-ip") || null;
}

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

export async function toggleLocation(form: FormData) {
  const viewer = await staff();
  const id = Number(form.get("id"));
  const visible = form.get("visible") === "1";

  await setVisibility(viewer.siteIds, id, visible, {
    userId: viewer.identity.user.id,
    ip: await callerIp(),
  });

  revalidatePath("/dashboard/sites/[slug]", "layout");
}

export async function saveMembership(_state: unknown, form: FormData) {
  const viewer = await staff();
  const userId = Number(form.get("user_id"));
  const slug = String(form.get("slug") ?? "");
  const expires = String(form.get("expires_at") ?? "").trim();

  const result = await updateMembership(
    viewer.siteIds,
    userId,
    slug,
    {
      tier: String(form.get("tier") ?? ""),
      status: String(form.get("status") ?? ""),
      expires_at: expires === "" ? null : expires,
    },
    { userId: viewer.identity.user.id, ip: await callerIp() },
  );

  revalidatePath(`/dashboard/clients/${userId}`);

  if (!result.ok) {
    return {
      error:
        result.reason === "not_found"
          ? "That brand is not yours to change."
          : "Those values are not a combination we allow.",
    };
  }

  return { saved: `${slug} updated.` };
}

export async function decide(form: FormData) {
  const viewer = await staff();
  const id = Number(form.get("id"));
  const decision = form.get("decision") === "approve" ? "approve" : "decline";
  const days = Number(form.get("days"));

  await decideTrial(
    viewer,
    id,
    decision,
    { days: Number.isFinite(days) && days > 0 ? days : undefined, ip: await callerIp() },
  );

  revalidatePath("/dashboard/trials");
}
