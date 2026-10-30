/**
 * Per-market rules, read from the price module.
 *
 * The module's database is replaced by a reader returning a fixed rulebook.
 * What is pinned is this side's contribution: each rule's market names
 * checked against the brand's markets by exact title, as the module resolves
 * them, with near misses reported rather than silently matched.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db";
import { memberships, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { ModuleUnavailable, adjustment, removeRule, rulesFor, saveRule, setSiteRounding, type ModuleBook, type ModuleReader } from "@/domain/price/rules";
import { makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const EUROPE = "Europe Domestic SN 150 FOB Group I";
const CHINA = "China Domestic SN 150 FOB Group I";
const KOREA = "Korea SN 150";
const SPAIN = "Spain SN 150";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const BOOK: ModuleBook = {
  rules: [
    { id: 1, derived: EUROPE, reference: "Report: Northwestern Europe SN 150", value: -20, kind: "percent", enabled: true },
    { id: 2, derived: CHINA, reference: EUROPE, value: -15, kind: "percent", enabled: true },
    // A double space: the module's exact match misses it, so the rule never runs.
    { id: 3, derived: KOREA, reference: "China Domestic  SN 150 FOB Group I", value: 25, kind: "usd", enabled: true },
    { id: 4, derived: "Atlantis SN 150", reference: EUROPE, value: 5, kind: "percent", enabled: true },
    { id: 5, derived: SPAIN, reference: "Nowhere", value: 1, kind: "percent", enabled: false },
  ],
  rounding: { step: 5, direction: "nearest", overrides: [{ location: KOREA, step: 10, direction: "up", asPrinted: false }] },
};

const reading =
  (book: ModuleBook = BOOK): ModuleReader =>
  async (slug) => (slug === "baseoil" ? book : { rules: [], rounding: { step: null, direction: "nearest", overrides: [] } });

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", [EUROPE, CHINA, KOREA, SPAIN, "Iran SN 150"]);
  bitumart = await makeBrand("bitumart", ["Mumbai VG30"]);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
  await publishPrice(baseoil, EUROPE, 1200, "2026-10-20");
});

describe("the rulebook", () => {
  it("checks each rule's markets against the brand, by exact title", async () => {
    const view = await rulesFor(guard([]), { site: "baseoil" }, db(), reading());

    if (!view.connected) {
      throw new Error("expected a connected view");
    }

    const rule = (id: number) => view.rules.find((r) => r.id === id)!;

    expect(rule(1).referenceMatch).toEqual({ status: "report" });
    expect(rule(1).derivedMatch).toMatchObject({ status: "market", price: 1200, date: "2026-10-20" });
    expect(rule(1).feeds).toBe(2);
    expect(rule(2).referenceMatch).toMatchObject({ status: "market", title: EUROPE });
    expect(rule(3).referenceMatch).toEqual({ status: "near", title: CHINA });
    expect(rule(4).derivedMatch).toEqual({ status: "missing" });
    expect(rule(5).referenceMatch).toEqual({ status: "missing" });
  });

  it("counts what cannot run, leaving switched-off rules out, and the markets left to the reports", async () => {
    const view = await rulesFor(guard([]), { site: "baseoil" }, db(), reading());

    expect(view).toMatchObject({ connected: true, broken: 2, markets: 5, fromReports: 1 });
  });

  it("writes an adjustment the way the console does", () => {
    expect(adjustment({ value: -15, kind: "percent" })).toBe("−15%");
    expect(adjustment({ value: 25, kind: "usd" })).toBe("+25 USD");
    expect(adjustment({ value: 5, kind: "eur" })).toBe("+5 EUR");
  });

  it("passes the rounding through", async () => {
    const view = await rulesFor(guard([]), { site: "baseoil" }, db(), reading());

    expect(view).toMatchObject({ rounding: { step: 5, overrides: [{ location: KOREA, step: 10, direction: "up" }] } });
  });
});

describe("when the module cannot be read", () => {
  it("says so instead of failing the page", async () => {
    const down: ModuleReader = async () => {
      throw new ModuleUnavailable("MODULE_DATABASE_URL is not set.");
    };

    expect(await rulesFor(guard([]), { site: "baseoil" }, db(), down)).toEqual({
      connected: false,
      reason: "MODULE_DATABASE_URL is not set.",
    });
  });
});

describe("who may see it", () => {
  it("is not another brand's staff's, nor a role's without the price view", async () => {
    await expect(rulesFor(guard([bitumart.siteId]), { site: "baseoil" }, db(), reading())).rejects.toMatchObject({ status: 403 });

    const [role] = await db().insert(roles).values({ name: "Content" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "article-create" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(rulesFor(guard([baseoil.siteId]), { site: "baseoil" }, db(), reading())).rejects.toBeInstanceOf(AccessError);
  });
});

describe("who may change it", () => {
  it("is a role with the rules permission; one that may only look sees no form, and is refused before the engine is asked", async () => {
    const [role] = await db().insert(roles).values({ name: "Prices, read only" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "price-batch-view" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    const view = await rulesFor(guard([baseoil.siteId]), { site: "baseoil" }, db(), reading());

    expect(view.connected && view.canEdit).toBe(false);

    // No ENGINE_URL in the test environment: reaching the engine would fail
    // differently. A refusal with the permission's name is the role check.
    const refused = { status: 403, message: expect.stringContaining("change the per-market rules and rounding") };

    await expect(saveRule(guard([baseoil.siteId]), "baseoil", { derived: KOREA, reference: EUROPE, value: "-10", kind: "percent" })).rejects.toMatchObject(refused);
    await expect(removeRule(guard([baseoil.siteId]), "baseoil", 1)).rejects.toMatchObject(refused);
    await expect(setSiteRounding(guard([baseoil.siteId]), "baseoil", { step: "5", direction: "nearest" })).rejects.toMatchObject(refused);
  });

  it("is never another brand's staff", async () => {
    await expect(saveRule(guard([bitumart.siteId]), "baseoil", { derived: KOREA, reference: EUROPE, value: "-10", kind: "percent" })).rejects.toMatchObject({ status: 403 });
  });

  it("is open to a superadmin", async () => {
    const view = await rulesFor(guard([]), { site: "baseoil" }, db(), reading());

    expect(view.connected && view.canEdit).toBe(true);
  });
});
