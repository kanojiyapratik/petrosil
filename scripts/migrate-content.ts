/**
 * Carry one brand's content out of its MariaDB dump and into the platform.
 *
 *   npm run migrate:content -- --from baseoilreport --site baseoil [--fresh]
 *   npm run migrate:content -- --from baseoilreport --site baseoil --only mails
 *
 * `--only mails` carries just the system mail templates, replacing any the
 * brand already has, into a brand whose other content is already here.
 *
 * `migrate-site` moves the things the price module needs — locations, prices,
 * people. This moves everything the admin screens show: articles, pages,
 * announcements, reports, offers, impex sheets, ads, newsletters, trade
 * quantities, roles, currencies and settings. They are separate scripts
 * because they fail for different reasons and because prices mattered first.
 *
 * Three things it does rather than copies.
 *
 * `publish_options` becomes a status and a paywall flag, and anything it does
 * not recognise becomes a draft — never published.
 *
 * The 44 `*_free` / `*_premium` settings rows per site become `form_fields`
 * rows, one per field, with the two flags side by side. That is the same
 * information in the shape the question is actually asked.
 *
 * Currencies are estate-wide, so the first brand to arrive creates them and
 * the rest match on code.
 *
 * It reads a database and never writes to it. `--fresh` clears what a
 * previous run of THIS brand put in; without it the script refuses to run
 * twice, because a second pass would duplicate every article.
 */

import mysql from "mysql2/promise";
import { and, count, eq, inArray, isNull } from "drizzle-orm";

import { closeDb, db } from "@/db";
import {
  adPlacements,
  ads,
  coupons,
  announcements,
  articleCategories,
  articles,
  currencies,
  formFields,
  impexSheets,
  mailTemplates,
  newsletterTemplates,
  newsletters,
  offers,
  orders,
  pages,
  planPrices,
  plans,
  reports,
  rolePermissions,
  roles,
  settings,
  sites,
  tradeLocations,
  tradeQuantities,
  users,
  type FormKind,
  type TradeKind,
} from "@/db/schema";
import { columnList, readDate, readDay } from "@/domain/migrate/transform";
import {
  couponAction,
  excerptFrom,
  readCurrency,
  readPaymentStatus,
  readStatus,
  systemMailFor,
  termsFrom,
  uniqueSlug,
} from "@/domain/migrate/content";

type Options = { from: string; site: string; fresh: boolean; only: string | null; host: string; port: number };

function options(): Options {
  const args = process.argv.slice(2);
  const read = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);

    return at === -1 ? undefined : args[at + 1];
  };

  const from = read("from");
  const site = read("site");

  if (!from || !site) {
    throw new Error("usage: migrate-content --from <mysql database> --site <platform slug> [--fresh | --only mails]");
  }

  return {
    from,
    site,
    fresh: args.includes("--fresh"),
    only: read("only") ?? null,
    host: read("host") ?? "127.0.0.1",
    port: Number(read("port") ?? 3399),
  };
}

type Row = mysql.RowDataPacket;

/**
 * Insert in slices, so a 20,000-row article table does not arrive as one
 * statement.
 *
 * The `any` is deliberate and contained: this takes any table, and Drizzle's
 * insert types are built per table, so a generic helper over fourteen of them
 * cannot be typed without a union nothing else would use. Every call site is
 * typed, because `values` is built from the table's own `$inferInsert`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertAll<T>(
  table: Parameters<ReturnType<typeof db>["insert"]>[0],
  values: T[],
  size = 400,
): Promise<number> {
  for (let at = 0; at < values.length; at += size) {
    await db()
      .insert(table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values(values.slice(at, at + size) as any);
  }

  return values.length;
}

/** Does this dump have that table? Six of the nine predate several of them. */
async function tablesIn(source: mysql.Connection, schema: string): Promise<Set<string>> {
  const [rows] = await source.query<Row[]>(
    "select table_name from information_schema.tables where table_schema = ?",
    [schema],
  );

  return new Set(rows.map((row) => String(row.table_name ?? row.TABLE_NAME)));
}

/** What columns that table has. Three of the nine dumps predate several. */
async function columnsIn(
  source: mysql.Connection,
  schema: string,
  table: string,
): Promise<string[]> {
  const [rows] = await source.query<Row[]>(
    "select column_name from information_schema.columns where table_schema = ? and table_name = ?",
    [schema, table],
  );

  return rows.map((row) => String(row.column_name ?? row.COLUMN_NAME));
}

function text(value: unknown): string | null {
  const raw = value === null || value === undefined ? "" : String(value).trim();

  return raw === "" ? null : raw;
}

function clipped(value: unknown, max: number): string | null {
  const raw = text(value);

  return raw === null ? null : raw.slice(0, max);
}

/** "company_name" -> "Company name", for a field nobody ever labelled. */
function humanise(key: string): string {
  const words = key.replace(/_/g, " ").trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The old settings names, against the catalogue's. */
const SETTING_KEYS: Record<string, string> = {
  site_title: "site_title",
  site_description: "site_description",
  site_keywords: "site_keywords",
  site_admin_email: "site_admin_email",
  site_support_email: "site_support_email",
  mailOption: "mail_transport",
  mailAddress: "mail_from_address",
  mailReplyAddress: "mail_reply_to",
  smtpHost: "smtp_host",
  smtpPort: "smtp_port",
  smtpUsername: "smtp_username",
  smtpPass: "smtp_password",
  report_added_users: "report_recipients",
  added_offer_users: "offer_recipients",
  tinymce: "tinymce_key",
  getresponse_key: "getresponse_key",
  getresponse: "getresponse_list",
  mailwizz: "mailwizz_list",
};

/**
 * The old `mails` table: the system mails staff edit. A function of its own so
 * `--only mails` can carry it into a brand whose other content is already here.
 */
async function carryMailTemplates(
  source: mysql.Connection,
  database: ReturnType<typeof db>,
  siteId: number,
  have: Set<string>,
): Promise<void> {
  if (!have.has("mails")) {
    return;
  }

  const [rows] = await source.query<Row[]>(
    `select id, title, subject, description, publish_options, created_at, updated_at
       from mails where deleted_at is null order by id`,
  );

  const values = rows.flatMap((row) => {
    // By id, the way the old code chose them; a row we cannot place is
    // reported rather than guessed at.
    const role = systemMailFor(Number(row.id));

    if (!role) {
      console.log(`mails        skipped #${row.id} "${text(row.title) ?? ""}": not one the old code ever sent`);

      return [];
    }

    const title = clipped(row.title, 191) ?? role.key;

    return [
      {
        siteId,
        key: role.key,
        variant: role.variant,
        title,
        // `send-report` has no subject on any brand; the report's own title
        // was used. The template title stands in until staff write one.
        subject: clipped(row.subject, 255) ?? title,
        body: text(row.description) ?? "",
        enabled: readStatus(text(row.publish_options)).status === "published",
        createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
        updatedAt: readDate(row.updated_at) ?? readDate(row.created_at) ?? new Date("2015-01-01"),
      },
    ];
  });

  await insertAll(mailTemplates, values);
  console.log(`mails        ${values.length} system mail templates`);
}

async function main(): Promise<void> {
  const opts = options();
  const database = db();

  const [brand] = await database.select().from(sites).where(eq(sites.slug, opts.site)).limit(1);

  if (!brand) {
    throw new Error(`no site "${opts.site}" on the platform — run db:seed first`);
  }

  const source = await mysql.createConnection({
    host: opts.host,
    port: opts.port,
    user: process.env.SOURCE_USER ?? "root",
    password: process.env.SOURCE_PASSWORD ?? "scratch",
    database: opts.from,
    dateStrings: true,
  });

  console.log(`\n${opts.from}  ->  ${brand.name} (${brand.slug})   content`);
  console.log("-".repeat(64));

  try {
    if (opts.only !== null) {
      if (opts.only !== "mails") {
        throw new Error(`--only knows "mails"; "${opts.only}" is not a section it can carry alone`);
      }

      // A replace, so running it again after an edit at the source is safe.
      await database.delete(mailTemplates).where(eq(mailTemplates.siteId, brand.id));
      await carryMailTemplates(source, database, brand.id, await tablesIn(source, opts.from));

      return;
    }

    const have = await tablesIn(source, opts.from);

    /**
     * What this brand already holds, in delete-safe order (children first).
     *
     * Every one of them is checked, not just `articles`: three of the nine
     * brands have no articles at all, so a guard that looked only there let
     * them straight through and duplicated their categories and ads.
     */
    const carried = [
      orders,
      plans,
      articles,
      articleCategories,
      pages,
      announcements,
      reports,
      offers,
      impexSheets,
      ads,
      adPlacements,
      newsletters,
      newsletterTemplates,
      mailTemplates,
      tradeQuantities,
      tradeLocations,
      formFields,
      settings,
    ];

    // `coupons` is deliberately absent: a code widened to the whole estate
    // has no brand to clear it by, and re-running one brand must not take a
    // coupon away from the other eight.

    // Same reason as `insertAll`: one loop over fourteen differently typed
    // tables, so the table is cast once per statement rather than the loop
    // being written out fourteen times.
    let held = 0;

    for (const table of carried) {
      const [row] = await database
        .select({ n: count() })
        .from(table as any)
        .where(eq((table as any).siteId, brand.id));

      held += Number(row?.n ?? 0);
    }

    if (held > 0) {
      if (!opts.fresh) {
        throw new Error(
          `${brand.slug} already holds ${held} content rows. Re-run with --fresh to replace ` +
            "them, or migrate into an empty brand.",
        );
      }

      // Only this brand's rows. `roles` and `currencies` are estate-wide and
      // are left alone: another brand may be holding them.
      for (const table of carried) {
        await database.delete(table as any).where(eq((table as any).siteId, brand.id));
      }

      console.log(`cleared ${held} rows of this brand's content (--fresh)`);
    }

    /* ------------------------------------------------------- currencies */

    // The plans step needs the old currency ids, so they are kept here.
    const currencyCodes = new Map<number, string>();

    if (have.has("currencies")) {
      const [rows] = await source.query<Row[]>(
        "select id, title, symbol, currency_code from currencies where deleted_at is null",
      );

      const existing = new Set(
        (await database.select({ code: currencies.code }).from(currencies)).map((row) => row.code),
      );

      const fresh = rows
        .map((row) => ({
          code: String(row.currency_code ?? "").trim().toUpperCase().slice(0, 3),
          title: clipped(row.title, 96) ?? "Unnamed",
          symbol: clipped(row.symbol, 8) ?? "?",
        }))
        .filter((row) => row.code !== "" && !existing.has(row.code))
        .filter((row, at, all) => all.findIndex((other) => other.code === row.code) === at);

      await insertAll(currencies, fresh);
      console.log(`currencies   ${fresh.length} new, ${existing.size} already on the platform`);

      for (const row of rows) {
        currencyCodes.set(
          Number(row.id),
          String(row.currency_code ?? "").trim().toUpperCase().slice(0, 3) || "USD",
        );
      }
    }

    /* ------------------------------------------------- article categories */

    const categoryMap = new Map<number, number>();

    if (have.has("categories")) {
      const [rows] = await source.query<Row[]>(
        "select id, title, created_at from categories where deleted_at is null order by id",
      );

      const seen = new Set<string>();

      for (const [at, row] of rows.entries()) {
        const title = clipped(row.title, 191) ?? `Category ${row.id}`;

        const [inserted] = await database
          .insert(articleCategories)
          .values({
            siteId: brand.id,
            slug: uniqueSlug(title, Number(row.id), seen),
            name: title,
            sortOrder: at,
            createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
          })
          .returning();

        categoryMap.set(Number(row.id), inserted!.id);
      }

      console.log(`categories   ${categoryMap.size} carried`);
    }

    /* ------------------------------------------------------- article filing */

    const filedUnder = new Map<number, number>();

    if (have.has("categorizables")) {
      const [rows] = await source.query<Row[]>(
        "select category_id, categorizables_id from categorizables",
      );

      for (const row of rows) {
        const category = categoryMap.get(Number(row.category_id));

        if (category !== undefined) {
          filedUnder.set(Number(row.categorizables_id), category);
        }
      }
    }

    /* ------------------------------------------------------------ articles */

    if (have.has("articles")) {
      const [rows] = await source.query<Row[]>(
        `select id, title, description, path, thumb_image, publish_options, meta_description,
                authored_on, published_datetime, published_at, clicks, created_at, updated_at
           from articles
          where deleted_at is null
          order by id`,
      );

      const seen = new Set<string>();
      let drafts = 0;
      let paywalled = 0;

      const values = rows.map((row) => {
        const read = readStatus(text(row.publish_options));
        const title = clipped(row.title, 255) ?? `Untitled ${row.id}`;
        const published =
          readDate(row.published_datetime) ??
          readDate(row.published_at) ??
          readDate(row.authored_on) ??
          readDate(row.created_at);

        if (read.status === "draft") {
          drafts += 1;
        }

        if (read.premium) {
          paywalled += 1;
        }

        return {
          siteId: brand.id,
          categoryId: filedUnder.get(Number(row.id)) ?? null,
          slug: uniqueSlug(text(row.path) ?? title, Number(row.id), seen),
          title,
          // A locked article shows its excerpt to everyone, and most rows
          // have no meta_description — so the body stands in for one.
          excerpt: excerptFrom(text(row.meta_description), text(row.description)),
          body: text(row.description) ?? "",
          heroImage: clipped(row.thumb_image, 512),
          status: read.status,
          premiumOnly: read.premium,
          publishedAt: read.status === "published" ? published : null,
          views: Number(row.clicks ?? 0),
          createdAt: readDate(row.created_at) ?? published ?? new Date("2015-01-01"),
          updatedAt: readDate(row.updated_at) ?? readDate(row.created_at) ?? new Date("2015-01-01"),
        };
      });

      await insertAll(articles, values);
      console.log(
        `articles     ${values.length} carried  (${drafts} as drafts, ${paywalled} subscribers-only)`,
      );
    }

    /* --------------------------------------------------------------- pages */

    if (have.has("pages")) {
      const [rows] = await source.query<Row[]>(
        `select id, title, description, path, publish_options, created_at, updated_at
           from pages where deleted_at is null order by id`,
      );

      const seen = new Set<string>();

      const values = rows.map((row) => {
        const title = clipped(row.title, 255) ?? `Page ${row.id}`;

        return {
          siteId: brand.id,
          slug: uniqueSlug(text(row.path) ?? title, Number(row.id), seen),
          title,
          body: text(row.description) ?? "",
          visible: readStatus(text(row.publish_options)).status === "published",
          createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
          updatedAt: readDate(row.updated_at) ?? readDate(row.created_at) ?? new Date("2015-01-01"),
        };
      });

      await insertAll(pages, values);
      console.log(`pages        ${values.length} carried`);
    }

    /* ------------------------------------------------------- announcements */

    if (have.has("announcements")) {
      const [rows] = await source.query<Row[]>(
        `select id, title, description, path, publish_options, created_at
           from announcements where deleted_at is null order by id`,
      );

      const values = rows.map((row) => ({
        siteId: brand.id,
        // The old strip had a title and a body; the strip here is one line,
        // so the title is it and the body goes nowhere rather than being
        // pasted into a banner nobody can fit.
        body: clipped(row.title, 1000) ?? "(blank)",
        link: clipped(row.path, 512),
        enabled: readStatus(text(row.publish_options)).status === "published",
        createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
      }));

      await insertAll(announcements, values);
      console.log(`announcements ${values.length} carried`);
    }

    /* ------------------------------------------------------------- reports */

    if (have.has("reports")) {
      const [rows] = await source.query<Row[]>(
        `select id, title, description, attach_file, report_type, thumb_image, publish_options,
                authored_on, clicks, meta_title, meta_description, path, created_at, updated_at
           from reports where deleted_at is null order by id`,
      );

      const seen = new Set<string>();

      const values = rows.map((row) => {
        const read = readStatus(text(row.publish_options));
        const title = clipped(row.title, 255) ?? `Report ${row.id}`;

        return {
          siteId: brand.id,
          slug: uniqueSlug(text(row.path) ?? title, Number(row.id), seen),
          title,
          description: text(row.description),
          reportType: clipped(row.report_type, 64) ?? "report",
          file: clipped(row.attach_file, 512),
          thumbnail: clipped(row.thumb_image, 512),
          status: read.premium ? "premium" : read.status,
          authoredOn: readDay(row.authored_on) ?? readDay(row.created_at),
          clicks: Number(row.clicks ?? 0),
          metaTitle: clipped(row.meta_title, 255),
          metaDescription: text(row.meta_description),
          createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
          updatedAt: readDate(row.updated_at) ?? readDate(row.created_at) ?? new Date("2015-01-01"),
        };
      });

      await insertAll(reports, values);
      console.log(`reports      ${values.length} carried`);
    }

    /* -------------------------------------------------------------- offers */

    if (have.has("offers")) {
      const [rows] = await source.query<Row[]>(
        `select id, subject, offer_type, keywords, description, contact_person, contact_email,
                contact_phone, company_name, city, state, country, offer_value, attach_image,
                attach_file, publish_options, clicks, authored_on, created_at, updated_at
           from offers where deleted_at is null order by id`,
      );

      const values = rows.map((row) => {
        const read = readStatus(text(row.publish_options));

        return {
          siteId: brand.id,
          subject: clipped(row.subject, 255) ?? `Offer ${row.id}`,
          // The old column held "Buy"/"Sell" and occasionally something else;
          // anything that is not plainly buying is recorded as selling, which
          // is what the sites display it as.
          offerType: (text(row.offer_type) ?? "").toLowerCase().startsWith("buy") ? "buy" : "sell",
          keywords: clipped(row.keywords, 255),
          description: text(row.description),
          contactPerson: clipped(row.contact_person, 191),
          contactEmail: clipped(row.contact_email, 191),
          contactPhone: clipped(row.contact_phone, 64),
          companyName: clipped(row.company_name, 191),
          city: clipped(row.city, 96),
          state: clipped(row.state, 96),
          country: clipped(row.country, 96),
          offerValue: clipped(row.offer_value, 64),
          image: clipped(row.attach_image, 512),
          file: clipped(row.attach_file, 512),
          status: read.premium ? "premium" : read.status,
          clicks: Number(row.clicks ?? 0),
          authoredOn: readDay(row.authored_on) ?? readDay(row.created_at),
          createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
          updatedAt: readDate(row.updated_at) ?? readDate(row.created_at) ?? new Date("2015-01-01"),
        };
      });

      await insertAll(offers, values);
      console.log(`offers       ${values.length} carried`);
    }

    /* -------------------------------------------------------- impex sheets */

    if (have.has("impexes")) {
      const [rows] = await source.query<Row[]>(
        `select id, title, description, attach_file, publish_options, authored_on, clicks,
                path, created_at, updated_at
           from impexes where deleted_at is null order by id`,
      );

      const seen = new Set<string>();

      const values = rows.map((row) => {
        const read = readStatus(text(row.publish_options));
        const title = clipped(row.title, 255) ?? `Sheet ${row.id}`;

        return {
          siteId: brand.id,
          slug: uniqueSlug(text(row.path) ?? title, Number(row.id), seen),
          title,
          description: text(row.description),
          file: clipped(row.attach_file, 512),
          status: read.premium ? "premium" : read.status,
          authoredOn: readDay(row.authored_on) ?? readDay(row.created_at),
          clicks: Number(row.clicks ?? 0),
          createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
          updatedAt: readDate(row.updated_at) ?? readDate(row.created_at) ?? new Date("2015-01-01"),
        };
      });

      await insertAll(impexSheets, values);
      console.log(`impex        ${values.length} carried`);
    }

    /* ----------------------------------------------------------------- ads */

    const placementMap = new Map<number, number>();

    if (have.has("adlocations")) {
      const [rows] = await source.query<Row[]>(
        "select id, title, status, created_at from adlocations where deleted_at is null order by id",
      );

      const seen = new Set<string>();

      for (const row of rows) {
        let title = clipped(row.title, 191) ?? `Slot ${row.id}`;

        // The table had no unique index and some sites list a slot twice.
        if (seen.has(title.toLowerCase())) {
          title = `${title} (${row.id})`;
        }

        seen.add(title.toLowerCase());

        const [inserted] = await database
          .insert(adPlacements)
          .values({
            siteId: brand.id,
            title,
            enabled: (text(row.status) ?? "Show").toLowerCase() !== "hide",
            createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
          })
          .returning();

        placementMap.set(Number(row.id), inserted!.id);
      }
    }

    if (have.has("ads")) {
      const [rows] = await source.query<Row[]>(
        `select id, adlocation_id, title, ad_type, attach_image, video, ad_code, url, start_date,
                end_date, publish_options, ad_sequence, clicks, show_on_dashboard,
                show_on_newsletter, created_at
           from ads where deleted_at is null order by id`,
      );

      const values = rows.map((row) => ({
        siteId: brand.id,
        placementId: placementMap.get(Number(row.adlocation_id)) ?? null,
        title: clipped(row.title, 191) ?? `Ad ${row.id}`,
        adType: clipped(row.ad_type, 16) ?? "image",
        image: clipped(row.attach_image, 512),
        video: clipped(row.video, 512),
        code: text(row.ad_code),
        url: text(row.url),
        startsAt: readDay(row.start_date),
        endsAt: readDay(row.end_date),
        enabled: readStatus(text(row.publish_options)).status === "published",
        sortOrder: Number(row.ad_sequence ?? 0),
        clicks: Number(row.clicks ?? 0),
        onDashboard: Number(row.show_on_dashboard ?? 0) === 1,
        onNewsletter: Number(row.show_on_newsletter ?? 0) === 1,
        createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
      }));

      await insertAll(ads, values);
      console.log(`ads          ${values.length} carried into ${placementMap.size} slots`);
    }

    /* --------------------------------------------------------- newsletters */

    const templateMap = new Map<number, number>();

    if (have.has("templates")) {
      const [rows] = await source.query<Row[]>(
        `select id, title, description, publish_options, created_at, updated_at
           from templates where deleted_at is null order by id`,
      );

      const seen = new Set<string>();

      for (const row of rows) {
        let title = clipped(row.title, 191) ?? `Template ${row.id}`;

        if (seen.has(title.toLowerCase())) {
          title = `${title} (${row.id})`;
        }

        seen.add(title.toLowerCase());

        const [inserted] = await database
          .insert(newsletterTemplates)
          .values({
            siteId: brand.id,
            title,
            body: text(row.description) ?? "",
            enabled: readStatus(text(row.publish_options)).status === "published",
            createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
            updatedAt:
              readDate(row.updated_at) ?? readDate(row.created_at) ?? new Date("2015-01-01"),
          })
          .returning();

        templateMap.set(Number(row.id), inserted!.id);
      }
    }

    if (have.has("newsletters")) {
      const [rows] = await source.query<Row[]>(
        `select id, title, description, publish_options, created_at, updated_at
           from newsletters where deleted_at is null order by id`,
      );

      const values = rows.map((row) => ({
        siteId: brand.id,
        templateId: null,
        title: clipped(row.title, 255) ?? `Issue ${row.id}`,
        body: text(row.description) ?? "",
        // Nothing in the old schema recorded a send, so nothing here claims
        // one. Not "draft" either: these are history, read-only, and copied
        // into a new draft to be reused.
        status: "archived",
        createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
        updatedAt: readDate(row.updated_at) ?? readDate(row.created_at) ?? new Date("2015-01-01"),
      }));

      await insertAll(newsletters, values);
      console.log(
        `newsletters  ${values.length} carried into ${templateMap.size} templates, all archived (no send was ever recorded)`,
      );
    }

    await carryMailTemplates(source, database, brand.id, have);

    /* --------------------------------------------------------- trade flows */

    // One place list. All three quantity tables reference `qtylocations` on
    // both ends -- checked against the data, not assumed: the id ranges in
    // `globalimportqties` reach 146, and `importlocations` holds four rows.
    // Those four-row `importlocations` / `exportlocations` tables duplicate
    // the first qty locations by name and nothing points at them, so they are
    // not carried.
    const tradeMap = new Map<number, number>();

    if (have.has("qtylocations")) {
      const [rows] = await source.query<Row[]>(
        "select id, title, status, clicks, created_at from qtylocations where deleted_at is null order by id",
      );

      const seen = new Set<string>();

      for (const row of rows) {
        let title = clipped(row.title, 191) ?? `Place ${row.id}`;

        // (site, title) is unique here and was not there.
        if (seen.has(title.toLowerCase())) {
          title = `${title} (${row.id})`;
        }

        seen.add(title.toLowerCase());

        const [inserted] = await database
          .insert(tradeLocations)
          .values({
            siteId: brand.id,
            title,
            visible: (text(row.status) ?? "Show").toLowerCase() !== "hide",
            clicks: Number(row.clicks ?? 0),
            createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
          })
          .returning();

        tradeMap.set(Number(row.id), inserted!.id);
      }
    }

    const qtyTables: { table: string; kind: TradeKind }[] = [
      { table: "globalqties", kind: "qty" },
      { table: "globalimportqties", kind: "import" },
      { table: "globalexportqties", kind: "export" },
    ];

    let quantities = 0;
    let collapsed = 0;
    let unresolved = 0;

    for (const { table, kind } of qtyTables) {
      if (!have.has(table)) {
        continue;
      }

      // Newest first, so the first row seen for a cell is the one kept --
      // the same "most recently entered wins" rule the price migration
      // applies, rather than whichever row happens to be oldest.
      const [rows] = await source.query<Row[]>(
        `select id, export_location_id, import_location_id, qty, qtydate
           from ${table} where deleted_at is null order by id desc`,
      );

      const cells = new Set<string>();
      const values: (typeof tradeQuantities.$inferInsert)[] = [];

      for (const row of rows) {
        const from = tradeMap.get(Number(row.export_location_id)) ?? null;
        const to = tradeMap.get(Number(row.import_location_id)) ?? null;
        const day = readDay(row.qtydate);

        // A row whose place was deleted from `qtylocations` has nowhere to
        // hang. Counted and skipped rather than stored as a flow between two
        // nulls, which is what collapsed 96% of this table the first time.
        if (from === null && to === null) {
          unresolved += 1;
          continue;
        }

        // (site, kind, from, to, date) is unique here and the old tables had
        // no index, so the first row seen for a cell -- the newest -- wins.
        const cell = `${from}|${to}|${day}`;

        if (cells.has(cell)) {
          collapsed += 1;
          continue;
        }

        cells.add(cell);

        values.push({
          siteId: brand.id,
          kind,
          fromLocationId: from,
          toLocationId: to,
          qty: row.qty === null ? null : String(row.qty),
          qtyDate: day,
        });
      }

      quantities += await insertAll(tradeQuantities, values);
    }

    if (tradeMap.size > 0 || quantities > 0) {
      console.log(
        `trade        ${tradeMap.size} places, ${quantities} quantities` +
          (collapsed > 0 ? `, ${collapsed} duplicate cells collapsed` : "") +
          (unresolved > 0 ? `, ${unresolved} with no place left to hang on` : ""),
      );
    }

    /* ------------------------------------------------------------- coupons */

    if (have.has("coupons")) {
      const [rows] = await source.query<Row[]>(
        `select ${columnList(
          ["coupon_code", "discount", "description", "start_date", "end_date", "publish_options"],
          await columnsIn(source, opts.from, "coupons"),
        )} from coupons where deleted_at is null order by id`,
      );

      let made = 0;
      let broadened = 0;
      const conflicts: string[] = [];

      for (const row of rows) {
        const code = (text(row.coupon_code) ?? "").toUpperCase();

        if (code === "") {
          continue;
        }

        // The old column is a bare double with no type beside it, and every
        // value in the estate is a percentage.
        const incoming = {
          percentOff: Math.round(Number(row.discount ?? 0)),
          amountOff: null,
          enabled: readStatus(text(row.publish_options)).status === "published",
        };

        const [existing] = await database
          .select()
          .from(coupons)
          .where(eq(coupons.code, code))
          .limit(1);

        const decision = couponAction(
          existing
            ? {
                siteId: existing.siteId,
                percentOff: existing.percentOff,
                amountOff: existing.amountOff,
                enabled: existing.enabled,
              }
            : null,
          incoming,
          brand.id,
        );

        if (decision.action === "create") {
          await database.insert(coupons).values({
            siteId: decision.siteId,
            code,
            percentOff: incoming.percentOff,
            startsAt: readDay(row.start_date),
            expiresAt: readDay(row.end_date),
            enabled: incoming.enabled,
          });
          made += 1;
        } else if (decision.action === "broaden") {
          // A second brand prints the same code on the same terms, so it is
          // one estate-wide coupon rather than two rows fighting over a
          // unique index.
          await database
            .update(coupons)
            .set({ siteId: null })
            .where(eq(coupons.id, existing!.id));
          broadened += 1;
        } else if (decision.action === "conflict") {
          conflicts.push(code);
        }
      }

      console.log(
        `coupons      ${made} new, ${broadened} widened to the whole estate` +
          (conflicts.length > 0
            ? `; LEFT ALONE, same code different terms: ${conflicts.join(", ")}`
            : ""),
      );
    }

    /* -------------------------------------------------- plans and payments */

    const planMap = new Map<number, number>();

    if (have.has("subscriptions")) {
      const [rows] = await source.query<Row[]>(
        `select ${columnList(
          [
            "id",
            "title",
            "cost",
            "cost2",
            "cost3",
            "currency_id",
            "members",
            "description",
            "publish_options",
            "sequence",
          ],
          await columnsIn(source, opts.from, "subscriptions"),
        )} from subscriptions where deleted_at is null order by sequence, id`,
      );

      const seen = new Set<string>();
      let priced = 0;

      for (const row of rows) {
        const title = clipped(row.title, 191) ?? `Plan ${row.id}`;
        const members = Number(row.members ?? 1);

        const [inserted] = await database
          .insert(plans)
          .values({
            siteId: brand.id,
            // The old table had the same title at several seat counts, so the
            // code carries the seats: "india-subcontinent-plan-5".
            code: uniqueSlug(`${title}${members > 1 ? ` ${members}` : ""}`, Number(row.id), seen),
            name: title,
            description: text(row.description),
            currency: currencyCodes.get(Number(row.currency_id)) ?? "USD",
            visible: readStatus(text(row.publish_options)).status === "published",
            sortOrder: Number(row.sequence ?? 0),
          })
          .returning();

        planMap.set(Number(row.id), inserted!.id);

        const terms = termsFrom(row.cost, row.cost2, row.cost3);

        priced += await insertAll(
          planPrices,
          terms.map((term) => ({ planId: inserted!.id, years: term.years, amount: term.amount })),
        );
      }

      console.log(`plans        ${planMap.size} carried, ${priced} prices`);
    }

    // What each old plan was priced in, for an order that records no currency
    // of its own -- 225 of baseoil's 635. The plan priced the sale.
    const planCurrency = new Map<number, string>();

    if (have.has("subscriptions")) {
      const [rows] = await source.query<Row[]>(
        "select id, currency_id from subscriptions",
      );

      for (const row of rows) {
        planCurrency.set(
          Number(row.id),
          currencyCodes.get(Number(row.currency_id)) ?? "USD",
        );
      }
    }

    if (have.has("subscription_users")) {
      // Legacy user ids are not carried, so the buyer is found by the email
      // on their old row and matched to the person already on the platform.
      // Three of the nine dumps have no `payment_order_id`, and asking for it
      // threw — which aborted every step after this one and quietly cost
      // those brands their roles and settings.
      const columns = columnList(
        [
          "subscription_id",
          "plan_name",
          "cost",
          "currency_code",
          "no_year",
          "payment_method",
          "transaction_no",
          "razorpay_payment_id",
          "payment_date",
          "payment_status",
          "payment_order_id",
          "expiry_date",
          "created_at",
        ],
        await columnsIn(source, opts.from, "subscription_users"),
      )
        .split(", ")
        .map((column) => (column.startsWith("null as ") ? column : `su.${column}`))
        .join(", ");

      const [rows] = await source.query<Row[]>(
        `select ${columns}, lower(trim(u.email)) as email
           from subscription_users su
           join users u on u.id = su.user_id
          where u.email is not null and u.email <> ''
          order by su.id`,
      );

      const emails = [...new Set(rows.map((row) => String(row.email)))];
      const onPlatform = new Map<string, number>();

      for (let at = 0; at < emails.length; at += 500) {
        const found = await database
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.email, emails.slice(at, at + 500)));

        for (const person of found) {
          onPlatform.set(person.email, person.id);
        }
      }

      const references = new Set(
        (
          await database
            .select({ reference: orders.providerOrderId })
            .from(orders)
        )
          .map((row) => row.reference)
          .filter((reference): reference is string => Boolean(reference)),
      );

      const values: (typeof orders.$inferInsert)[] = [];
      let unknown = 0;

      for (const row of rows) {
        const userId = onPlatform.get(String(row.email));

        if (userId === undefined) {
          unknown += 1;
          continue;
        }

        // The provider reference is unique platform-wide; 634 of baseoil's
        // 635 rows have none, and a repeat would reject the whole slice.
        let reference = text(row.payment_order_id);

        if (reference !== null && references.has(reference)) {
          reference = null;
        }

        if (reference !== null) {
          references.add(reference);
        }

        const amount = Number(row.cost ?? 0).toFixed(2);
        const status = readPaymentStatus(text(row.payment_status));

        values.push({
          siteId: brand.id,
          userId,
          planId: planMap.get(Number(row.subscription_id)) ?? null,
          planName: clipped(row.plan_name, 191) ?? "Subscription",
          years: Number(row.no_year ?? 0) > 0 ? Number(row.no_year) : 1,
          // The id over the free text: that column holds symbols as often as
          // codes, and upper-casing it put "₹" in an ISO column.
          currency: readCurrency(
            row.currency_id === null || row.currency_id === undefined
              ? null
              : Number(row.currency_id),
            text(row.currency_code),
            currencyCodes,
            planCurrency.get(Number(row.subscription_id)) ?? "USD",
          ),
          listAmount: amount,
          amount,
          status,
          provider: (text(row.payment_method) ?? "manual").toLowerCase().slice(0, 32),
          providerOrderId: reference,
          providerPaymentId: clipped(row.razorpay_payment_id ?? row.transaction_no, 191),
          paidAt: status === "paid" ? readDate(row.payment_date) ?? readDate(row.created_at) : null,
          grantedUntil: readDay(row.expiry_date),
          createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
        });
      }

      await insertAll(orders, values);

      console.log(
        `transactions ${values.length} carried` +
          (unknown > 0 ? `, ${unknown} whose buyer is no longer on the platform` : ""),
      );
    }

    /* --------------------------------------------------------------- roles */

    if (have.has("roles") && have.has("permissions") && have.has("role_has_permissions")) {
      const [roleRows] = await source.query<Row[]>(
        "select id, name from roles where deleted_at is null order by id",
      );
      const [permissionRows] = await source.query<Row[]>("select id, name from permissions");
      const [linkRows] = await source.query<Row[]>(
        "select role_id, permission_id from role_has_permissions",
      );

      const permissionNames = new Map(
        permissionRows.map((row) => [Number(row.id), String(row.name)]),
      );

      const existing = new Set(
        (await database.select({ name: roles.name }).from(roles)).map((row) => row.name),
      );

      let made = 0;
      let granted = 0;

      for (const row of roleRows) {
        const name = clipped(row.name, 96) ?? `Role ${row.id}`;

        // Roles are estate-wide here. The nine sites had the same eight role
        // names; the first brand to arrive creates them, the rest match.
        if (existing.has(name)) {
          continue;
        }

        existing.add(name);

        const [inserted] = await database
          .insert(roles)
          .values({ name, description: `Carried from ${opts.from}` })
          .returning();

        made += 1;

        const permissions = linkRows
          .filter((link) => Number(link.role_id) === Number(row.id))
          .map((link) => permissionNames.get(Number(link.permission_id)))
          .filter((permission): permission is string => Boolean(permission))
          .filter((permission, at, all) => all.indexOf(permission) === at);

        granted += await insertAll(
          rolePermissions,
          permissions.map((permission) => ({ roleId: inserted!.id, permission })),
        );
      }

      console.log(`roles        ${made} new, ${granted} permissions granted`);
    }

    /* ------------------------------------------------------------ settings */

    if (have.has("settings")) {
      const [rows] = await source.query<Row[]>("select name, val from settings");

      const known: { siteId: number; key: string; value: string }[] = [];
      const fields: (typeof formFields.$inferInsert)[] = [];
      const paywall = new Map<string, { form: FormKind; key: string; free?: boolean; premium?: boolean }>();
      let stranded = 0;

      for (const row of rows) {
        const name = String(row.name ?? "").trim();
        const value = String(row.val ?? "");

        if (name === "") {
          continue;
        }

        const mapped = SETTING_KEYS[name];

        if (mapped) {
          if (value.trim() !== "") {
            known.push({ siteId: brand.id, key: mapped, value });
          }

          continue;
        }

        // `city_free`, `offer_phone_premium` and the other 42: two rows per
        // field, one per tier, which become one row with two flags.
        const tier = name.endsWith("_free") ? "free" : name.endsWith("_premium") ? "premium" : null;

        if (tier) {
          const stem = name.slice(0, -(tier.length + 1));
          const form: FormKind = stem.startsWith("offer_") ? "offer" : "directory";
          const key = form === "offer" ? stem.slice("offer_".length) : stem;
          const at = `${form}|${key}`;
          const held = paywall.get(at) ?? { form, key };

          held[tier] = value.trim() === "1";
          paywall.set(at, held);

          continue;
        }

        // Kept rather than dropped, and reported on the Settings screen as
        // carried over and read by nothing.
        known.push({ siteId: brand.id, key: name.slice(0, 96), value });
        stranded += 1;
      }

      for (const [at, held] of [...paywall.entries()].sort()) {
        void at;

        fields.push({
          siteId: brand.id,
          form: held.form,
          key: held.key.slice(0, 96),
          label: humanise(held.key),
          showFree: held.free ?? false,
          showPremium: held.premium ?? true,
          sortOrder: fields.length,
        });
      }

      await insertAll(settings, known);
      await insertAll(formFields, fields);

      console.log(
        `settings     ${known.length - stranded} recognised, ${stranded} carried as unknown; ` +
          `${fields.length} paywalled fields rebuilt from ${paywall.size * 2} loose rows`,
      );
    }

    /* ---------------------------------------------- attribute the articles */

    // The old `authored_by` points at a user id in the brand's own table, and
    // nothing here carries legacy ids — so authorship is left null rather
    // than guessed. Said out loud because an empty byline looks like a bug.
    const [[unattributed]] = [
      await database
        .select({ n: count() })
        .from(articles)
        .where(and(eq(articles.siteId, brand.id), isNull(articles.authorId))),
    ];

    if ((unattributed?.n ?? 0) > 0) {
      console.log(
        `\nNote: ${unattributed!.n} articles have no author. The old \`authored_by\` is a\n` +
          "legacy user id and nothing carries legacy ids, so it is left empty rather\n" +
          "than attributed to the wrong person.",
      );
    }

    console.log("\ndone.");
  } finally {
    await source.end();
    await closeDb();
  }
}

main().catch(async (error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  await closeDb();
  process.exitCode = 1;
});
