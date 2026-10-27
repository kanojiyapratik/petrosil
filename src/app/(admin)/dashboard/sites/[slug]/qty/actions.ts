"use server";

/** Entering quantities, and the countries they are entered against. The rules are in `domain/trade/sheets.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { clearSheet, saveSheet, saveTradePlace } from "@/domain/trade/sheets";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type QtyResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function failed(error: unknown, what: string): QtyResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not save ${what}`, { error });

  return { error: "Something went wrong. Nothing was saved." };
}

/** "2026-09" from a month box → the first of that month, as the figures are dated. */
const monthStart = (value: string) => (/^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value);

/** Open a country's month: its sheet, whether or not it has figures yet. */
export async function openMonthAction(_state: unknown, form: FormData): Promise<QtyResult> {
  const slug = text(form, "site");
  const kind = text(form, "kind");
  const location = Number(form.get("location"));
  const month = text(form, "month");

  if (!Number.isInteger(location) || location <= 0) {
    return { error: "Choose the reporting country.", field: "location" };
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { error: "Choose the month.", field: "month" };
  }

  redirect(`/dashboard/sites/${slug}/qty/${kind}/${location}/${monthStart(month)}`);
}

export async function saveSheetAction(_state: unknown, form: FormData): Promise<QtyResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const kind = text(form, "kind");
  const location = Number(form.get("location"));
  const date = text(form, "date");
  const quantities: Record<string, string> = {};

  for (const [name, value] of form.entries()) {
    const match = /^qty_(\d+)$/.exec(name);

    if (match) {
      quantities[match[1]!] = String(value);
    }
  }

  let result: { saved: number; cleared: number };

  try {
    result = await saveSheet(viewer, { site: slug, kind, location, date, quantities }, { ip: await callerIp() });
  } catch (error) {
    return failed(error, "a quantity sheet");
  }

  revalidatePath(`/dashboard/sites/${slug}/qty`, "layout");

  return {
    saved: `Saved ${result.saved} figure${result.saved === 1 ? "" : "s"}${result.cleared ? `, removed ${result.cleared}` : ""}.`,
  };
}

export async function clearSheetAction(_state: unknown, form: FormData): Promise<QtyResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const kind = text(form, "kind");
  const location = Number(form.get("location"));

  try {
    await clearSheet(viewer, { site: slug, kind, location, date: text(form, "date") }, { ip: await callerIp() });
  } catch (error) {
    return failed(error, "a quantity sheet");
  }

  revalidatePath(`/dashboard/sites/${slug}/qty`, "layout");
  redirect(`/dashboard/sites/${slug}/qty/${kind}/${location}`);
}

export async function saveTradePlaceAction(_state: unknown, form: FormData): Promise<QtyResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = text(form, "id") === "" ? undefined : Number(form.get("id"));

  try {
    const saved = await saveTradePlace(
      viewer,
      { id, site: slug, title: text(form, "title"), visible: form.get("visible") === "on" },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That country is not yours to change." };
    }
  } catch (error) {
    return failed(error, "a country");
  }

  revalidatePath(`/dashboard/sites/${slug}/qty`, "layout");

  return { saved: id === undefined ? "Added." : "Saved." };
}
