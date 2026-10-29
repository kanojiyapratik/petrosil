/**
 * Ads on the brand sites, and the click that counts them.
 *
 * The old sites loaded every slot into every page and showed an ad when it
 * was "Published" and ticked "Dashboard" — which, despite the name, meant
 * the website: an unticked ad went out in newsletters only (baseoil's
 * "LinkedIn banner"). That tick is `on_dashboard` here.
 *
 * What runs is what the admin's "live" column says: switched on, inside its
 * dates, in a slot that is switched on. The old site ignored the dates, so
 * ads that ended in 2023 were still showing; they are not served.
 *
 * A click goes through the platform so it can be counted, then on to the
 * ad's link. Only a live ad with a link is followed — an id for anything
 * else answers as missing, so the endpoint cannot be used to bounce a reader
 * to an address nobody approved. Embed code carries its own links and is
 * never counted.
 */

import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { adPlacements, ads } from "@/db/schema";
import { IMAGE_FOLDER, VIDEO_FOLDER } from "@/domain/ads/editor";

export type PublicAd = {
  id: number;
  title: string;
  ad_type: string;
  image_url: string | null;
  video_url: string | null;
  code: string | null;
  /** The counting link the page should use, or null when there is nothing to follow. */
  click_url: string | null;
};

export type PublicSlot = { slot: string; ads: PublicAd[] };

const fileUrl = (brand: string, folder: string, name: string | null) =>
  name ? `/api/public/${brand}/files/${folder}/${encodeURIComponent(name)}` : null;

/** Running today: switched on, shown on the site, inside its dates, not deleted. */
const running = () =>
  and(
    isNull(ads.deletedAt),
    eq(ads.enabled, true),
    eq(ads.onDashboard, true),
    or(isNull(ads.startsAt), sql`${ads.startsAt} <= current_date`),
    or(isNull(ads.endsAt), sql`${ads.endsAt} >= current_date`),
  );

/**
 * Every slot with something running, its ads in the order staff set. One
 * slot only when `slot` names it (by title, as the slots list shows it).
 */
export async function liveAds(
  brand: { id: number; slug: string },
  query: { slot?: string | null } = {},
  database: Database = db(),
): Promise<PublicSlot[]> {
  const slot = query.slot?.trim() || null;

  const rows = await database
    .select({ ad: ads, slot: adPlacements.title })
    .from(ads)
    .innerJoin(adPlacements, eq(adPlacements.id, ads.placementId))
    .where(
      and(
        eq(ads.siteId, brand.id),
        eq(adPlacements.enabled, true),
        slot ? sql`lower(${adPlacements.title}) = lower(${slot})` : undefined,
        running(),
      ),
    )
    .orderBy(asc(adPlacements.title), asc(ads.sortOrder), asc(ads.id));

  const slots = new Map<string, PublicAd[]>();

  for (const { ad, slot: title } of rows) {
    const list = slots.get(title) ?? [];

    list.push({
      id: ad.id,
      title: ad.title,
      ad_type: ad.adType,
      image_url: ad.adType === "image" ? fileUrl(brand.slug, IMAGE_FOLDER, ad.image) : null,
      video_url: ad.adType === "video" ? fileUrl(brand.slug, VIDEO_FOLDER, ad.video) : null,
      code: ad.adType === "code" ? ad.code : null,
      click_url: ad.adType !== "code" && ad.url ? `/api/public/${brand.slug}/ads/${ad.id}/click` : null,
    });
    slots.set(title, list);
  }

  return [...slots].map(([title, list]) => ({ slot: title, ads: list }));
}

/**
 * Count a click and say where it goes, or null when the ad is not one the
 * site is showing. A failed count still sends the reader on: losing one
 * click is better than a dead banner.
 */
export async function followAd(siteId: number, id: number, database: Database = db()): Promise<string | null> {
  const [ad] = await database
    .select({ id: ads.id, url: ads.url })
    .from(ads)
    .innerJoin(adPlacements, eq(adPlacements.id, ads.placementId))
    .where(
      and(
        eq(ads.id, id),
        eq(ads.siteId, siteId),
        eq(adPlacements.enabled, true),
        sql`${ads.adType} <> 'code'`,
        isNotNull(ads.url),
        running(),
      ),
    )
    .limit(1);

  if (!ad?.url) {
    return null;
  }

  // The editor only saves http(s) links; carried rows are checked again here.
  let target: URL;

  try {
    target = new URL(ad.url);
  } catch {
    return null;
  }

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return null;
  }

  try {
    await database
      .update(ads)
      .set({ clicks: sql`${ads.clicks} + 1` })
      .where(eq(ads.id, ad.id));
  } catch (error) {
    console.error("could not count an ad click", { id: ad.id, error });
  }

  return target.toString();
}
