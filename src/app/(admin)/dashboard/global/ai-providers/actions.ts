"use server";

/** Managing the AI providers. The rules are in `domain/ai/providers.ts` and, behind it, the engine. */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { chooseModel } from "@/domain/ai/update";
import {
  addProvider,
  makeDefaultProvider,
  modelsForKey,
  revealKey,
  removeProvider,
  testProvider,
  updateProvider,
} from "@/domain/ai/providers";

export type ProviderSaid = { error?: string; saved?: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

async function run(what: string, work: (viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>>) => Promise<string>): Promise<ProviderSaid> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  try {
    const saved = await work(viewer);

    revalidatePath("/dashboard/global/ai-providers");

    return { saved };
  } catch (error) {
    if (error instanceof EngineError || error instanceof AccessError) {
      return { error: error.message };
    }

    console.error(`could not ${what}`, { error });

    return { error: "Something went wrong. Nothing was changed." };
  }
}

export async function addProviderAction(_state: ProviderSaid, form: FormData): Promise<ProviderSaid> {
  return run("add a provider", (viewer) =>
    addProvider(viewer, {
      provider: text(form, "provider"),
      apiKey: text(form, "api_key"),
      name: text(form, "name"),
      makeDefault: form.get("make_default") !== null,
    }),
  );
}

export async function updateProviderAction(_state: ProviderSaid, form: FormData): Promise<ProviderSaid> {
  return run("save a provider", (viewer) =>
    updateProvider(viewer, Number(form.get("id")), {
      name: text(form, "name"),
      model: text(form, "model"),
      apiKey: text(form, "api_key"),
      enabled: form.get("enabled") !== null,
    }),
  );
}

export async function providerButtonAction(_state: ProviderSaid, form: FormData): Promise<ProviderSaid> {
  const id = Number(form.get("id"));
  const intent = text(form, "intent");

  return run(intent, (viewer) =>
    intent === "default"
      ? makeDefaultProvider(viewer, id)
      : intent === "remove"
        ? removeProvider(viewer, id)
        : testProvider(viewer, id),
  );
}

export async function checkKeyAction(input: { provider: string; apiKey: string }): Promise<{ models: string[] } | { error: string }> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  try {
    return { models: await modelsForKey(viewer, input) };
  } catch (error) {
    if (error instanceof EngineError || error instanceof AccessError) {
      return { error: error.message };
    }

    return { error: "That key could not be checked just now." };
  }
}

export async function revealKeyAction(id: number): Promise<{ key: string } | { error: string }> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  try {
    return { key: await revealKey(viewer, id) };
  } catch (error) {
    if (error instanceof EngineError || error instanceof AccessError) {
      return { error: error.message };
    }

    return { error: "The key could not be shown just now." };
  }
}

/** One brand's provider and model, from the table of every brand. */
export async function brandModelAction(_state: ProviderSaid, form: FormData): Promise<ProviderSaid> {
  return run("choose a brand's model", (viewer) =>
    chooseModel(viewer, text(form, "site"), { providerId: text(form, "provider_id"), model: text(form, "model") }),
  );
}
