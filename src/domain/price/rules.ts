/**
 * Per-market rules: the prices worked out from other prices.
 *
 * Most of a brand's markets never appear in a market report; the price
 * module calculates them from the few that do ("South Korea FOB = Singapore
 * FOB −10%"). The rulebook lives in the module's own database and is edited
 * on its console, where the arithmetic runs — so this side reads it, never
 * writes it, and links to the console for changes.
 *
 * What it adds over the console's list is the brand's side of each rule: a
 * rule names its markets by exact title, and a title that matches nothing on
 * this brand means the rule silently never runs. Those are flagged here,
 * with the near miss when one exists (on baseoil, a double space).
 */

import { and, eq, isNull } from "drizzle-orm";
import postgres from "postgres";

import { db, type Database } from "@/db";
import { locations, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";

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
  overrides: { location: string; step: number; direction: string; asPrinted: boolean }[];
};

export type ModuleBook = { rules: ModuleRule[]; rounding: ModuleRounding };

/** Reads one brand's rulebook from the module. Injected in tests. */
export type ModuleReader = (slug: string) => Promise<ModuleBook>;

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
};

const FIXED: Record<string, string> = { usd: "USD", eur: "EUR", inr: "INR" };

/** "−10%" or "+25 USD" — written the way the console writes it. */
export function adjustment(rule: Pick<ModuleRule, "value" | "kind">): string {
  const sign = rule.value > 0 ? "+" : rule.value < 0 ? "−" : "±";
  const amount = Math.abs(rule.value).toLocaleString("en-IN", { maximumFractionDigits: 4 });

  return FIXED[rule.kind] ? `${sign}${amount} ${FIXED[rule.kind]}` : `${sign}${amount}%`;
}

let moduleClient: ReturnType<typeof postgres> | undefined;

/**
 * The module's database, read-only at the session level: this side has no
 * business writing the rulebook, and the connection cannot.
 */
export const readModule: ModuleReader = async (slug) => {
  const url = process.env.MODULE_DATABASE_URL;

  if (!url) {
    throw new ModuleUnavailable("MODULE_DATABASE_URL is not set.");
  }

  moduleClient ??= postgres(url, {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 5,
    connection: { default_transaction_read_only: true },
    onnotice: () => {},
  });

  try {
    const [rules, sitesRow, overrides] = await Promise.all([
      moduleClient<{ id: string; derived_location: string; reference_location: string; adjustment_value: string; adjustment_kind: string; enabled: boolean }[]>`
        select id, derived_location, reference_location, adjustment_value, adjustment_kind, enabled
        from console_price_rules where site_slug = ${slug} order by derived_location`,
      moduleClient<{ round_to_nearest: string | null; round_direction: string | null }[]>`
        select round_to_nearest, round_direction from console_sites where slug = ${slug}`,
      moduleClient<{ location: string; round_to_nearest: string; direction: string; as_printed: boolean }[]>`
        select location, round_to_nearest, direction, as_printed
        from console_location_rounding where site_slug = ${slug} order by location`,
    ]);

    return {
      rules: rules.map((row) => ({
        id: Number(row.id),
        derived: row.derived_location,
        reference: row.reference_location,
        value: Number(row.adjustment_value),
        kind: row.adjustment_kind,
        enabled: row.enabled,
      })),
      rounding: {
        step: sitesRow[0]?.round_to_nearest == null ? null : Number(sitesRow[0].round_to_nearest),
        direction: sitesRow[0]?.round_direction ?? "nearest",
        overrides: overrides.map((row) => ({
          location: row.location,
          step: Number(row.round_to_nearest),
          direction: row.direction,
          asPrinted: row.as_printed,
        })),
      },
    };
  } catch (error) {
    throw new ModuleUnavailable(error instanceof Error ? error.message : String(error));
  }
};

/** Where the rules are edited, when the console's address is known. */
export function consoleRulesUrl(slug: string): string | null {
  const base = process.env.MODULE_CONSOLE_URL?.replace(/\/+$/, "");

  return base ? `${base}/console/sites/${encodeURIComponent(slug)}/rules` : null;
}

/** One brand's rulebook, each rule checked against the brand's markets. */
export async function rulesFor(
  guard: Guarded,
  input: { site: string },
  database: Database = db(),
  read: ModuleReader = readModule,
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
    book = await read(brand.slug);
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
