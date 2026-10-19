/**
 * The content pages and the announcement strip.
 *
 * Both are staff-edited rows rather than deployed files, which is how the old
 * estate worked and the right call: "advertise with us" changes more often
 * than the application does.
 */

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { announcements, pages } from "@/db/schema";

export type Page = { slug: string; title: string; body: string; updated_at: string };

export async function pageBySlug(
  siteId: number,
  slug: string,
  database: Database = db(),
): Promise<Page | null> {
  const [row] = await database
    .select()
    .from(pages)
    .where(and(eq(pages.siteId, siteId), eq(pages.slug, slug), eq(pages.visible, true)))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    slug: row.slug,
    title: row.title,
    body: row.body,
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function pageIndex(siteId: number, database: Database = db()) {
  const rows = await database
    .select({ slug: pages.slug, title: pages.title })
    .from(pages)
    .where(and(eq(pages.siteId, siteId), eq(pages.visible, true)))
    .orderBy(pages.title);

  return rows;
}

export type Announcement = { id: number; body: string; link: string | null };

/**
 * What is running right now.
 *
 * A null start means "already running" and a null end means "until further
 * notice"; the last day counts, as it does everywhere else in this codebase.
 */
export async function liveAnnouncements(
  siteId: number,
  database: Database = db(),
): Promise<Announcement[]> {
  const rows = await database
    .select()
    .from(announcements)
    .where(
      and(
        eq(announcements.siteId, siteId),
        eq(announcements.enabled, true),
        or(isNull(announcements.startsAt), sql`${announcements.startsAt} <= current_date`),
        or(isNull(announcements.endsAt), sql`${announcements.endsAt} >= current_date`),
      ),
    )
    .orderBy(desc(announcements.createdAt));

  return rows.map((row) => ({ id: row.id, body: row.body, link: row.link }));
}
