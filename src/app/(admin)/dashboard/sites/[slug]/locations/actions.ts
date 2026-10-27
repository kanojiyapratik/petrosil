"use server";

/** Adding and changing a price location. The rules are in `domain/dashboard/locations.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { saveLocation } from "@/domain/dashboard/locations";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type LocationResult = { error?: string; field?: string; saved?: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function saveLocationAction(_state: unknown, form: FormData): Promise<LocationResult> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = text(form, "site");
  const id = text(form, "id") === "" ? undefined : Number(form.get("id"));
  let savedId: number;

  try {
    const saved = await saveLocation(
      viewer,
      {
        id,
        site: slug,
        title: text(form, "title"),
        currency: text(form, "currency"),
        unit: text(form, "unit"),
        visible: form.get("visible") === "on",
        sort_order: text(form, "sort_order"),
      },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That location is not yours to change." };
    }

    savedId = saved.id;
  } catch (error) {
    if (error instanceof AccountError) {
      return { error: error.message, field: error.field ?? undefined };
    }

    if (error instanceof AccessError) {
      return { error: error.message };
    }

    console.error("could not save a location", { error });

    return { error: "Something went wrong. Nothing was saved." };
  }

  revalidatePath(`/dashboard/sites/${slug}/locations`, "layout");

  if (id === undefined) {
    redirect(`/dashboard/sites/${slug}/locations/${savedId}`);
  }

  return { saved: "Saved." };
}
