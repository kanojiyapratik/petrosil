"use server";

/** Choosing this brand's AI model. The rules are in `domain/ai/update.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { chooseModel } from "@/domain/ai/update";

export type ModelSaid = { error?: string; saved?: string } | null;

export async function chooseModelAction(_state: ModelSaid, form: FormData): Promise<ModelSaid> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = String(form.get("site") ?? "");

  try {
    const saved = await chooseModel(viewer, slug, {
      providerId: String(form.get("provider_id") ?? ""),
      model: String(form.get("model") ?? ""),
    });

    revalidatePath(`/dashboard/sites/${slug}/ai-settings`);

    return { saved };
  } catch (error) {
    if (error instanceof EngineError || error instanceof AccessError) {
      return { error: error.message };
    }

    console.error("could not choose an AI model", { error });

    return { error: "Something went wrong. Nothing was changed." };
  }
}
