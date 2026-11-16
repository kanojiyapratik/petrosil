/**
 * Who is off a brand's newsletter, for staff to see and change.
 *
 * Readers take themselves off with the link in every copy ("link"). Staff can
 * take someone off by hand, say after a request by email or phone ("staff").
 * Putting someone back is allowed for either kind, but it is the one change
 * that makes mail reach a person who asked for none, so it needs the right to
 * send newsletters, and every change is in the audit log.
 */

import { and, desc, eq, ilike, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, memberships, newsletterOptOuts, sites, users } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { requirePermission } from "@/domain/staff/permissions";

export const OPT_OUT_SOURCES = { link: "Used the link", staff: "Taken off by staff" } as const;

const PER_PAGE = 50;

const allowed = (guard: Guarded, siteId: number) => guard.isSuperadmin || guard.siteIds.includes(siteId);

async function brand(guard: Guarded, slug: string, database: Database) {
  const [site] = await database.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.slug, slug)).limit(1);

  return site && allowed(guard, site.id) ? site : null;
}

export type OptOutRow = {
  id: number;
  email: string;
  source: string;
  createdAt: string;
  /** The member with this address on this brand, when there is one. */
  name: string | null;
  userId: number | null;
};

export type OptOutPage = { siteId: number; rows: OptOutRow[]; total: number; page: number; perPage: number };

export async function listOptOuts(
  guard: Guarded,
  input: { site: string; q?: string; source?: string; page?: number },
  database: Database = db(),
): Promise<OptOutPage | null> {
  const site = await brand(guard, input.site, database);

  if (!site) {
    return null;
  }

  await requirePermission(guard, site.id, "newsletter-list", database);

  const where = and(
    eq(newsletterOptOuts.siteId, site.id),
    input.q?.trim() ? ilike(newsletterOptOuts.email, `%${input.q.trim()}%`) : undefined,
    input.source && input.source in OPT_OUT_SOURCES ? eq(newsletterOptOuts.source, input.source) : undefined,
  );

  const page = Math.max(1, input.page ?? 1);

  const [rows, [counted]] = await Promise.all([
    database
      .select({
        id: newsletterOptOuts.id,
        email: newsletterOptOuts.email,
        source: newsletterOptOuts.source,
        createdAt: newsletterOptOuts.createdAt,
        // The brand's own member with this address, if any: a name is easier to recognise.
        name: sql<string | null>`(select u.name from ${users} u join ${memberships} m on m.user_id = u.id and m.site_id = ${site.id} where lower(u.email) = newsletter_opt_outs.email limit 1)`,
        userId: sql<number | null>`(select u.id from ${users} u join ${memberships} m on m.user_id = u.id and m.site_id = ${site.id} where lower(u.email) = newsletter_opt_outs.email limit 1)`,
      })
      .from(newsletterOptOuts)
      .where(where)
      .orderBy(desc(newsletterOptOuts.createdAt), desc(newsletterOptOuts.id))
      .limit(PER_PAGE)
      .offset((page - 1) * PER_PAGE),
    database.select({ n: sql<number>`count(*)::int` }).from(newsletterOptOuts).where(where),
  ]);

  return {
    siteId: site.id,
    rows: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), name: row.name || null })),
    total: counted?.n ?? 0,
    page,
    perPage: PER_PAGE,
  };
}

export type OptOutChanged = { ok: true; message: string } | { ok: false; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Take an address off the brand's newsletter by hand. */
export async function addOptOut(
  guard: Guarded,
  input: { site: string; email: string },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<OptOutChanged> {
  const site = await brand(guard, input.site, database);

  if (!site) {
    return { ok: false, message: "That brand is not yours to change." };
  }

  await requirePermission(guard, site.id, "newsletter-edit", database);

  const email = input.email.trim().toLowerCase();

  if (!EMAIL.test(email) || email.length > 191) {
    return { ok: false, message: "Type the email address to take off, like name@company.com." };
  }

  const [added] = await database
    .insert(newsletterOptOuts)
    .values({ siteId: site.id, email, source: "staff" })
    .onConflictDoNothing()
    .returning({ id: newsletterOptOuts.id });

  if (!added) {
    return { ok: false, message: `${email} is already off the ${site.name} newsletter.` };
  }

  await database.insert(auditLog).values({
    siteId: site.id,
    userId: guard.identity.user.id,
    action: "newsletter.opt_out",
    entity: "newsletter_opt_out",
    entityId: added.id,
    detail: { email },
    ip: context.ip ?? null,
  });

  return { ok: true, message: `${email} will get no more ${site.name} newsletters.` };
}

/** Put an address back on the brand's newsletter. */
export async function removeOptOut(
  guard: Guarded,
  input: { site: string; id: number },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<OptOutChanged> {
  const site = await brand(guard, input.site, database);

  if (!site) {
    return { ok: false, message: "That brand is not yours to change." };
  }

  await requirePermission(guard, site.id, "newsletter-send", database);

  const [removed] = await database
    .delete(newsletterOptOuts)
    .where(and(eq(newsletterOptOuts.id, input.id), eq(newsletterOptOuts.siteId, site.id)))
    .returning({ id: newsletterOptOuts.id, email: newsletterOptOuts.email, source: newsletterOptOuts.source });

  if (!removed) {
    return { ok: false, message: "That address is no longer on the list." };
  }

  await database.insert(auditLog).values({
    siteId: site.id,
    userId: guard.identity.user.id,
    action: "newsletter.opt_in",
    entity: "newsletter_opt_out",
    entityId: removed.id,
    detail: { email: removed.email, was: removed.source },
    ip: context.ip ?? null,
  });

  return { ok: true, message: `${removed.email} is back on the ${site.name} newsletter.` };
}
