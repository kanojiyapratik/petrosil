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
    tier: varchar("tier", { length: 24 }).default("free").notNull(),
    expiresAt: date("expires_at"),
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
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The sender's query: oldest unsent first.
    pending: index("mail_outbox_pending_idx").on(t.sentAt, t.id),
    byUser: index("mail_outbox_user_idx").on(t.userId),
  }),
);

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
