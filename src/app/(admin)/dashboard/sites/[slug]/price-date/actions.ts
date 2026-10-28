"use server";

/** Withdrawing prices from a date, and putting them back. The rules are in `domain/price/date-corrections.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { putBack, withdrawPrices } from "@/domain/price/date-corrections";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type CorrectionState = { error?: string; done?: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

function failed(error: unknown, what: string): CorrectionState {
  if (error instanceof AccountError || error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not ${what}`, { error });

  return { error: "Something went wrong. Nothing was changed." };
}

/** Go to one date's prices. */
export async function openDateAction(form: FormData): Promise<void> {
  const slug = text(form, "site");
  const date = text(form, "date");

  redirect(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `/dashboard/sites/${slug}/price-date/${date}` : `/dashboard/sites/${slug}/price-date`);
}

export async function withdrawAction(_state: unknown, form: FormData): Promise<CorrectionState> {
  const viewer = await staff();
  const slug = text(form, "site");
  const priceIds = form.getAll("price").map(Number);

  try {
    const { withdrawn } = await withdrawPrices(viewer, { site: slug, date: text(form, "date"), priceIds }, { ip: await callerIp() });

    revalidatePath(`/dashboard/sites/${slug}`, "layout");

    return { done: `Withdrew ${withdrawn} price${withdrawn === 1 ? "" : "s"}. Enter the right figures on the price grid, or put them back below.` };
  } catch (error) {
    return failed(error, "withdraw prices");
  }
}

export async function putBackAction(_state: unknown, form: FormData): Promise<CorrectionState> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    const { restored, skipped } = await putBack(viewer, { site: slug, withdrawalId: Number(form.get("withdrawal")) }, { ip: await callerIp() });

    revalidatePath(`/dashboard/sites/${slug}`, "layout");

    return {
      done:
        `Put back ${restored}.` +
        (skipped ? ` ${skipped} kept the figure entered since, which is newer.` : ""),
    };
  } catch (error) {
    return failed(error, "put prices back");
  }
}
