"use server";

/** Asking the AI to read a customs sheet. The rules are in `domain/trade/customs.ts`. */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { analyseCustomsSheet } from "@/domain/trade/customs";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type Said = { error?: string } | null;

export async function analyseAction(_state: unknown, form: FormData): Promise<Said> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = String(form.get("site") ?? "");
  const id = Number(form.get("id"));
  let done: string;

  try {
    const result = await analyseCustomsSheet(viewer, slug, id, { ip: await callerIp() });

    done = result.status === "complete" ? "The AI analysis is below." : "The analysis did not complete. The reason is below; you can run it again.";
  } catch (error) {
    if (error instanceof AccountError || error instanceof AccessError) {
      return { error: error.message };
    }

    console.error("could not analyse a customs sheet", { id, error });

    return { error: "Something went wrong. Try again." };
  }

  const page = `/dashboard/sites/${slug}/trade-analysis/sheets/${id}`;

  revalidatePath(page);
  redirect(`${page}?done=${encodeURIComponent(done)}#analysis`);
}
