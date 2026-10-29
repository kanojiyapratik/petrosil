/**
 * The three things a brand site publishes besides prices and articles:
 * reports, trade offers and impex sheets.
 *
 * All three were separate Laravel tables with the same shape and the same
 * `publish_options` column holding "Published" or "Premium" — the paywall as
 * a string. Here the paywall is `status`, and all three list the same way
 * because the team does the same thing with them: find one, see whether it
 * is public, see how many people opened it.
 */

import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { impexSheets, offers, reports, sites, users } from "@/db/schema";
import { paging, siteScope, type Paged } from "./scope";

export type ReportRow = {
  id: number;
  site: string;
  site_name: string;
  slug: string;
  title: string;
  report_type: string;
  status: string;
  file: string | null;
  authored_on: string | null;
  clicks: number;
  created_at: string;
};

export async function listReports(
  siteIds: number[],
  query: { site?: string; status?: string; type?: string; search?: string; page?: number; perPage?: number } = {},
  database: Database = db(),
): Promise<Paged<ReportRow>> {
  const only = await siteScope(siteIds, query.site, database);
  const { page, perPage, offset } = paging(query);

  const where = and(
    isNull(reports.deletedAt),
    only ? inArray(reports.siteId, only) : undefined,
    query.status ? eq(reports.status, query.status) : undefined,
    query.type ? eq(reports.reportType, query.type) : undefined,
    query.search ? ilike(reports.title, `%${query.search}%`) : undefined,
  );

  const [totals] = await database.select({ n: sql<number>`count(*)` }).from(reports).where(where);

  const rows = await database
    .select({ report: reports, slug: sites.slug, name: sites.name })
    .from(reports)
    .innerJoin(sites, eq(sites.id, reports.siteId))
    .where(where)
    // Undated rows last: Postgres sorts nulls first in a descending order.
    .orderBy(sql`${reports.authoredOn} desc nulls last`, desc(reports.id))
    .limit(perPage)
    .offset(offset);

  return {
    rows: rows.map(({ report, slug, name }) => ({
      id: report.id,
      site: slug,
      site_name: name,
      slug: report.slug,
      title: report.title,
      report_type: report.reportType,
      status: report.status,
      file: report.file,
      authored_on: report.authoredOn,
      clicks: report.clicks,
      created_at: report.createdAt.toISOString(),
    })),
    total: Number(totals?.n ?? 0),
    page,
    per_page: perPage,
  };
}

export type OfferRow = {
  id: number;
  site: string;
  site_name: string;
  subject: string;
  offer_type: string;
  company_name: string | null;
  contact_person: string | null;
  contact_email: string | null;
  country: string | null;
  offer_value: string | null;
  status: string;
  clicks: number;
  posted_by: string | null;
  created_at: string;
};

export async function listOffers(
  siteIds: number[],
  query: {
    site?: string;
    type?: string;
    status?: string;
    search?: string;
    page?: number;
    perPage?: number;
  } = {},
  database: Database = db(),
): Promise<Paged<OfferRow>> {
  const only = await siteScope(siteIds, query.site, database);
  const { page, perPage, offset } = paging(query);

  const where = and(
    isNull(offers.deletedAt),
    only ? inArray(offers.siteId, only) : undefined,
    query.type ? eq(offers.offerType, query.type) : undefined,
    query.status ? eq(offers.status, query.status) : undefined,
    query.search
      ? or(
          ilike(offers.subject, `%${query.search}%`),
          ilike(offers.companyName, `%${query.search}%`),
          ilike(offers.keywords, `%${query.search}%`),
        )
      : undefined,
  );

  const [totals] = await database.select({ n: sql<number>`count(*)` }).from(offers).where(where);

  const rows = await database
    .select({ offer: offers, slug: sites.slug, name: sites.name, who: users.name })
    .from(offers)
    .innerJoin(sites, eq(sites.id, offers.siteId))
    .leftJoin(users, eq(users.id, offers.userId))
    .where(where)
    .orderBy(desc(offers.createdAt), desc(offers.id))
    .limit(perPage)
    .offset(offset);

  return {
    rows: rows.map(({ offer, slug, name, who }) => ({
      id: offer.id,
      site: slug,
      site_name: name,
      subject: offer.subject,
      offer_type: offer.offerType,
      company_name: offer.companyName,
      contact_person: offer.contactPerson,
      contact_email: offer.contactEmail,
      country: offer.country,
      offer_value: offer.offerValue,
      status: offer.status,
      clicks: offer.clicks,
      posted_by: who,
      created_at: offer.createdAt.toISOString(),
    })),
    total: Number(totals?.n ?? 0),
    page,
    per_page: perPage,
  };
}

export type ImpexRow = {
  id: number;
  site: string;
  site_name: string;
  slug: string;
  title: string;
  file: string | null;
  status: string;
  authored_on: string | null;
  clicks: number;
  created_at: string;
};

export async function listImpex(
  siteIds: number[],
  query: { site?: string; status?: string; search?: string; page?: number; perPage?: number } = {},
  database: Database = db(),
): Promise<Paged<ImpexRow>> {
  const only = await siteScope(siteIds, query.site, database);
  const { page, perPage, offset } = paging(query);

  const where = and(
    isNull(impexSheets.deletedAt),
    only ? inArray(impexSheets.siteId, only) : undefined,
    query.status ? eq(impexSheets.status, query.status) : undefined,
    query.search ? ilike(impexSheets.title, `%${query.search}%`) : undefined,
  );

  const [totals] = await database
    .select({ n: sql<number>`count(*)` })
    .from(impexSheets)
    .where(where);

  const rows = await database
    .select({ sheet: impexSheets, slug: sites.slug, name: sites.name })
    .from(impexSheets)
    .innerJoin(sites, eq(sites.id, impexSheets.siteId))
    .where(where)
    .orderBy(sql`${impexSheets.authoredOn} desc nulls last`, desc(impexSheets.id))
    .limit(perPage)
    .offset(offset);

  return {
    rows: rows.map(({ sheet, slug, name }) => ({
      id: sheet.id,
      site: slug,
      site_name: name,
      slug: sheet.slug,
      title: sheet.title,
      file: sheet.file,
      status: sheet.status,
      authored_on: sheet.authoredOn,
      clicks: sheet.clicks,
      created_at: sheet.createdAt.toISOString(),
    })),
    total: Number(totals?.n ?? 0),
    page,
    per_page: perPage,
  };
}
