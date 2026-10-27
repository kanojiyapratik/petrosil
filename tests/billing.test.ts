/**
 * Selling a subscription: plans, coupons, orders, payment, trials, and the
 * sweep that ends a term.
 *
 * The rules that matter here are the ones about money and about time. The
 * server prices the order (the old checkout posted the price it had been
 * shown and the controller trusted it); a renewal extends rather than
 * replaces, so renewing early does not throw away the weeks still paid for;
 * and settling the same order twice must not buy two years.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { desc, eq } from "drizzle-orm";

import { GET as plansRoute } from "@/app/api/public/[site]/plans/route";
import { POST as couponCheckRoute } from "@/app/api/public/[site]/coupon-check/route";
import { GET as myOrdersRoute, POST as createOrderRoute } from "@/app/api/account/orders/route";
import { POST as confirmRoute } from "@/app/api/account/orders/[id]/confirm/route";
import { POST as trialRoute } from "@/app/api/account/trial/route";
import { POST as decideTrialRoute } from "@/app/api/dashboard/trials/[id]/route";
import { GET as trialsRoute } from "@/app/api/dashboard/trials/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";

import { db } from "@/db";
import { auditLog, coupons, memberships, orders, payments, planPrices, planSites, plans, trialRequests, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { extendedUntil } from "@/domain/billing/term";
import { applyCoupon } from "@/domain/billing/pricing";
import { sweepExpiries } from "@/domain/billing/sweep";
import { today } from "@/domain/price/dates";
import { dayOffset, makeBrand, resetDatabase, type Brand } from "./helpers";

const PASSWORD = "hunter22!";
const SECRET = "test_secret_key";
const TODAY = today();

let baseoil: Brand;
let bitumart: Brand;
let planId: number;

beforeEach(async () => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = SECRET;

  await resetDatabase();
  baseoil = await makeBrand("baseoil", ["Singapore SN 150 FOB"]);
  bitumart = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);
  planId = await makePlan(baseoil, "annual", { 1: "600.00", 2: "1000.00" });
});

async function makePlan(
  brand: Brand,
  code: string,
  terms: Record<number, string>,
  currency = "USD",
): Promise<number> {
  const [plan] = await db()
    .insert(plans)
    .values({ code, name: `${code} plan` })
    .returning();

  await db().insert(planSites).values({ planId: plan!.id, siteId: brand.siteId });

  for (const [years, amount] of Object.entries(terms)) {
    await db().insert(planPrices).values({ planId: plan!.id, currency, years: Number(years), amount });
  }

  return plan!.id;
}

async function person(
  email: string,
  grants: { brand: Brand; role?: string; tier?: string; expiresAt?: string | null }[] = [
    { brand: baseoil },
  ],
): Promise<number> {
  const [row] = await db()
    .insert(users)
    .values({
      email,
      name: email.split("@")[0]!,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
    })
    .returning();

  for (const grant of grants) {
    await db().insert(memberships).values({
      userId: row!.id,
      siteId: grant.brand.siteId,
      role: grant.role ?? "subscriber",
      tier: grant.tier ?? "free",
      expiresAt: grant.expiresAt ?? null,
    });
  }

  return row!.id;
}

async function signedIn(email: string): Promise<string> {
  const response = await loginRoute(
    new Request("http://platform.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const post = (url: string, body: unknown, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const get = (url: string, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, { headers: cookie ? { cookie } : {} });

const context = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

const signatureFor = (orderId: string, paymentId: string, secret = SECRET): string =>
  createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

async function orderFor(cookie: string, body: Record<string, unknown>) {
  const response = await createOrderRoute(post("/api/account/orders", body, cookie));

  return { status: response.status, body: await response.json() };
}

/* ------------------------------------------------------------ pure: the term */

describe("working out what a term buys", () => {
  it("starts from today when there is nothing to extend", () => {
    expect(extendedUntil(null, 1, "2026-10-19")).toBe("2027-10-19");
  });

  it("starts from today when the old term has already run out", () => {
    expect(extendedUntil("2025-01-01", 1, "2026-10-19")).toBe("2027-10-19");
  });

  it("adds to a term still running, so renewing early loses nothing", () => {
    expect(extendedUntil("2027-01-31", 1, "2026-10-19")).toBe("2028-01-31");
  });

  it("buys more than one year at a time", () => {
    expect(extendedUntil(null, 3, "2026-10-19")).toBe("2029-10-19");
  });

  it("does not turn 29 February into 1 March", () => {
    expect(extendedUntil("2028-02-29", 1, "2026-10-19")).toBe("2029-02-28");
  });
});

/* --------------------------------------------------------- pure: the coupon */

describe("applying a coupon", () => {
  const coupon = (over: Partial<typeof coupons.$inferSelect> = {}) =>
    ({
      id: 1,
      siteId: null,
      code: "WELCOME10",
      percentOff: 10,
      amountOff: null,
      currency: null,
      maxRedemptions: null,
      redeemed: 0,
      startsAt: null,
      expiresAt: null,
      enabled: true,
      createdAt: new Date(),
      ...over,
    }) as typeof coupons.$inferSelect;

  it("takes a percentage off, to the penny", () => {
    expect(applyCoupon("600.00", coupon(), 1, "USD", TODAY)).toMatchObject({
      discount: "60.00",
      amount: "540.00",
    });
  });

  it("rounds a percentage that does not divide evenly", () => {
    expect(applyCoupon("333.33", coupon({ percentOff: 15 }), 1, "USD", TODAY)).toMatchObject({
      discount: "50.00",
      amount: "283.33",
    });
  });

  it("takes a flat amount off", () => {
    expect(
      applyCoupon("600.00", coupon({ percentOff: null, amountOff: "150.00" }), 1, "USD", TODAY),
    ).toMatchObject({ discount: "150.00", amount: "450.00" });
  });

  it("never discounts past zero, and never into a refund", () => {
    const result = applyCoupon(
      "100.00",
      coupon({ percentOff: null, amountOff: "250.00" }),
      1,
      "USD",
      TODAY,
    );

    expect(result).toMatchObject({ discount: "100.00", amount: "0.00" });
  });

  it("refuses a code that has been switched off", () => {
    expect(applyCoupon("600.00", coupon({ enabled: false }), 1, "USD", TODAY)).toBeNull();
  });

  it("refuses a code before its first day and after its last", () => {
    expect(applyCoupon("600.00", coupon({ startsAt: "2099-01-01" }), 1, "USD", TODAY)).toBeNull();
    expect(applyCoupon("600.00", coupon({ expiresAt: "2020-01-01" }), 1, "USD", TODAY)).toBeNull();
  });

  it("admits a code on its last day", () => {
    expect(applyCoupon("600.00", coupon({ expiresAt: TODAY }), 1, "USD", TODAY)).not.toBeNull();
  });

  it("refuses a code that has been used up", () => {
    expect(
      applyCoupon("600.00", coupon({ maxRedemptions: 5, redeemed: 5 }), 1, "USD", TODAY),
    ).toBeNull();
  });

  it("refuses a code meant for another brand", () => {
    expect(applyCoupon("600.00", coupon({ siteId: 99 }), 1, "USD", TODAY)).toBeNull();
  });

  it("refuses a flat discount quoted in another currency", () => {
    expect(
      applyCoupon("600.00", coupon({ percentOff: null, amountOff: "100.00", currency: "INR" }), 1, "USD", TODAY),
    ).toBeNull();
  });
});

/* ----------------------------------------------------------------- plans */

describe("the plans a brand sells", () => {
  it("lists them with a price for each term", async () => {
    const body = await (
      await plansRoute(get("/api/public/baseoil/plans"), context({ site: "baseoil" }))
    ).json();

    expect(body.plans).toHaveLength(1);
    // Every currency it is priced in; the buyer's country picks one at the checkout.
    expect(body.plans[0]).toMatchObject({ code: "annual", currencies: ["USD"], on_sale: false });
    expect(body.plans[0].terms).toEqual([
      { currency: "USD", years: 1, amount: "600.00", sale_amount: null },
      { currency: "USD", years: 2, amount: "1000.00", sale_amount: null },
    ]);
  });

  it("leaves a hidden plan out", async () => {
    await db().update(plans).set({ visible: false }).where(eq(plans.id, planId));

    const body = await (
      await plansRoute(get("/api/public/baseoil/plans"), context({ site: "baseoil" }))
    ).json();

    expect(body.plans).toEqual([]);
  });

  it("shows only the brand's own plans", async () => {
    await makePlan(bitumart, "bitumen-annual", { 1: "700.00" });

    const body = await (
      await plansRoute(get("/api/public/baseoil/plans"), context({ site: "baseoil" }))
    ).json();

    expect(body.plans.map((plan: { code: string }) => plan.code)).toEqual(["annual"]);
  });
});

/* -------------------------------------------------------- checking a coupon */

describe("checking a coupon before buying", () => {
  beforeEach(async () => {
    await db().insert(coupons).values({ code: "WELCOME10", percentOff: 10 });
  });

  it("quotes what the order would come to", async () => {
    const body = await (
      await couponCheckRoute(
        post("/api/public/baseoil/coupon-check", { plan: "annual", years: 1, code: "welcome10" }),
        context({ site: "baseoil" }),
      )
    ).json();

    expect(body).toMatchObject({ valid: true, list_amount: "600.00", discount: "60.00", amount: "540.00" });
  });

  it("says plainly that a code is no good, without saying why", async () => {
    const response = await couponCheckRoute(
      post("/api/public/baseoil/coupon-check", { plan: "annual", years: 1, code: "NOPE" }),
      context({ site: "baseoil" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.valid).toBe(false);
  });
});

/* ---------------------------------------------------------------- ordering */

describe("placing an order", () => {
  it("is refused to someone not signed in", async () => {
    const response = await createOrderRoute(
      post("/api/account/orders", { site: "baseoil", plan: "annual", years: 1 }),
    );

    expect(response.status).toBe(401);
  });

  it("prices the order from the plan, not from the request", async () => {
    await person("buyer@company.example");
    const cookie = await signedIn("buyer@company.example");

    const { status, body } = await orderFor(cookie, {
      site: "baseoil",
      plan: "annual",
      years: 1,
      // What a tampered checkout would post.
      amount: "1.00",
      list_amount: "1.00",
      discount: "599.00",
    });

    expect(status).toBe(201);
    expect(body.order).toMatchObject({
      list_amount: "600.00",
      discount: "0.00",
      amount: "600.00",
      currency: "USD",
      status: "pending",
      years: 1,
    });
  });

  it("keeps the plan's name on the order, so a later rename cannot rewrite an invoice", async () => {
    await person("buyer@company.example");
    const cookie = await signedIn("buyer@company.example");

    await orderFor(cookie, { site: "baseoil", plan: "annual", years: 1 });
    await db().update(plans).set({ name: "renamed later" }).where(eq(plans.id, planId));

    const [order] = await db().select().from(orders);

    expect(order!.planName).toBe("annual plan");
  });

  it("applies a coupon, and records which one", async () => {
    await db().insert(coupons).values({ code: "WELCOME10", percentOff: 10 });
    await person("buyer@company.example");
    const cookie = await signedIn("buyer@company.example");

    const { body } = await orderFor(cookie, {
      site: "baseoil",
      plan: "annual",
      years: 1,
      code: "welcome10",
    });

    expect(body.order).toMatchObject({ discount: "60.00", amount: "540.00", coupon_code: "WELCOME10" });
  });

  it("refuses an order with a coupon that is no good, rather than quietly charging full price", async () => {
    await person("buyer@company.example");
    const cookie = await signedIn("buyer@company.example");

    const { status } = await orderFor(cookie, {
      site: "baseoil",
      plan: "annual",
      years: 1,
      code: "NOPE",
    });

    expect(status).toBe(422);
    expect(await db().select().from(orders)).toHaveLength(0);
  });

  it("does not spend the coupon until the order is paid", async () => {
    await db().insert(coupons).values({ code: "WELCOME10", percentOff: 10, maxRedemptions: 1 });
    await person("buyer@company.example");
    const cookie = await signedIn("buyer@company.example");

    await orderFor(cookie, { site: "baseoil", plan: "annual", years: 1, code: "WELCOME10" });

    const [coupon] = await db().select().from(coupons);

    // An abandoned checkout must not burn a one-use code.
    expect(coupon!.redeemed).toBe(0);
  });

  it("refuses a term the plan is not sold for", async () => {
    await person("buyer@company.example");
    const cookie = await signedIn("buyer@company.example");

    const { status } = await orderFor(cookie, { site: "baseoil", plan: "annual", years: 5 });

    expect(status).toBe(422);
  });

  it("refuses a plan belonging to another brand", async () => {
    await makePlan(bitumart, "bitumen-annual", { 1: "700.00" });
    await person("buyer@company.example");
    const cookie = await signedIn("buyer@company.example");

    const { status } = await orderFor(cookie, {
      site: "baseoil",
      plan: "bitumen-annual",
      years: 1,
    });

    expect(status).toBe(422);
  });

  it("hands back something the payment page can open a checkout with", async () => {
    await person("buyer@company.example");
    const cookie = await signedIn("buyer@company.example");

    const { body } = await orderFor(cookie, { site: "baseoil", plan: "annual", years: 1 });

    expect(body.order.provider).toBe("razorpay");
    expect(body.order.provider_order_id).toMatch(/.+/);
    expect(body.checkout).toMatchObject({ key: "rzp_test_key", currency: "USD" });
    // Razorpay works in the smallest unit of the currency.
    expect(body.checkout.amount).toBe(60000);
  });
});

/* ------------------------------------------------------------- settling up */

describe("settling an order", () => {
  let cookie: string;
  let orderId: number;
  let providerOrderId: string;

  beforeEach(async () => {
    await person("buyer@company.example");
    cookie = await signedIn("buyer@company.example");

    const { body } = await orderFor(cookie, { site: "baseoil", plan: "annual", years: 1 });

    orderId = body.order.id;
    providerOrderId = body.order.provider_order_id;
  });

  const confirm = (body: Record<string, unknown>, as = cookie) =>
    confirmRoute(post(`/api/account/orders/${orderId}/confirm`, body, as), context({ id: String(orderId) }));

  it("refuses a signature that does not check out, and records the attempt", async () => {
    const response = await confirm({
      razorpay_payment_id: "pay_123",
      razorpay_signature: "not-a-real-signature",
    });

    expect(response.status).toBe(400);

    const [order] = await db().select().from(orders);

    expect(order!.status).toBe("pending");

    const [attempt] = await db().select().from(payments);

    expect(attempt).toMatchObject({ status: "failed" });
  });

  it("refuses a signature made with the wrong secret", async () => {
    const response = await confirm({
      razorpay_payment_id: "pay_123",
      razorpay_signature: signatureFor(providerOrderId, "pay_123", "someone-elses-secret"),
    });

    expect(response.status).toBe(400);
  });

  it("refuses a signature for a different payment id than the one sent", async () => {
    const response = await confirm({
      razorpay_payment_id: "pay_123",
      razorpay_signature: signatureFor(providerOrderId, "pay_999"),
    });

    expect(response.status).toBe(400);
  });

  it("marks it paid and turns the reader into a subscriber", async () => {
    const response = await confirm({
      razorpay_payment_id: "pay_123",
      razorpay_signature: signatureFor(providerOrderId, "pay_123"),
    });

    expect(response.status).toBe(200);

    const [order] = await db().select().from(orders);

    expect(order!.status).toBe("paid");
    expect(order!.providerPaymentId).toBe("pay_123");
    expect(order!.paidAt).not.toBeNull();

    const [grant] = await db().select().from(memberships);

    expect(grant!.tier).toBe("premium");
    expect(grant!.expiresAt).toBe(extendedUntil(null, 1, TODAY));
    expect(order!.grantedUntil).toBe(grant!.expiresAt);
  });

  it("does not buy two years when the same payment is confirmed twice", async () => {
    const signature = signatureFor(providerOrderId, "pay_123");

    await confirm({ razorpay_payment_id: "pay_123", razorpay_signature: signature });
    const [first] = await db().select().from(memberships);

    const second = await confirm({ razorpay_payment_id: "pay_123", razorpay_signature: signature });
    const [after] = await db().select().from(memberships);

    expect(second.status).toBe(200);
    expect(after!.expiresAt).toBe(first!.expiresAt);
    expect(await db().select().from(orders)).toHaveLength(1);
  });

  it("extends a term that is still running instead of replacing it", async () => {
    const stillRunning = dayOffset(new Date(), 90);

    await db().update(memberships).set({ tier: "premium", expiresAt: stillRunning });

    await confirm({
      razorpay_payment_id: "pay_123",
      razorpay_signature: signatureFor(providerOrderId, "pay_123"),
    });

    const [grant] = await db().select().from(memberships);

    expect(grant!.expiresAt).toBe(extendedUntil(stillRunning, 1, TODAY));
  });

  it("spends the coupon once the money is in", async () => {
    await db().insert(coupons).values({ code: "WELCOME10", percentOff: 10, maxRedemptions: 1 });
    const { body } = await orderFor(cookie, {
      site: "baseoil",
      plan: "annual",
      years: 2,
      code: "WELCOME10",
    });

    await confirmRoute(
      post(
        `/api/account/orders/${body.order.id}/confirm`,
        {
          razorpay_payment_id: "pay_456",
          razorpay_signature: signatureFor(body.order.provider_order_id, "pay_456"),
        },
        cookie,
      ),
      context({ id: String(body.order.id) }),
    );

    const [coupon] = await db().select().from(coupons);

    expect(coupon!.redeemed).toBe(1);
  });

  it("will not let one person settle another person's order", async () => {
    await person("other@company.example", [{ brand: baseoil }]);
    const otherCookie = await signedIn("other@company.example");

    const response = await confirm(
      {
        razorpay_payment_id: "pay_123",
        razorpay_signature: signatureFor(providerOrderId, "pay_123"),
      },
      otherCookie,
    );

    expect(response.status).toBe(404);

    const [order] = await db().select().from(orders);

    expect(order!.status).toBe("pending");
  });

  it("settles a wholly discounted order without asking a payment provider anything", async () => {
    await db().insert(coupons).values({ code: "ONTHEHOUSE", percentOff: 100 });
    const { body } = await orderFor(cookie, {
      site: "baseoil",
      plan: "annual",
      years: 1,
      code: "ONTHEHOUSE",
    });

    expect(body.order).toMatchObject({ amount: "0.00", provider: "coupon" });
    expect(body.checkout).toBeNull();

    const response = await confirmRoute(
      post(`/api/account/orders/${body.order.id}/confirm`, {}, cookie),
      context({ id: String(body.order.id) }),
    );

    expect(response.status).toBe(200);

    const [grant] = await db().select().from(memberships);

    expect(grant!.tier).toBe("premium");
  });
});

describe("my invoices", () => {
  it("lists my own orders and nobody else's", async () => {
    await person("buyer@company.example");
    await person("other@company.example", [{ brand: baseoil }]);

    const mine = await signedIn("buyer@company.example");
    const theirs = await signedIn("other@company.example");

    await orderFor(mine, { site: "baseoil", plan: "annual", years: 1 });
    await orderFor(theirs, { site: "baseoil", plan: "annual", years: 2 });

    const body = await (await myOrdersRoute(get("/api/account/orders", mine))).json();

    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({ years: 1, site: "baseoil" });
  });
});

/* ------------------------------------------------------------------ trials */

describe("asking for a free trial", () => {
  it("records the request as pending", async () => {
    await person("curious@company.example");
    const cookie = await signedIn("curious@company.example");

    const response = await trialRoute(
      post("/api/account/trial", { site: "baseoil", note: "evaluating for our team" }, cookie),
    );

    expect(response.status).toBe(201);

    const [request] = await db().select().from(trialRequests);

    expect(request).toMatchObject({ status: "pending", siteId: baseoil.siteId });
  });

  it("refuses a second request while one is still waiting", async () => {
    await person("curious@company.example");
    const cookie = await signedIn("curious@company.example");

    await trialRoute(post("/api/account/trial", { site: "baseoil" }, cookie));
    const second = await trialRoute(post("/api/account/trial", { site: "baseoil" }, cookie));

    expect(second.status).toBe(409);
    expect(await db().select().from(trialRequests)).toHaveLength(1);
  });

  it("refuses a trial to someone who is already paying", async () => {
    await person("payer@company.example", [
      { brand: baseoil, tier: "premium", expiresAt: dayOffset(new Date(), 200) },
    ]);
    const cookie = await signedIn("payer@company.example");

    const response = await trialRoute(post("/api/account/trial", { site: "baseoil" }, cookie));

    expect(response.status).toBe(409);
  });

  it("lets a lapsed subscriber ask again", async () => {
    await person("lapsed@company.example", [
      { brand: baseoil, tier: "premium", expiresAt: dayOffset(new Date(), -5) },
    ]);
    const cookie = await signedIn("lapsed@company.example");

    const response = await trialRoute(post("/api/account/trial", { site: "baseoil" }, cookie));

    expect(response.status).toBe(201);
  });
});

describe("staff deciding a trial", () => {
  let requestId: number;

  beforeEach(async () => {
    await person("curious@company.example");
    const reader = await signedIn("curious@company.example");

    await trialRoute(post("/api/account/trial", { site: "baseoil" }, reader));

    const [request] = await db().select().from(trialRequests);

    requestId = request!.id;
  });

  it("grants the trial, with an end date and a record of who said yes", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await decideTrialRoute(
      post(`/api/dashboard/trials/${requestId}`, { decision: "approve", days: 14 }, cookie),
      context({ id: String(requestId) }),
    );

    expect(response.status).toBe(200);

    const [grant] = await db()
      .select()
      .from(memberships)
      .where(eq(memberships.siteId, baseoil.siteId))
      .orderBy(memberships.id);

    expect(grant).toMatchObject({ tier: "trial" });
    expect(grant!.expiresAt).toBe(dayOffset(new Date(), 14));

    const [request] = await db().select().from(trialRequests);

    expect(request).toMatchObject({ status: "approved" });
    expect(request!.decidedBy).not.toBeNull();

    const [logged] = await db().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);

    expect(logged).toMatchObject({ action: "trial.approve" });
  });

  it("declines without changing what the person holds", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    await decideTrialRoute(
      post(`/api/dashboard/trials/${requestId}`, { decision: "decline" }, cookie),
      context({ id: String(requestId) }),
    );

    const [request] = await db().select().from(trialRequests);
    const [grant] = await db().select().from(memberships).orderBy(memberships.id);

    expect(request!.status).toBe("declined");
    expect(grant!.tier).toBe("free");
  });

  it("hides another brand's request from staff who cannot see it", async () => {
    await person("editor@bitumart.example", [{ brand: bitumart, role: "staff" }]);
    const cookie = await signedIn("editor@bitumart.example");

    const list = await (await trialsRoute(get("/api/dashboard/trials", cookie))).json();

    expect(list.requests).toEqual([]);

    const response = await decideTrialRoute(
      post(`/api/dashboard/trials/${requestId}`, { decision: "approve" }, cookie),
      context({ id: String(requestId) }),
    );

    expect(response.status).toBe(404);
  });

  it("will not decide the same request twice", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    await decideTrialRoute(
      post(`/api/dashboard/trials/${requestId}`, { decision: "approve" }, cookie),
      context({ id: String(requestId) }),
    );
    const second = await decideTrialRoute(
      post(`/api/dashboard/trials/${requestId}`, { decision: "decline" }, cookie),
      context({ id: String(requestId) }),
    );

    expect(second.status).toBe(409);
  });
});

/* ------------------------------------------------------------------ the sweep */

describe("the sweep that ends a term", () => {
  it("drops a lapsed subscriber back to free", async () => {
    await person("lapsed@company.example", [
      { brand: baseoil, tier: "premium", expiresAt: dayOffset(new Date(), -1) },
    ]);

    const result = await sweepExpiries();

    expect(result.lapsed).toBe(1);

    const [grant] = await db().select().from(memberships);

    expect(grant!.tier).toBe("free");
    // The date it ran out stays on the row: the client screen tells a lapsed
    // subscriber from someone who never paid, and that is the difference.
    expect(grant!.expiresAt).toBe(dayOffset(new Date(), -1));
  });

  it("ends a trial the same way", async () => {
    await person("trialist@company.example", [
      { brand: baseoil, tier: "trial", expiresAt: dayOffset(new Date(), -1) },
    ]);

    await sweepExpiries();

    const [grant] = await db().select().from(memberships);

    expect(grant!.tier).toBe("free");
  });

  it("leaves a term that runs out today alone, because today is still theirs", async () => {
    await person("payer@company.example", [{ brand: baseoil, tier: "premium", expiresAt: TODAY }]);

    expect((await sweepExpiries()).lapsed).toBe(0);
    expect((await db().select().from(memberships))[0]!.tier).toBe("premium");
  });

  it("leaves an open-ended subscription alone", async () => {
    await person("founder@company.example", [{ brand: baseoil, tier: "premium", expiresAt: null }]);

    expect((await sweepExpiries()).lapsed).toBe(0);
    expect((await db().select().from(memberships))[0]!.tier).toBe("premium");
  });

  it("never touches a staff row", async () => {
    await person("editor@petrosil.example", [
      { brand: baseoil, role: "staff", tier: "premium", expiresAt: dayOffset(new Date(), -1) },
    ]);

    await sweepExpiries();

    const [grant] = await db().select().from(memberships);

    expect(grant!.role).toBe("staff");
    expect(grant!.tier).toBe("premium");
  });

  it("writes what it did, because a subscriber asking why they were cut off deserves an answer", async () => {
    await person("lapsed@company.example", [
      { brand: baseoil, tier: "premium", expiresAt: dayOffset(new Date(), -1) },
    ]);

    await sweepExpiries();

    const [logged] = await db().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);

    expect(logged).toMatchObject({ action: "membership.lapsed", siteId: baseoil.siteId });
  });

  it("is safe to run twice in one day", async () => {
    await person("lapsed@company.example", [
      { brand: baseoil, tier: "premium", expiresAt: dayOffset(new Date(), -1) },
    ]);

    await sweepExpiries();

    expect((await sweepExpiries()).lapsed).toBe(0);
    expect(await db().select().from(auditLog)).toHaveLength(1);
  });
});
