/**
 * Per-market rules: the prices worked out from other prices.
 *
 * Most of a brand's markets never appear in a market report; the price
 * module calculates them from the few that do ("South Korea FOB = Singapore
 * FOB −10%"). The rulebook belongs to the AI engine (engine/), where the
 * arithmetic runs: it is read and changed through the engine, so a rule
 * saved here meets exactly the checks a rule saved on its console meets —
 * not calculated from itself, a fixed amount in the market's own currency,
 * the typo limits — and comes back with what it would do at today's prices.
 *
 * What it adds over the console's list is the brand's side of each rule: a
 * rule names its markets by exact title, and a title that matches nothing on
 * this brand means the rule silently never runs. Those are flagged here,
 * with the near miss when one exists (on baseoil, a double space).
 */

import { and, eq, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { locations, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { can, requirePermission } from "@/domain/staff/permissions";
import { engine, EngineError } from "@/lib/engine/client";

import { locationsWithLatestPrice, normaliseName } from "./locations";

/** A rule as the module stores it (`console_price_rules`). */
export type ModuleRule = {
  id: number;
  derived: string;
  reference: string;
  value: number;
  /** "percent", or a fixed amount: "usd", "eur", "inr". */
  kind: string;
  enabled: boolean;
};

export type ModuleRounding = {
  /** The brand's default step, or null for none. */
  step: number | null;
  direction: string;
  overrides: { id?: number; location: string; step: number; direction: string; asPrinted: boolean }[];
};

/** What the editing form offers: the markets, today's price and currency of each, and the report figures already in use. */
export type RuleEditor = {
  markets: string[];
  prices: Record<string, number>;
  currencies: Record<string, string>;
  benchmarks: string[];
};

export type ModuleBook = { rules: ModuleRule[]; rounding: ModuleRounding; editor?: RuleEditor };

/** Reads one brand's rulebook. Injected in tests. */
export type ModuleReader = (slug: string, actor: string) => Promise<ModuleBook>;

export class ModuleUnavailable extends Error {}

/** How a rule's market resolves against this brand's markets. */
export type Match =
  | { status: "market"; title: string; visible: boolean; price: number | null; date: string | null }
  | { status: "report" }
  /** Not this brand's title as written, but one differs only in case or spacing. */
  | { status: "near"; title: string }
  | { status: "missing" };

export type RuleRow = ModuleRule & {
  formula: string;
  derivedMatch: Match;
  referenceMatch: Match;
  /** Rules that are themselves worked out from this rule's price. */
  feeds: number;
};

export type RulesView = {
  connected: true;
  rules: RuleRow[];
  rounding: ModuleRounding;
  /** Markets on the brand with no rule: they come from the reports alone. */
  fromReports: number;
  markets: number;
  /** Rules that cannot run, because a name matches nothing on this brand. */
  broken: number;
  /** For the editing form; null when the reader gave none. */
  editor: RuleEditor | null;
  /** Whether this person may change the rules and rounding. */
  canEdit: boolean;
};

const FIXED: Record<string, string> = { usd: "USD", eur: "EUR", inr: "INR" };

export const RULE_PERMISSION = "price-rule-edit";

/** "−10%" or "+25 USD" — written the way the console writes it. */
export function adjustment(rule: Pick<ModuleRule, "value" | "kind">): string {
  const sign = rule.value > 0 ? "+" : rule.value < 0 ? "−" : "±";
  const amount = Math.abs(rule.value).toLocaleString("en-IN", { maximumFractionDigits: 4 });

  return FIXED[rule.kind] ? `${sign}${amount} ${FIXED[rule.kind]}` : `${sign}${amount}%`;
}

/**
 * Reads one brand's rulebook from the AI engine, which owns it: the rules,
 * the rounding, and — for the editing form — the markets as the engine sees
 * them, with today's price and currency of each.
 */
export const readEngine: ModuleReader = async (slug, actor) => {
  try {
    const book = await engine<EngineBook>(slug, "rules", { actor });

    return {
      rules: book.rules.map((rule) => ({
        id: rule.id,
        derived: rule.derived_location,
        reference: rule.reference_location,
        value: Number(rule.adjustment_value),
        kind: rule.adjustment_kind,
        enabled: rule.enabled,
      })),
      rounding: {
        step: book.round_to_nearest == null || Number(book.round_to_nearest) === 0 ? null : Number(book.round_to_nearest),
        direction: book.round_direction ?? "nearest",
        overrides: book.rounding_overrides.map((row) => ({
          id: row.id,
          location: row.location,
          step: Number(row.round_to_nearest),
          direction: row.direction,
          asPrinted: row.as_printed,
        })),
      },
      editor: { markets: book.locations, prices: book.prices, currencies: book.currencies, benchmarks: book.benchmarks },
    };
  } catch (error) {
    if (error instanceof EngineError) {
      throw new ModuleUnavailable(error.message);
    }

    throw error;
  }
};

type EngineBook = {
  rules: { id: number; derived_location: string; reference_location: string; adjustment_value: number; adjustment_kind: string; enabled: boolean }[];
  locations: string[];
  benchmarks: string[];
  prices: Record<string, number>;
  currencies: Record<string, string>;
  round_to_nearest: number | null;
  round_direction: string | null;
  rounding_overrides: { id: number; location: string; round_to_nearest: number; direction: string; as_printed: boolean }[];
};

/** One brand's rulebook, each rule checked against the brand's markets. */
export async function rulesFor(
  guard: Guarded,
  input: { site: string },
  database: Database = db(),
  read: ModuleReader = readEngine,
): Promise<RulesView | { connected: false; reason: string }> {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, input.site)).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "price-batch-view", database);

  let book: ModuleBook;

  try {
    book = await read(brand.slug, guard.identity.user.email);
  } catch (error) {
    if (error instanceof ModuleUnavailable) {
      return { connected: false, reason: error.message };
    }

    throw error;
  }

  const [latest, shown] = await Promise.all([
    locationsWithLatestPrice(brand.id, database),
    database
      .select({ id: locations.id, visible: locations.visible })
      .from(locations)
      .where(and(eq(locations.siteId, brand.id), isNull(locations.deletedAt))),
  ]);

  const visible = new Map(shown.map((row) => [row.id, row.visible]));
  const exact = new Map(latest.map((row) => [row.title, row]));
  const near = new Map(latest.map((row) => [normaliseName(row.title), row]));

  // Exact title, as the module resolves it. A near match is reported, not used.
  const match = (name: string, reportAllowed: boolean): Match => {
    if (reportAllowed && name.trim().toLowerCase().startsWith("report:")) {
      return { status: "report" };
    }

    const hit = exact.get(name);

    if (hit) {
      return { status: "market", title: hit.title, visible: visible.get(hit.id) ?? true, price: hit.latest_price, date: hit.latest_pricedate };
    }

    const close = near.get(normaliseName(name));

    return close ? { status: "near", title: close.title } : { status: "missing" };
  };

  const feeds = new Map<string, number>();

  for (const rule of book.rules) {
    feeds.set(rule.reference, (feeds.get(rule.reference) ?? 0) + 1);
  }

  const rows: RuleRow[] = book.rules.map((rule) => ({
    ...rule,
    formula: `${rule.reference} ${adjustment(rule)}`,
    derivedMatch: match(rule.derived, false),
    referenceMatch: match(rule.reference, true),
    feeds: feeds.get(rule.derived) ?? 0,
  }));

  const derivedTitles = new Set(rows.filter((row) => row.derivedMatch.status === "market").map((row) => row.derived));

  return {
    connected: true,
    rules: rows,
    rounding: book.rounding,
    editor: book.editor ?? null,
    canEdit: await can(guard, brand.id, RULE_PERMISSION, database),
    markets: latest.length,
    fromReports: latest.filter((row) => !derivedTitles.has(row.title)).length,
    broken: rows.filter(
      (row) =>
        row.enabled &&
        (row.derivedMatch.status === "near" ||
          row.derivedMatch.status === "missing" ||
          row.referenceMatch.status === "near" ||
          row.referenceMatch.status === "missing"),
    ).length,
  };
}

/* ------------------------------------------------------------- editing */

/** The brand, if this person may change its rules. */
async function editable(guard: Guarded, slug: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand || (!guard.isSuperadmin && !guard.siteIds.includes(brand.id))) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, RULE_PERMISSION, database);

  return brand;
}

/** One change through the engine; answers with what the engine says happened. */
async function change(
  guard: Guarded,
  slug: string,
  path: string,
  method: "POST" | "PATCH" | "PUT",
  json: unknown,
  database: Database,
): Promise<string> {
  await editable(guard, slug, database);

  return (await engine<{ message: string }>(slug, path, { method, json, actor: guard.identity.user.email })).message;
}

/** Add a rule, or replace the one the derived market already has. */
export function saveRule(
  guard: Guarded,
  slug: string,
  input: { derived: string; reference: string; value: string; kind: string },
  database: Database = db(),
) {
  return change(guard, slug, "rules", "POST", input, database);
}

export function switchRule(guard: Guarded, slug: string, id: number, enabled: boolean, database: Database = db()) {
  return change(guard, slug, `rules/${id}`, "PATCH", { enabled }, database);
}

export async function removeRule(guard: Guarded, slug: string, id: number, database: Database = db()) {
  await editable(guard, slug, database);

  return (await engine<{ message: string }>(slug, `rules/${id}`, { method: "DELETE", actor: guard.identity.user.email })).message;
}

/** The brand's step for every market; a blank step turns rounding off. */
export function setSiteRounding(guard: Guarded, slug: string, input: { step: string; direction: string }, database: Database = db()) {
  return change(guard, slug, "rounding", "PUT", input, database);
}

/** One market's own rounding: a step, "never rounded", and whether its figure is taken as printed. */
export function setMarketRounding(
  guard: Guarded,
  slug: string,
  input: { location: string; step: string; direction: string; exact: boolean; as_printed: boolean },
  database: Database = db(),
) {
  return change(guard, slug, "rounding/locations", "POST", input, database);
}

export async function removeMarketRounding(guard: Guarded, slug: string, id: number, database: Database = db()) {
  await editable(guard, slug, database);

  return (await engine<{ message: string }>(slug, `rounding/locations/${id}`, { method: "DELETE", actor: guard.identity.user.email })).message;
}
