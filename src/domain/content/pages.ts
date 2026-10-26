/**
 * The content pages and the announcement strip.
 *
 * Both are staff-edited rows rather than deployed files, which is how the old
 * estate worked and the right call: "advertise with us" changes more often
 * than the application does.
 */

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { announcements, auditLog, pages, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { requirePermission } from "@/domain/staff/permissions";

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

/* ----------------------------------------- writing the announcement strip */

export type AnnouncementInput = {
  id?: number | null;
  site: string;
  body: string;
  link?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  enabled?: boolean;
};

export type AnnouncementSaved =
  | { ok: true; id: number }
  | { ok: false; id?: number; message: string; field?: string };

/** An empty date field means "no bound", not the epoch. */
function day(value: unknown): string | null {
  const text = String(value ?? "").trim();

  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * Save a notice, new or existing.
 *
 * Two rules the old schema had no way to express.
 *
 * A notice with nothing to say is refused: `body` is the whole strip, and a
 * blank one renders an empty bar on the brand site.
 *
 * A window whose end is before its start is refused. The old table allowed
 * it, and the result is indistinguishable from a notice nobody ever wrote —
 * invisible, with no complaint anywhere to lead you back to the typo. Both
 * ends open is fine and means "running, until further notice", which is how
 * `liveAnnouncements` already reads it.
 *
 * The brand is checked against the grant, and so is the id on an edit: a
 * notice belonging to a brand this viewer cannot see is refused even when
 * they name it directly.
 */
export async function saveAnnouncement(
  guard: Guarded,
  input: AnnouncementInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<AnnouncementSaved> {
  const body = String(input.body ?? "").trim();

  if (body === "") {
    return { ok: false, message: "Give the notice something to say.", field: "body" };
  }

  const startsAt = day(input.starts_at);
  const endsAt = day(input.ends_at);

  if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
    return {
      ok: false,
      message: "That window ends before it starts, so the notice would never show.",
      field: "ends_at",
    };
  }

  const [brand] = await database
    .select()
    .from(sites)
    .where(eq(sites.slug, String(input.site ?? "")))
    .limit(1);

  if (!brand || (!guard.isSuperadmin && !guard.siteIds.includes(brand.id))) {
    return { ok: false, message: "That brand is not yours to post to.", field: "site" };
  }

  await requirePermission(guard, brand.id, typeof input.id === "number" ? "announcement-edit" : "announcement-create", database);

  const values = {
    siteId: brand.id,
    body: body.slice(0, 2000),
    link: String(input.link ?? "").trim().slice(0, 512) || null,
    startsAt,
    endsAt,
    enabled: input.enabled !== false,
  };

  let id = typeof input.id === "number" ? input.id : null;

  if (id !== null) {
    const [existing] = await database
      .select()
      .from(announcements)
      .where(eq(announcements.id, id))
      .limit(1);

    // Naming an id does not grant access to it: another brand's notice is
    // refused here exactly as its brand would have been above.
    if (
      !existing ||
      (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))
    ) {
      return { ok: false, message: "That notice is not yours to change.", field: "id" };
    }

    await database.update(announcements).set(values).where(eq(announcements.id, id));
  } else {
    const [made] = await database.insert(announcements).values(values).returning();

    id = made!.id;
  }

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "announcement.save",
    entity: "announcement",
    entityId: id,
    detail: { body: values.body.slice(0, 120), enabled: values.enabled },
    ip: context.ip ?? null,
  });

  return { ok: true, id };
}

/**
 * Take a notice off the site.
 *
 * Deleted outright, unlike an article: a strip is a sentence with a date on
 * it, not twenty years of writing, and nothing links to one.
 */
export async function removeAnnouncement(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const [found] = await database
    .select()
    .from(announcements)
    .where(eq(announcements.id, id))
    .limit(1);

  if (!found || (!guard.isSuperadmin && !guard.siteIds.includes(found.siteId))) {
    return false;
  }

  await requirePermission(guard, found.siteId, "announcement-delete", database);

  await database.delete(announcements).where(eq(announcements.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "announcement.remove",
    entity: "announcement",
    entityId: id,
    detail: { body: found.body.slice(0, 120) },
    ip: context.ip ?? null,
  });

  return true;
}
