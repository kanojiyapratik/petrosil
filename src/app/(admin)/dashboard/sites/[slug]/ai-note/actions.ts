"use server";

/** Correcting, removing and writing the published price note. The rules are in `domain/price/notes.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { correctNote, removeNote, writeNote } from "@/domain/price/notes";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type NoteResult = { error?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

function failed(error: unknown): NoteResult {
  if (error instanceof AccountError || error instanceof AccessError) {
    return { error: error.message };
  }

  console.error("could not change a price note", { error });

  return { error: "Something went wrong. Nothing was saved." };
}

export async function noteAction(_state: unknown, form: FormData): Promise<NoteResult> {
  const viewer = await staff();
  const slug = String(form.get("site") ?? "");
  const id = Number(form.get("id"));
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "remove") {
      if (!(await removeNote(viewer, id, { ip: await callerIp() }))) {
        return { error: "That note is not yours to change." };
      }
    } else if (intent === "write") {
      await writeNote(viewer, { site: slug, summary: form.get("summary") }, { ip: await callerIp() });
    } else if (!(await correctNote(viewer, id, { summary: form.get("summary") }, { ip: await callerIp() }))) {
      return { error: "That note is not yours to change." };
    }
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/dashboard/sites/${slug}/ai-note`);

  return { saved: intent === "remove" ? "Removed." : intent === "write" ? "Published." : "Corrected." };
}
