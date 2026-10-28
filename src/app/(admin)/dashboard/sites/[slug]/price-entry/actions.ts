"use server";

/** Saving the price-entry grid. The rules are in `domain/price/entry.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { enterPrices, type EntryResult } from "@/domain/price/entry";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type EntryState = { error?: string; field?: string; result?: EntryResult } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Open another date's grid. */
export async function openDateAction(form: FormData): Promise<void> {
  const slug = text(form, "site");
  const date = text(form, "date");

  redirect(`/dashboard/sites/${slug}/price-entry${/^\d{4}-\d{2}-\d{2}$/.test(date) ? `?date=${date}` : ""}`);
}

export async function enterPricesAction(_state: unknown, form: FormData): Promise<EntryState> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = text(form, "site");
  const figures: Record<string, string> = {};

  for (const [name, value] of form.entries()) {
    const match = /^price_(\d+)$/.exec(name);

    if (match) {
      figures[match[1]!] = String(value);
    }
  }

  try {
    const result = await enterPrices(viewer, { site: slug, date: text(form, "date"), figures }, { ip: await callerIp() });

    revalidatePath(`/dashboard/sites/${slug}`, "layout");

    return { result };
  } catch (error) {
    if (error instanceof AccountError) {
      return { error: error.message, field: error.field ?? undefined };
    }

    if (error instanceof AccessError) {
      return { error: error.message };
    }

    console.error("could not save the price grid", { error });

    return { error: "Something went wrong. Nothing was saved." };
  }
}
