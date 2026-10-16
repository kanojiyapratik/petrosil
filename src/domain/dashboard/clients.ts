/**
 * Clients, across every brand at once.
 *
 * The screen this feeds is the one the demo sells hardest: one row per
 * person, with every brand they read or pay for, instead of up to nine
 * lookups in nine admin panels. The query shape follows from that — search
 * people, then attach their memberships, never the other way round.
 */

import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { loginAttempts, memberships, sites, users } from "@/db/schema";

export type Segment = "premium" | "trial" | "expired" | "free";

export type ClientRow = {
  id: number;
  name: string;
  email: string;
  company: string | null;
  country: string | null;
  status: string;
  member_since: string;
  last_login_at: string | null;
  brands: { slug: string; name: string; role: string; tier: string; expires_at: string | null }[];
  segment: Segment | "staff";
};

export type ClientQuery = {
  search?: string;
  site?: string;
  segment?: Segment;
  page?: number;
  perPage?: number;
};

const PER_PAGE = 25;

/**
 * One person's standing, read off their memberships: paying anywhere makes
 * them premium, otherwise a live trial, otherwise a lapsed subscription,
 * otherwise a free reader. Staff are labelled as such so they cannot be
 * mistaken for customers in a count.
 */
export function segmentOf(
  rows: { role: string; tier: string; expiresAt: string | null }[],
  today: string,
): Segment | "staff" {
  if (rows.some((row) => row.role === "superadmin" || row.role === "staff")) {
    return "staff";
  }

  const live = (row: { expiresAt: string | null }) => row.expiresAt === null || row.expiresAt >= today;

  if (rows.some((row) => row.tier === "premium" && live(row))) {
    return "premium";
  }

  if (rows.some((row) => row.tier === "trial" && live(row))) {
    return "trial";
  }

  if (rows.some((row) => row.tier === "premium" || row.tier === "trial")) {
    return "expired";
  }

  return "free";
}

export async function listClients(
  siteIds: number[],
  query: ClientQuery = {},
  database: Database = db(),
  now: Date = new Date(),
): Promise<{ rows: ClientRow[]; total: number; page: number; per_page: number }> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.trunc(query.perPage ?? PER_PAGE)));
  const today = isoDay(now);

  // Which brands this viewer may see, narrowed further if they asked for one.
  const allowed = await resolveScope(siteIds, query.site, database);

  if (allowed === null) {
    return { rows: [], total: 0, page, per_page: perPage };
  }

  const scoped = allowed.length > 0 ? inArray(memberships.siteId, allowed) : undefined;
  const search = (query.search ?? "").trim();

  const matching = search
    ? or(
        ilike(users.name, `%${search}%`),
        ilike(users.email, `%${search}%`),
        ilike(users.company, `%${search}%`),
      )
    : undefined;

  // The id list first: a person is one row however many brands they hold, so
  // paginating the join would give short pages and duplicate people.
  const base = database
    .selectDistinct({ id: users.id, name: users.name, createdAt: users.createdAt })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(scoped, matching, isNull(users.email) ? undefined : undefined));

  const found = await base.orderBy(asc(users.name)).limit(perPage).offset((page - 1) * perPage);

  const [totals] = await database
    .select({ n: sql<number>`cast(count(distinct ${users.id}) as int)` })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(scoped, matching));

  if (found.length === 0) {
    return { rows: [], total: totals?.n ?? 0, page, per_page: perPage };
  }

  const ids = found.map((row) => row.id);

  const [people, brandRows] = await Promise.all([
    database.select().from(users).where(inArray(users.id, ids)),
    database
      .select({
        userId: memberships.userId,
        slug: sites.slug,
        name: sites.name,
        siteId: sites.id,
        role: memberships.role,
        tier: memberships.tier,
        expiresAt: memberships.expiresAt,
      })
      .from(memberships)
      .innerJoin(sites, eq(sites.id, memberships.siteId))
      .where(inArray(memberships.userId, ids))
      .orderBy(sites.slug),
  ]);

  const byPerson = new Map(people.map((person) => [person.id, person]));

  const rows: ClientRow[] = [];

  for (const { id } of found) {
    const person = byPerson.get(id);

    if (!person) {
      continue;
    }

    // Only the brands this viewer may see are listed — a staff member of one
    // brand must not learn what a client pays another brand.
    const brands = brandRows.filter(
      (row) => row.userId === id && (allowed.length === 0 || allowed.includes(row.siteId)),
    );

    const segment = segmentOf(brands, today);

    if (query.segment && segment !== query.segment) {
      continue;
    }

    rows.push({
      id: person.id,
      name: person.name,
      email: person.email,
      company: person.company,
      country: person.country,
      status: person.status,
      member_since: person.createdAt.toISOString().slice(0, 10),
      last_login_at: person.lastLoginAt ? person.lastLoginAt.toISOString() : null,
      brands: brands.map((row) => ({
        slug: row.slug,
        name: row.name,
        role: row.role,
        tier: row.tier,
        expires_at: row.expiresAt,
      })),
      segment,
    });
  }

  return { rows, total: totals?.n ?? 0, page, per_page: perPage };
}

/** One client in full: the drawer the demo opens on "Manage". */
export async function clientDetail(
  siteIds: number[],
  userId: number,
  database: Database = db(),
  now: Date = new Date(),
): Promise<(ClientRow & { recent_logins: { at: string; ip: string | null; ok: boolean }[] }) | null> {
  const brandRows = await database
    .select({
      slug: sites.slug,
      name: sites.name,
      siteId: sites.id,
      role: memberships.role,
      tier: memberships.tier,
      expiresAt: memberships.expiresAt,
    })
    .from(memberships)
    .innerJoin(sites, eq(sites.id, memberships.siteId))
    .where(eq(memberships.userId, userId))
    .orderBy(sites.slug);

  const visible =
    siteIds.length === 0 ? brandRows : brandRows.filter((row) => siteIds.includes(row.siteId));

  // Not "no such person": a client of another brand is simply not this
  // viewer's to see, and the answer must not reveal that they exist.
  if (visible.length === 0) {
    return null;
  }

  const [person] = await database.select().from(users).where(eq(users.id, userId)).limit(1);

  if (!person) {
    return null;
  }

  const logins = await database
    .select()
    .from(loginAttempts)
    .where(eq(loginAttempts.userId, person.id))
    .orderBy(desc(loginAttempts.createdAt))
    .limit(10);

  return {
    id: person.id,
    name: person.name,
    email: person.email,
    company: person.company,
    country: person.country,
    status: person.status,
    member_since: person.createdAt.toISOString().slice(0, 10),
    last_login_at: person.lastLoginAt ? person.lastLoginAt.toISOString() : null,
    brands: visible.map((row) => ({
      slug: row.slug,
      name: row.name,
      role: row.role,
      tier: row.tier,
      expires_at: row.expiresAt,
    })),
    segment: segmentOf(visible, isoDay(now)),
    recent_logins: logins.map((row) => ({
      at: row.createdAt.toISOString(),
      ip: row.ip,
      ok: row.succeeded,
    })),
  };
}

/** How many people sit in each segment, for the filter chips. */
export async function segmentCounts(
  siteIds: number[],
  database: Database = db(),
  now: Date = new Date(),
): Promise<Record<Segment | "staff", number>> {
  const scoped = siteIds.length > 0 ? inArray(memberships.siteId, siteIds) : undefined;
  const today = isoDay(now);

  const rows = await database
    .select({
      userId: memberships.userId,
      role: memberships.role,
      tier: memberships.tier,
      expiresAt: memberships.expiresAt,
    })
    .from(memberships)
    .where(scoped);

  const byPerson = new Map<number, { role: string; tier: string; expiresAt: string | null }[]>();

  for (const row of rows) {
    const bucket = byPerson.get(row.userId) ?? [];
    bucket.push(row);
    byPerson.set(row.userId, bucket);
  }

  const counts: Record<Segment | "staff", number> = {
    premium: 0,
    trial: 0,
    expired: 0,
    free: 0,
    staff: 0,
  };

  for (const held of byPerson.values()) {
    counts[segmentOf(held, today)] += 1;
  }

  return counts;
}

/** Narrow the viewer's brands by the one they asked for; null means "nothing to show". */
async function resolveScope(
  siteIds: number[],
  slug: string | undefined,
  database: Database,
): Promise<number[] | null> {
  if (!slug) {
    return siteIds;
  }

  const [site] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!site) {
    return null;
  }

  if (siteIds.length > 0 && !siteIds.includes(site.id)) {
    return null;
  }

  return [site.id];
}

const isoDay = (value: Date): string =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;

export { count };
