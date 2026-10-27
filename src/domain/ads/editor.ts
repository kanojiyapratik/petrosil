/**
 * Ads and the slots they run in.
 *
 * An ad is a picture, a video or a piece of embed code (a Google ad, say),
 * in one of the brand's slots, between two dates. Whether it is running is
 * worked out from those dates and the switch, never stored: the old screen
 * showed "Published" on ads that ended in 2021.
 *
 * Two checks the old form did not make. The link must be a web address: a
 * `javascript:` link in an ad runs on every page the ad appears on. And the
 * picture or video must be in the brand's ad folder, so an ad cannot show
 * nothing, or another brand's file.
 *
 * Embed code is kept as typed. It runs on the brand site by design, which is
 * why only staff with ad permissions can write it.
 */

import { and, count, eq, isNull, ne, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { adPlacements, ads, auditLog, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { attachable, storedFileId } from "@/domain/files/attach";
import { dateInput } from "@/domain/billing/inputs";

export const AD_TYPES = ["image", "video", "code"] as const;

export const IMAGE_FOLDER = "ads/images";
export const VIDEO_FOLDER = "ads/video";

type Row = typeof ads.$inferSelect;

export type AdInput = {
  id?: number;
  /** The brand, on a new ad only. */
  site?: string;
  title: unknown;
  placement_id?: unknown;
  ad_type: unknown;
  image?: unknown;
  video?: unknown;
  code?: unknown;
  url?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
  enabled?: boolean;
  sort_order?: unknown;
  on_dashboard?: boolean;
  on_newsletter?: boolean;
};

/** A web address, or null for none. */
function link(value: unknown): string | null {
  const text = String(value ?? "").trim();

  if (text === "") {
    return null;
  }

  // "felubeoil.com", as eleven carried ads have it, means its https address.
  const full = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(text) ? `https://${text}` : text;

  let parsed: URL;

  try {
    parsed = new URL(full);
  } catch {
    throw new AccountError("The link has to be a full web address, starting https://", 422, "url");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AccountError("The link has to be a web address, starting https://", 422, "url");
  }

  return full.slice(0, 2000);
}

async function slotFor(siteId: number, value: unknown, database: Database): Promise<number | null> {
  const raw = String(value ?? "").trim();

  if (raw === "") {
    return null;
  }

  const [found] = await database
    .select({ id: adPlacements.id })
    .from(adPlacements)
    .where(and(eq(adPlacements.id, Number(raw)), eq(adPlacements.siteId, siteId)))
    .limit(1);

  if (!found) {
    throw new AccountError("Choose one of this brand's ad slots.", 422, "placement_id");
  }

  return found.id;
}

/** Null when it is another brand's ad. */
export async function saveAd(
  guard: Guarded,
  input: AdInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ id: number; title: string } | null> {
  let existing: Row | undefined;
  let siteId: number;

  if (input.id !== undefined) {
    [existing] = await database
      .select()
      .from(ads)
      .where(and(eq(ads.id, input.id), isNull(ads.deletedAt)))
      .limit(1);

    if (!existing || (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))) {
      return null;
    }

    siteId = existing.siteId;
    await requirePermission(guard, siteId, "ad-edit", database);
  } else {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, String(input.site ?? ""))).limit(1);

    if (!brand) {
      throw new AccountError("We do not recognise that brand.", 422, "site");
    }

    if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
      throw new AccountError("You do not have access to that brand.", 403, "site");
    }

    siteId = brand.id;
    await requirePermission(guard, siteId, "ad-create", database);
  }

  const title = String(input.title ?? "").trim().replace(/\s+/g, " ").slice(0, 191);

  if (title === "") {
    throw new AccountError("Give the ad a name, so it can be found in the list.", 422, "title");
  }

  const adType = String(input.ad_type ?? "");

  if (!(AD_TYPES as readonly string[]).includes(adType)) {
    throw new AccountError("Choose a picture, a video or embed code.", 422, "ad_type");
  }

  // Only the field the ad shows is kept; the others are cleared, so a picture
  // ad turned into a code ad does not keep a stale picture.
  const image = adType === "image" ? await attachable(siteId, IMAGE_FOLDER, "image", input.image ?? "", "picture", database) : null;
  const video = adType === "video" ? await attachable(siteId, VIDEO_FOLDER, "video", input.video ?? "", "video", database) : null;
  const code = adType === "code" ? String(input.code ?? "").trim() || null : null;

  if (adType === "image" && !image) {
    throw new AccountError("Upload the picture the ad shows.", 422, "image");
  }

  if (adType === "video" && !video) {
    throw new AccountError("Upload the video the ad shows.", 422, "video");
  }

  if (adType === "code" && !code) {
    throw new AccountError("Paste the embed code the ad runs.", 422, "code");
  }

  const startsAt = dateInput(input.starts_at, "starts_at");
  const endsAt = dateInput(input.ends_at, "ends_at");

  if (startsAt && endsAt && endsAt < startsAt) {
    throw new AccountError("It would end before it starts.", 422, "ends_at");
  }

  const values = {
    title,
    placementId: await slotFor(siteId, input.placement_id, database),
    adType,
    image: image ?? null,
    video: video ?? null,
    code,
    url: link(input.url),
    startsAt,
    endsAt,
    enabled: input.enabled ?? true,
    sortOrder: Number.isInteger(Number(input.sort_order)) ? Number(input.sort_order) : (existing?.sortOrder ?? 0),
    onDashboard: input.on_dashboard ?? false,
    onNewsletter: input.on_newsletter ?? false,
  };

  const [row] = existing
    ? await database.update(ads).set(values).where(eq(ads.id, existing.id)).returning()
    : await database.insert(ads).values({ ...values, siteId }).returning();

  await database.insert(auditLog).values({
    siteId,
    userId: guard.identity.user.id,
    action: existing ? "ad.update" : "ad.create",
    entity: "ad",
    entityId: row!.id,
    detail: {
      title,
      type: adType,
      runs: `${startsAt ?? "now"} to ${endsAt ?? "no end"}`,
      enabled: values.enabled,
      ...(existing && existing.url !== values.url ? { link: { from: existing.url, to: values.url } } : {}),
    },
    ip: context.ip ?? null,
  });

  return { id: row!.id, title: row!.title };
}

/** Withdraw, not delete: the click count is the record of what was sold. */
export async function withdrawAd(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const [found] = await database
    .select()
    .from(ads)
    .where(and(eq(ads.id, id), isNull(ads.deletedAt)))
    .limit(1);

  if (!found || (!guard.isSuperadmin && !guard.siteIds.includes(found.siteId))) {
    return false;
  }

  await requirePermission(guard, found.siteId, "ad-delete", database);

  await database.update(ads).set({ deletedAt: new Date() }).where(eq(ads.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "ad.withdraw",
    entity: "ad",
    entityId: id,
    detail: { title: found.title, clicks: found.clicks },
    ip: context.ip ?? null,
  });

  return true;
}

/** One ad for its editor, scoped like every dashboard read. */
export async function adForEdit(siteIds: number[], id: number, database: Database = db()) {
  const [row] = await database
    .select({ ad: ads, slug: sites.slug, name: sites.name })
    .from(ads)
    .innerJoin(sites, eq(sites.id, ads.siteId))
    .where(and(eq(ads.id, id), isNull(ads.deletedAt)))
    .limit(1);

  if (!row || (siteIds.length > 0 && !siteIds.includes(row.ad.siteId))) {
    return null;
  }

  const { ad } = row;
  const [imageId, videoId] = await Promise.all([
    ad.image ? storedFileId(ad.siteId, IMAGE_FOLDER, ad.image, database) : null,
    ad.video ? storedFileId(ad.siteId, VIDEO_FOLDER, ad.video, database) : null,
  ]);

  return {
    id: ad.id,
    site: row.slug,
    site_name: row.name,
    title: ad.title,
    placement_id: ad.placementId,
    ad_type: ad.adType,
    image: ad.image,
    image_id: imageId,
    video: ad.video,
    video_id: videoId,
    code: ad.code,
    url: ad.url,
    starts_at: ad.startsAt,
    ends_at: ad.endsAt,
    enabled: ad.enabled,
    sort_order: ad.sortOrder,
    on_dashboard: ad.onDashboard,
    on_newsletter: ad.onNewsletter,
    clicks: ad.clicks,
  };
}

export type AdForEdit = NonNullable<Awaited<ReturnType<typeof adForEdit>>>;

/* ------------------------------------------------------------------ slots */

/** Null when it is another brand's slot. Names are unique per brand, ignoring case. */
export async function savePlacement(
  guard: Guarded,
  input: { id?: number; site?: string; title: unknown; enabled?: boolean },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ id: number; title: string; enabled: boolean } | null> {
  let existing: typeof adPlacements.$inferSelect | undefined;
  let siteId: number;

  if (input.id !== undefined) {
    [existing] = await database.select().from(adPlacements).where(eq(adPlacements.id, input.id)).limit(1);

    if (!existing || (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))) {
      return null;
    }

    siteId = existing.siteId;
    await requirePermission(guard, siteId, "adlocation-edit", database);
  } else {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, String(input.site ?? ""))).limit(1);

    if (!brand) {
      throw new AccountError("We do not recognise that brand.", 422, "site");
    }

    if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
      throw new AccountError("You do not have access to that brand.", 403, "site");
    }

    siteId = brand.id;
    await requirePermission(guard, siteId, "adlocation-create", database);
  }

  const title = String(input.title ?? "").trim().replace(/\s+/g, " ").slice(0, 191);

  if (title === "") {
    throw new AccountError("Give the slot a name.", 422, "title");
  }

  const [clash] = await database
    .select({ id: adPlacements.id })
    .from(adPlacements)
    .where(
      and(
        eq(adPlacements.siteId, siteId),
        sql`lower(${adPlacements.title}) = ${title.toLowerCase()}`,
        existing ? ne(adPlacements.id, existing.id) : undefined,
      ),
    )
    .limit(1);

  if (clash) {
    throw new AccountError("This brand already has a slot by that name.", 409, "title");
  }

  const values = { title, enabled: input.enabled ?? true };
  const [row] = existing
    ? await database.update(adPlacements).set(values).where(eq(adPlacements.id, existing.id)).returning()
    : await database.insert(adPlacements).values({ ...values, siteId }).returning();

  await database.insert(auditLog).values({
    siteId,
    userId: guard.identity.user.id,
    action: existing ? "ad-slot.update" : "ad-slot.create",
    entity: "ad_placement",
    entityId: row!.id,
    detail: existing ? { was: existing.title, now: title, enabled: values.enabled } : { title },
    ip: context.ip ?? null,
  });

  return { id: row!.id, title: row!.title, enabled: row!.enabled };
}

/** Refused while ads run in it; an empty slot is deleted for good. */
export async function deletePlacement(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const [found] = await database.select().from(adPlacements).where(eq(adPlacements.id, id)).limit(1);

  if (!found || (!guard.isSuperadmin && !guard.siteIds.includes(found.siteId))) {
    return false;
  }

  await requirePermission(guard, found.siteId, "adlocation-delete", database);

  const [placed] = await database
    .select({ n: count() })
    .from(ads)
    .where(and(eq(ads.placementId, id), isNull(ads.deletedAt)));

  if ((placed?.n ?? 0) > 0) {
    throw new AccountError(
      `${placed!.n} ad${placed!.n === 1 ? " is" : "s are"} in "${found.title}". Move or withdraw ${placed!.n === 1 ? "it" : "them"} first.`,
      409,
    );
  }

  await database.delete(adPlacements).where(eq(adPlacements.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "ad-slot.delete",
    entity: "ad_placement",
    entityId: id,
    detail: { title: found.title },
    ip: context.ip ?? null,
  });

  return true;
}
