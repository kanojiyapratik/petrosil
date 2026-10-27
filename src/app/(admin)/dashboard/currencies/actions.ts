"use server";

/** Saving a currency. The rules are in `domain/billing/currencies.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { AccountError } from "@/domain/accounts/register";
import { saveCurrency } from "@/domain/billing/currencies";
import { callerIp } from "../actions";

export type CurrencyResult = { error?: string; field?: string; saved?: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function saveCurrencyAction(_state: unknown, form: FormData): Promise<CurrencyResult> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const id = text(form, "id") === "" ? undefined : Number(form.get("id"));

  try {
    await saveCurrency(
      viewer,
      { id, code: text(form, "code"), title: text(form, "title"), symbol: text(form, "symbol"), enabled: form.get("enabled") === "on" },
      { ip: await callerIp() },
    );
  } catch (error) {
    if (error instanceof AccountError) {
      return { error: error.message, field: error.field ?? undefined };
    }

    console.error("could not save a currency", { error });

    return { error: "Something went wrong. Nothing was saved." };
  }

  revalidatePath("/dashboard/currencies");

  return { saved: id === undefined ? "Added." : "Saved." };
}
