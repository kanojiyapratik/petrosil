"use server";

/**
 * The AI price update's buttons. Each one goes through `domain/ai/update.ts`,
 * which checks the brand and the role before the engine is asked anything.
 * Uploading reports is a route instead (the files are too big for an action).
 */

import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import {
  addReadRow,
  correctReadRow,
  draftPrices,
  saveAiDraft,
  saveAiInstructions,
  type RowFields,
} from "@/domain/ai/update";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type Said = { error?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

/** What to tell the person: the engine's or the role check's own words, or an apology. */
function said(error: unknown, what: string): string {
  if (error instanceof EngineError || error instanceof AccessError) {
    return error.message;
  }

  console.error(`AI price update: ${what} failed`, { error });

  return "Something went wrong. Nothing was changed.";
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

function rowFields(form: FormData): RowFields {
  return {
    name: text(form, "name"),
    price: text(form, "price"),
    price_min: text(form, "price_min"),
    price_max: text(form, "price_max"),
    currency: text(form, "currency"),
    unit: text(form, "unit"),
    basis: text(form, "basis"),
    price_date: text(form, "price_date"),
    note: text(form, "note"),
    kept: form.get("kept") !== null,
  };
}

export async function saveInstructionsAction(_state: Said, form: FormData): Promise<Said> {
  const slug = text(form, "site");

  try {
    await saveAiInstructions(await staff(), slug, text(form, "instructions"));
  } catch (error) {
    return { error: said(error, "saving instructions") };
  }

  revalidatePath(`/dashboard/sites/${slug}/ai-update`);

  return { saved: "Saved as this brand's instructions." };
}

export async function correctRowAction(_state: Said, form: FormData): Promise<Said> {
  const slug = text(form, "site");
  const setId = Number(form.get("set"));

  try {
    await correctReadRow(await staff(), slug, setId, Number(form.get("row")), rowFields(form));
  } catch (error) {
    return { error: said(error, "correcting a row") };
  }

  revalidatePath(`/dashboard/sites/${slug}/ai-update/readings/${setId}`);

  return { saved: "Saved." };
}

export async function addRowAction(_state: Said, form: FormData): Promise<Said> {
  const slug = text(form, "site");
  const setId = Number(form.get("set"));
  const fileId = Number(form.get("file_id"));

  try {
    await addReadRow(await staff(), slug, setId, {
      ...rowFields(form),
      kept: true,
      file_id: Number.isInteger(fileId) && fileId > 0 ? fileId : null,
      filename: text(form, "filename"),
    });
  } catch (error) {
    return { error: said(error, "adding a row") };
  }

  revalidatePath(`/dashboard/sites/${slug}/ai-update/readings/${setId}`);

  return { saved: "Added." };
}

export type Drafted =
  | { ok: true; draftId: number }
  | { ok: false; error: string; reuse: { set_id: number; pricedate: string; used_at: string } | null };

export async function draftAction(input: {
  slug: string;
  setId: number;
  pricedate: string;
  again?: boolean;
  usedAt?: string;
}): Promise<Drafted> {
  try {
    const result = await draftPrices(await staff(), input.slug, input);

    if (!result.draft_id) {
      return { ok: false, error: "The draft was made but could not be kept. Try again.", reuse: null };
    }

    revalidatePath(`/dashboard/sites/${input.slug}/ai-update`);

    return { ok: true, draftId: result.draft_id };
  } catch (error) {
    return {
      ok: false,
      error: said(error, "drafting"),
      reuse: error instanceof EngineError ? error.reuse : null,
    };
  }
}

export type SavedDraft = { ok: true; batchId: number; saved: number } | { ok: false; error: string };

export async function saveDraftAction(input: {
  slug: string;
  draftId: number;
  pricedate: string;
  rows: { location: string; price: number; calculation?: string }[];
}): Promise<SavedDraft> {
  try {
    const result = await saveAiDraft(
      await staff(),
      input.slug,
      input.draftId,
      { pricedate: input.pricedate, rows: input.rows },
      { ip: await callerIp() },
    );

    revalidatePath(`/dashboard/sites/${input.slug}/ai-update`);
    revalidatePath(`/dashboard/sites/${input.slug}/batches`);

    return { ok: true, batchId: result.batch_id, saved: result.saved };
  } catch (error) {
    return { ok: false, error: said(error, "saving a draft") };
  }
}
