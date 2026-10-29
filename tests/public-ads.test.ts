/**
 * Ads on the brand sites, and the click that counts them.
 *
 * What a page shows is what the admin calls live: switched on, ticked for the
 * website, inside its dates, in a slot that is on. The old site ignored the
 * dates; an ad that ended years ago is not served here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { adPlacements, ads } from "@/db/schema";
import { followAd, liveAds } from "@/domain/public/ads";
import { GET as listRoute } from "@/app/api/public/[site]/ads/route";
import { GET as clickRoute } from "@/app/api/public/[site]/ads/[id]/click/route";
import { apiRequest, dayOffset, makeBrand, resetDatabase, routeContext, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let header: number;
let sidebar: number;

const brandOf = (brand: Brand) => ({ id: brand.siteId, slug: brand.slug });

async function slot(brand: Brand, title: string, enabled = true) {
  const [row] = await db().insert(adPlacements).values({ siteId: brand.siteId, title, enabled }).returning();

  return row!.id;
}

async function ad(values: Partial<typeof ads.$inferInsert> & { title: string }, brand = baseoil) {
  const [row] = await db()
    .insert(ads)
    .values({
      siteId: brand.siteId,
      placementId: header,
      adType: "image",
      image: "banner.png",
      url: "https://advertiser.example/offer",
      enabled: true,
      onDashboard: true,
      ...values,
    })
    .returning();

  return row!.id;
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);
  header = await slot(baseoil, "Header");
  sidebar = await slot(baseoil, "Sidebar");
});

describe("the ads a page shows", () => {
  it("groups running ads by slot, in the order staff set", async () => {
    await ad({ title: "Second", sortOrder: 2 });
    await ad({ title: "First", sortOrder: 1 });
    await ad({ title: "Video", placementId: sidebar, adType: "video", image: null, video: "clip.mp4" });

    const slots = await liveAds(brandOf(baseoil));

    expect(slots.map((s) => s.slot)).toEqual(["Header", "Sidebar"]);
    expect(slots[0]!.ads.map((a) => a.title)).toEqual(["First", "Second"]);
    expect(slots[0]!.ads[0]!.image_url).toBe("/api/public/baseoil/files/ads/images/banner.png");
    expect(slots[0]!.ads[0]!.click_url).toMatch(/^\/api\/public\/baseoil\/ads\/\d+\/click$/);
    expect(slots[1]!.ads[0]!.video_url).toBe("/api/public/baseoil/files/ads/video/clip.mp4");
  });

  it("leaves out ads switched off, newsletter-only, out of their dates, deleted or slotless", async () => {
    const today = new Date();

    await ad({ title: "Running", startsAt: dayOffset(today, -3), endsAt: dayOffset(today, 3) });
    await ad({ title: "Off", enabled: false });
    // The old form's "Dashboard" tick: unticked meant newsletters only.
    await ad({ title: "Newsletter only", onDashboard: false, onNewsletter: true });
    await ad({ title: "Ended", endsAt: dayOffset(today, -1) });
    await ad({ title: "Not yet", startsAt: dayOffset(today, 1) });
    await ad({ title: "Deleted", deletedAt: new Date() });
    await ad({ title: "No slot", placementId: null });

    const slots = await liveAds(brandOf(baseoil));

    expect(slots.flatMap((s) => s.ads.map((a) => a.title))).toEqual(["Running"]);
  });

  it("hides a slot that is switched off, and another brand's ads", async () => {
    const off = await slot(baseoil, "Footer", false);

    await ad({ title: "In a closed slot", placementId: off });
    await ad({ title: "Bitumart's", placementId: await slot(bitumart, "Header") }, bitumart);

    expect(await liveAds(brandOf(baseoil))).toEqual([]);
  });

  it("answers one slot by name", async () => {
    await ad({ title: "Top" });
    await ad({ title: "Side", placementId: sidebar });

    const slots = await liveAds(brandOf(baseoil), { slot: "sidebar" });

    expect(slots).toHaveLength(1);
    expect(slots[0]!.ads.map((a) => a.title)).toEqual(["Side"]);
  });

  it("serves embed code with no click link", async () => {
    await ad({ title: "Google", adType: "code", image: null, code: "<ins>ad</ins>", url: null });

    const [only] = await liveAds(brandOf(baseoil));

    expect(only!.ads[0]).toMatchObject({ code: "<ins>ad</ins>", click_url: null, image_url: null });
  });

  it("is served at /api/public/{site}/ads", async () => {
    await ad({ title: "Top" });

    const response = await listRoute(apiRequest("/api/public/baseoil/ads"), routeContext({ site: "baseoil" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.slots[0].ads[0].title).toBe("Top");
  });
});

describe("following an ad", () => {
  it("counts the click and sends the reader to the ad's link", async () => {
    const id = await ad({ title: "Top" });

    const response = await clickRoute(
      apiRequest(`/api/public/baseoil/ads/${id}/click`),
      routeContext({ site: "baseoil", id: String(id) }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://advertiser.example/offer");

    const [row] = await db().select().from(ads).where(eq(ads.id, id));

    expect(row!.clicks).toBe(1);
  });

  it("will not follow an ad the site is not showing, another brand's, or one with no link", async () => {
    const ended = await ad({ title: "Ended", endsAt: "2023-10-10" });
    const noLink = await ad({ title: "No link", url: null });
    const theirs = await ad({ title: "Theirs", placementId: await slot(bitumart, "Header") }, bitumart);
    const code = await ad({ title: "Code", adType: "code", code: "<ins/>" });

    for (const id of [ended, noLink, theirs, code, 999999]) {
      expect(await followAd(baseoil.siteId, id)).toBeNull();
    }

    const counted = await db().select({ clicks: ads.clicks }).from(ads);

    expect(counted.every((row) => row.clicks === 0)).toBe(true);
  });

  it("refuses a carried link that is not a web address", async () => {
    const id = await ad({ title: "Bad", url: "javascript:alert(1)" });

    const response = await clickRoute(
      apiRequest(`/api/public/baseoil/ads/${id}/click`),
      routeContext({ site: "baseoil", id: String(id) }),
    );

    expect(response.status).toBe(404);
  });
});
