/**
 * The team's side of the tables the platform already had.
 *
 * Content pages, the announcement strip, the plan catalogue, coupons,
 * transactions, article categories, the staff list and the crawler's watch
 * list. Each of these existed in all nine PHP admins, one brand at a time;
 * here each is one screen across the estate, scoped by `siteIds` exactly as
 * every other dashboard query is.
 *
 * Only transactions pages, because only transactions grows without bound.
 * The rest are short by nature and short in fact: 117 content pages across
 * the estate, 39 categories, 66 plans, a handful of coupons, four watched
 * URLs.
 */

import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  announcements,
  articleCategories,
  articles,
  coupons,
  memberships,
  orders,
  pages,
  payments,
  planPrices,
  plans,
  priceCrawlActivities,
  priceCrawlUrls,
  sites,
  users,
} from "@/db/schema";
import { statusLabel } from "@/domain/crawl/urls";
import { isoDay, siteScope } from "./scope";

/* --------------------------------------------------------------- content */

export type StaffPage = {
  id: number;
  site: string;
  site_name: string;
  slug: string;
  title: string;
  visible: boolean;
  words: number;
  updated_at: string;
};

export async function staffPages(
  siteIds: number[],
  query: { site?: string } = {},
  database: Database = db(),
): Promise<StaffPage[]> {
  const only = await siteScope(siteIds, query.site, database);

  const rows = await database
    .select({ page: pages, slug: sites.slug, name: sites.name })
    .from(pages)
    .innerJoin(sites, eq(sites.id, pages.siteId))
    .where(only ? inArray(pages.siteId, only) : undefined)
    .orderBy(asc(sites.slug), asc(pages.title));

  return rows.map(({ page, slug, name }) => ({
    id: page.id,
    site: slug,
    site_name: name,
    slug: page.slug,
    title: page.title,
    visible: page.visible,
    words: page.body.trim() === "" ? 0 : page.body.trim().split(/\s+/).length,
    updated_at: page.updatedAt.toISOString(),
  }));
}

export type StaffAnnouncement = {
  id: number;
  site: string;
  site_name: string;
  body: string;
  link: string | null;
  starts_at: string | null;
  ends_at: string | null;
  enabled: boolean;
  /** Showing on the brand site right now — the only thing anyone wants to know. */
  live: boolean;
};

export async function listAnnouncements(
  siteIds: number[],
  query: { site?: string } = {},
  database: Database = db(),
  now: Date = new Date(),
): Promise<StaffAnnouncement[]> {
  const only = await siteScope(siteIds, query.site, database);
  const today = isoDay(now);

  const rows = await database
    .select({ strip: announcements, slug: sites.slug, name: sites.name })
    .from(announcements)
    .innerJoin(sites, eq(sites.id, announcements.siteId))
    .where(only ? inArray(announcements.siteId, only) : undefined)
    .orderBy(asc(sites.slug), desc(announcements.createdAt));

  return rows.map(({ strip, slug, name }) => ({
    id: strip.id,
    site: slug,
    site_name: name,
    body: strip.body,
    link: strip.link,
    starts_at: strip.startsAt,
    ends_at: strip.endsAt,
    enabled: strip.enabled,
    // A null start means "already running", a null end "until further
    // notice", and the last day counts — as everywhere else in this codebase.
    live:
      strip.enabled &&
      (strip.startsAt === null || strip.startsAt <= today) &&
      (strip.endsAt === null || strip.endsAt >= today),
  }));
}

export type StaffCategory = {
  id: number;
  site: string;
  site_name: string;
  slug: string;
  name: string;
  sort_order: number;
  articles: number;
};

export async function listCategories(
  siteIds: number[],
  query: { site?: string } = {},
  database: Database = db(),
): Promise<StaffCategory[]> {
  const only = await siteScope(siteIds, query.site, database);

  const rows = await database
    .select({
      category: articleCategories,
      slug: sites.slug,
      name: sites.name,
      filed: sql<number>`count(${articles.id})`,
    })
    .from(articleCategories)
    .innerJoin(sites, eq(sites.id, articleCategories.siteId))
    .leftJoin(
      articles,
      and(eq(articles.categoryId, articleCategories.id), isNull(articles.deletedAt)),
    )
    .where(only ? inArray(articleCategories.siteId, only) : undefined)
    .groupBy(articleCategories.id, sites.slug, sites.name)
    .orderBy(asc(sites.slug), asc(articleCategories.sortOrder), asc(articleCategories.name));

  return rows.map(({ category, slug, name, filed }) => ({
    id: category.id,
    site: slug,
    site_name: name,
    slug: category.slug,
    name: category.name,
    sort_order: category.sortOrder,
    articles: Number(filed),
  }));
}

/* ----------------------------------------------------------------- money */

export type StaffPlan = {
  id: number;
  site: string;
  site_name: string;
  code: string;
  name: string;
  description: string | null;
  currency: string;
  visible: boolean;
  sort_order: number;
  terms: { years: number; amount: number }[];
  /** Orders actually paid. A pending order has sold nothing. */
  sold: number;
};

export async function listPlans(
  siteIds: number[],
  query: { site?: string } = {},
  database: Database = db(),
): Promise<StaffPlan[]> {
  const only = await siteScope(siteIds, query.site, database);

  const rows = await database
    .select({ plan: plans, slug: sites.slug, name: sites.name })
    .from(plans)
    .innerJoin(sites, eq(sites.id, plans.siteId))
    .where(only ? inArray(plans.siteId, only) : undefined)
    .orderBy(asc(sites.slug), asc(plans.sortOrder), asc(plans.name));

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.plan.id);

  const terms = await database
    .select()
    .from(planPrices)
    .where(inArray(planPrices.planId, ids))
    .orderBy(asc(planPrices.years));

  const sold = await database
    .select({ planId: orders.planId, n: sql<number>`count(*)` })
    .from(orders)
    .where(and(inArray(orders.planId, ids), eq(orders.status, "paid")))
    .groupBy(orders.planId);

  const byPlan = new Map<number, { years: number; amount: number }[]>();

  for (const term of terms) {
    const list = byPlan.get(term.planId) ?? [];
    list.push({ years: term.years, amount: Number(term.amount) });
    byPlan.set(term.planId, list);
  }

  const counts = new Map(sold.map((row) => [row.planId, Number(row.n)]));

  return rows.map(({ plan, slug, name }) => ({
    id: plan.id,
    site: slug,
    site_name: name,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    currency: plan.currency,
    visible: plan.visible,
    sort_order: plan.sortOrder,
    terms: byPlan.get(plan.id) ?? [],
    sold: counts.get(plan.id) ?? 0,
  }));
}

export type CouponState = "live" | "off" | "expired" | "used up" | "scheduled";

export type StaffCoupon = {
  id: number;
  site: string | null;
  code: string;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  max_redemptions: number | null;
  redeemed: number;
  starts_at: string | null;
  expires_at: string | null;
  enabled: boolean;
  state: CouponState;
};

export async function listCoupons(
  siteIds: number[],
  database: Database = db(),
  now: Date = new Date(),
): Promise<StaffCoupon[]> {
  const today = isoDay(now);

  const rows = await database
    .select({ coupon: coupons, slug: sites.slug })
    .from(coupons)
    .leftJoin(sites, eq(sites.id, coupons.siteId))
    .orderBy(asc(coupons.code));

  // A coupon with no brand works everywhere, so staff see it even though it
  // is not scoped to them; one belonging to a brand they cannot see is not
  // theirs to read.
  const visible = rows.filter(
    ({ coupon }) =>
      coupon.siteId === null || siteIds.length === 0 || siteIds.includes(coupon.siteId),
  );

  return visible.map(({ coupon, slug }) => ({
    id: coupon.id,
    site: slug,
    code: coupon.code,
    percent_off: coupon.percentOff,
    amount_off: coupon.amountOff === null ? null : Number(coupon.amountOff),
    currency: coupon.currency,
    max_redemptions: coupon.maxRedemptions,
    redeemed: coupon.redeemed,
    starts_at: coupon.startsAt,
    expires_at: coupon.expiresAt,
    enabled: coupon.enabled,
    state: couponState(coupon, today),
  }));
}

/**
 * Why a code is not working, in the order the team asks it.
 *
 * Switched off first, because that is the deliberate act; then expired, then
 * spent, then not started. "Enabled" alone was what the old screen showed,
 * which is why "but the coupon is active" was a recurring support thread.
 */
function couponState(
  coupon: {
    enabled: boolean;
    startsAt: string | null;
    expiresAt: string | null;
    maxRedemptions: number | null;
    redeemed: number;
  },
  today: string,
): CouponState {
  if (!coupon.enabled) {
    return "off";
  }

  if (coupon.expiresAt !== null && coupon.expiresAt < today) {
    return "expired";
  }

  if (coupon.maxRedemptions !== null && coupon.redeemed >= coupon.maxRedemptions) {
    return "used up";
  }

  if (coupon.startsAt !== null && coupon.startsAt > today) {
    return "scheduled";
  }

  return "live";
}

export type Transaction = {
  id: number;
  site: string;
  site_name: string;
  user_id: number;
  who: string;
  email: string;
  plan_name: string;
  years: number;
  currency: string;
  list_amount: number;
  discount: number;
  amount: number;
  coupon_code: string | null;
  status: string;
  provider: string;
  provider_payment_id: string | null;
  granted_until: string | null;
  attempts: number;
  created_at: string;
  paid_at: string | null;
};

const PER_PAGE = 25;

export async function listTransactions(
  siteIds: number[],
  query: { site?: string; status?: string; page?: number; perPage?: number } = {},
  database: Database = db(),
): Promise<{ rows: Transaction[]; total: number; page: number; per_page: number }> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.trunc(query.perPage ?? PER_PAGE)));
  const only = await siteScope(siteIds, query.site, database);

  const where = and(
    only ? inArray(orders.siteId, only) : undefined,
    query.status ? eq(orders.status, query.status) : undefined,
  );

  const [totals] = await database
    .select({ n: sql<number>`count(*)` })
    .from(orders)
    .where(where);

  const rows = await database
    .select({
      order: orders,
      slug: sites.slug,
      name: sites.name,
      who: users.name,
      email: users.email,
      attempts: sql<number>`(select count(*) from ${payments} where ${payments.orderId} = ${orders.id})`,
    })
    .from(orders)
    .innerJoin(sites, eq(sites.id, orders.siteId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return {
    rows: rows.map(({ order, slug, name, who, email, attempts }) => ({
      id: order.id,
      site: slug,
      site_name: name,
      user_id: order.userId,
      who,
      email,
      plan_name: order.planName,
      years: order.years,
      currency: order.currency,
      list_amount: Number(order.listAmount),
      discount: Number(order.discount),
      amount: Number(order.amount),
      coupon_code: order.couponCode,
      status: order.status,
      provider: order.provider,
      provider_payment_id: order.providerPaymentId,
      granted_until: order.grantedUntil,
      attempts: Number(attempts),
      created_at: order.createdAt.toISOString(),
      paid_at: order.paidAt ? order.paidAt.toISOString() : null,
    })),
    total: Number(totals?.n ?? 0),
    page,
    per_page: perPage,
  };
}

/* ----------------------------------------------------------------- team */

export type StaffMember = {
  id: number;
  name: string;
  email: string;
  status: string;
  last_login_at: string | null;
  superadmin: boolean;
  brands: { slug: string; name: string; role: string }[];
};

/**
 * Who can get into the admin.
 *
 * A superadmin has no brand list worth showing — they see everything — so
 * the flag carries that and the brands are the grants that actually narrow
 * someone. Readers are excluded: a subscriber is not staff.
 */
export async function listStaff(
  siteIds: number[],
  database: Database = db(),
): Promise<StaffMember[]> {
  const rows = await database
    .select({
      user: users,
      role: memberships.role,
      siteId: memberships.siteId,
      slug: sites.slug,
      name: sites.name,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(sites, eq(sites.id, memberships.siteId))
    .where(inArray(memberships.role, ["staff", "superadmin"]))
    .orderBy(asc(users.name), asc(sites.slug));

  const byUser = new Map<number, StaffMember>();

  for (const row of rows) {
    // Someone whose only grants are on brands this viewer cannot see is not
    // theirs to list — except a superadmin, who is estate-wide by definition.
    const mine =
      row.role === "superadmin" || siteIds.length === 0 || siteIds.includes(row.siteId);

    if (!mine) {
      continue;
    }

    const existing = byUser.get(row.user.id);

    const member: StaffMember =
      existing ??
      {
        id: row.user.id,
        name: row.user.name,
        email: row.user.email,
        status: row.user.status,
        last_login_at: row.user.lastLoginAt ? row.user.lastLoginAt.toISOString() : null,
        superadmin: false,
        brands: [],
      };

    if (row.role === "superadmin") {
      member.superadmin = true;
    } else {
      member.brands.push({ slug: row.slug, name: row.name, role: row.role });
    }

    byUser.set(row.user.id, member);
  }

  return [...byUser.values()];
}

/* ------------------------------------------------------------- crawler */

export type WatchedUrl = {
  id: number;
  site: string;
  site_name: string;
  url: string;
  label: string | null;
  enabled: boolean;
  last_status: string | null;
  status_label: string;
  last_error: string | null;
  last_row_count: number;
  last_checked_at: string | null;
  last_changed_at: string | null;
  findings: number;
};

export async function listWatchedUrls(
  siteIds: number[],
  query: { site?: string } = {},
  database: Database = db(),
): Promise<WatchedUrl[]> {
  const only = await siteScope(siteIds, query.site, database);

  const rows = await database
    .select({
      watched: priceCrawlUrls,
      slug: sites.slug,
      name: sites.name,
      findings: sql<number>`(select count(*) from ${priceCrawlActivities} where ${priceCrawlActivities.urlId} = ${priceCrawlUrls.id})`,
    })
    .from(priceCrawlUrls)
    .innerJoin(sites, eq(sites.id, priceCrawlUrls.siteId))
    .where(only ? inArray(priceCrawlUrls.siteId, only) : undefined)
    .orderBy(asc(sites.slug), asc(priceCrawlUrls.sortOrder), asc(priceCrawlUrls.id));

  return rows.map(({ watched, slug, name, findings }) => ({
    id: watched.id,
    site: slug,
    site_name: name,
    url: watched.url,
    label: watched.label,
    enabled: watched.enabled,
    last_status: watched.lastStatus,
    status_label: statusLabel(watched.lastStatus),
    last_error: watched.lastError,
    last_row_count: watched.lastRowCount,
    last_checked_at: watched.lastCheckedAt ? watched.lastCheckedAt.toISOString() : null,
    last_changed_at: watched.lastChangedAt ? watched.lastChangedAt.toISOString() : null,
    findings: Number(findings),
  }));
}

export type ArticleTally = { all: number; published: number; draft: number; withdrawn: number };

/**
 * How many articles sit in each state, for the filter chips.
 *
 * A count, not a `length`: the list screen shows 200 of 93,000 and the chips
 * sitting above it were counting the 200. It takes the same search the chips
 * are next to, because a count that ignores the filter beside it is worse
 * than no count.
 */
export async function articleTally(
  siteIds: number[],
  query: { site?: string; search?: string } = {},
  database: Database = db(),
): Promise<ArticleTally> {
  const only = await siteScope(siteIds, query.site, database);

  const [row] = await database
    .select({
      all: sql<number>`count(*)`,
      published: sql<number>`count(*) filter (where ${articles.status} = 'published')`,
      draft: sql<number>`count(*) filter (where ${articles.status} = 'draft')`,
      withdrawn: sql<number>`count(*) filter (where ${articles.status} = 'withdrawn')`,
    })
    .from(articles)
    .where(
      and(
        isNull(articles.deletedAt),
        only ? inArray(articles.siteId, only) : undefined,
        query.search ? ilike(articles.title, `%${query.search}%`) : undefined,
      ),
    );

  return {
    all: Number(row?.all ?? 0),
    published: Number(row?.published ?? 0),
    draft: Number(row?.draft ?? 0),
    withdrawn: Number(row?.withdrawn ?? 0),
  };
}
