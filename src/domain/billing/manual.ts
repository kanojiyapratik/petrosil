/**
 * Recording a payment the team took by hand: a bank transfer, a cheque, a
 * card over the phone.
 *
 * The old "mark as paid" form wrote the price, the method and the
 * transaction number onto the subscription row, so the Transactions screen
 * and the plan's sales never saw them. Here it is an order and a payment like
 * any other, at the price actually charged — baseoil has sold the ₹15,000
 * plan for anything from ₹9,000 to ₹250,000.
 *
 * The term follows the checkout's rule: a renewal extends a subscription that
 * is still running, from its own end, and a lapsed one starts again from the
 * day the money arrived. When the team agreed a different end date, they say
 * so and it is used as given. The same transaction number cannot be recorded
 * twice on a brand, because the commonest mistake with a manual form is
 * pressing Save twice.
 */

import { and, eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, memberships, orders, payments, planPrices, planSites, plans, sites, users } from "@/db/schema";
import { currencyFor } from "./pricing";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { today } from "@/domain/price/dates";
import { extendedUntil } from "./term";
import { dateInput, moneyInput } from "./inputs";

export const PAYMENT_METHODS = [
  { key: "bank", label: "Bank transfer" },
  { key: "cheque", label: "Cheque" },
  { key: "card", label: "Card" },
  { key: "online", label: "Payment link" },
  { key: "cash", label: "Cash" },
  { key: "other", label: "Other" },
] as const;

export type ManualPayment = {
  user_id: number;
  site: string;
  plan_id: number;
  years: unknown;
  amount: unknown;
  method: unknown;
  /** The transaction, cheque or UTR number. Optional: cash has none. */
  reference?: unknown;
  paid_on?: unknown;
  /** The end date the team agreed, when it is not the usual one. */
  until?: unknown;
  /** INR or USD. Blank: as the checkout would have charged them. */
  currency?: unknown;
};

export type Recorded = { order_id: number; until: string };

const toMinor = (amount: string) => Math.round(Number(amount) * 100);
const toDecimal = (minor: number) => (minor / 100).toFixed(2);

export async function recordPayment(
  guard: Guarded,
  input: ManualPayment,
  context: { ip?: string | null } = {},
  database: Database = db(),
  now: Date = new Date(),
): Promise<Recorded> {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, input.site)).limit(1);

  if (!brand) {
    throw new AccountError("Choose a brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  // The same permission as the membership editor: this changes what a reader holds.
  await requirePermission(guard, brand.id, "directory-edit", database);

  const [person] = await database.select().from(users).where(eq(users.id, input.user_id)).limit(1);

  if (!person) {
    throw new AccountError("We cannot find that person.", 404, "user_id");
  }

  const [sold] = await database
    .select({ plan: plans })
    .from(plans)
    .innerJoin(planSites, and(eq(planSites.planId, plans.id), eq(planSites.siteId, brand.id)))
    .where(eq(plans.id, input.plan_id))
    .limit(1);
  const plan = sold?.plan;

  if (!plan) {
    throw new AccountError(`Choose one of ${brand.name}'s plans.`, 422, "plan_id");
  }

  const years = Number(input.years);

  if (!Number.isInteger(years) || years < 1 || years > 10) {
    throw new AccountError("The term is a whole number of years, from 1 to 10.", 422, "years");
  }

  const amount = moneyInput(input.amount, "amount");
  const method = PAYMENT_METHODS.find((row) => row.key === input.method);

  if (!method) {
    throw new AccountError("Choose how they paid.", 422, "method");
  }

  const reference = String(input.reference ?? "").trim().slice(0, 191) || null;
  const day = today(now);
  const paidOn = dateInput(input.paid_on, "paid_on") ?? day;

  if (paidOn > day) {
    throw new AccountError("A payment cannot be dated in the future.", 422, "paid_on");
  }

  const agreed = dateInput(input.until, "until");

  if (agreed !== null && agreed < paidOn) {
    throw new AccountError("Access would end before the payment was made.", 422, "until");
  }

  if (reference) {
    const [seen] = await database
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.siteId, brand.id), eq(orders.provider, "manual"), eq(orders.providerPaymentId, reference)))
      .limit(1);

    if (seen) {
      throw new AccountError(`Transaction ${reference} is already recorded on ${brand.name}, as order ${seen.id}.`, 409, "reference");
    }
  }

  // The currency they paid in: as the team says, or else as the checkout would
  // have charged them, by their country.
  const offered = await database
    .select({ currency: planPrices.currency, years: planPrices.years, amount: planPrices.amount })
    .from(planPrices)
    .where(eq(planPrices.planId, plan.id));
  const currencies = [...new Set(offered.map((row) => row.currency))];
  const asked = String(input.currency ?? "").trim().toUpperCase();

  if (asked !== "" && !currencies.includes(asked)) {
    throw new AccountError(`${plan.name} is not priced in ${asked}.`, 422, "currency");
  }

  const currency = asked || currencyFor(person.country, currencies);

  if (!currency) {
    throw new AccountError(`${plan.name} has no price yet. Set one on the Plans screen first.`, 422, "plan_id");
  }

  const term = offered.find((row) => row.currency === currency && row.years === years);

  // The invoice must add up: list less discount is what was paid. Below the
  // list price the difference is the discount; above it, the agreed price is
  // the list. The plan's own price goes in the audit entry either way.
  const listPrice = term ? Number(term.amount).toFixed(2) : amount;
  const above = toMinor(amount) >= toMinor(listPrice);
  const listAmount = above ? amount : listPrice;
  const discount = above ? "0.00" : toDecimal(toMinor(listPrice) - toMinor(amount));

  return database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, person.id), eq(memberships.siteId, brand.id)))
      .limit(1);

    const until = agreed ?? extendedUntil(existing?.expiresAt ?? null, years, paidOn);
    const paidAt = new Date(`${paidOn}T12:00:00Z`);

    const [order] = await tx
      .insert(orders)
      .values({
        siteId: brand.id,
        userId: person.id,
        planId: plan.id,
        planName: plan.name,
        years,
        currency: currency,
        listAmount,
        discount,
        amount,
        status: "paid",
        provider: "manual",
        providerPaymentId: reference,
        paidAt,
        grantedUntil: until,
      })
      .returning();

    await tx.insert(payments).values({
      orderId: order!.id,
      provider: method.key,
      providerPaymentId: reference,
      amount,
      currency: currency,
      status: "succeeded",
    });

    if (existing) {
      // A staff row keeps its role: buying a subscription changes what they hold, not what they are.
      await tx
        .update(memberships)
        .set({ tier: "premium", expiresAt: until, lapsedFrom: null, updatedAt: new Date() })
        .where(eq(memberships.id, existing.id));
    } else {
      await tx.insert(memberships).values({
        userId: person.id,
        siteId: brand.id,
        role: "subscriber",
        tier: "premium",
        expiresAt: until,
      });
    }

    await tx.insert(auditLog).values({
      siteId: brand.id,
      userId: guard.identity.user.id,
      action: "order.manual",
      entity: "order",
      entityId: order!.id,
      detail: {
        reader: person.id,
        plan: plan.name,
        years,
        amount,
        currency: currency,
        list: listPrice,
        method: method.key,
        reference,
        paid_on: paidOn,
        was: existing ? { tier: existing.tier, expires_at: existing.expiresAt } : null,
        until,
      },
      ip: context.ip ?? null,
    });

    return { order_id: order!.id, until };
  });
}
