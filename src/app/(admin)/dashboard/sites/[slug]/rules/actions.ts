"use server";

/**
 * Changing a brand's per-market rules and rounding. Each goes through
 * `domain/price/rules.ts`, which checks the brand and the role, then hands
 * the change to the AI engine — whose checks and words come back as they are.
 */

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { AccountError } from "@/domain/accounts/register";
import {
  removeMarketRounding,
  removeRule,
  saveRule,
  setMarketRounding,
  setSiteRounding,
  switchRule,
} from "@/domain/price/rules";

export type RuleSaid = { error?: string; saved?: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

async function run(form: FormData, what: string, change: (viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>>, slug: string) => Promise<string>): Promise<RuleSaid> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = text(form, "site");

  try {
    const saved = await change(viewer, slug);

    revalidatePath(`/dashboard/sites/${slug}/rules`);

    return { saved };
  } catch (error) {
    if (error instanceof EngineError || error instanceof AccessError || error instanceof AccountError) {
      return { error: error.message };
    }

    console.error(`could not ${what}`, { error });

    return { error: "Something went wrong. Nothing was changed." };
  }
}

export async function saveRuleAction(_state: RuleSaid, form: FormData): Promise<RuleSaid> {
  return run(form, "save a rule", (viewer, slug) =>
    saveRule(viewer, slug, {
      derived: text(form, "derived"),
      reference: text(form, "reference"),
      value: text(form, "value"),
      kind: text(form, "kind"),
    }),
  );
}

export async function switchRuleAction(_state: RuleSaid, form: FormData): Promise<RuleSaid> {
  return run(form, "switch a rule", (viewer, slug) => switchRule(viewer, slug, Number(form.get("id")), form.get("enabled") === "1"));
}

export async function removeRuleAction(_state: RuleSaid, form: FormData): Promise<RuleSaid> {
  return run(form, "remove a rule", (viewer, slug) => removeRule(viewer, slug, Number(form.get("id"))));
}

export async function siteRoundingAction(_state: RuleSaid, form: FormData): Promise<RuleSaid> {
  return run(form, "set the rounding", (viewer, slug) =>
    setSiteRounding(viewer, slug, { step: text(form, "step"), direction: text(form, "direction") }),
  );
}

export async function marketRoundingAction(_state: RuleSaid, form: FormData): Promise<RuleSaid> {
  return run(form, "set a market's rounding", (viewer, slug) =>
    setMarketRounding(viewer, slug, {
      location: text(form, "location"),
      step: text(form, "step"),
      direction: text(form, "direction"),
      exact: form.get("exact") !== null,
      as_printed: form.get("as_printed") !== null,
    }),
  );
}

export async function removeMarketRoundingAction(_state: RuleSaid, form: FormData): Promise<RuleSaid> {
  return run(form, "remove a market's rounding", (viewer, slug) => removeMarketRounding(viewer, slug, Number(form.get("id"))));
}
