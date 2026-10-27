/**
 * Ads and the slots they run in.
 *
 * An ad is a picture, a video or a piece of embed code, in one of the brand's
 * slots, between two dates. Its link is checked to be a web address: the old
 * form took anything, and a `javascript:` link in an ad runs on every page
 * the ad is shown on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { adPlacements, ads, auditLog, mediaFiles, memberships, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { adForEdit, deletePlacement, saveAd, savePlacement, withdrawAd } from "@/domain/ads/editor";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;
let slot: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

async function stored(brand: Brand, folder: string, name: string) {
  await db()
    .insert(mediaFiles)
    .values({ siteId: brand.siteId, path: `${brand.slug}/${folder}/${name}`, folder, name, kind: "image/png", bytes: 10 });
}

const ad = (extra: Record<string, unknown> = {}) => ({
  site: "baseoil",
  title: "Gulf Lubes — header",
  placement_id: slot,
  ad_type: "image",
  image: "gulf.png",
  url: "https://gulflubes.example/",
  starts_at: "2026-11-01",
  ends_at: "2026-11-30",
  enabled: true,
  ...extra,
});

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
  slot = (await savePlacement(guard([]), { site: "baseoil", title: "Header Top 1", enabled: true }))!.id;
  await stored(baseoil, "ads/images", "gulf.png");
});

describe("an ad", () => {
  it("is saved in its slot with its picture, link and dates", async () => {
    const made = await saveAd(guard([]), ad());

    const [row] = await db().select().from(ads).where(eq(ads.id, made!.id));

    expect(row).toMatchObject({
      siteId: baseoil.siteId,
      placementId: slot,
      adType: "image",
      image: "gulf.png",
      url: "https://gulflubes.example/",
      startsAt: "2026-11-01",
      endsAt: "2026-11-30",
      enabled: true,
    });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "ad.create"));

    expect(entry).toMatchObject({ entityId: made!.id, siteId: baseoil.siteId });
  });

  it("needs the thing it shows: a picture, a video or its code", async () => {
    await expect(saveAd(guard([]), ad({ image: "" }))).rejects.toMatchObject({ field: "image" });
    await expect(saveAd(guard([]), ad({ ad_type: "video", image: "" }))).rejects.toMatchObject({ field: "video" });
    await expect(saveAd(guard([]), ad({ ad_type: "code", image: "", code: " " }))).rejects.toMatchObject({ field: "code" });

    const embed = await saveAd(guard([]), ad({ ad_type: "code", image: "", code: "<ins class='adsbygoogle'></ins>" }));

    expect(embed).not.toBeNull();
  });

  it("takes a picture only from the brand's ad folder", async () => {
    await stored(bitumart, "ads/images", "theirs.png");

    await expect(saveAd(guard([]), ad({ image: "theirs.png" }))).rejects.toMatchObject({ field: "image" });
  });

  it("refuses a link that is not a web address", async () => {
    await expect(saveAd(guard([]), ad({ url: "javascript:alert(1)" }))).rejects.toMatchObject({ field: "url" });
    await expect(saveAd(guard([]), ad({ url: "not a link" }))).rejects.toMatchObject({ field: "url" });
    expect(await saveAd(guard([]), ad({ url: "" }))).not.toBeNull();
  });

  it("reads a bare domain, as carried ads have it, as its https address", async () => {
    const made = (await saveAd(guard([]), ad({ url: "felubeoil.com" })))!;

    expect((await adForEdit([], made.id))!.url).toBe("https://felubeoil.com");
  });

  it("refuses dates the wrong way round, and another brand's slot", async () => {
    await expect(saveAd(guard([]), ad({ starts_at: "2026-12-01", ends_at: "2026-11-01" }))).rejects.toMatchObject({
      field: "ends_at",
    });

    const theirs = (await savePlacement(guard([]), { site: "bitumart", title: "Header", enabled: true }))!;

    await expect(saveAd(guard([]), ad({ placement_id: theirs.id }))).rejects.toMatchObject({ field: "placement_id" });
  });

  it("changes, and is withdrawn rather than deleted", async () => {
    const made = (await saveAd(guard([]), ad()))!;

    await saveAd(guard([]), ad({ id: made.id, title: "Gulf Lubes — December", ends_at: "2026-12-31", enabled: false }));

    expect(await adForEdit([], made.id)).toMatchObject({ title: "Gulf Lubes — December", ends_at: "2026-12-31", enabled: false });

    expect(await withdrawAd(guard([]), made.id)).toBe(true);

    const [row] = await db().select().from(ads).where(eq(ads.id, made.id));

    expect(row!.deletedAt).not.toBeNull();
    expect(await adForEdit([], made.id)).toBeNull();
  });

  it("is not another brand's staff's, nor a role's without ad-create", async () => {
    const theirs = (await saveAd(guard([]), ad()))!;

    expect(await saveAd(guard([bitumart.siteId]), ad({ id: theirs.id }))).toBeNull();
    await expect(saveAd(guard([bitumart.siteId]), ad())).rejects.toMatchObject({ status: 403 });

    const [role] = await db().insert(roles).values({ name: "Ad reader" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "ad-list" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(saveAd(guard([baseoil.siteId]), ad())).rejects.toBeInstanceOf(AccessError);
  });
});

describe("an ad slot", () => {
  it("is renamed and switched off, but not given a name the brand already uses", async () => {
    const other = (await savePlacement(guard([]), { site: "baseoil", title: "Left sidebar", enabled: true }))!;

    await expect(savePlacement(guard([]), { id: other.id, title: "header top 1", enabled: true })).rejects.toMatchObject({
      field: "title",
      status: 409,
    });

    const saved = await savePlacement(guard([]), { id: other.id, title: "Left sidebar 1", enabled: false });

    expect(saved).toMatchObject({ title: "Left sidebar 1", enabled: false });
  });

  it("cannot be deleted while ads run in it", async () => {
    const made = (await saveAd(guard([]), ad()))!;

    await expect(deletePlacement(guard([]), slot)).rejects.toMatchObject({ status: 409 });

    await withdrawAd(guard([]), made.id);

    expect(await deletePlacement(guard([]), slot)).toBe(true);
    expect(await db().select().from(adPlacements).where(eq(adPlacements.id, slot))).toEqual([]);
  });
});
