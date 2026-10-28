/**
 * Correcting a whole date: withdraw published prices, put them back.
 *
 * Pins that a withdrawal only reaches the date and brand it names, that it is
 * recorded with the figures it took down, that the grid can then re-enter the
 * date, and that putting back never overwrites a figure entered since.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, prices, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { dateSheet, priceDates, putBack, withdrawPrices } from "@/domain/price/date-corrections";
import { enterPrices } from "@/domain/price/entry";
import { dayOffset, makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const NOW = new Date(2026, 9, 28, 11, 0, 0);
const DAY = dayOffset(NOW, -5);
const OTHER_DAY = dayOffset(NOW, -6);

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

let sg: number;
let uae: number;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", [SG, UAE, KOREA]);
  bitumart = await makeBrand("bitumart", ["Mumbai VG30"]);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
  sg = await publishPrice(baseoil, SG, 700, DAY);
  uae = await publishPrice(baseoil, UAE, 650, DAY);
  await publishPrice(baseoil, SG, 690, OTHER_DAY);
});

describe("the dates", () => {
  it("lists every date with prices, newest first", async () => {
    const list = await priceDates(guard([]), { site: "baseoil" });

    expect(list).toMatchObject({ markets: 3, total: 2 });
    expect(list.rows).toEqual([
      { date: DAY, prices: 2 },
      { date: OTHER_DAY, prices: 1 },
    ]);
  });

  it("shows a date's prices, and which update set them", async () => {
    await enterPrices(guard([]), { site: "baseoil", date: DAY, figures: { [baseoil.locationIds[KOREA]!]: "800" } }, {}, db(), NOW);

    const sheet = await dateSheet(guard([]), { site: "baseoil", date: DAY });
    const row = (title: string) => sheet.prices.find((r) => r.title === title)!;

    expect(sheet.prices).toHaveLength(3);
    expect(row(SG).setBy).toBeNull();
    expect(row(KOREA).setBy).toMatchObject({ source: "manual" });
  });
});

describe("withdrawing", () => {
  it("takes down only the ticked prices on that date, and records them", async () => {
    const result = await withdrawPrices(guard([]), { site: "baseoil", date: DAY, priceIds: [sg] });

    expect(result.withdrawn).toBe(1);
    expect(await live(baseoil, SG, DAY)).toEqual([]);
    expect(await live(baseoil, UAE, DAY)).toEqual([650]);
    expect(await live(baseoil, SG, OTHER_DAY)).toEqual([690]);

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.id, result.withdrawalId));

    expect(entry).toMatchObject({ action: "price.withdraw", userId: staff, siteId: baseoil.siteId });
    expect(entry!.detail).toMatchObject({ date: DAY, prices: [{ id: sg, title: SG }] });
  });

  it("lets the grid enter the right figure afterwards", async () => {
    await withdrawPrices(guard([]), { site: "baseoil", date: DAY, priceIds: [sg, uae] });

    const entered = await enterPrices(
      guard([]),
      { site: "baseoil", date: DAY, figures: { [baseoil.locationIds[SG]!]: "705" } },
      {},
      db(),
      NOW,
    );

    expect(entered).toMatchObject({ created: 1, locked: [] });
    expect(await live(baseoil, SG, DAY)).toEqual([705]);
  });

  it("refuses a price from another date or brand, and changes nothing", async () => {
    const elsewhere = await publishPrice(bitumart, "Mumbai VG30", 400, DAY);

    await expect(withdrawPrices(guard([]), { site: "baseoil", date: OTHER_DAY, priceIds: [sg] })).rejects.toMatchObject({ status: 409 });
    await expect(withdrawPrices(guard([]), { site: "baseoil", date: DAY, priceIds: [sg, elsewhere] })).rejects.toMatchObject({ status: 409 });
    await expect(withdrawPrices(guard([]), { site: "baseoil", date: DAY, priceIds: [] })).rejects.toMatchObject({ field: "prices" });
    expect(await live(baseoil, SG, DAY)).toEqual([700]);
  });

  it("is not another brand's staff's, nor a role's without the rollback permission", async () => {
    await expect(withdrawPrices(guard([bitumart.siteId]), { site: "baseoil", date: DAY, priceIds: [sg] })).rejects.toMatchObject({ status: 403 });

    const [role] = await db().insert(roles).values({ name: "Viewer" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "price-batch-view" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    expect((await dateSheet(guard([baseoil.siteId]), { site: "baseoil", date: DAY })).prices).toHaveLength(2);
    await expect(withdrawPrices(guard([baseoil.siteId]), { site: "baseoil", date: DAY, priceIds: [sg] })).rejects.toBeInstanceOf(AccessError);
  });
});

describe("putting back", () => {
  it("restores what was withdrawn, once", async () => {
    const { withdrawalId } = await withdrawPrices(guard([]), { site: "baseoil", date: DAY, priceIds: [sg, uae] });

    expect(await putBack(guard([]), { site: "baseoil", withdrawalId })).toEqual({ restored: 2, skipped: 0 });
    expect(await live(baseoil, SG, DAY)).toEqual([700]);
    expect(await live(baseoil, UAE, DAY)).toEqual([650]);
    await expect(putBack(guard([]), { site: "baseoil", withdrawalId })).rejects.toMatchObject({ status: 409 });

    const sheet = await dateSheet(guard([]), { site: "baseoil", date: DAY });

    expect(sheet.withdrawals).toHaveLength(1);
    expect(sheet.withdrawals[0]!.putBackAt).not.toBeNull();
  });

  it("keeps a figure entered since, rather than overwriting it", async () => {
    const { withdrawalId } = await withdrawPrices(guard([]), { site: "baseoil", date: DAY, priceIds: [sg, uae] });

    await enterPrices(guard([]), { site: "baseoil", date: DAY, figures: { [baseoil.locationIds[SG]!]: "705" } }, {}, db(), NOW);

    expect(await putBack(guard([]), { site: "baseoil", withdrawalId })).toEqual({ restored: 1, skipped: 1 });
    expect(await live(baseoil, SG, DAY)).toEqual([705]);
    expect(await live(baseoil, UAE, DAY)).toEqual([650]);
  });

  it("is not another brand's to put back", async () => {
    const { withdrawalId } = await withdrawPrices(guard([]), { site: "baseoil", date: DAY, priceIds: [sg] });

    await expect(putBack(guard([]), { site: "bitumart", withdrawalId })).rejects.toMatchObject({ status: 404 });
  });
});
