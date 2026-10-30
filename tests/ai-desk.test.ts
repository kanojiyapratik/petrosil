/**
 * The crawler desk on Watched pages, and who may manage the AI providers.
 *
 * The engine is not running here (no ENGINE_URL): everything tested either
 * never reaches it (a refusal) or is this app's own data (staging findings).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, priceBatches, priceBatchItems, priceCrawlActivities, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { clearFindings, crawlNow, findings, stageFindings } from "@/domain/crawl/desk";
import { addProvider, providerList, removeProvider, testProvider } from "@/domain/ai/providers";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

const KOREA = "Korea SN 150";
const SINGAPORE = "Singapore SN 150";

let brand: Brand;
let other: Brand;
let staff: number;

const guard = (siteIds: number[], superadmin = false) =>
  ({ identity: { user: { id: staff, email: "editor@petrosil.example" }, memberships: [] }, siteIds, isSuperadmin: superadmin }) as never;

async function found(location: string, price: number, placed: boolean) {
  const [row] = await db()
    .insert(priceCrawlActivities)
    .values({
      siteId: brand.siteId,
      locationId: placed ? brand.locationIds[location]! : null,
      location,
      price: String(price),
      priceDate: "2099-03-02",
    })
    .returning();

  return row!.id;
}

beforeEach(async () => {
  await resetDatabase();
  brand = await makeBrand("baseoil", [KOREA, SINGAPORE]);
  other = await makeBrand("bitumart", ["Mumbai VG30"]);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

describe("the crawler's findings", () => {
  it("stage as draft price updates marked as the person's, with a hand match recorded", async () => {
    const placed = await found(KOREA, 1404, true);
    const unplaced = await found("S'pore N150 (per t)", 1560, false);

    const said = await stageFindings(guard([brand.siteId]), "baseoil", {
      ids: [placed],
      matched: [{ id: unplaced, location: SINGAPORE }],
    });

    expect(said).toMatch(/Staged price update #\d+ with 1 price\. Staged price update #\d+ with 1 price matched by hand\. Nothing is on the website yet\./);

    const batches = await db().select().from(priceBatches).where(eq(priceBatches.siteId, brand.siteId));

    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.createdBy === staff && batch.status === "draft" && batch.source === "crawl")).toBe(true);

    const items = await db().select().from(priceBatchItems);

    expect(items.map((item) => [item.rawLocation, Number(item.newPrice)]).sort()).toEqual([
      [KOREA, 1404],
      [SINGAPORE, 1560],
    ]);

    const [match] = await db().select().from(auditLog).where(eq(auditLog.action, "crawl.match"));

    expect(match!.detail).toMatchObject({ found_as: "S'pore N150 (per t)", matched_to: SINGAPORE, price: 1560 });
  });

  it("refuse an empty tick", async () => {
    await expect(stageFindings(guard([brand.siteId]), "baseoil", { ids: [], matched: [] })).rejects.toMatchObject({ status: 422 });
  });

  it("clear, and the clearing is recorded", async () => {
    await found(KOREA, 1404, true);

    expect(await clearFindings(guard([brand.siteId]), "baseoil")).toBe("Cleared 1 finding.");
    expect(await findings(guard([brand.siteId]), "baseoil")).toEqual([]);
  });

  it("are never another brand's staff's, and a read-only role cannot stage or crawl", async () => {
    await found(KOREA, 1404, true);

    await expect(findings(guard([other.siteId]), "baseoil")).rejects.toMatchObject({ status: 403 });

    const [role] = await db().insert(roles).values({ name: "Prices, read only" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "price-batch-view" });
    await db().insert(memberships).values({ userId: staff, siteId: brand.siteId, role: "staff", roleId: role!.id });

    expect(await findings(guard([brand.siteId]), "baseoil")).toHaveLength(1);
    await expect(stageFindings(guard([brand.siteId]), "baseoil", { ids: [1], matched: [] })).rejects.toBeInstanceOf(AccessError);
    await expect(crawlNow(guard([brand.siteId]), "baseoil")).rejects.toBeInstanceOf(AccessError);
  });
});

describe("the AI providers", () => {
  it("are a superadmin's to manage; staff are refused before the engine is asked", async () => {
    const staffGuard = guard([brand.siteId]);
    const refused = { status: 403, message: "Only a superadmin can change the AI providers." };

    await expect(providerList(staffGuard)).rejects.toMatchObject(refused);
    await expect(addProvider(staffGuard, { provider: "openai", apiKey: "sk-x", name: "", makeDefault: false })).rejects.toMatchObject(refused);
    await expect(removeProvider(staffGuard, 1)).rejects.toMatchObject(refused);
    await expect(testProvider(staffGuard, 1)).rejects.toMatchObject(refused);
  });
});
