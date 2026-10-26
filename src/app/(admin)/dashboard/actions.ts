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
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { locations, sites } from "@/db/schema";
import { refusal, requirePermission } from "@/domain/staff/permissions";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";

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
  const [location] = await db().select({ siteId: locations.siteId }).from(locations).where(eq(locations.id, id)).limit(1);

  if (location) {
    await requirePermission(viewer, location.siteId, "location-edit");
  }

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
  const [brand] = await db().select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).limit(1);

  try {
    if (brand) {
      await requirePermission(viewer, brand.id, "directory-edit");
    }
  } catch (error) {
    return { error: refusal(error) };
  }

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

  // A refusal (role without the permission) or a request already decided
  // simply leaves the list as it is.
  try {
    await decideTrial(
      viewer,
      id,
      decision,
      { days: Number.isFinite(days) && days > 0 ? days : undefined, ip: await callerIp() },
    );
  } catch (error) {
    // Already decided by someone else: the list will show that on reload.
    if (!(error instanceof AccessError) && !(error instanceof AccountError)) {
      throw error;
    }
  }

  revalidatePath("/dashboard/trials");
}
