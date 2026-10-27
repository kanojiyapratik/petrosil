/**
 * The money editors: what a brand sells, its discount codes, and recording a
 * payment the team took by hand.
 *
 * The last is the one the team uses most. Baseoil has terms sold at ₹9,000 to
 * ₹250,000 against a ₹15,000 list price, by bank transfer and cheque, and the
 * old "mark as paid" form wrote the price, the method and the transaction
 * number onto the subscription. Here it is an order and a payment like any
 * other, so the Transactions screen and the plan's "sold" count include it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, coupons, memberships, orders, payments, planPrices, planSites, plans, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { savePlan } from "@/domain/billing/plans";
import { saveCoupon } from "@/domain/billing/coupons";
import { recordPayment } from "@/domain/billing/manual";
import { plansFor, quote } from "@/domain/billing/orders";
import { listTransactions } from "@/domain/dashboard/catalogue";
import { addDays } from "@/domain/billing/sweep";
import { addYears } from "@/domain/billing/term";
import { today } from "@/domain/price/dates";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const TODAY = today();

/** For the cases that must succeed: the save answers null only for someone else's row. */
const planOk = async (...args: Parameters<typeof savePlan>) => (await savePlan(...args))!;
const couponOk = async (...args: Parameters<typeof saveCoupon>) => (await saveCoupon(...args))!;

async function withRole(brand: Brand, permissions: string[]) {
  const [role] = await db().insert(roles).values({ name: `Role ${permissions.join(" ")}` }).returning();

  for (const permission of permissions) {
    await db().insert(rolePermissions).values({ roleId: role!.id, permission });
  }

  await db().insert(memberships).values({ userId: staff, siteId: brand.siteId, role: "staff", roleId: role!.id });

  return guard([brand.siteId]);
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "boss@petrosil.example", name: "Boss" }).returning();

  staff = me!.id;
});

/* ------------------------------------------------------------------ plans */

/** A plan for the tests: the given brands, INR only unless the terms say otherwise. */
const plan = (extra: Partial<Parameters<typeof savePlan>[1]> = {}): Parameters<typeof savePlan>[1] => ({
  name: "India Subcontinent Plan",
  sites: ["baseoil"],
  currencies: ["INR"],
  terms: [
    { currency: "INR", years: 1, amount: "15000" },
    { currency: "INR", years: 2, amount: "25000.50" },
  ],
  ...extra,
});

describe("a plan", () => {
  it("is created with a code from its name, its brands and its prices", async () => {
    const made = await planOk(guard([]), plan());

    const [row] = await db().select().from(plans).where(eq(plans.id, made.id));
    const held = await db().select().from(planSites).where(eq(planSites.planId, made.id));
    const terms = await db().select().from(planPrices).where(eq(planPrices.planId, made.id)).orderBy(planPrices.years);

    expect(row).toMatchObject({ code: "india-subcontinent-plan", visible: true, onSale: false });
    expect(held.map((row) => row.siteId)).toEqual([baseoil.siteId]);
    expect(terms.map((term) => [term.currency, term.years, term.amount, term.saleAmount])).toEqual([
      ["INR", 1, "15000.00", null],
      ["INR", 2, "25000.50", null],
    ]);
  });

  it("can be sold on several brands, in rupees and dollars at once", async () => {
    const made = await planOk(
      guard([]),
      plan({
        sites: ["baseoil", "bitumart"],
        currencies: ["INR", "USD"],
        terms: [
          { currency: "INR", years: 1, amount: "15000" },
          { currency: "USD", years: 1, amount: "540" },
        ],
      }),
    );

    const held = await db().select().from(planSites).where(eq(planSites.planId, made.id));
    const terms = await db().select().from(planPrices).where(eq(planPrices.planId, made.id)).orderBy(planPrices.currency);

    expect(held.map((row) => row.siteId).sort()).toEqual([baseoil.siteId, bitumart.siteId].sort());
    expect(terms.map((term) => [term.currency, term.amount])).toEqual([
      ["INR", "15000.00"],
      ["USD", "540.00"],
    ]);
  });

  it("ignores the prices of a currency that is not ticked, and needs a price in each one that is", async () => {
    const made = await planOk(
      guard([]),
      plan({
        currencies: ["USD"],
        terms: [
          { currency: "INR", years: 1, amount: "15000" },
          { currency: "USD", years: 1, amount: "540" },
        ],
      }),
    );

    const terms = await db().select().from(planPrices).where(eq(planPrices.planId, made.id));

    expect(terms.map((term) => term.currency)).toEqual(["USD"]);

    await expect(savePlan(guard([]), plan({ currencies: ["INR", "USD"] }))).rejects.toMatchObject({ field: "terms" });
    await expect(savePlan(guard([]), plan({ currencies: [] }))).rejects.toMatchObject({ field: "currencies" });
    await expect(savePlan(guard([]), plan({ currencies: ["EUR"] }))).rejects.toMatchObject({ field: "currencies" });
  });

  it("keeps a sale price per term, below the regular one, and needs one to go on sale", async () => {
    const made = await planOk(
      guard([]),
      plan({
        on_sale: true,
        terms: [
          { currency: "INR", years: 1, amount: "15000", sale_amount: "12000" },
          { currency: "INR", years: 2, amount: "25000" },
        ],
      }),
    );

    const terms = await db().select().from(planPrices).where(eq(planPrices.planId, made.id)).orderBy(planPrices.years);

    expect(made.on_sale).toBe(true);
    expect(terms.map((term) => term.saleAmount)).toEqual(["12000.00", null]);

    await expect(
      savePlan(guard([]), plan({ terms: [{ currency: "INR", years: 1, amount: "15000", sale_amount: "16000" }] })),
    ).rejects.toMatchObject({ field: "terms" });
    await expect(savePlan(guard([]), plan({ on_sale: true }))).rejects.toMatchObject({ field: "terms" });
  });

  it("gets a numbered code when the name is taken anywhere in the estate", async () => {
    await planOk(guard([]), plan({ name: "Global" }));
    const second = await planOk(guard([]), plan({ name: "Global", sites: ["bitumart"] }));

    expect(second.code).toBe("global-2");
  });

  it("replaces its brands and prices on save, keeps its code, and records both", async () => {
    const made = await planOk(
      guard([]),
      plan({
        name: "{{ ADMIN_NAME }} - Global",
        terms: [
          { currency: "INR", years: 1, amount: "500" },
          { currency: "INR", years: 3, amount: "1200" },
        ],
      }),
    );

    const saved = await planOk(
      guard([]),
      plan({
        id: made.id,
        name: "Base Oil Report - Global",
        sites: ["bitumart"],
        visible: false,
        terms: [{ currency: "INR", years: 1, amount: "540" }],
      }),
    );

    const held = await db().select().from(planSites).where(eq(planSites.planId, made.id));
    const terms = await db().select().from(planPrices).where(eq(planPrices.planId, made.id));

    expect(saved).toMatchObject({ name: "Base Oil Report - Global", code: made.code, visible: false });
    expect(held.map((row) => row.siteId)).toEqual([bitumart.siteId]);
    expect(terms.map((term) => [term.years, term.amount])).toEqual([[1, "540.00"]]);

    // Both brands' trails record it: one lost the plan, one gained it.
    const entries = await db().select().from(auditLog).where(eq(auditLog.action, "plan.update"));

    expect(entries.map((entry) => entry.siteId).sort()).toEqual([baseoil.siteId, bitumart.siteId].sort());
    expect(entries[0]!.detail).toMatchObject({
      was: { name: "{{ ADMIN_NAME }} - Global", prices: { "INR 1y": "500.00", "INR 3y": "1200.00" } },
      now: { name: "Base Oil Report - Global", prices: { "INR 1y": "540.00" } },
    });
  });

  it("refuses a price that is not money, a term twice, and no brand at all", async () => {
    await expect(
      savePlan(guard([]), plan({ terms: [{ currency: "INR", years: 1, amount: "12.345" }] })),
    ).rejects.toMatchObject({ field: "terms" });
    await expect(
      savePlan(guard([]), plan({ terms: [{ currency: "INR", years: 1, amount: "-5" }] })),
    ).rejects.toMatchObject({ field: "terms" });
    await expect(
      savePlan(
        guard([]),
        plan({
          terms: [
            { currency: "INR", years: 1, amount: "5" },
            { currency: "INR", years: 1, amount: "6" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ field: "terms" });
    await expect(savePlan(guard([]), plan({ sites: [] }))).rejects.toMatchObject({ field: "sites" });
  });

  it("is only for brands the editor manages, and a shared plan is not brand staff's to change", async () => {
    await expect(savePlan(guard([baseoil.siteId]), plan({ sites: ["baseoil", "bitumart"] }))).rejects.toMatchObject({
      status: 403,
    });

    const shared = await planOk(guard([]), plan({ sites: ["baseoil", "bitumart"] }));

    expect(await savePlan(guard([baseoil.siteId]), plan({ id: shared.id, name: "Mine now" }))).toBeNull();

    const theirs = await planOk(guard([]), plan({ sites: ["bitumart"] }));

    expect(await savePlan(guard([baseoil.siteId]), plan({ id: theirs.id }))).toBeNull();
  });

  it("needs the plan permissions when the editor holds a role", async () => {
    const limited = await withRole(baseoil, ["coupon-create"]);

    await expect(savePlan(limited, plan())).rejects.toBeInstanceOf(AccessError);
  });
});

/* ------------------------------------------------------------ the checkout */

describe("what the checkout charges", () => {
  const both = () =>
    plan({
      name: "Global",
      sites: ["baseoil"],
      currencies: ["INR", "USD"],
      terms: [
        { currency: "INR", years: 1, amount: "15000", sale_amount: "12000" },
        { currency: "USD", years: 1, amount: "540", sale_amount: "450" },
      ],
    });

  it("charges rupees in India and dollars elsewhere when a plan has both", async () => {
    const made = await planOk(guard([]), both());

    const india = await quote(baseoil.siteId, made.code, 1, "", { country: "India" });
    const uae = await quote(baseoil.siteId, made.code, 1, "", { country: "United Arab Emirates" });
    const unknown = await quote(baseoil.siteId, made.code, 1, "", null);

    expect([india.currency, india.priced.amount]).toEqual(["INR", "15000.00"]);
    expect([uae.currency, uae.priced.amount]).toEqual(["USD", "540.00"]);
    expect(unknown.currency).toBe("USD");
  });

  it("charges a one-currency plan in that currency to everybody", async () => {
    const made = await planOk(guard([]), plan());

    const abroad = await quote(baseoil.siteId, made.code, 1, "", { country: "Germany" });

    expect([abroad.currency, abroad.priced.amount]).toEqual(["INR", "15000.00"]);
  });

  it("charges the sale price while on sale, with the regular price as the list", async () => {
    const made = await planOk(guard([]), { ...both(), on_sale: true });

    const priced = (await quote(baseoil.siteId, made.code, 1, "", { country: "India" })).priced;

    expect(priced).toEqual({ list_amount: "15000.00", discount: "3000.00", amount: "12000.00" });

    await planOk(guard([]), { ...both(), id: made.id, on_sale: false });

    expect((await quote(baseoil.siteId, made.code, 1, "", { country: "India" })).priced.amount).toBe("15000.00");
  });

  it("takes a coupon off the sale price, and counts both as the discount", async () => {
    const made = await planOk(guard([]), { ...both(), on_sale: true });

    await couponOk(guard([]), { site: "baseoil", code: "TENOFF", kind: "percent", value: "10", enabled: true });

    const priced = (await quote(baseoil.siteId, made.code, 1, "TENOFF", { country: "India" })).priced;

    expect(priced).toEqual({ list_amount: "15000.00", discount: "4200.00", amount: "10800.00" });
  });

  it("does not sell a plan on a brand it was not ticked for", async () => {
    const made = await planOk(guard([]), plan({ sites: ["bitumart"] }));

    await expect(quote(baseoil.siteId, made.code, 1, "", null)).rejects.toMatchObject({ field: "plan" });
  });

  it("lists a brand's plans with every currency and the sale price", async () => {
    await planOk(guard([]), { ...both(), on_sale: true });
    await planOk(guard([]), plan({ name: "Bitumart only", sites: ["bitumart"] }));

    const listed = await plansFor(baseoil.siteId);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "Global",
      on_sale: true,
      currencies: ["INR", "USD"],
      terms: [
        { currency: "INR", years: 1, amount: "15000.00", sale_amount: "12000.00" },
        { currency: "USD", years: 1, amount: "540.00", sale_amount: "450.00" },
      ],
    });
  });
});

/* ---------------------------------------------------------------- coupons */

describe("a coupon", () => {
  it("is stored upper-cased, for one brand", async () => {
    const made = await couponOk(guard([]), {
      site: "baseoil",
      code: " welcome10 ",
      kind: "percent",
      value: "10",
      max_redemptions: "50",
      expires_at: "2099-01-01",
      enabled: true,
    });

    const [row] = await db().select().from(coupons).where(eq(coupons.id, made.id));

    expect(row).toMatchObject({
      code: "WELCOME10",
      siteId: baseoil.siteId,
      percentOff: 10,
      amountOff: null,
      maxRedemptions: 50,
      expiresAt: "2099-01-01",
    });
  });

  it("takes a fixed amount only with its currency", async () => {
    await expect(
      saveCoupon(guard([]), { site: "baseoil", code: "FLAT", kind: "amount", value: "100", enabled: true }),
    ).rejects.toMatchObject({ field: "currency" });

    const made = await couponOk(guard([]), {
      site: "baseoil",
      code: "FLAT",
      kind: "amount",
      value: "100",
      currency: "INR",
      enabled: true,
    });

    const [row] = await db().select().from(coupons).where(eq(coupons.id, made.id));

    expect(row).toMatchObject({ percentOff: null, amountOff: "100.00", currency: "INR" });
  });

  it("refuses a code already in use, a percentage over 100 and dates the wrong way round", async () => {
    await saveCoupon(guard([]), { site: "baseoil", code: "TAKEN", kind: "percent", value: "5", enabled: true });

    await expect(
      saveCoupon(guard([]), { site: "bitumart", code: "taken", kind: "percent", value: "5", enabled: true }),
    ).rejects.toMatchObject({ field: "code", status: 409 });
    await expect(
      saveCoupon(guard([]), { site: "baseoil", code: "BIG", kind: "percent", value: "120", enabled: true }),
    ).rejects.toMatchObject({ field: "value" });
    await expect(
      saveCoupon(guard([]), {
        site: "baseoil",
        code: "BACKWARDS",
        kind: "percent",
        value: "5",
        starts_at: "2026-12-01",
        expires_at: "2026-11-01",
        enabled: true,
      }),
    ).rejects.toMatchObject({ field: "expires_at" });
  });

  it("cannot be capped below the times it has already been used", async () => {
    const made = await couponOk(guard([]), { site: "baseoil", code: "USED", kind: "percent", value: "5", enabled: true });

    await db().update(coupons).set({ redeemed: 7 }).where(eq(coupons.id, made.id));

    await expect(
      saveCoupon(guard([]), { id: made.id, code: "USED", kind: "percent", value: "5", max_redemptions: "3", enabled: true }),
    ).rejects.toMatchObject({ field: "max_redemptions" });
  });

  it("works on every brand only when a superadmin says so", async () => {
    const everywhere = await couponOk(guard([]), { site: "", code: "ALL", kind: "percent", value: "5", enabled: true });

    const [row] = await db().select().from(coupons).where(eq(coupons.id, everywhere.id));

    expect(row!.siteId).toBeNull();

    await expect(
      saveCoupon(guard([baseoil.siteId]), { site: "", code: "MINE", kind: "percent", value: "5", enabled: true }),
    ).rejects.toMatchObject({ status: 403 });
    // Nor may brand staff change an estate-wide one.
    expect(
      await saveCoupon(guard([baseoil.siteId]), { id: everywhere.id, code: "ALL", kind: "percent", value: "50", enabled: true }),
    ).toBeNull();
  });

  it("is switched off, not deleted", async () => {
    const made = await couponOk(guard([]), { site: "baseoil", code: "OFF", kind: "percent", value: "5", enabled: true });

    await saveCoupon(guard([]), { id: made.id, code: "OFF", kind: "percent", value: "5", enabled: false });

    const [row] = await db().select().from(coupons).where(eq(coupons.id, made.id));

    expect(row!.enabled).toBe(false);
  });
});

/* -------------------------------------------------------- record a payment */

describe("recording a payment taken by hand", () => {
  let planId: number;
  let reader: number;

  beforeEach(async () => {
    const made = await planOk(
      guard([]),
      plan({
        terms: [
          { currency: "INR", years: 1, amount: "15000" },
          { currency: "INR", years: 2, amount: "25000" },
        ],
      }),
    );

    planId = made.id;

    const [person] = await db().insert(users).values({ email: "buyer@company.example", name: "Buyer" }).returning();

    reader = person!.id;
  });

  const base = () => ({
    user_id: reader,
    site: "baseoil",
    plan_id: planId,
    years: 1,
    amount: "9000",
    method: "bank",
    reference: "UTR123456",
    paid_on: TODAY,
  });

  it("makes a paid order at the price actually charged, and a payment", async () => {
    const result = await recordPayment(guard([]), base());

    const [order] = await db().select().from(orders).where(eq(orders.id, result.order_id));
    const [payment] = await db().select().from(payments).where(eq(payments.orderId, result.order_id));

    expect(order).toMatchObject({
      status: "paid",
      provider: "manual",
      planName: "India Subcontinent Plan",
      currency: "INR",
      listAmount: "15000.00",
      discount: "6000.00",
      amount: "9000.00",
      providerPaymentId: "UTR123456",
      years: 1,
    });
    expect(payment).toMatchObject({ provider: "bank", providerPaymentId: "UTR123456", amount: "9000.00", status: "succeeded" });
  });

  it("shows on Transactions with how it was paid and the transaction number", async () => {
    await recordPayment(guard([]), base());

    const [row] = (await listTransactions([])).rows;

    expect(row).toMatchObject({ provider: "manual", method: "bank", provider_payment_id: "UTR123456", amount: 9000 });
  });

  it("records a price above the list as the price, with no discount", async () => {
    const result = await recordPayment(guard([]), { ...base(), amount: "250000" });

    const [order] = await db().select().from(orders).where(eq(orders.id, result.order_id));

    expect(order).toMatchObject({ listAmount: "250000.00", discount: "0.00", amount: "250000.00" });
  });

  it("makes them premium on the brand, from the payment date", async () => {
    const result = await recordPayment(guard([]), base());

    const [membership] = await db()
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, reader), eq(memberships.siteId, baseoil.siteId)));

    expect(membership).toMatchObject({ role: "subscriber", tier: "premium" });
    expect(membership!.expiresAt).toBe(result.until);
    expect(result.until).toBe(addYears(TODAY, 1));
  });

  it("extends a subscription that is still running from its own end", async () => {
    const running = addDays(TODAY, 40);

    await db().insert(memberships).values({ userId: reader, siteId: baseoil.siteId, tier: "premium", expiresAt: running });

    const result = await recordPayment(guard([]), base());

    expect(result.until).toBe(addYears(running, 1));
  });

  it("takes the end date the team agreed when one is given", async () => {
    const result = await recordPayment(guard([]), { ...base(), until: "2028-03-31" });

    expect(result.until).toBe("2028-03-31");
  });

  it("refuses the same transaction number twice on a brand", async () => {
    await recordPayment(guard([]), base());

    await expect(recordPayment(guard([]), base())).rejects.toMatchObject({ field: "reference", status: 409 });
  });

  it("refuses another brand's plan, a payment dated in the future and an unknown method", async () => {
    const theirs = await planOk(guard([]), plan({ name: "Theirs", sites: ["bitumart"] }));

    await expect(recordPayment(guard([]), { ...base(), plan_id: theirs.id })).rejects.toMatchObject({ field: "plan_id" });
    await expect(recordPayment(guard([]), { ...base(), paid_on: addDays(TODAY, 2) })).rejects.toMatchObject({
      field: "paid_on",
    });
    await expect(recordPayment(guard([]), { ...base(), method: "barter" })).rejects.toMatchObject({ field: "method" });
  });

  it("keeps a staff member's role when they are sold a subscription", async () => {
    await db().insert(memberships).values({ userId: reader, siteId: baseoil.siteId, role: "staff" });

    await recordPayment(guard([]), base());

    const [membership] = await db()
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, reader), eq(memberships.siteId, baseoil.siteId)));

    expect(membership).toMatchObject({ role: "staff", tier: "premium" });
  });

  it("is audited with who recorded it and what the list price was", async () => {
    const result = await recordPayment(guard([]), base(), { ip: "10.0.0.2" });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "order.manual"));

    expect(entry).toMatchObject({ userId: staff, entityId: result.order_id, ip: "10.0.0.2" });
    expect(entry!.detail).toMatchObject({ amount: "9000.00", list: "15000.00", method: "bank", reference: "UTR123456" });
  });

  it("is not for staff of another brand, or a role without directory-edit", async () => {
    await expect(recordPayment(guard([bitumart.siteId]), base())).rejects.toMatchObject({ status: 403 });

    const limited = await withRole(baseoil, ["directory-list"]);

    await expect(recordPayment(limited, base())).rejects.toBeInstanceOf(AccessError);
  });
});
