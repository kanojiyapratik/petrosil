/**
 * Ads and newsletters — the two things the estate sends outward.
 *
 * `live` on an ad is computed from today's date rather than read off the
 * enabled flag, for the same reason it is on an announcement: the old screen
 * showed "Published" for an ad whose end date was in 2021, and the slot
 * looked sold when it was empty.
 */

import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { adPlacements, ads, newsletterTemplates, newsletters, sites } from "@/db/schema";
import { isoDay, paging, siteScope, type Paged } from "./scope";

export type Placement = {
  id: number;
  site: string;
  site_name: string;
  title: string;
  enabled: boolean;
  ads: number;
  /** Of those, how many are actually running today. */
  live: number;
};

export async function listPlacements(
  siteIds: number[],
  query: { site?: string } = {},
  database: Database = db(),
  now: Date = new Date(),
): Promise<Placement[]> {
  const only = await siteScope(siteIds, query.site, database);
  const today = isoDay(now);

  const rows = await database
    .select({ slot: adPlacements, slug: sites.slug, name: sites.name })
    .from(adPlacements)
    .innerJoin(sites, eq(sites.id, adPlacements.siteId))
    .where(only ? inArray(adPlacements.siteId, only) : undefined)
    .orderBy(asc(sites.slug), asc(adPlacements.title));

  if (rows.length === 0) {
    return [];
  }

  const counts = await database
    .select({
      placementId: ads.placementId,
      total: sql<number>`count(*)`,
      live: sql<number>`count(*) filter (
        where ${ads.enabled}
          and (${ads.startsAt} is null or ${ads.startsAt} <= ${today})
          and (${ads.endsAt} is null or ${ads.endsAt} >= ${today})
      )`,
    })
    .from(ads)
    .where(
      and(
        isNull(ads.deletedAt),
        inArray(
          ads.placementId,
          rows.map((row) => row.slot.id),
        ),
      ),
    )
    .groupBy(ads.placementId);

  const byPlacement = new Map(
    counts.map((row) => [row.placementId, { total: Number(row.total), live: Number(row.live) }]),
  );

  return rows.map(({ slot, slug, name }) => ({
    id: slot.id,
    site: slug,
    site_name: name,
    title: slot.title,
    enabled: slot.enabled,
    ads: byPlacement.get(slot.id)?.total ?? 0,
    live: byPlacement.get(slot.id)?.live ?? 0,
  }));
}

export type AdRow = {
  id: number;
  site: string;
  site_name: string;
  placement: string | null;
  title: string;
  ad_type: string;
  url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  enabled: boolean;
  live: boolean;
  clicks: number;
  on_dashboard: boolean;
  on_newsletter: boolean;
};

export async function listAds(
  siteIds: number[],
  query: { site?: string; placement?: number } = {},
  database: Database = db(),
  now: Date = new Date(),
): Promise<AdRow[]> {
  const only = await siteScope(siteIds, query.site, database);
  const today = isoDay(now);

  const rows = await database
    .select({
      ad: ads,
      slug: sites.slug,
      name: sites.name,
      placement: adPlacements.title,
    })
    .from(ads)
    .innerJoin(sites, eq(sites.id, ads.siteId))
    .leftJoin(adPlacements, eq(adPlacements.id, ads.placementId))
    .where(
      and(
        isNull(ads.deletedAt),
        only ? inArray(ads.siteId, only) : undefined,
        query.placement ? eq(ads.placementId, query.placement) : undefined,
      ),
    )
    .orderBy(asc(sites.slug), asc(adPlacements.title), asc(ads.sortOrder), asc(ads.id));

  return rows.map(({ ad, slug, name, placement }) => ({
    id: ad.id,
    site: slug,
    site_name: name,
    placement,
    title: ad.title,
    ad_type: ad.adType,
    url: ad.url,
    starts_at: ad.startsAt,
    ends_at: ad.endsAt,
    enabled: ad.enabled,
    live:
      ad.enabled &&
      (ad.startsAt === null || ad.startsAt <= today) &&
      (ad.endsAt === null || ad.endsAt >= today),
    clicks: ad.clicks,
    on_dashboard: ad.onDashboard,
    on_newsletter: ad.onNewsletter,
  }));
}

export type TemplateRow = {
  id: number;
  site: string;
  site_name: string;
  title: string;
  enabled: boolean;
  used_by: number;
  updated_at: string;
};

export async function listTemplates(
  siteIds: number[],
  query: { site?: string } = {},
  database: Database = db(),
): Promise<TemplateRow[]> {
  const only = await siteScope(siteIds, query.site, database);

  const rows = await database
    .select({
      template: newsletterTemplates,
      slug: sites.slug,
      name: sites.name,
      used: sql<number>`(select count(*) from ${newsletters} where ${newsletters.templateId} = ${newsletterTemplates.id})`,
    })
    .from(newsletterTemplates)
    .innerJoin(sites, eq(sites.id, newsletterTemplates.siteId))
    .where(only ? inArray(newsletterTemplates.siteId, only) : undefined)
    .orderBy(asc(sites.slug), asc(newsletterTemplates.title));

  return rows.map(({ template, slug, name, used }) => ({
    id: template.id,
    site: slug,
    site_name: name,
    title: template.title,
    enabled: template.enabled,
    used_by: Number(used),
    updated_at: template.updatedAt.toISOString(),
  }));
}

export type NewsletterRow = {
  id: number;
  site: string;
  site_name: string;
  title: string;
  template: string | null;
  status: string;
  scheduled_for: string | null;
  sent_at: string | null;
  recipients: number;
  created_at: string;
};

export async function listNewsletters(
  siteIds: number[],
  query: { site?: string; status?: string; q?: string; page?: number; perPage?: number } = {},
  database: Database = db(),
): Promise<Paged<NewsletterRow>> {
  const only = await siteScope(siteIds, query.site, database);
  const { page, perPage, offset } = paging(query);

  const where = and(
    isNull(newsletters.deletedAt),
    only ? inArray(newsletters.siteId, only) : undefined,
    query.status ? eq(newsletters.status, query.status) : undefined,
    // Words in the title, any case. Escaped so a % typed into the box is a
    // percent sign, not a wildcard.
    query.q?.trim()
      ? ilike(newsletters.title, `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      : undefined,
  );

  const [totals] = await database
    .select({ n: sql<number>`count(*)` })
    .from(newsletters)
    .where(where);

  const rows = await database
    .select({
      issue: newsletters,
      slug: sites.slug,
      name: sites.name,
      template: newsletterTemplates.title,
    })
    .from(newsletters)
    .innerJoin(sites, eq(sites.id, newsletters.siteId))
    .leftJoin(newsletterTemplates, eq(newsletterTemplates.id, newsletters.templateId))
    .where(where)
    .orderBy(desc(newsletters.createdAt), desc(newsletters.id))
    .limit(perPage)
    .offset(offset);

  return {
    rows: rows.map(({ issue, slug, name, template }) => ({
      id: issue.id,
      site: slug,
      site_name: name,
      title: issue.title,
      template,
      status: issue.status,
      scheduled_for: issue.scheduledFor ? issue.scheduledFor.toISOString() : null,
      sent_at: issue.sentAt ? issue.sentAt.toISOString() : null,
      recipients: issue.recipients,
      created_at: issue.createdAt.toISOString(),
    })),
    total: Number(totals?.n ?? 0),
    page,
    per_page: perPage,
  };
}
