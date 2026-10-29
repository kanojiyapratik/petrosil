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
import { auditLog, loginAttempts, memberships, sites, users } from "@/db/schema";

/**
 * The lists the old admin's Directory menu names. A lapsed trial and a
 * lapsed subscription are separate screens there -- it queries them as
 * `premium = 3` with a past date against `premium = 2` -- and separate
 * jobs for whoever chases them, so they are separate here.
 */
export type Segment = "premium" | "trial" | "expired" | "trial_expired" | "free";

export type ClientRow = {
  id: number;
  name: string;
  email: string;
  company: string | null;
  country: string | null;
  /* Filled from the old `profiles` table, which is where the customer record
   * actually lived: `users.country` and `users.city` are empty on every row
   * in the estate. Carried 2026-10-23. */
  designation?: string | null;
  city?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  postcode?: string | null;
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
  /**
   * Days: narrows to standings that run out inside that many days from now.
   * This is what the old admin's "Upcoming Renewal" claims to be and is not
   * -- it routes to `premium = 1` with no date filter, the same set as
   * Premium Users. An open-ended standing is never due.
   */
  due?: number;
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

  // Lapsed, and which kind matters. A lapsed subscription outranks a lapsed
  // trial: they once paid, which is the whole reason that list is opened.
  if (rows.some((row) => row.tier === "premium")) {
    return "expired";
  }

  if (rows.some((row) => row.tier === "trial")) {
    return "trial_expired";
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
    ? or(ilike(users.name, `%${search}%`), ilike(users.email, `%${search}%`), ilike(users.company, `%${search}%`))
    : undefined;

  // Standing and "due" are judged over the person's memberships in scope,
  // so they are filters on the group, applied before the page is cut. They
  // used to be applied to the 25 people already on the page: page one of an
  // alphabetical list rarely held a paying reader, so "Premium" showed
  // nobody while the count still read every person.
  const live = sql`(${memberships.expiresAt} is null or ${memberships.expiresAt} >= ${today})`;
  const standing = sql<string>`case
    when bool_or(${memberships.role} in ('superadmin', 'staff')) then 'staff'
    when bool_or(${memberships.tier} = 'premium' and ${live}) then 'premium'
    when bool_or(${memberships.tier} = 'trial' and ${live}) then 'trial'
    when bool_or(${memberships.tier} = 'premium') then 'expired'
    when bool_or(${memberships.tier} = 'trial') then 'trial_expired'
    else 'free' end`;
  const cutoff = query.due !== undefined ? isoDay(new Date(now.getTime() + query.due * 86_400_000)) : null;
  const having = and(
    query.segment ? sql`${standing} = ${query.segment}` : undefined,
    // Inside the window and not already past it; no end date is never due.
    cutoff
      ? sql`bool_or(${memberships.expiresAt} is not null and ${memberships.expiresAt} >= ${today} and ${memberships.expiresAt} <= ${cutoff})`
      : undefined,
  );

  // The id list first: a person is one row however many brands they hold, so
  // paginating the join would give short pages and duplicate people.
  // A function, not one builder: drizzle builders change in place, and the
  // page limit added for the list must not reach the count.
  const people = () =>
    database
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(and(scoped, matching))
      .groupBy(users.id, users.name)
      .having(having);

  const found = await people()
    .orderBy(asc(users.name))
    .limit(perPage)
    .offset((page - 1) * perPage);

  const [totals] = await database.select({ n: sql<number>`cast(count(*) as int)` }).from(people().as("people"));

  if (found.length === 0) {
    return { rows: [], total: totals?.n ?? 0, page, per_page: perPage };
  }

  const ids = found.map((row) => row.id);

  const [details, brandRows] = await Promise.all([
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

  const byPerson = new Map(details.map((person) => [person.id, person]));

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

  const visible = siteIds.length === 0 ? brandRows : brandRows.filter((row) => siteIds.includes(row.siteId));

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
    designation: person.designation,
    city: person.city,
    phone: person.phone,
    website: person.website,
    address: person.address,
    postcode: person.postcode,
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
    trial_expired: 0,
    free: 0,
    staff: 0,
  };

  for (const held of byPerson.values()) {
    counts[segmentOf(held, today)] += 1;
  }

  return counts;
}

/**
 * Change what a client gets on one brand: their tier, when it runs out, or
 * whether the account works at all.
 *
 * This is the "extend access" and "approve trial" the team does by hand
 * today, and the reason the audit trail exists — an access change with no
 * record of who made it is the thing nobody could answer afterwards.
 */
export async function updateMembership(
  siteIds: number[],
  userId: number,
  slug: string,
  change: { tier?: string; expires_at?: string | null; status?: string },
  actor: { userId: number; ip?: string | null },
  database: Database = db(),
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid" }> {
  const [site] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!site || (siteIds.length > 0 && !siteIds.includes(site.id))) {
    return { ok: false, reason: "not_found" };
  }

  const [existing] = await database
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.siteId, site.id)))
    .limit(1);

  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  if (change.tier !== undefined && !["free", "premium", "trial"].includes(change.tier)) {
    return { ok: false, reason: "invalid" };
  }

  if (change.status !== undefined && !["active", "disabled"].includes(change.status)) {
    return { ok: false, reason: "invalid" };
  }

  if (change.expires_at !== undefined && change.expires_at !== null && !/^\d{4}-\d{2}-\d{2}$/.test(change.expires_at)) {
    return { ok: false, reason: "invalid" };
  }

  // Role is NOT settable here. Granting staff access is a different decision
  // from selling a subscription, and mixing them into one endpoint is how a
  // client-support screen ends up able to make someone an administrator.
  const values: Partial<typeof memberships.$inferInsert> = { updatedAt: new Date() };

  if (change.tier !== undefined) {
    values.tier = change.tier;
    // A tier set by hand is a decision, not a lapse.
    values.lapsedFrom = null;
  }

  if (change.expires_at !== undefined) {
    values.expiresAt = change.expires_at;
  }

  if (Object.keys(values).length > 1) {
    await database.update(memberships).set(values).where(eq(memberships.id, existing.id));
  }

  if (change.status !== undefined) {
    // The account is one person across every brand, so this is estate-wide
    // by nature — recorded against the brand whose screen made the change.
    await database.update(users).set({ status: change.status, updatedAt: new Date() }).where(eq(users.id, userId));
  }

  await database.insert(auditLog).values({
    siteId: site.id,
    userId: actor.userId,
    action: "client.update",
    entity: "membership",
    entityId: existing.id,
    detail: {
      client: userId,
      was: { tier: existing.tier, expires_at: existing.expiresAt },
      now: { tier: values.tier ?? existing.tier, expires_at: values.expiresAt ?? existing.expiresAt },
      ...(change.status === undefined ? {} : { status: change.status }),
    },
    ip: actor.ip ?? null,
  });

  return { ok: true };
}

/** Narrow the viewer's brands by the one they asked for; null means "nothing to show". */
async function resolveScope(siteIds: number[], slug: string | undefined, database: Database): Promise<number[] | null> {
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
