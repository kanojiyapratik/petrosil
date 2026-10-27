/**
 * Ad slots and article categories, across the brands.
 *
 * Seven brands have the same six ad slots and eight have an "AMEA Events"
 * category. These are names, not text, so the global screens show which
 * brands have each name, and add, rename, switch off or remove it on the
 * brands ticked — through the same per-brand rules, so a slot with ads in it
 * or a category with articles filed under it is kept and named back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { adPlacements, ads, articleCategories, articles, users } from "@/db/schema";
import {
  applyCategory,
  applySlot,
  globalCategories,
  globalSlots,
  removeCategory,
  removeSlot,
} from "@/domain/global/estate";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let wax: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const slotsOn = (brand: Brand) =>
  db().select().from(adPlacements).where(eq(adPlacements.siteId, brand.siteId));

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);
  wax = await makeBrand("waxreport", []);

  const [me] = await db().insert(users).values({ email: "boss@petrosil.example", name: "Boss" }).returning();

  staff = me!.id;

  await db()
    .insert(adPlacements)
    .values([
      { siteId: baseoil.siteId, title: "Header Top 1" },
      { siteId: bitumart.siteId, title: "header top 1" },
      { siteId: wax.siteId, title: "Header Row 1" },
    ]);
});

describe("ad slots across the brands", () => {
  it("groups the same name, whatever its case, and says who has it", async () => {
    const rows = await globalSlots([]);
    const header = rows.find((row) => row.title.toLowerCase() === "header top 1")!;

    expect(header.brands.map((brand) => brand.slug)).toEqual(["baseoil", "bitumart"]);
    expect(header.of).toBe(3);
  });

  it("adds a slot to the brands that lack it, and renames it where it is", async () => {
    const result = await applySlot(guard([]), {
      title: "Header Top 1",
      new_title: "Header — top left",
      enabled: true,
      sites: ["baseoil", "bitumart", "waxreport"],
    });

    expect(result).toEqual({ created: 1, updated: 2 });

    for (const brand of [baseoil, bitumart, wax]) {
      expect((await slotsOn(brand)).map((slot) => slot.title)).toContain("Header — top left");
    }

    expect((await slotsOn(wax)).map((slot) => slot.title).sort()).toEqual(["Header Row 1", "Header — top left"]);
  });

  it("switches a slot off on the brands ticked only", async () => {
    await applySlot(guard([]), { title: "Header Top 1", enabled: false, sites: ["bitumart"] });

    expect((await slotsOn(bitumart))[0]!.enabled).toBe(false);
    expect((await slotsOn(baseoil))[0]!.enabled).toBe(true);
  });

  it("refuses a new name a ticked brand already uses, before changing anything", async () => {
    await expect(
      applySlot(guard([]), { title: "Header Top 1", new_title: "Header Row 1", enabled: true, sites: ["baseoil", "waxreport"] }),
    ).rejects.toMatchObject({ field: "new_title", status: 409 });

    expect((await slotsOn(baseoil))[0]!.title).toBe("Header Top 1");
  });

  it("removes it where empty and keeps it where ads run in it", async () => {
    const [slot] = await slotsOn(baseoil);

    await db().insert(ads).values({ siteId: baseoil.siteId, placementId: slot!.id, title: "Running", adType: "code", code: "x" });

    const result = await removeSlot(guard([]), { title: "Header Top 1", sites: ["baseoil", "bitumart"] });

    expect(result).toEqual({ removed: 1, kept: ["baseoil"] });
    expect(await slotsOn(bitumart)).toEqual([]);
  });

  it("only touches brands the editor manages", async () => {
    await expect(
      applySlot(guard([baseoil.siteId]), { title: "Header Top 1", enabled: true, sites: ["baseoil", "bitumart"] }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("categories across the brands", () => {
  beforeEach(async () => {
    await db()
      .insert(articleCategories)
      .values([
        { siteId: baseoil.siteId, slug: "amea-events", name: "AMEA Events" },
        { siteId: bitumart.siteId, slug: "amea-events", name: "AMEA Events" },
      ]);
  });

  it("says who has each category, and adds it to the brands that lack it", async () => {
    expect((await globalCategories([])).find((row) => row.name === "AMEA Events")!.brands).toHaveLength(2);

    const result = await applyCategory(guard([]), { name: "AMEA Events", sites: ["baseoil", "bitumart", "waxreport"] });

    expect(result).toEqual({ created: 1, updated: 2 });

    const [added] = await db()
      .select()
      .from(articleCategories)
      .where(and(eq(articleCategories.siteId, wax.siteId), eq(articleCategories.name, "AMEA Events")));

    expect(added!.slug).toBe("amea-events");
  });

  it("renames it on the brands ticked without moving its slug", async () => {
    await applyCategory(guard([]), { name: "AMEA Events", new_name: "AMEA Events & Conferences", sites: ["baseoil"] });

    const rows = await db().select().from(articleCategories).orderBy(articleCategories.siteId);

    expect(rows.map((row) => [row.name, row.slug])).toEqual([
      ["AMEA Events & Conferences", "amea-events"],
      ["AMEA Events", "amea-events"],
    ]);
  });

  it("removes it where nothing is filed and keeps it where articles are", async () => {
    const [category] = await db()
      .select()
      .from(articleCategories)
      .where(eq(articleCategories.siteId, baseoil.siteId));

    await db()
      .insert(articles)
      .values({ siteId: baseoil.siteId, categoryId: category!.id, slug: "a", title: "A", body: "x", status: "published" });

    expect(await removeCategory(guard([]), { name: "AMEA Events", sites: ["baseoil", "bitumart"] })).toEqual({
      removed: 1,
      kept: ["baseoil"],
    });
  });
});
