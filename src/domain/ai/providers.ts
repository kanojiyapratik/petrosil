/**
 * The AI providers every brand chooses among, and what the AI has been used
 * for — estate-wide, under Global settings.
 *
 * The keys live in the AI engine and stay there: this side sees each one
 * masked, can test it, replace it or remove it, and never reads it back.
 * Managing them is a superadmin's job, like every other estate setting;
 * usage is visible to staff for the brands they work on.
 */

import { sites } from "@/db/schema";
import { db, type Database } from "@/db";
import { AccessError, type Guarded } from "@/lib/auth/guard";
import { engine } from "@/lib/engine/client";

type Who = Pick<Guarded, "identity" | "siteIds" | "isSuperadmin">;

export type Provider = {
  id: number;
  name: string;
  provider: string;
  label: string;
  model: string;
  masked_key: string;
  enabled: boolean;
  is_default: boolean;
  models: string[];
  /** Brands that chose this provider for themselves. */
  sites: string[];
};

export type ProviderList = {
  catalogue: Record<string, { label: string; key_hint: string }>;
  providers: Provider[];
};

function superadmin(guard: Who): void {
  if (!guard.isSuperadmin) {
    throw new AccessError("Only a superadmin can change the AI providers.", 403);
  }
}

const actor = (guard: Who) => guard.identity.user.email;

export async function providerList(guard: Who): Promise<ProviderList> {
  superadmin(guard);

  return engine<ProviderList>(null, "providers", { actor: actor(guard) });
}

/** What a key being typed in can run. The key goes to the engine to ask, and nowhere else. */
export async function modelsForKey(guard: Who, input: { provider: string; apiKey: string }): Promise<string[]> {
  superadmin(guard);

  return (
    await engine<{ models: string[] }>(null, "providers/check-key", {
      method: "POST",
      json: { provider: input.provider, api_key: input.apiKey },
      actor: actor(guard),
      timeout: 20_000,
    })
  ).models;
}

async function said(guard: Who, path: string, method: "POST" | "PATCH" | "DELETE", json?: unknown, timeout?: number): Promise<string> {
  superadmin(guard);

  return (await engine<{ message: string }>(null, path, { method, json, actor: actor(guard), timeout })).message;
}

export const addProvider = (guard: Who, input: { provider: string; apiKey: string; name: string; makeDefault: boolean }) =>
  said(guard, "providers", "POST", {
    provider: input.provider,
    api_key: input.apiKey,
    name: input.name,
    make_default: input.makeDefault,
  });

/** A blank key keeps the stored one. */
export const updateProvider = (guard: Who, id: number, input: { name: string; model: string; apiKey: string; enabled: boolean }) =>
  said(guard, `providers/${id}`, "PATCH", { name: input.name, model: input.model, api_key: input.apiKey, enabled: input.enabled });

export const makeDefaultProvider = (guard: Who, id: number) => said(guard, `providers/${id}/default`, "POST");

export const removeProvider = (guard: Who, id: number) => said(guard, `providers/${id}`, "DELETE");

/** One tiny call to the model, so a wrong key or an empty quota shows here, not mid-update. */
export const testProvider = (guard: Who, id: number) => said(guard, `providers/${id}/test`, "POST", undefined, 60_000);

/* ------------------------------------------------------------------ usage */

export type UsageReport = {
  days: number;
  by_day: { day: string; provider: string; model: string; calls: number; prompt_tokens: number; completion_tokens: number }[];
  by_site: { site: string | null; kind: string; calls: number; failed: number; prompt_tokens: number; completion_tokens: number }[];
  /** Brand names by slug, for the rows this person may see. */
  names: Record<string, string>;
  /** False for staff: the per-day totals cover every brand, so they are a superadmin's. */
  estate: boolean;
};

export async function aiUsage(guard: Who, days: number, database: Database = db()): Promise<UsageReport> {
  const report = await engine<Omit<UsageReport, "names" | "estate">>(null, `usage?days=${Math.max(1, Math.min(days, 365))}`, {
    actor: actor(guard),
  });
  const brands = await database.select({ id: sites.id, slug: sites.slug, name: sites.name }).from(sites);
  const mine = new Set(brands.filter((brand) => guard.isSuperadmin || guard.siteIds.includes(brand.id)).map((brand) => brand.slug));

  return {
    days: report.days,
    estate: guard.isSuperadmin,
    by_day: guard.isSuperadmin ? report.by_day : [],
    // Work with no brand (a provider test) is the estate's, not a brand's.
    by_site: report.by_site.filter((row) => (row.site ? mine.has(row.site) : guard.isSuperadmin)),
    names: Object.fromEntries(brands.filter((brand) => mine.has(brand.slug)).map((brand) => [brand.slug, brand.name])),
  };
}
