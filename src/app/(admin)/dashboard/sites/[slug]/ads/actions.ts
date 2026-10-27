"use server";

/** Saving and withdrawing an ad, and an ad slot. The rules are in `domain/ads/editor.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { deletePlacement, saveAd, savePlacement, withdrawAd } from "@/domain/ads/editor";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type AdResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const ticked = (form: FormData, name: string) => form.get(name) === "on";
const idOf = (form: FormData) => (text(form, "id") === "" ? undefined : Number(form.get("id")));

function failed(error: unknown, what: string): AdResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not save ${what}`, { error });

  return { error: "Something went wrong. Nothing was saved." };
}

export async function saveAdAction(_state: unknown, form: FormData): Promise<AdResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = idOf(form);
  let savedId: number;

  try {
    const saved = await saveAd(
      viewer,
      {
        id,
        site: slug,
        title: text(form, "title"),
        placement_id: text(form, "placement_id"),
        ad_type: text(form, "ad_type"),
        image: text(form, "image"),
        video: text(form, "video"),
        code: String(form.get("code") ?? ""),
        url: text(form, "url"),
        starts_at: text(form, "starts_at"),
        ends_at: text(form, "ends_at"),
        enabled: ticked(form, "enabled"),
        sort_order: text(form, "sort_order"),
        on_dashboard: ticked(form, "on_dashboard"),
        on_newsletter: ticked(form, "on_newsletter"),
      },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That ad is not yours to change." };
    }

    savedId = saved.id;
  } catch (error) {
    return failed(error, "an ad");
  }

  revalidatePath(`/dashboard/sites/${slug}/ads`);

  if (id === undefined) {
    redirect(`/dashboard/sites/${slug}/ads/${savedId}?saved=1`);
  }

  revalidatePath(`/dashboard/sites/${slug}/ads/${savedId}`);

  return { saved: "Saved." };
}

export async function withdrawAdAction(_state: unknown, form: FormData): Promise<AdResult> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    if (!(await withdrawAd(viewer, Number(form.get("id")), { ip: await callerIp() }))) {
      return { error: "That ad is not yours to change." };
    }
  } catch (error) {
    return failed(error, "an ad");
  }

  revalidatePath(`/dashboard/sites/${slug}/ads`);
  redirect(`/dashboard/sites/${slug}/ads`);
}

export async function savePlacementAction(_state: unknown, form: FormData): Promise<AdResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = idOf(form);

  try {
    const saved = await savePlacement(
      viewer,
      { id, site: slug, title: text(form, "title"), enabled: ticked(form, "enabled") },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That slot is not yours to change." };
    }
  } catch (error) {
    return failed(error, "an ad slot");
  }

  revalidatePath(`/dashboard/sites/${slug}/ad-locations`);

  return { saved: id === undefined ? "Added." : "Saved." };
}

export async function deletePlacementAction(_state: unknown, form: FormData): Promise<AdResult> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    if (!(await deletePlacement(viewer, Number(form.get("id")), { ip: await callerIp() }))) {
      return { error: "That slot is not yours to change." };
    }
  } catch (error) {
    return failed(error, "an ad slot");
  }

  revalidatePath(`/dashboard/sites/${slug}/ad-locations`);

  return { saved: "Deleted." };
}
