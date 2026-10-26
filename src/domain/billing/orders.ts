/**
 * Buying a subscription.
 *
 * Two rules worth stating before the code. **The server prices the order**:
 * the plan and the coupon decide what it costs, and anything price-shaped in
 * the request is ignored — the old checkout posted the amount it had been
 * shown and the controller wrote it to the row. And **settling is idempotent**:
 * a provider that retries a callback, or a customer who refreshes the success
 * page, must not buy a second year.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  auditLog,
  coupons,
  memberships,
  orders,
  payments,
  planPrices,
  plans,
  sites,
} from "@/db/schema";
import type { Identity } from "@/lib/auth/session";
import { today } from "@/domain/price/dates";
import { AccountError } from "@/domain/accounts/register";
import { applyCoupon, minorUnits, undiscounted, type Priced } from "./pricing";
import { extendedUntil } from "./term";
import { createProviderOrder, razorpayKeys, verifySignature } from "@/lib/payments/razorpay";

export type OrderView = {
  id: number;
  site: string;
  plan: string | null;
  plan_name: string;
  years: number;
  currency: string;
  list_amount: string;
  discount: string;
  amount: string;
  coupon_code: string | null;
  status: string;
  provider: string;
  provider_order_id: string | null;
  granted_until: string | null;
  paid_at: string | null;
  created_at: string;
};

export type Checkout = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  prefill: { name: string; email: string };
};

const view = (order: typeof orders.$inferSelect, slug: string, planCode: string | null): OrderView => ({
  id: order.id,
  site: slug,
  plan: planCode,
  plan_name: order.planName,
  years: order.years,
  currency: order.currency,
  list_amount: order.listAmount,
  discount: order.discount,
  amount: order.amount,
  coupon_code: order.couponCode,
  status: order.status,
  provider: order.provider,
  provider_order_id: order.providerOrderId,
  granted_until: order.grantedUntil,
  paid_at: order.paidAt?.toISOString() ?? null,
  created_at: order.createdAt.toISOString(),
});

/* ------------------------------------------------------------- what it costs */

export async function quote(
  siteId: number,
  planCode: unknown,
  years: unknown,
  code: unknown,
  database: Database = db(),
): Promise<{
  plan: typeof plans.$inferSelect;
  years: number;
  priced: Priced;
  coupon: typeof coupons.$inferSelect | null;
}> {
  const [plan] = await database
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.siteId, siteId),
        eq(plans.code, String(planCode ?? "")),
        eq(plans.visible, true),
      ),
    )
    .limit(1);

  if (!plan) {
    throw new AccountError("We do not sell that plan.", 422, "plan");
  }

  const term = Number(years);

  if (!Number.isInteger(term) || term < 1) {
    throw new AccountError("Choose how long you want to subscribe for.", 422, "years");
  }

  const [price] = await database
    .select()
    .from(planPrices)
    .where(and(eq(planPrices.planId, plan.id), eq(planPrices.years, term)))
    .limit(1);

  if (!price) {
    throw new AccountError("That plan is not sold for that length of time.", 422, "years");
  }

  const wanted = String(code ?? "").trim().toUpperCase();

  if (wanted.length === 0) {
    return { plan, years: term, priced: undiscounted(price.amount), coupon: null };
  }

  const [coupon] = await database
    .select()
    .from(coupons)
    .where(eq(sql`upper(${coupons.code})`, wanted))
    .limit(1);

  const priced = coupon
    ? applyCoupon(price.amount, coupon, siteId, plan.currency, today())
    : null;

  if (!coupon || !priced) {
    // One message for every reason. Naming the reason turns the checkout into
    // a way of exploring the coupon table.
    throw new AccountError("That code is not valid for this order.", 422, "code");
  }

  return { plan, years: term, priced, coupon };
}

/* ------------------------------------------------------------- placing one */

export async function placeOrder(
  identity: Identity,
  body: Record<string, unknown>,
  database: Database = db(),
): Promise<{ order: OrderView; checkout: Checkout | null }> {
  const [brand] = await database
    .select()
    .from(sites)
    .where(and(eq(sites.slug, String(body.site ?? "")), eq(sites.enabled, true)))
    .limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  const { plan, years, priced, coupon } = await quote(
    brand.id,
    body.plan,
    body.years,
    body.code,
    database,
  );

  // A coupon that clears the whole price leaves nothing for a payment
  // provider to do, so the order is marked as settled by the coupon and
  // confirmed without a signature.
  const free = minorUnits(priced.amount) === 0;

  const providerOrderId = free
    ? null
    : await createProviderOrder({
        amount: minorUnits(priced.amount),
        currency: plan.currency,
        receipt: `${brand.slug}-${identity.user.id}-${Date.now()}`,
      });

  const [order] = await database
    .insert(orders)
    .values({
      siteId: brand.id,
      userId: identity.user.id,
      planId: plan.id,
      // Copied, not joined: renaming a plan next year must not rewrite an
      // invoice someone already has.
      planName: plan.name,
      years,
      currency: plan.currency,
      listAmount: priced.list_amount,
      discount: priced.discount,
      amount: priced.amount,
      couponId: coupon?.id ?? null,
      couponCode: coupon?.code ?? null,
      status: "pending",
      provider: free ? "coupon" : "razorpay",
      providerOrderId,
    })
    .returning();

  const keys = razorpayKeys();

  return {
    order: view(order!, brand.slug, plan.code),
    checkout:
      free || !keys || !providerOrderId
        ? null
        : {
            key: keys.id,
            order_id: providerOrderId,
            amount: minorUnits(priced.amount),
            currency: plan.currency,
            name: brand.name,
            prefill: { name: identity.user.name, email: identity.user.email },
          },
  };
}

/* ------------------------------------------------------------- settling one */

export async function settleOrder(
  identity: Identity,
  orderId: number,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<OrderView> {
  const [row] = await database
    .select({ order: orders, slug: sites.slug })
    .from(orders)
    .innerJoin(sites, eq(sites.id, orders.siteId))
    // Another person's order answers as a missing one: a 403 would confirm
    // the order id is real.
    .where(and(eq(orders.id, orderId), eq(orders.userId, identity.user.id)))
    .limit(1);

  if (!row) {
    throw new AccountError("No such order.", 404);
  }

  const order = row.order;

  // Already done. Answering success rather than an error is what makes a
  // retried callback and a refreshed success page harmless.
  if (order.status === "paid") {
    return view(order, row.slug, null);
  }

  if (order.status !== "pending") {
    throw new AccountError("That order can no longer be paid.", 409);
  }

  if (order.provider === "razorpay") {
    const keys = razorpayKeys();

    if (!keys) {
      throw new AccountError("Payments are not configured.", 409);
    }

    const ok = verifySignature(
      order.providerOrderId ?? "",
      body.razorpay_payment_id,
      body.razorpay_signature,
      keys.secret,
    );

    if (!ok) {
      // Recorded: a run of these on one order is worth being able to see.
      await database.insert(payments).values({
        orderId: order.id,
        provider: order.provider,
        providerPaymentId:
          typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : null,
        amount: order.amount,
        currency: order.currency,
        status: "failed",
        reason: "signature did not verify",
      });

      throw new AccountError("We could not verify that payment.", 400);
    }
  }

  const grantedUntil = await database.transaction(async (tx) => {
    // The guard is in the WHERE clause, not in an `if` above it: two
    // callbacks arriving together both passed the read, and only one may win.
    const [claimed] = await tx
      .update(orders)
      .set({
        status: "paid",
        provider: order.provider,
        providerPaymentId:
          typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : null,
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
      .returning();

    if (!claimed) {
      return null;
    }

    const [existing] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, identity.user.id), eq(memberships.siteId, order.siteId)))
      .limit(1);

    const until = extendedUntil(existing?.expiresAt ?? null, order.years, today());

    if (existing) {
      await tx
        .update(memberships)
        .set({
          // A staff row keeps its role; buying a subscription does not change
          // what someone is, only what they hold.
          tier: "premium",
          expiresAt: until,
          lapsedFrom: null,
          updatedAt: new Date(),
        })
        .where(eq(memberships.id, existing.id));
    } else {
      await tx.insert(memberships).values({
        userId: identity.user.id,
        siteId: order.siteId,
        role: "subscriber",
        tier: "premium",
        expiresAt: until,
      });
    }

    await tx.update(orders).set({ grantedUntil: until }).where(eq(orders.id, order.id));

    await tx.insert(payments).values({
      orderId: order.id,
      provider: order.provider,
      providerPaymentId:
        typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : null,
      amount: order.amount,
      currency: order.currency,
      status: "succeeded",
    });

    // Spent here, not when the order was placed: an abandoned checkout must
    // not burn a one-use code. The cap is re-checked in the same statement,
    // so the last redemption cannot go to two people.
    if (order.couponId !== null) {
      await tx
        .update(coupons)
        .set({ redeemed: sql`${coupons.redeemed} + 1` })
        .where(
          and(
            eq(coupons.id, order.couponId),
            sql`(${coupons.maxRedemptions} is null or ${coupons.redeemed} < ${coupons.maxRedemptions})`,
          ),
        );
    }

    await tx.insert(auditLog).values({
      siteId: order.siteId,
      userId: identity.user.id,
      action: "order.paid",
      entity: "order",
      entityId: order.id,
      detail: { amount: order.amount, currency: order.currency, years: order.years, until },
      ip: context.ip ?? null,
    });

    return until;
  });

  const [after] = await database.select().from(orders).where(eq(orders.id, order.id)).limit(1);

  void grantedUntil;

  return view(after!, row.slug, null);
}

/* ------------------------------------------------------------- my invoices */

export async function ordersFor(
  userId: number,
  database: Database = db(),
): Promise<OrderView[]> {
  const rows = await database
    .select({ order: orders, slug: sites.slug, code: plans.code })
    .from(orders)
    .innerJoin(sites, eq(sites.id, orders.siteId))
    .leftJoin(plans, eq(plans.id, orders.planId))
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt), desc(orders.id));

  return rows.map((row) => view(row.order, row.slug, row.code));
}

/* ------------------------------------------------------------ what we sell */

export async function plansFor(siteId: number, database: Database = db()) {
  const rows = await database
    .select({ plan: plans, years: planPrices.years, amount: planPrices.amount })
    .from(plans)
    .leftJoin(planPrices, eq(planPrices.planId, plans.id))
    .where(and(eq(plans.siteId, siteId), eq(plans.visible, true)))
    .orderBy(plans.sortOrder, plans.id, planPrices.years);

  const byPlan = new Map<
    number,
    { code: string; name: string; description: string | null; currency: string; terms: { years: number; amount: string }[] }
  >();

  for (const row of rows) {
    const entry = byPlan.get(row.plan.id) ?? {
      code: row.plan.code,
      name: row.plan.name,
      description: row.plan.description,
      currency: row.plan.currency,
      terms: [],
    };

    if (row.years !== null && row.amount !== null) {
      entry.terms.push({ years: row.years, amount: row.amount });
    }

    byPlan.set(row.plan.id, entry);
  }

  return [...byPlan.values()];
}
