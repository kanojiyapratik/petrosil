/**
 * Newsletters: reading an issue, writing the next one, and a test send.
 *
 * A new issue is built the way the old composer built one: the brand's
 * template, with `{articles}`, `{report}`, `{offers}` and `{impex-data}`
 * replaced by its latest published items, saved as a draft for staff to edit.
 * Three things changed on the way:
 *
 * - The old composer also filled `{premium_user}` and `{latest_user}` with the
 *   newest customers' names, companies and cities, in a mail sent to the whole
 *   list. Those placeholders are emptied, not filled.
 * - The old ad blocks (`{topbar}`, `{menuadbar}`, `{sidebar}`) pointed at
 *   image files on the old hosts; they are emptied until the file store exists.
 * - Titles are escaped. The old blocks pasted them straight into the HTML.
 *
 * Only a draft is editable. An "archived" issue — carried from an old site
 * with no record of whether it went out — and a sent one are history; to reuse
 * one, copy it into a new draft.
 */

import { and, desc, eq, isNull, lte, or } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  articles,
  auditLog,
  impexSheets,
  newsletterTemplates,
  newsletters,
  offers,
  reports,
  sites,
  users,
} from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { linkBaseFor } from "@/lib/mail/deliver";
import { requirePermission } from "@/domain/staff/permissions";
import { queueMail } from "@/lib/mail/outbox";

const allowed = (guard: Guarded, siteId: number) => guard.isSuperadmin || guard.siteIds.includes(siteId);

function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type NewsletterDetail = {
  id: number;
  siteId: number;
  site: string;
  siteName: string;
  title: string;
  body: string;
  status: string;
  template: string | null;
  sentAt: Date | null;
  recipients: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function getNewsletter(
  guard: Guarded,
  id: number,
  database: Database = db(),
): Promise<NewsletterDetail | null> {
  const [found] = await database
    .select({ issue: newsletters, slug: sites.slug, name: sites.name, template: newsletterTemplates.title })
    .from(newsletters)
    .innerJoin(sites, eq(sites.id, newsletters.siteId))
    .leftJoin(newsletterTemplates, eq(newsletterTemplates.id, newsletters.templateId))
    .where(and(eq(newsletters.id, id), isNull(newsletters.deletedAt)))
    .limit(1);

  // Another brand's issue is answered exactly like one that does not exist.
  if (!found || !allowed(guard, found.issue.siteId)) {
    return null;
  }

  const { issue } = found;

  return {
    id: issue.id,
    siteId: issue.siteId,
    site: found.slug,
    siteName: found.name,
    title: issue.title,
    body: issue.body,
    status: issue.status,
    template: found.template,
    sentAt: issue.sentAt,
    recipients: issue.recipients,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

/* ------------------------------------------------------------ composing */

const LINK = "font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;color:#0072db;text-decoration:none;";

function list(items: { title: string; href: string; note?: string }[]): string {
  if (items.length === 0) {
    return "";
  }

  const rows = items
    .map(
      (item) =>
        `<li style="margin:0 0 10px 0"><a href="${escape(item.href)}" style="${LINK}">${escape(item.title)}</a>${
          item.note ? `<br /><span style="font-size:12px;color:#999">${escape(item.note)}</span>` : ""
        }</li>`,
    )
    .join("");

  return `<ul style="padding:0;margin:0 0 30px 20px">${rows}</ul>`;
}

const day = (value: Date | null) =>
  value ? value.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : undefined;

/** The blocks a template's placeholders are replaced with, built from the brand's latest items. */
async function blocksFor(database: Database, siteId: number, linkBase: string): Promise<Record<string, string>> {
  const now = new Date();

  const [latestArticles, latestReports, latestOffers, latestImpex] = await Promise.all([
    database
      .select({ title: articles.title, slug: articles.slug, publishedAt: articles.publishedAt })
      .from(articles)
      .where(
        and(
          eq(articles.siteId, siteId),
          eq(articles.status, "published"),
          isNull(articles.deletedAt),
          // A scheduled article is not news yet.
          or(isNull(articles.publishedAt), lte(articles.publishedAt, now)),
        ),
      )
      .orderBy(desc(articles.publishedAt), desc(articles.id))
      .limit(10),
    database
      .select({ title: reports.title, slug: reports.slug })
      .from(reports)
      .where(and(eq(reports.siteId, siteId), eq(reports.status, "published"), isNull(reports.deletedAt)))
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(5),
    database
      .select({ id: offers.id, subject: offers.subject })
      .from(offers)
      .where(and(eq(offers.siteId, siteId), eq(offers.status, "published"), isNull(offers.deletedAt)))
      .orderBy(desc(offers.createdAt), desc(offers.id))
      .limit(10),
    database
      .select({ title: impexSheets.title, slug: impexSheets.slug })
      .from(impexSheets)
      .where(and(eq(impexSheets.siteId, siteId), eq(impexSheets.status, "published"), isNull(impexSheets.deletedAt)))
      .orderBy(desc(impexSheets.createdAt), desc(impexSheets.id))
      .limit(10),
  ]);

  return {
    articles: list(
      latestArticles.map((row) => ({
        title: row.title,
        href: `${linkBase}/articles/${row.slug}`,
        note: day(row.publishedAt),
      })),
    ),
    report: list(latestReports.map((row) => ({ title: row.title, href: `${linkBase}/reports/${row.slug}` }))),
    offers: list(latestOffers.map((row) => ({ title: row.subject, href: `${linkBase}/offers/${row.id}` }))),
    "impex-data": list(latestImpex.map((row) => ({ title: row.title, href: `${linkBase}/impex/${row.slug}` }))),
  };
}

export type Made = { ok: true; id: number } | { ok: false; message: string };

export async function composeNewsletter(
  guard: Guarded,
  input: { site: string; templateId: number; title?: string },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<Made> {
  const [found] = await database
    .select({ template: newsletterTemplates, site: sites })
    .from(newsletterTemplates)
    .innerJoin(sites, eq(sites.id, newsletterTemplates.siteId))
    .where(eq(newsletterTemplates.id, input.templateId))
    .limit(1);

  if (!found || found.site.slug !== input.site || !allowed(guard, found.site.id)) {
    return { ok: false, message: "Choose one of this brand's templates." };
  }

  await requirePermission(guard, found.site.id, "newsletter-create", database);

  const blocks = await blocksFor(database, found.site.id, linkBaseFor({ slug: found.site.slug, domain: found.site.legacyDomain }));

  // Every placeholder goes: the four with content are filled, and the rest —
  // the customer lists, the ad slots — are emptied rather than sent as typed.
  const body = found.template.body.replace(/\{([a-z_-]+)\}/g, (_whole, name: string) => blocks[name] ?? "");

  const title =
    input.title?.trim() ||
    `${found.site.name} newsletter, ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;

  const [made] = await database
    .insert(newsletters)
    .values({ siteId: found.site.id, templateId: found.template.id, title: title.slice(0, 255), body, status: "draft" })
    .returning({ id: newsletters.id });

  await database.insert(auditLog).values({
    siteId: found.site.id,
    userId: guard.identity.user.id,
    action: "newsletter.compose",
    entity: "newsletter",
    entityId: made!.id,
    detail: { template: found.template.title },
    ip: context.ip ?? null,
  });

  return { ok: true, id: made!.id };
}

export async function copyNewsletter(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<Made> {
  const original = await getNewsletter(guard, id, database);

  if (!original) {
    return { ok: false, message: "That issue is not yours to copy." };
  }

  await requirePermission(guard, original.siteId, "newsletter-create", database);

  const [source] = await database.select().from(newsletters).where(eq(newsletters.id, id)).limit(1);

  const [made] = await database
    .insert(newsletters)
    .values({
      siteId: source!.siteId,
      templateId: source!.templateId,
      title: `${original.title} (copy)`.slice(0, 255),
      body: original.body,
      status: "draft",
    })
    .returning({ id: newsletters.id });

  await database.insert(auditLog).values({
    siteId: source!.siteId,
    userId: guard.identity.user.id,
    action: "newsletter.copy",
    entity: "newsletter",
    entityId: made!.id,
    detail: { from: id },
    ip: context.ip ?? null,
  });

  return { ok: true, id: made!.id };
}

/* -------------------------------------------------------------- editing */

export type Saved = { ok: true } | { ok: false; message: string; field?: string };

export async function saveNewsletter(
  guard: Guarded,
  input: { id: number; title: string; body: string },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<Saved> {
  const title = String(input.title ?? "").trim();
  const body = String(input.body ?? "").trim();

  if (title === "") {
    return { ok: false, message: "An issue needs a title.", field: "title" };
  }

  if (body === "") {
    return { ok: false, message: "An issue needs something in it.", field: "body" };
  }

  const existing = await getNewsletter(guard, input.id, database);

  if (!existing) {
    return { ok: false, message: "That issue is not yours to change." };
  }

  await requirePermission(guard, existing.siteId, "newsletter-edit", database);

  if (existing.status !== "draft") {
    return {
      ok: false,
      message: "Only a draft can be edited. Copy this issue into a new draft to reuse it.",
    };
  }

  await database
    .update(newsletters)
    .set({ title: title.slice(0, 255), body, updatedAt: new Date() })
    .where(eq(newsletters.id, input.id));

  await database.insert(auditLog).values({
    userId: guard.identity.user.id,
    action: "newsletter.save",
    entity: "newsletter",
    entityId: input.id,
    detail: { title: title.slice(0, 120) },
    ip: context.ip ?? null,
  });

  return { ok: true };
}

/* ------------------------------------------------------------ test send */

/**
 * Queue the issue to whoever asked, so they see it in a real inbox before it
 * goes anywhere else. It leaves with the next run of the mail job.
 */
export async function sendTestNewsletter(
  guard: Guarded,
  id: number,
  database: Database = db(),
): Promise<{ ok: true; to: string } | { ok: false; message: string }> {
  const issue = await getNewsletter(guard, id, database);

  if (!issue) {
    return { ok: false, message: "That issue is not yours to send." };
  }

  await requirePermission(guard, issue.siteId, "newsletter-edit", database);

  const [me] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, guard.identity.user.id))
    .limit(1);

  if (!me) {
    return { ok: false, message: "Your account has no email address to send to." };
  }

  const [site] = await database.select({ id: sites.id }).from(sites).where(eq(sites.slug, issue.site)).limit(1);

  await queueMail(
    {
      to: me.email,
      subject: `[Test] ${issue.title}`,
      template: "newsletter_test",
      payload: { html: issue.body, newsletter: issue.id },
      siteId: site?.id ?? null,
      userId: guard.identity.user.id,
    },
    database,
  );

  return { ok: true, to: me.email };
}
