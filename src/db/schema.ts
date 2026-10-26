/**
 * The platform's schema.
 *
 * Two rules run through all of it.
 *
 * 1. Every row that belongs to a brand carries `siteId`. The nine PHP sites
 *    kept nine databases; one database with a tenant column replaces them, and
 *    every query must be scoped. There is no "global" content table.
 * 2. The semantics of the old schema are ported, not its shape. Laravel's
 *    audit columns (submittedby/modifiedby/deletedby plus three IP columns on
 *    nearly every table) become one `audit_log`; the zero dates, the missing
 *    unique index on users.email and the MyISAM absence of foreign keys are
 *    fixed here rather than carried forward.
 *
 * What is NOT negotiable is the price shape: `prices` holds one numeric price
 * per (location, date), because that is what the sites publish and what the
 * compat API has to keep speaking to the Python module.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ sites */

export const sites = pgTable(
  "sites",
  {
    id: serial("id").primaryKey(),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    /** The domain this brand used to live on, kept for redirects and for copy. */
    legacyDomain: varchar("legacy_domain", { length: 191 }),
    /** Brand colour and anything else purely presentational. */
    theme: jsonb("theme").$type<Record<string, string>>().default({}).notNull(),
    defaultCurrency: varchar("default_currency", { length: 3 }).default("USD").notNull(),
    /** Free text: "weekly, Friday", "1st & 16th". Used to judge price freshness. */
    priceCadence: varchar("price_cadence", { length: 64 }),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex("sites_slug_unique").on(t.slug),
  }),
);

/**
 * Bearer tokens for the compat API. One site can hold several (rotation), and
 * only the hash is stored: the plaintext is shown once, when it is minted.
 * The Laravel sites kept `users.api_token` in clear text and one leaked into a
 * seed file; that precedent is the reason for hashing here.
 */
export const siteApiTokens = pgTable(
  "site_api_tokens",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 191 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    hashUnique: uniqueIndex("site_api_tokens_hash_unique").on(t.tokenHash),
    bySite: index("site_api_tokens_site_idx").on(t.siteId),
  }),
);

/* ------------------------------------------------------- people and access */

/**
 * One person, one row, however many brands they read or pay for. In the old
 * estate the same human had up to nine accounts with nine passwords.
 */
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 191 }).notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /** bcrypt. Laravel's `$2y$` hashes verify unchanged, which is what makes the migration possible. */
    passwordHash: varchar("password_hash", { length: 191 }),
    name: varchar("name", { length: 191 }).notNull(),
    company: varchar("company", { length: 191 }),
    designation: varchar("designation", { length: 191 }),
    phone: varchar("phone", { length: 64 }),
    country: varchar("country", { length: 96 }),
    city: varchar("city", { length: 96 }),
    website: varchar("website", { length: 191 }),
    /**
     * From the old `profiles` table, which is where the customer record
     * actually lived -- `users.country` is empty on all 16,589 baseoil rows
     * while `profiles.country_id` is set on 16,200 of them. The address is
     * filled on 91%, and a trade directory without one is not a directory.
     */
    address: text("address"),
    postcode: varchar("postcode", { length: 32 }),
    status: varchar("status", { length: 24 }).default("active").notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The Laravel users table had no unique index and duplicate emails exist;
    // they are merged at migration time and cannot come back.
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
  }),
);

/**
 * What a person is on a given brand. `superadmin` and `staff` are team roles,
 * `subscriber` is a reader; `tier` ("free" | "premium" | "trial") is what the
 * paywall reads, and `expiresAt` is what the nightly sweep looks at.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 24 }).default("subscriber").notNull(),
    /**
     * A named role on top of the three built-in ones, when the team wants a
     * narrower grant than "staff". Optional on purpose: the built-in role is
     * what the code checks, and a row in a table cannot grant a capability
     * nothing looks for.
     */
    roleId: integer("role_id"),
    tier: varchar("tier", { length: 24 }).default("free").notNull(),
    expiresAt: date("expires_at"),
    /**
     * What a lapsed member held before the sweep made them free — "premium"
     * or "trial" — so the right "your access has ended" mail goes out. Set
     * only by the sweep; any other change of tier clears it.
     */
    lapsedFrom: varchar("lapsed_from", { length: 24 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    oneRowPerUserPerSite: uniqueIndex("memberships_user_site_unique").on(t.userId, t.siteId),
    bySite: index("memberships_site_idx").on(t.siteId),
  }),
);

/**
 * A signed-in person.
 *
 * Opaque random tokens, stored only as a SHA-256, handed out in an httpOnly
 * cookie — the same reasoning as the API tokens. A stolen database row cannot
 * be replayed as a session, and signing out revokes server-side rather than
 * hoping the browser drops a self-contained JWT.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    userAgent: varchar("user_agent", { length: 255 }),
    ip: varchar("ip", { length: 64 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    hashUnique: uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    byUser: index("sessions_user_idx").on(t.userId),
  }),
);

/**
 * Every sign-in attempt, good or bad.
 *
 * Two jobs: the throttle that stops someone working through 112,000 migrated
 * accounts with a password list, and the login log the admin screens show —
 * which the old sites kept in `loginlogs` and the team actually reads.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 191 }).notNull(),
    ip: varchar("ip", { length: 64 }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    succeeded: boolean("succeeded").notNull(),
    reason: varchar("reason", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byEmail: index("login_attempts_email_idx").on(t.email, t.createdAt),
    byIp: index("login_attempts_ip_idx").on(t.ip, t.createdAt),
  }),
);

/* ----------------------------------------------------- locations and prices */

export const locations = pgTable(
  "locations",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 191 }).notNull(),
    currency: varchar("currency", { length: 3 }),
    unit: varchar("unit", { length: 32 }),
    /** `locations.show_on_dashboard` in the old schema: present but not published. */
    visible: boolean("visible").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Two locations on one brand may not share a title: that is what made
    // name resolution ambiguous on the old sites, and the resolver still
    // reports AMBIGUOUS defensively, but new data cannot create the case.
    titlePerSite: uniqueIndex("locations_site_title_unique").on(t.siteId, t.title),
    bySite: index("locations_site_idx").on(t.siteId),
  }),
);

/**
 * A published price. One numeric figure per location and date — the shape the
 * brand sites publish and the compat API returns. Ranges (min/max) live in the
 * price module and are not stored here; the module sends the single figure it
 * wants published.
 */
export const prices = pgTable(
  "prices",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    price: numeric("price", { precision: 14, scale: 4 }).notNull(),
    currency: varchar("currency", { length: 3 }),
    priceDate: date("price_date").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The old table had ~6,500 soft-deleted duplicates of (location, date) and
    // no constraint. Live rows are unique here; history that was deleted stays
    // deleted and does not block the index.
    oneLivePerLocationPerDate: uniqueIndex("prices_location_date_live_unique")
      .on(t.locationId, t.priceDate)
      .where(sql`deleted_at is null`),
    bySiteDate: index("prices_site_date_idx").on(t.siteId, t.priceDate),
  }),
);

/* --------------------------------------------------------------- batches */

/** Where a batch's rows came from. Values match the Laravel sites exactly. */
export const BATCH_SOURCES = ["upload", "bulk_edit", "api", "crawl", "editorial"] as const;
export const BATCH_STATUSES = ["draft", "committed", "rolled_back", "discarded"] as const;

/**
 * Item statuses, with the meaning the module and its tests rely on:
 *   new        no live price for that location and date — will be inserted
 *   changed    a live price exists and differs — will be updated
 *   unchanged  a live price exists and matches — nothing to do
 *   locked     the date has passed and a price is already published there
 *   ambiguous  the name matched more than one location
 *   unmatched  the name matched none
 *   invalid    the price or the date could not be read
 *   conflict   the live row moved after staging; found at commit time
 */
export const ITEM_STATUSES = [
  "changed",
  "new",
  "unchanged",
  "locked",
  "ambiguous",
  "unmatched",
  "invalid",
  "conflict",
] as const;

export type BatchSource = (typeof BATCH_SOURCES)[number];
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const priceBatches = pgTable(
  "price_batches",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 24 }).$type<BatchSource>().notNull(),
    status: varchar("status", { length: 24 }).$type<BatchStatus>().default("draft").notNull(),
    createdBy: integer("created_by").references(() => users.id),
    committedBy: integer("committed_by").references(() => users.id),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("price_batches_site_idx").on(t.siteId, t.id),
  }),
);

export const priceBatchItems = pgTable(
  "price_batch_items",
  {
    id: serial("id").primaryKey(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => priceBatches.id, { onDelete: "cascade" }),
    /** The name exactly as the caller sent it, kept even once resolved. */
    rawLocation: varchar("raw_location", { length: 191 }).notNull(),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "set null" }),
    /** The live row this item was diffed against, if there was one. */
    priceId: integer("price_id").references(() => prices.id, { onDelete: "set null" }),
    priceDate: date("price_date").notNull(),
    oldPrice: numeric("old_price", { precision: 14, scale: 4 }),
    newPrice: numeric("new_price", { precision: 14, scale: 4 }).notNull(),
    currency: varchar("currency", { length: 3 }),
    status: varchar("status", { length: 24 }).$type<ItemStatus>().notNull(),
    isIncluded: boolean("is_included").default(true).notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byBatch: index("price_batch_items_batch_idx").on(t.batchId, t.id),
  }),
);

/** The plain-English note the module's AI writes about a published update. */
export const priceSummaries = pgTable(
  "price_summaries",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    priceBatchId: integer("price_batch_id").references(() => priceBatches.id, {
      onDelete: "set null",
    }),
    source: varchar("source", { length: 32 }).default("editorial").notNull(),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("price_summaries_site_idx").on(t.siteId, t.createdAt),
  }),
);

/* ---------------------------------------------------------------- crawler */

export const priceCrawlUrls = pgTable(
  "price_crawl_urls",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    label: varchar("label", { length: 191 }),
    enabled: boolean("enabled").default(true).notNull(),
    /** Validators from the last fetch, so most checks can end in a 304. */
    etag: varchar("etag", { length: 191 }),
    lastModified: varchar("last_modified", { length: 191 }),
    contentHash: varchar("content_hash", { length: 64 }),
    lastStatus: varchar("last_status", { length: 24 }),
    lastError: text("last_error"),
    lastNotes: text("last_notes"),
    lastRowCount: integer("last_row_count").default(0).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("price_crawl_urls_site_idx").on(t.siteId, t.id),
  }),
);

export const priceCrawlActivities = pgTable(
  "price_crawl_activities",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    urlId: integer("url_id").references(() => priceCrawlUrls.id, { onDelete: "cascade" }),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "set null" }),
    /** The name as the page gave it, which may not resolve to a location. */
    location: varchar("location", { length: 191 }).notNull(),
    price: numeric("price", { precision: 14, scale: 4 }),
    priceDate: date("price_date"),
    previousPrice: numeric("previous_price", { precision: 14, scale: 4 }),
    /** What this site held for that location and date when the finding arrived. */
    sitePrice: numeric("site_price", { precision: 14, scale: 4 }),
    changeType: varchar("change_type", { length: 24 }),
    changePct: numeric("change_pct", { precision: 10, scale: 4 }),
    differsFromSite: boolean("differs_from_site").default(false).notNull(),
    stagedBatchId: integer("staged_batch_id").references(() => priceBatches.id, {
      onDelete: "set null",
    }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("price_crawl_activities_site_idx").on(t.siteId, t.detectedAt),
  }),
);

/** Per-site crawler settings that are not per-URL. */
export const siteCrawlSettings = pgTable("site_crawl_settings", {
  siteId: integer("site_id")
    .primaryKey()
    .references(() => sites.id, { onDelete: "cascade" }),
  intervalMinutes: integer("interval_minutes").default(15).notNull(),
  /** What the module's model is told to look for on these pages. */
  instructions: text("instructions"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/* ---------------------------------------------------------------- content */

export const articleCategories = pgTable(
  "article_categories",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 191 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugPerSite: uniqueIndex("article_categories_site_slug_unique").on(t.siteId, t.slug),
  }),
);

/**
 * An article. 119,000 of them across the estate, so the published-list query
 * is the one to keep honest: `(site_id, status, published_at)` is the index it
 * reads, and the body is never selected for a list.
 *
 * `premiumOnly` is per article, not per brand: the old sites paywalled some
 * analysis and left the news open, and that mix is a selling point rather
 * than an accident.
 */
export const articles = pgTable(
  "articles",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => articleCategories.id, {
      onDelete: "set null",
    }),
    slug: varchar("slug", { length: 191 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    /** Shown to everyone, including on a locked article: it is the hook. */
    excerpt: text("excerpt"),
    body: text("body").notNull(),
    heroImage: varchar("hero_image", { length: 512 }),
    status: varchar("status", { length: 24 }).default("draft").notNull(),
    premiumOnly: boolean("premium_only").default(false).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
    views: integer("views").default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugPerSite: uniqueIndex("articles_site_slug_unique").on(t.siteId, t.slug),
    published: index("articles_site_status_idx").on(t.siteId, t.status, t.publishedAt),
  }),
);

/**
 * The DB-backed content pages — about, methodology, advertise, terms. Fourteen
 * per site in the dumps, edited by staff rather than deployed.
 */
export const pages = pgTable(
  "pages",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 191 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    visible: boolean("visible").default(true).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugPerSite: uniqueIndex("pages_site_slug_unique").on(t.siteId, t.slug),
  }),
);

/** The strip across the top of a brand site, with a window it shows in. */
export const announcements = pgTable(
  "announcements",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    link: varchar("link", { length: 512 }),
    startsAt: date("starts_at"),
    endsAt: date("ends_at"),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("announcements_site_idx").on(t.siteId, t.enabled),
  }),
);

/* ------------------------------------------------------------------ money */

/**
 * What a brand sells.
 *
 * The old sites kept `subscriptions` (the plan) and `subscription_users` (who
 * bought one) in one place and multi-year pricing in a second table reached
 * through `getPrice/{plan_id}/{year}`. The split is kept, because a plan
 * priced for one, two and three years is the shape the estate actually sells,
 * but the money is `numeric` here rather than the old float columns.
 */
export const plans = pgTable(
  "plans",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 191 }).notNull(),
    description: text("description"),
    currency: varchar("currency", { length: 3 }).default("USD").notNull(),
    /** Hidden plans still honour the orders already placed against them. */
    visible: boolean("visible").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codePerSite: uniqueIndex("plans_site_code_unique").on(t.siteId, t.code),
  }),
);

/** One row per term a plan can be bought for: 1 year, 2 years, 3 years. */
export const planPrices = pgTable(
  "plan_prices",
  {
    id: serial("id").primaryKey(),
    planId: integer("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    years: integer("years").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    termPerPlan: uniqueIndex("plan_prices_plan_years_unique").on(t.planId, t.years),
  }),
);

/**
 * A discount code.
 *
 * `redeemed` is a counter on the row rather than a count over orders, so the
 * cap can be enforced in the same statement that spends it — two people
 * holding the last redemption of a code must not both get it.
 */
export const coupons = pgTable(
  "coupons",
  {
    id: serial("id").primaryKey(),
    /** Null means it works on every brand. */
    siteId: integer("site_id").references(() => sites.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 64 }).notNull(),
    percentOff: integer("percent_off"),
    amountOff: numeric("amount_off", { precision: 12, scale: 2 }),
    currency: varchar("currency", { length: 3 }),
    maxRedemptions: integer("max_redemptions"),
    redeemed: integer("redeemed").default(0).notNull(),
    startsAt: date("starts_at"),
    expiresAt: date("expires_at"),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Stored upper-cased, matched upper-cased: "WELCOME10" and "welcome10"
    // are one code, which is how people actually type them.
    codeUnique: uniqueIndex("coupons_code_unique").on(t.code),
  }),
);

export const ORDER_STATUSES = ["pending", "paid", "failed", "cancelled"] as const;

/**
 * An order.
 *
 * The amounts are written by the server from the plan and the coupon, never
 * read from the request. The old checkout posted the price it had been shown
 * and the controller trusted it.
 */
export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: integer("plan_id").references(() => plans.id, { onDelete: "set null" }),
    /** Copied, not joined: a plan renamed next year must not rewrite an invoice. */
    planName: varchar("plan_name", { length: 191 }).notNull(),
    years: integer("years").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    listAmount: numeric("list_amount", { precision: 12, scale: 2 }).notNull(),
    discount: numeric("discount", { precision: 12, scale: 2 }).default("0").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    couponId: integer("coupon_id").references(() => coupons.id, { onDelete: "set null" }),
    couponCode: varchar("coupon_code", { length: 64 }),
    status: varchar("status", { length: 24 }).default("pending").notNull(),
    /** "razorpay" | "coupon" (nothing left to pay) | "manual" (staff marked it paid). */
    provider: varchar("provider", { length: 32 }).default("razorpay").notNull(),
    providerOrderId: varchar("provider_order_id", { length: 191 }),
    providerPaymentId: varchar("provider_payment_id", { length: 191 }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** What the membership's expiry became, so an invoice can state the term it bought. */
    grantedUntil: date("granted_until"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byUser: index("orders_user_idx").on(t.userId, t.createdAt),
    bySite: index("orders_site_idx").on(t.siteId, t.status),
    providerOrderUnique: uniqueIndex("orders_provider_order_unique").on(t.providerOrderId),
  }),
);

/**
 * Every attempt to settle an order, successful or not — the old admin's
 * "transaction" screen. Kept separate from `orders` because a failed attempt
 * followed by a successful one is two records and one order.
 */
export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerPaymentId: varchar("provider_payment_id", { length: 191 }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrder: index("payments_order_idx").on(t.orderId, t.createdAt),
  }),
);

/**
 * A free-trial request, which staff approve. The old sites had `freetrial` →
 * `freeTrialRequest` and an admin who granted it by editing the user row;
 * the decision is a record here, because "who gave them a trial" was asked.
 */
export const trialRequests = pgTable(
  "trial_requests",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 24 }).default("pending").notNull(),
    note: text("note"),
    days: integer("days").default(14).notNull(),
    decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("trial_requests_site_idx").on(t.siteId, t.status),
    byUser: index("trial_requests_user_idx").on(t.userId),
  }),
);

/* ------------------------------------- one-shot links, and the mail that carries them */

/**
 * A single-use link: confirm an address, or set a new password.
 *
 * Only the SHA-256 is stored, for the same reason as sessions and API tokens
 * — a leaked table must not be a bag of working password-reset links. The
 * plaintext exists for exactly as long as it takes to put it in an email.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which brand the person was on when they asked, so the mail can be branded. */
    siteId: integer("site_id").references(() => sites.id, { onDelete: "set null" }),
    /** "verify_email" | "reset_password". Checked on use: a confirmation link must not set a password. */
    purpose: varchar("purpose", { length: 32 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    hashUnique: uniqueIndex("auth_tokens_hash_unique").on(t.tokenHash),
    byUser: index("auth_tokens_user_idx").on(t.userId, t.purpose),
  }),
);

/**
 * Mail waiting to go out.
 *
 * Writing the row and sending it are deliberately separate. The estate's
 * credentials live in the old sites' settings table (Brevo, SendGrid, SMTP)
 * and are not ours to use yet, so nothing here talks to a mail server: a
 * registration queues its verification mail and the endpoint answers. When a
 * sender is wired up it drains this table, and the newsletter and
 * report-mailing screens the old admin had will queue into the same place.
 *
 * It doubles as the record of what was sent to whom, which is what the old
 * `sent_emails` table was for.
 */
export const mailOutbox = pgTable(
  "mail_outbox",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id").references(() => sites.id, { onDelete: "set null" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Named `recipient` in the database: `to` is a reserved word. */
    to: varchar("recipient", { length: 191 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    template: varchar("template", { length: 64 }).notNull(),
    /** Everything the template needs, including any one-shot link. */
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    /**
     * Not before this. A claimed row is pushed forward as a lease, so a
     * worker that dies mid-send hands the mail back instead of stranding it;
     * a failed one is pushed forward by the retry delay.
     */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Given up on: the reason is in `error`. */
    failedAt: timestamp("failed_at", { withTimezone: true }),
    error: text("error"),
    /** The provider's id for the message, for tracing a delivery complaint. */
    providerMessageId: varchar("provider_message_id", { length: 191 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The sender's query: unsent, not given up on, due, oldest first.
    pending: index("mail_outbox_pending_idx").on(t.sentAt, t.failedAt, t.nextAttemptAt, t.id),
    byUser: index("mail_outbox_user_idx").on(t.userId),
  }),
);

/* ---------------------------------------------------------- system mails */

/**
 * The mails the system sends on its own — welcome, trial and renewal
 * reminders, sample reports — one set per brand, written and edited by staff.
 * The old `mails` table, keyed by what the mail is for instead of by the
 * numeric id the old code hard-wired. `variant` carries the old regional
 * pairs ("asia" and "default" for subscription details and sample reports).
 * `{name}`-style placeholders are filled at delivery.
 */
export const mailTemplates = pgTable(
  "mail_templates",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 48 }).notNull(),
    variant: varchar("variant", { length: 16 }).default("default").notNull(),
    title: varchar("title", { length: 191 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    body: text("body").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    onePerKey: uniqueIndex("mail_templates_site_key_variant_unique").on(t.siteId, t.key, t.variant),
  }),
);

/**
 * Every expiry reminder queued, so a re-run — a forced job, a restart in the
 * middle of a tick — cannot send the same one twice. The unique index is the
 * guarantee; the job inserts here first and queues only what it inserted.
 */
export const membershipReminders = pgTable(
  "membership_reminders",
  {
    id: serial("id").primaryKey(),
    membershipId: integer("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    /** The template key: trial-expiring, subscription-expired, … */
    kind: varchar("kind", { length: 48 }).notNull(),
    expiresAt: date("expires_at").notNull(),
    /** Days before (expiring) or after (expired) the end. */
    days: integer("days").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex("membership_reminders_once").on(t.membershipId, t.kind, t.expiresAt, t.days),
  }),
);

/* -------------------------------------------------------------- enquiries */

/**
 * A member writing to a company in the directory ("company"), replying to an
 * offer ("offer"), or asking about a plan ("plan"). The old sites kept these in
 * `messages` (with no sender: who wrote was only in the mail) and
 * `subscription_contacts`, and had no screen for either.
 *
 * The sender is copied onto the row as well as linked, so the enquiry still
 * says who wrote it after an account is deleted or renamed. `about` is the
 * company's name, the offer's subject or the plan's name, kept as text for
 * the same reason — and because carried offer replies cannot always be tied
 * back to their offer.
 *
 * `status`: "new" | "handled" | "archived" (carried from an old site, which
 * never recorded whether anyone dealt with it).
 */
export const enquiries = pgTable(
  "enquiries",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).default("new").notNull(),
    fromUserId: integer("from_user_id").references(() => users.id, { onDelete: "set null" }),
    fromName: varchar("from_name", { length: 191 }),
    fromEmail: varchar("from_email", { length: 191 }),
    fromPhone: varchar("from_phone", { length: 64 }),
    fromCompany: varchar("from_company", { length: 191 }),
    toUserId: integer("to_user_id").references(() => users.id, { onDelete: "set null" }),
    offerId: integer("offer_id").references(() => offers.id, { onDelete: "set null" }),
    planId: integer("plan_id").references(() => plans.id, { onDelete: "set null" }),
    about: varchar("about", { length: 255 }),
    subject: varchar("subject", { length: 255 }),
    message: text("message").notNull(),
    /** Plan enquiries: years, members and the price quoted at the time. */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    handledBy: integer("handled_by").references(() => users.id, { onDelete: "set null" }),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    inbox: index("enquiries_site_status_idx").on(t.siteId, t.status, t.createdAt),
    bySender: index("enquiries_from_idx").on(t.fromUserId, t.createdAt),
  }),
);

/* -------------------------------------------------------- scheduled jobs */

/**
 * One row per background job: when it last started, how it ended, what it
 * reported. The row is also the lock — an instance runs a job only after an
 * UPDATE that moves `last_started_at` past the due time succeeds, so two
 * instances ticking together cannot both run it.
 */
export const scheduledJobs = pgTable("scheduled_jobs", {
  name: varchar("name", { length: 64 }).primaryKey(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  /** "running" | "ok" | "failed" */
  lastStatus: varchar("last_status", { length: 16 }),
  lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
  lastError: text("last_error"),
  runs: integer("runs").default(0).notNull(),
});

/* ------------------------------------------------------------- audit trail */

/**
 * One log instead of audit columns on forty tables. Every write that a human
 * or a token causes lands here with the brand it belonged to — the old console
 * once had an id-only cross-site bug, so site_id is part of every record.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id").references(() => sites.id, { onDelete: "set null" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when the actor was a machine holding a site token, not a person. */
    tokenId: integer("token_id").references(() => siteApiTokens.id, { onDelete: "set null" }),
    action: varchar("action", { length: 64 }).notNull(),
    entity: varchar("entity", { length: 64 }),
    entityId: integer("entity_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("audit_log_site_idx").on(t.siteId, t.createdAt),
  }),
);

/* ----------------------------------------------------------- the masters
 *
 * Currencies are estate-wide, and that is a change from the old schema on
 * purpose: nine sites each kept their own three-row `currencies` table, so
 * "USD" existed nine times and nothing guaranteed the nine agreed. A
 * location still names its currency as text, because that is what the price
 * module and the compat API already speak.
 */
export const currencies = pgTable(
  "currencies",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 3 }).notNull(),
    title: varchar("title", { length: 96 }).notNull(),
    symbol: varchar("symbol", { length: 8 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codeUnique: uniqueIndex("currencies_code_unique").on(t.code),
  }),
);

/**
 * Uploaded files, indexed.
 *
 * The old sites had a `file_manager` directory and a PHP file browser over
 * it, so what was in it was whatever happened to be on disk — including
 * 200MB of orphans nobody could attribute. Here every file is a row: who put
 * it there, how big it is, and what refers to it.
 */
export const mediaFiles = pgTable(
  "media_files",
  {
    id: serial("id").primaryKey(),
    /** Null means the file is the estate's rather than one brand's. */
    siteId: integer("site_id").references(() => sites.id, { onDelete: "cascade" }),
    path: varchar("path", { length: 512 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 96 }).notNull(),
    bytes: integer("bytes").default(0).notNull(),
    uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pathUnique: uniqueIndex("media_files_path_unique").on(t.path),
    bySite: index("media_files_site_idx").on(t.siteId, t.createdAt),
  }),
);

/* ------------------------------------------------------- published things
 *
 * Reports, offers and impex sheets are the three things the brand sites
 * publish besides prices and articles. All three were separate tables with
 * identical Laravel audit columns and an `attach_file` pointing into the
 * file manager; here the audit columns are gone and the file is a path that
 * `media_files` knows about.
 */

/** A PDF the brand sells or gives away — 584 of them on baseoil alone. */
export const reports = pgTable(
  "reports",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 191 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    /** "weekly" | "monthly" | "annual" | "sample" — the old `report_type`. */
    reportType: varchar("report_type", { length: 64 }).notNull(),
    file: varchar("file", { length: 512 }),
    thumbnail: varchar("thumbnail", { length: 512 }),
    /** "published" | "premium" | "draft": premium means subscribers only. */
    status: varchar("status", { length: 24 }).default("draft").notNull(),
    authoredOn: date("authored_on"),
    clicks: integer("clicks").default(0).notNull(),
    metaTitle: varchar("meta_title", { length: 255 }),
    metaDescription: text("meta_description"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugPerSite: uniqueIndex("reports_site_slug_unique").on(t.siteId, t.slug),
    bySite: index("reports_site_status_idx").on(t.siteId, t.status, t.authoredOn),
  }),
);

/**
 * A buy or sell offer from the trade — the old `offers` table, 2,719 rows on
 * baseoil and 11,094 on bitumart.
 *
 * `userId` is nullable because most of them were posted by staff on behalf
 * of somebody who phoned in, and the old table recorded the contact details
 * separately from any account. Those fields are kept as they are.
 */
export const offers = pgTable(
  "offers",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    subject: varchar("subject", { length: 255 }).notNull(),
    /** "buy" | "sell". */
    offerType: varchar("offer_type", { length: 16 }).notNull(),
    keywords: varchar("keywords", { length: 255 }),
    description: text("description"),
    contactPerson: varchar("contact_person", { length: 191 }),
    contactEmail: varchar("contact_email", { length: 191 }),
    contactPhone: varchar("contact_phone", { length: 64 }),
    companyName: varchar("company_name", { length: 191 }),
    city: varchar("city", { length: 96 }),
    state: varchar("state", { length: 96 }),
    country: varchar("country", { length: 96 }),
    offerValue: varchar("offer_value", { length: 64 }),
    image: varchar("image", { length: 512 }),
    file: varchar("file", { length: 512 }),
    /** "published" | "premium" | "draft". */
    status: varchar("status", { length: 24 }).default("premium").notNull(),
    clicks: integer("clicks").default(0).notNull(),
    authoredOn: date("authored_on"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("offers_site_idx").on(t.siteId, t.status, t.createdAt),
  }),
);

/** An import/export data sheet. The old `impexes`, 1,167 rows on baseoil. */
export const impexSheets = pgTable(
  "impex_sheets",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 191 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    file: varchar("file", { length: 512 }),
    status: varchar("status", { length: 24 }).default("draft").notNull(),
    authoredOn: date("authored_on"),
    clicks: integer("clicks").default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugPerSite: uniqueIndex("impex_sheets_site_slug_unique").on(t.siteId, t.slug),
  }),
);

/* ------------------------------------------------------------ trade flows
 *
 * The old schema had three near-identical quantity tables (`globalqties`,
 * `globalimportqties`, `globalexportqties`) and three near-identical
 * location tables (`qtylocations`, `importlocations`, `exportlocations`).
 *
 * The quantity tables are genuinely three things — a standing quantity, an
 * import and an export — so they are one table with a `kind`.
 *
 * The location tables were not. All three quantity tables reference
 * `qtylocations`, all 146 rows of it, on both ends; `importlocations` and
 * `exportlocations` hold four rows each whose names duplicate the first four
 * qty locations and which nothing references. They are not carried. So a
 * place here is just a place, and what kind of flow it took part in is a
 * property of the flow.
 */
export const TRADE_KINDS = ["qty", "import", "export"] as const;
export type TradeKind = (typeof TRADE_KINDS)[number];

export const tradeLocations = pgTable(
  "trade_locations",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 191 }).notNull(),
    visible: boolean("visible").default(true).notNull(),
    clicks: integer("clicks").default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    titlePerSite: uniqueIndex("trade_locations_site_title_unique").on(t.siteId, t.title),
  }),
);

/**
 * A quantity moved between two places on a date.
 *
 * `numeric` rather than the old `bigint(11)`: the sheets carry tonnages with
 * decimals and the old column silently truncated them.
 */
export const tradeQuantities = pgTable(
  "trade_quantities",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).$type<TradeKind>().notNull(),
    fromLocationId: integer("from_location_id").references(() => tradeLocations.id, {
      onDelete: "cascade",
    }),
    toLocationId: integer("to_location_id").references(() => tradeLocations.id, {
      onDelete: "cascade",
    }),
    qty: numeric("qty", { precision: 18, scale: 3 }),
    qtyDate: date("qty_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("trade_quantities_site_idx").on(t.siteId, t.kind, t.qtyDate),
    cell: uniqueIndex("trade_quantities_cell_unique").on(
      t.siteId,
      t.kind,
      t.fromLocationId,
      t.toLocationId,
      t.qtyDate,
    ),
  }),
);

/* ------------------------------------------------------------------- ads */

/** Where an ad can go: 6 slots per site in the old `adlocations`. */
export const adPlacements = pgTable(
  "ad_placements",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 191 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    titlePerSite: uniqueIndex("ad_placements_site_title_unique").on(t.siteId, t.title),
  }),
);

export const ads = pgTable(
  "ads",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    placementId: integer("placement_id").references(() => adPlacements.id, {
      onDelete: "set null",
    }),
    title: varchar("title", { length: 191 }).notNull(),
    /** "image" | "video" | "code". */
    adType: varchar("ad_type", { length: 16 }).default("image").notNull(),
    image: varchar("image", { length: 512 }),
    video: varchar("video", { length: 512 }),
    code: text("code"),
    url: text("url"),
    startsAt: date("starts_at"),
    endsAt: date("ends_at"),
    enabled: boolean("enabled").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    clicks: integer("clicks").default(0).notNull(),
    onDashboard: boolean("on_dashboard").default(false).notNull(),
    onNewsletter: boolean("on_newsletter").default(false).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byPlacement: index("ads_placement_idx").on(t.siteId, t.placementId, t.sortOrder),
  }),
);

/* ------------------------------------------------------------ newsletters */

/** The wrapper a newsletter is sent in. Four per site in the old schema. */
export const newsletterTemplates = pgTable(
  "newsletter_templates",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 191 }).notNull(),
    body: text("body").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    titlePerSite: uniqueIndex("newsletter_templates_site_title_unique").on(t.siteId, t.title),
  }),
);

/**
 * One newsletter.
 *
 * `sentAt` and `recipients` are new: the old table recorded what was written
 * and `sent_emails` recorded six rows in total, so "did the 14 March issue
 * actually go out, and to how many" was unanswerable.
 */
export const newsletters = pgTable(
  "newsletters",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    templateId: integer("template_id").references(() => newsletterTemplates.id, {
      onDelete: "set null",
    }),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    /**
     * "draft" | "scheduled" | "sent" | "archived". Archived = carried from an
     * old site, which never recorded whether an issue went out.
     */
    status: varchar("status", { length: 24 }).default("draft").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    recipients: integer("recipients").default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index("newsletters_site_idx").on(t.siteId, t.status, t.createdAt),
  }),
);

/* ------------------------------------------------------- roles and settings */

/**
 * A named set of permissions.
 *
 * The old sites had 8 roles and 93 permission rows each, maintained nine
 * times; the permissions themselves are a code constant here (`PERMISSIONS`
 * in `src/domain/dashboard/permissions.ts`) because a permission is a thing
 * the code can or cannot do, and a row in a table cannot grant a capability
 * nothing checks for.
 */
export const roles = pgTable(
  "roles",
  {
    id: serial("id").primaryKey(),
    /** Null means the role is available on every brand. */
    siteId: integer("site_id").references(() => sites.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 96 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    nameUnique: uniqueIndex("roles_name_unique").on(t.name),
  }),
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: serial("id").primaryKey(),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: varchar("permission", { length: 96 }).notNull(),
  },
  (t) => ({
    once: uniqueIndex("role_permissions_unique").on(t.roleId, t.permission),
  }),
);

/**
 * Settings, as key and value.
 *
 * 69 rows per site in the old schema, `name`/`val`/`type` — and 69 × 9 of
 * them, so the nine sites' "items per page" could and did differ. A null
 * `siteId` is the estate's default and a row with a brand overrides it, so
 * one setting can be shared by eight brands and special on the ninth.
 */
export const settings = pgTable(
  "settings",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id").references(() => sites.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 96 }).notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyPerSite: uniqueIndex("settings_site_key_unique").on(t.siteId, t.key),
  }),
);

export const FORM_KINDS = ["directory", "offer"] as const;
export type FormKind = (typeof FORM_KINDS)[number];

/**
 * Which fields of a directory entry or an offer each tier gets to see.
 *
 * This is the paywall, and the old schema kept it as 44 loose settings rows
 * per site named `city_free`, `city_premium`, `offer_phone_free` and so on
 * — 396 rows across the estate, with nothing to say what a name meant or
 * which of them were read. One row per field per form, with the two flags
 * side by side, is the same information in the shape the question is asked:
 * "does a free reader see the phone number?"
 */
export const formFields = pgTable(
  "form_fields",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    form: varchar("form", { length: 16 }).$type<FormKind>().notNull(),
    key: varchar("key", { length: 96 }).notNull(),
    label: varchar("label", { length: 191 }).notNull(),
    /** Shown to someone who has not paid. */
    showFree: boolean("show_free").default(false).notNull(),
    /** Shown to a subscriber. */
    showPremium: boolean("show_premium").default(true).notNull(),
    /** Collected at all. A field switched off here is on neither form. */
    enabled: boolean("enabled").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyPerForm: uniqueIndex("form_fields_site_form_key_unique").on(t.siteId, t.form, t.key),
  }),
);

/* ------------------------------------------------------------- relations */

export const sitesRelations = relations(sites, ({ many }) => ({
  locations: many(locations),
  batches: many(priceBatches),
  tokens: many(siteApiTokens),
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  site: one(sites, { fields: [locations.siteId], references: [sites.id] }),
  prices: many(prices),
}));

export const pricesRelations = relations(prices, ({ one }) => ({
  location: one(locations, { fields: [prices.locationId], references: [locations.id] }),
  site: one(sites, { fields: [prices.siteId], references: [sites.id] }),
}));

export const priceBatchesRelations = relations(priceBatches, ({ one, many }) => ({
  site: one(sites, { fields: [priceBatches.siteId], references: [sites.id] }),
  items: many(priceBatchItems),
}));

export const priceBatchItemsRelations = relations(priceBatchItems, ({ one }) => ({
  batch: one(priceBatches, { fields: [priceBatchItems.batchId], references: [priceBatches.id] }),
  location: one(locations, { fields: [priceBatchItems.locationId], references: [locations.id] }),
}));
