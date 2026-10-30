"use server";

/**
 * Committing, discarding and rolling back a price update. The rules are in
 * `domain/price/entry.ts`.
 *
 * Each one changes the update's status, and the button that was pressed
 * belongs to the old status — so on success the page is reloaded with what
 * happened in its address, rather than told to a button that is gone.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { commitUpdate, discardUpdate, rollBackUpdate } from "@/domain/price/entry";
import { askForNote } from "@/domain/ai/update";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type RollBackState = { error?: string; done?: string } | null;

async function staff() {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

function refused(error: unknown, what: string): RollBackState {
  if (error instanceof AccountError || error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not ${what} a price update`, { error });

  return { error: `Something went wrong. Nothing was ${what === "commit" ? "published" : "changed"}.` };
}

export async function rollBackAction(_state: unknown, form: FormData): Promise<RollBackState> {
  const viewer = await staff();
  const slug = String(form.get("site") ?? "");

  const batchId = Number(form.get("batch"));
  let done: string;

  try {
    const result = await rollBackUpdate(viewer, { site: slug, batchId }, { ip: await callerIp() });

    done =
      `Rolled back: ${result.removed} removed, ${result.reverted} put back` +
      (result.skipped ? `, ${result.skipped} left alone because they changed again since.` : ".");
  } catch (error) {
    return refused(error, "roll back");
  }

  revalidatePath(`/dashboard/sites/${slug}`, "layout");
  redirect(`/dashboard/sites/${slug}/batches/${batchId}?done=${encodeURIComponent(done)}`);
}

export async function commitAction(_state: unknown, form: FormData): Promise<RollBackState> {
  const viewer = await staff();
  const slug = String(form.get("site") ?? "");
  const batchId = Number(form.get("batch"));

  let done: string;

  try {
    const result = await commitUpdate(viewer, { site: slug, batchId }, { ip: await callerIp() });

    // `created` are prices on a date that had none, `applied` change one
    // already there; to whoever pressed the button both are published.
    const published = result.applied + result.created;

    done =
      `Published ${published} price${published === 1 ? "" : "s"}.` +
      (result.conflicts ? ` ${result.conflicts} left out because the live price changed since staging.` : "");
  } catch (error) {
    return refused(error, "commit");
  }

  // The note above the price table is written once the prices are live,
  // after this answer has gone back: it takes a model call.
  after(() => askForNote(viewer, slug, batchId));
  revalidatePath(`/dashboard/sites/${slug}`, "layout");
  redirect(`/dashboard/sites/${slug}/batches/${batchId}?done=${encodeURIComponent(`${done} The note above the price table is being written.`)}`);
}

export async function discardAction(_state: unknown, form: FormData): Promise<RollBackState> {
  const viewer = await staff();
  const slug = String(form.get("site") ?? "");

  const batchId = Number(form.get("batch"));

  try {
    await discardUpdate(viewer, { site: slug, batchId }, { ip: await callerIp() });
  } catch (error) {
    return refused(error, "discard");
  }

  revalidatePath(`/dashboard/sites/${slug}`, "layout");
  redirect(`/dashboard/sites/${slug}/batches/${batchId}?done=${encodeURIComponent("Discarded. Nothing from it was published.")}`);
}
