/**
 * Entering prices by hand: the per-market grid.
 *
 * Pins the two faults the old grid had and this one must not: a partial fill
 * wiping the markets left alone, and a past published price being rewritten.
 * Also that every save is a committed batch, and that one can be rolled back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, priceBatches, prices, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { enterPrices, entrySheet, rollBackUpdate } from "@/domain/price/entry";
import { dayOffset, makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const NOW = new Date(2026, 9, 28, 11, 0, 0);
const TODAY = dayOffset(NOW, 0);
const YESTERDAY = dayOffset(NOW, -1);
const LAST_WEEK = dayOffset(NOW, -7);

const SG = "Singapore SN 150 FOB";
const UAE = "UAE SN 500";
const KOREA = "Korea SN 150";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const live = async (brand: Brand, title: string, date: string) =>
  (
    await db()
      .select()
      .from(prices)
      .where(and(eq(prices.locationId, brand.locationIds[title]!), eq(prices.priceDate, date), isNull(prices.deletedAt)))
  ).map((row) => Number(row.price));

const enter = (date: string, figures: Record<string, string>, siteIds: number[] = []) =>
  enterPrices(
    guard(siteIds),
    {
      site: "baseoil",
      date,
      figures: Object.fromEntries(Object.entries(figures).map(([title, value]) => [String(baseoil.locationIds[title]), value])),
    },
    {},
    db(),
    NOW,
  );

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", [SG, UAE, KOREA]);
  bitumart = await makeBrand("bitumart", ["Mumbai VG30"]);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

describe("the grid", () => {
  it("shows every market, its price on the date, and its figure before", async () => {
    await publishPrice(baseoil, SG, 700, LAST_WEEK);
    await publishPrice(baseoil, SG, 710, YESTERDAY);
    await publishPrice(baseoil, UAE, 650, TODAY);

    const sheet = await entrySheet(guard([]), { site: "baseoil", date: TODAY }, db(), NOW);
    const row = (title: string) => sheet.rows.find((r) => r.title === title)!;

    expect(sheet.past).toBe(false);
    expect(sheet.rows).toHaveLength(3);
    expect(row(SG)).toMatchObject({ onDate: null, before: { date: YESTERDAY } });
    expect(Number(row(SG).before!.price)).toBe(710);
    expect(Number(row(UAE).onDate)).toBe(650);
    expect(row(KOREA)).toMatchObject({ onDate: null, before: null });
  });

  it("refuses a date that has not happened, and another brand's staff", async () => {
    await expect(entrySheet(guard([]), { site: "baseoil", date: dayOffset(NOW, 1) }, db(), NOW)).rejects.toMatchObject({ field: "date" });
    await expect(entrySheet(guard([bitumart.siteId]), { site: "baseoil", date: TODAY }, db(), NOW)).rejects.toMatchObject({ status: 403 });
  });
});

describe("saving it", () => {
  it("leaves empty boxes alone — a partial fill wipes nothing", async () => {
    await publishPrice(baseoil, UAE, 650, TODAY);

    const result = await enter(TODAY, { [SG]: "720", [UAE]: "", [KOREA]: "" });

    expect(result).toMatchObject({ created: 1, changed: 0, locked: [], conflicts: 0 });
    expect(await live(baseoil, SG, TODAY)).toEqual([720]);
    expect(await live(baseoil, UAE, TODAY)).toEqual([650]);
  });

  it("publishes through one committed manual batch, audited", async () => {
    await publishPrice(baseoil, UAE, 650, TODAY);

    const result = await enter(TODAY, { [SG]: "1,250.5", [UAE]: "655", [KOREA]: "" });

    expect(result).toMatchObject({ created: 1, changed: 1 });
    expect(await live(baseoil, SG, TODAY)).toEqual([1250.5]);
    expect(await live(baseoil, UAE, TODAY)).toEqual([655]);

    const [batch] = await db().select().from(priceBatches).where(eq(priceBatches.id, result.batchId!));

    expect(batch).toMatchObject({ source: "manual", status: "committed", createdBy: staff, committedBy: staff });

    const audit = await db().select().from(auditLog).where(eq(auditLog.entityId, result.batchId!));

    expect(audit.map((row) => row.action)).toContain("price_batch.commit");
  });

  it("makes no batch when nothing changed", async () => {
    await publishPrice(baseoil, UAE, 650, TODAY);

    const result = await enter(TODAY, { [SG]: "", [UAE]: "650.00" });

    expect(result).toMatchObject({ batchId: null, created: 0, changed: 0 });
    expect(await db().select().from(priceBatches)).toHaveLength(0);
  });

  it("fills an empty past date, but never rewrites a published one", async () => {
    await publishPrice(baseoil, UAE, 650, YESTERDAY);

    const result = await enter(YESTERDAY, { [SG]: "700", [UAE]: "999" });

    expect(result.created).toBe(1);
    expect(result.locked).toEqual([{ title: UAE, published: expect.any(String), entered: "999" }]);
    expect(await live(baseoil, SG, YESTERDAY)).toEqual([700]);
    expect(await live(baseoil, UAE, YESTERDAY)).toEqual([650]);
  });

  it("saves nothing when one figure cannot be read", async () => {
    await expect(enter(TODAY, { [SG]: "720", [UAE]: "about 650" })).rejects.toMatchObject({ field: "prices" });
    expect(await live(baseoil, SG, TODAY)).toEqual([]);
    expect(await db().select().from(priceBatches)).toHaveLength(0);
  });

  it("refuses another brand's market and a future date", async () => {
    await expect(
      enterPrices(guard([]), { site: "baseoil", date: TODAY, figures: { [bitumart.locationIds["Mumbai VG30"]!]: "1" } }, {}, db(), NOW),
    ).rejects.toMatchObject({ field: "prices" });
    await expect(enter(dayOffset(NOW, 1), { [SG]: "1" })).rejects.toMatchObject({ field: "date" });
  });

  it("needs both the stage and the commit permission", async () => {
    const [role] = await db().insert(roles).values({ name: "Stager" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "price-batch-create" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(enter(TODAY, { [SG]: "720" }, [baseoil.siteId])).rejects.toBeInstanceOf(AccessError);

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "price-batch-commit" });

    expect((await enter(TODAY, { [SG]: "720" }, [baseoil.siteId])).created).toBe(1);
  });
});

describe("rolling a save back", () => {
  it("removes what it created and puts back what it changed", async () => {
    await publishPrice(baseoil, UAE, 650, TODAY);

    const saved = await enter(TODAY, { [SG]: "720", [UAE]: "660" });
    const undone = await rollBackUpdate(guard([]), { site: "baseoil", batchId: saved.batchId! });

    expect(undone).toEqual({ removed: 1, reverted: 1, skipped: 0 });
    expect(await live(baseoil, SG, TODAY)).toEqual([]);
    expect(await live(baseoil, UAE, TODAY)).toEqual([650]);
    await expect(rollBackUpdate(guard([]), { site: "baseoil", batchId: saved.batchId! })).rejects.toMatchObject({ field: "batch" });
  });

  it("is not another brand's to roll back", async () => {
    const saved = await enter(TODAY, { [SG]: "720" });

    await expect(rollBackUpdate(guard([bitumart.siteId]), { site: "baseoil", batchId: saved.batchId! })).rejects.toMatchObject({ status: 403 });
    await expect(rollBackUpdate(guard([]), { site: "bitumart", batchId: saved.batchId! })).rejects.toMatchObject({ status: 404 });
  });
});
