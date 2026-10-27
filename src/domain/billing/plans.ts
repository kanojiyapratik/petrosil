/**
 * Creating and changing what the brands sell.
 *
 * A plan applies to the brands ticked for it, every brand when all are
 * ticked, and is priced in each currency ticked for it: one plan carries both
 * the rupee and the dollar price, and the buyer's country decides which they
 * pay. Each term may also have a sale price, charged while the plan is on sale.
 *
 * A plan is never deleted: orders point at it, and a plan nobody may buy any
 * more is hidden instead. Changing a price changes nothing already sold,
 * because every order copied its plan name, term and amount when it was
 * placed. The code is made once from the name and never moves.
 *
 * Brand staff may only touch a plan whose brands are all theirs: a plan
 * shared with a brand they do not run is not theirs to reprice.
 */

import { eq, inArray, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, planPrices, planSites, plans, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { moneyInput } from "./inputs";

/** The currencies a plan can be priced in. */
export const PLAN_CURRENCIES = ["INR", "USD"] as const;

export type TermInput = { currency: unknown; years: unknown; amount: unknown; sale_amount?: unknown };

export type PlanInput = {
  id?: number;
  name: unknown;
  description?: unknown;
  /** Brand slugs. */
  sites: unknown[];
  currencies: unknown[];
  visible?: boolean;
  on_sale?: boolean;
  sort_order?: unknown;
  /** Every price the plan is sold at. A term left out is no longer offered. */
  terms: TermInput[];
};

export type SavedPlan = { id: number; code: string; name: string; visible: boolean; on_sale: boolean };

type Term = { currency: string; years: number; amount: string; saleAmount: string | null };

function readCurrencies(given: unknown[]): string[] {
  const chosen = [...new Set(given.map((value) => String(value ?? "").trim().toUpperCase()))].filter(Boolean);

  if (chosen.length === 0) {
    throw new AccountError("Tick at least one currency.", 422, "currencies");
  }

  for (const currency of chosen) {
    if (!(PLAN_CURRENCIES as readonly string[]).includes(currency)) {
      throw new AccountError(`Plans are priced in ${PLAN_CURRENCIES.join(" or ")}.`, 422, "currencies");
    }
  }

  return chosen.sort();
}

/** The prices, for the ticked currencies only: an unticked currency's boxes are ignored. */
function readTerms(given: TermInput[], currencies: string[], onSale: boolean): Term[] {
  const out = new Map<string, Term>();

  for (const term of given) {
    const currency = String(term.currency ?? "").trim().toUpperCase();

    if (!currencies.includes(currency)) {
      continue;
    }

    const years = Number(term.years);

    if (!Number.isInteger(years) || years < 1 || years > 10) {
      throw new AccountError("A term is a whole number of years, from 1 to 10.", 422, "terms");
    }

    const key = `${currency}|${years}`;

    if (out.has(key)) {
      throw new AccountError(`The ${years}-year ${currency} price is given twice.`, 422, "terms");
    }

    const label = `The ${years}-year ${currency}`;
    const amount = moneyInput(term.amount, "terms", `${label} price is not an amount, like 15000 or 540.50.`);
    const saleText = String(term.sale_amount ?? "").trim();
    const saleAmount = saleText === "" ? null : moneyInput(saleText, "terms", `${label} sale price is not an amount.`);

    if (saleAmount !== null && Number(saleAmount) >= Number(amount)) {
      throw new AccountError(`${label} sale price has to be below its regular price.`, 422, "terms");
    }

    out.set(key, { currency, years, amount, saleAmount });
  }

  for (const currency of currencies) {
    if (![...out.values()].some((term) => term.currency === currency)) {
      throw new AccountError(`Give at least one ${currency} price, or untick ${currency}.`, 422, "terms");
    }
  }

  if (onSale && ![...out.values()].some((term) => term.saleAmount !== null)) {
    throw new AccountError("A plan on sale needs a sale price for at least one term.", 422, "terms");
  }

  return [...out.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.years - b.years);
}

async function codeFor(name: string, database: Database): Promise<string> {
  const base =
    name
      .toLowerCase()
      // The carried "{{ ADMIN_NAME }}" placeholder is not part of anyone's name.
      .replace(/\{\{[^}]*\}\}/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "plan";

  const taken = await database
    .select({ code: plans.code })
    .from(plans)
    .where(sql`${plans.code} like ${`${base}%`}`);

  const used = new Set(taken.map((row) => row.code));

  if (!used.has(base)) {
    return base;
  }

  for (let n = 2; n < 1000; n += 1) {
    if (!used.has(`${base}-${n}`)) {
      return `${base}-${n}`;
    }
  }

  return `${base}-${Date.now()}`;
}

const mayRun = (guard: Guarded, siteIds: number[]) =>
  guard.isSuperadmin || siteIds.every((id) => guard.siteIds.includes(id));

const pricesOf = (rows: Term[]) =>
  Object.fromEntries(rows.map((row) => [`${row.currency} ${row.years}y`, row.saleAmount ? `${row.amount} (sale ${row.saleAmount})` : row.amount]));

/** Null when the plan is not one this editor may change. */
export async function savePlan(
  guard: Guarded,
  input: PlanInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<SavedPlan | null> {
  let existing: typeof plans.$inferSelect | undefined;
  let before: { siteIds: number[]; terms: Term[] } = { siteIds: [], terms: [] };

  if (input.id !== undefined) {
    [existing] = await database.select().from(plans).where(eq(plans.id, input.id)).limit(1);

    if (!existing) {
      return null;
    }

    const held = await database.select({ siteId: planSites.siteId }).from(planSites).where(eq(planSites.planId, existing.id));

    before = {
      siteIds: held.map((row) => row.siteId),
      terms: await database.select().from(planPrices).where(eq(planPrices.planId, existing.id)),
    };

    if (!mayRun(guard, before.siteIds)) {
      return null;
    }
  }

  // The brands, checked before anything else: who may is not a matter of how well the form was filled in.
  const slugs = [...new Set(input.sites.map((value) => String(value ?? "").trim()).filter(Boolean))];

  if (slugs.length === 0) {
    throw new AccountError("Tick at least one brand.", 422, "sites");
  }

  const brands = await database.select().from(sites).where(inArray(sites.slug, slugs));

  if (brands.length !== slugs.length) {
    throw new AccountError("One of those brands does not exist.", 422, "sites");
  }

  const siteIds = brands.map((brand) => brand.id);

  if (!mayRun(guard, siteIds)) {
    throw new AccountError("You can only sell a plan on brands you manage.", 403, "sites");
  }

  for (const siteId of siteIds) {
    await requirePermission(guard, siteId, existing ? "subscription-edit" : "subscription-create", database);
  }

  const name = String(input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 191);

  if (name === "") {
    throw new AccountError("Give the plan a name.", 422, "name");
  }

  const description = String(input.description ?? "").trim() || null;
  const sortOrder = Number.isInteger(Number(input.sort_order)) ? Number(input.sort_order) : 0;
  const visible = input.visible ?? true;
  const onSale = input.on_sale ?? false;
  const currencies = readCurrencies(input.currencies);
  const terms = readTerms(input.terms, currencies, onSale);
  const code = existing ? existing.code : await codeFor(name, database);

  const saved = await database.transaction(async (tx) => {
    const values = { name, description, visible, onSale, sortOrder, updatedAt: new Date() };

    const [row] = existing
      ? await tx.update(plans).set(values).where(eq(plans.id, existing.id)).returning()
      : await tx.insert(plans).values({ ...values, code }).returning();

    await tx.delete(planSites).where(eq(planSites.planId, row!.id));
    await tx.insert(planSites).values(siteIds.map((siteId) => ({ planId: row!.id, siteId })));

    await tx.delete(planPrices).where(eq(planPrices.planId, row!.id));
    await tx.insert(planPrices).values(terms.map((term) => ({ planId: row!.id, ...term })));

    // One entry per brand it now touches, so each brand's audit trail shows it.
    const touched = [...new Set([...siteIds, ...before.siteIds])];

    await tx.insert(auditLog).values(
      touched.map((siteId) => ({
        siteId,
        userId: guard.identity.user.id,
        action: existing ? "plan.update" : "plan.create",
        entity: "plan",
        entityId: row!.id,
        detail: {
          ...(existing
            ? {
                was: {
                  name: existing.name,
                  visible: existing.visible,
                  on_sale: existing.onSale,
                  brands: before.siteIds,
                  prices: pricesOf(before.terms),
                },
              }
            : {}),
          now: { name, visible, on_sale: onSale, brands: siteIds, prices: pricesOf(terms) },
        },
        ip: context.ip ?? null,
      })),
    );

    return row!;
  });

  return { id: saved.id, code: saved.code, name: saved.name, visible: saved.visible, on_sale: saved.onSale };
}

/** One plan for its editor. Staff see a plan when any of its brands is theirs. */
export async function planForEdit(siteIds: number[], id: number, database: Database = db()) {
  const [plan] = await database.select().from(plans).where(eq(plans.id, id)).limit(1);

  if (!plan) {
    return null;
  }

  const held = await database
    .select({ id: sites.id, slug: sites.slug, name: sites.name })
    .from(planSites)
    .innerJoin(sites, eq(sites.id, planSites.siteId))
    .where(eq(planSites.planId, id))
    .orderBy(sites.slug);

  if (siteIds.length > 0 && !held.some((brand) => siteIds.includes(brand.id))) {
    return null;
  }

  const prices = await database
    .select()
    .from(planPrices)
    .where(eq(planPrices.planId, id))
    .orderBy(planPrices.currency, planPrices.years);

  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    visible: plan.visible,
    on_sale: plan.onSale,
    sort_order: plan.sortOrder,
    sites: held.map((brand) => brand.slug),
    site_names: held.map((brand) => brand.name),
    /** False when the plan is shared with a brand this viewer does not run: they may look, not change. */
    editable: siteIds.length === 0 || held.every((brand) => siteIds.includes(brand.id)),
    currencies: [...new Set(prices.map((price) => price.currency))],
    terms: prices.map((price) => ({
      currency: price.currency,
      years: price.years,
      amount: price.amount,
      sale_amount: price.saleAmount,
    })),
  };
}

export type PlanForEdit = NonNullable<Awaited<ReturnType<typeof planForEdit>>>;
