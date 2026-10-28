"use server";

/** Rolling a committed price update back. The rules are in `domain/price/entry.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { rollBackUpdate } from "@/domain/price/entry";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type RollBackState = { error?: string; done?: string } | null;

export async function rollBackAction(_state: unknown, form: FormData): Promise<RollBackState> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = String(form.get("site") ?? "");

  try {
    const result = await rollBackUpdate(viewer, { site: slug, batchId: Number(form.get("batch")) }, { ip: await callerIp() });

    revalidatePath(`/dashboard/sites/${slug}`, "layout");

    return {
      done:
        `Rolled back: ${result.removed} removed, ${result.reverted} put back` +
        (result.skipped ? `, ${result.skipped} left alone because they changed again since.` : "."),
    };
  } catch (error) {
    if (error instanceof AccountError || error instanceof AccessError) {
      return { error: error.message };
    }

    console.error("could not roll back a price update", { error });

    return { error: "Something went wrong. Nothing was rolled back." };
  }
}
