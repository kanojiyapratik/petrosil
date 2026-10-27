/**
 * Creating and changing what a brand sells.
 *
 * A plan is never deleted: orders point at it, and a plan nobody may buy any
 * more is hidden instead. Changing a price changes nothing already sold,
 * because every order copied its plan name, term and amount when it was
 * placed. The code is made once from the name and never moves, so a plan
 * renamed from the carried "{{ ADMIN_NAME }} - Global" keeps its address.
 */

import { and, eq, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, planPrices, plans, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { currencyInput, moneyInput } from "./inputs";

export type PlanInput = {
  id?: number;
  /** The brand, on a new plan only. */
  site?: string;
  name: unknown;
  description?: unknown;
  currency: unknown;
  visible?: boolean;
  sort_order?: unknown;
  /** Every term the plan is sold for. A term left out is no longer offered. */
  terms: { years: unknown; amount: unknown }[];
};

export type SavedPlan = { id: number; code: string; name: string; visible: boolean };

function readTerms(given: PlanInput["terms"]): Map<number, string> {
  const out = new Map<number, string>();

  for (const term of given) {
    const years = Number(term.years);

    if (!Number.isInteger(years) || years < 1 || years > 10) {
      throw new AccountError("A term is a whole number of years, from 1 to 10.", 422, "terms");
    }

    if (out.has(years)) {
      throw new AccountError(`The ${years}-year price is given twice.`, 422, "terms");
    }

    out.set(years, moneyInput(term.amount, "terms", `The ${years}-year price is not an amount, like 15000 or 540.50.`));
  }

  return out;
}

async function codeFor(siteId: number, name: string, database: Database): Promise<string> {
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
    .where(and(eq(plans.siteId, siteId), sql`${plans.code} like ${`${base}%`}`));

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

const termsOf = (rows: { years: number; amount: string }[]) =>
  Object.fromEntries(rows.map((row) => [row.years, row.amount]));

/** Null when the plan is not one this editor may see. */
export async function savePlan(
  guard: Guarded,
  input: PlanInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<SavedPlan | null> {
  let existing: typeof plans.$inferSelect | undefined;
  let siteId: number;

  // Who may, before what: a refusal should not depend on how well the form was filled in.
  if (input.id !== undefined) {
    [existing] = await database.select().from(plans).where(eq(plans.id, input.id)).limit(1);

    if (!existing || (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))) {
      return null;
    }

    siteId = existing.siteId;
    await requirePermission(guard, siteId, "subscription-edit", database);
  } else {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, String(input.site ?? ""))).limit(1);

    if (!brand) {
      throw new AccountError("Choose a brand.", 422, "site");
    }

    if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
      throw new AccountError("You do not have access to that brand.", 403, "site");
    }

    siteId = brand.id;
    await requirePermission(guard, siteId, "subscription-create", database);
  }

  const name = String(input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 191);

  if (name === "") {
    throw new AccountError("Give the plan a name.", 422, "name");
  }

  const description = String(input.description ?? "").trim() || null;
  const currency = currencyInput(input.currency);
  const sortOrder = Number.isInteger(Number(input.sort_order)) ? Number(input.sort_order) : 0;
  const prices = readTerms(input.terms);
  const visible = input.visible ?? true;

  const before = existing
    ? termsOf(await database.select().from(planPrices).where(eq(planPrices.planId, existing.id)))
    : {};
  const code = existing ? existing.code : await codeFor(siteId, name, database);

  const saved = await database.transaction(async (tx) => {
    const values = { name, description, currency, visible, sortOrder, updatedAt: new Date() };

    const [row] = existing
      ? await tx.update(plans).set(values).where(eq(plans.id, existing.id)).returning()
      : await tx.insert(plans).values({ ...values, siteId, code }).returning();

    await tx.delete(planPrices).where(eq(planPrices.planId, row!.id));

    if (prices.size > 0) {
      await tx.insert(planPrices).values([...prices].map(([years, amount]) => ({ planId: row!.id, years, amount })));
    }

    await tx.insert(auditLog).values({
      siteId,
      userId: guard.identity.user.id,
      action: existing ? "plan.update" : "plan.create",
      entity: "plan",
      entityId: row!.id,
      detail: {
        ...(existing
          ? { was: { name: existing.name, currency: existing.currency, visible: existing.visible, terms: before } }
          : {}),
        now: { name, currency, visible, terms: Object.fromEntries(prices) },
      },
      ip: context.ip ?? null,
    });

    return row!;
  });

  return { id: saved.id, code: saved.code, name: saved.name, visible: saved.visible };
}

/** One plan for its editor, scoped like every dashboard read. */
export async function planForEdit(siteIds: number[], id: number, database: Database = db()) {
  const [row] = await database
    .select({ plan: plans, slug: sites.slug, siteName: sites.name })
    .from(plans)
    .innerJoin(sites, eq(sites.id, plans.siteId))
    .where(eq(plans.id, id))
    .limit(1);

  if (!row || (siteIds.length > 0 && !siteIds.includes(row.plan.siteId))) {
    return null;
  }

  const prices = await database.select().from(planPrices).where(eq(planPrices.planId, id)).orderBy(planPrices.years);

  return {
    id: row.plan.id,
    site: row.slug,
    site_name: row.siteName,
    code: row.plan.code,
    name: row.plan.name,
    description: row.plan.description,
    currency: row.plan.currency,
    visible: row.plan.visible,
    sort_order: row.plan.sortOrder,
    terms: prices.map((price) => ({ years: price.years, amount: price.amount })),
  };
}

export type PlanForEdit = NonNullable<Awaited<ReturnType<typeof planForEdit>>>;
