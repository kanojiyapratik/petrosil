/**
 * Move one brand's data out of its MariaDB dump and into the platform.
 *
 *   docker exec -i petrosil-scratch-db mariadb -uroot -pscratch \
 *     -e "create database methanolreport"
 *   docker exec -i petrosil-scratch-db mariadb -uroot -pscratch methanolreport \
 *     < methanolreport_2026-09-18.sql
 *   npm run migrate:site -- --from methanolreport --site methanolreport
 *
 * It reads a scratch database, never a live one, and it never writes back to
 * the source. Add `--fresh` to clear what a previous run of THIS brand put
 * in; without it the script refuses to run twice, because a second pass
 * would double every price.
 *
 * What it carries: locations, published prices, people and their standing.
 * Articles, reports, offers and the directory wait for the tables that will
 * hold them. Nothing carries a legacy id, and `api_token` is never read.
 */

import mysql from "mysql2/promise";
import { and, count, eq, inArray } from "drizzle-orm";

import { closeDb, db } from "@/db";
import { locations, memberships, prices, sites, users } from "@/db/schema";
import {
  columnList,
  dedupeByEmail,
  dedupePrices,
  readDate,
  readDay,
  readUser,
  type LegacyPrice,
  type LegacyUser,
} from "@/domain/migrate/transform";

type Options = { from: string; site: string; fresh: boolean; host: string; port: number };

function options(): Options {
  const args = process.argv.slice(2);
  const read = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);

    return at === -1 ? undefined : args[at + 1];
  };

  const from = read("from");
  const site = read("site");

  if (!from || !site) {
    throw new Error("usage: migrate-site --from <mysql database> --site <platform slug> [--fresh]");
  }

  return {
    from,
    site,
    fresh: args.includes("--fresh"),
    host: read("host") ?? "127.0.0.1",
    port: Number(read("port") ?? 3399),
  };
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

  console.log(`\n${opts.from}  ->  ${brand.name} (${brand.slug})`);
  console.log("-".repeat(60));

  try {
    const [[already]] = [
      await database
        .select({ n: count() })
        .from(locations)
        .where(eq(locations.siteId, brand.id)),
    ];

    if ((already?.n ?? 0) > 0) {
      if (!opts.fresh) {
        throw new Error(
          `${brand.slug} already holds ${already!.n} locations. Re-run with --fresh to replace them, ` +
            "or migrate into an empty brand — a second pass would double every price.",
        );
      }

      // Only this brand's rows: the delete is scoped exactly like every read.
      await database.delete(prices).where(eq(prices.siteId, brand.id));
      await database.delete(locations).where(eq(locations.siteId, brand.id));
      console.log(`cleared ${already!.n} locations and their prices (--fresh)`);
    }

    const currencies = new Map<number, string>();
    const [currencyRows] = await source.query<mysql.RowDataPacket[]>(
      "select id, currency_code from currencies",
    );

    for (const row of currencyRows) {
      currencies.set(Number(row.id), String(row.currency_code).trim().toUpperCase().slice(0, 3));
    }

    /* ---------------------------------------------------------- locations */

    // Two of the nine dumps predate `show_on_dashboard`, so ask the dump
    // what it has before asking it for columns.
    const [columnRows] = await source.query<mysql.RowDataPacket[]>(
      "select column_name from information_schema.columns where table_schema = ? and table_name = ?",
      [opts.from, "locations"],
    );
    const have = columnRows.map((row) => String(row.column_name ?? row.COLUMN_NAME));

    const [locationRows] = await source.query<mysql.RowDataPacket[]>(
      `select ${columnList(
        ["id", "title", "currency_id", "show_on_dashboard", "deleted_at", "created_at"],
        have,
      )} from locations order by id`,
    );

    const locationMap = new Map<number, number>();
    const seenTitles = new Map<string, number>();
    let renamed = 0;

    for (const row of locationRows) {
      const title = String(row.title).trim();

      // The new schema allows one title per brand; the old one allowed two,
      // which is what made name resolution ambiguous. A collision keeps both
      // rows but marks the later one, so nothing is silently thrown away.
      const key = title.toLowerCase();
      let finalTitle = title;

      if (seenTitles.has(key)) {
        finalTitle = `${title} (duplicate ${row.id})`;
        renamed += 1;
      }

      seenTitles.set(key, Number(row.id));

      const [inserted] = await database
        .insert(locations)
        .values({
          siteId: brand.id,
          title: finalTitle,
          currency: row.currency_id ? (currencies.get(Number(row.currency_id)) ?? null) : null,
          visible: String(row.show_on_dashboard ?? "Show").toLowerCase() !== "hide",
          deletedAt: readDate(row.deleted_at),
          createdAt: readDate(row.created_at) ?? new Date("2015-01-01"),
        })
        .returning();

      locationMap.set(Number(row.id), inserted!.id);
    }

    console.log(
      `locations   ${locationMap.size} carried` +
        (renamed > 0 ? `, ${renamed} renamed to clear a duplicate title` : ""),
    );

    /* ------------------------------------------------------------- prices */

    const [priceRows] = await source.query<mysql.RowDataPacket[]>(
      "select id, location_id, pricedate, price, currency_id, deleted_at from globalprices",
    );

    const prepared = dedupePrices(priceRows as unknown as LegacyPrice[]);
    const batchSize = 1000;
    let written = 0;
    let orphans = 0;

    for (let at = 0; at < prepared.kept.length; at += batchSize) {
      const slice = prepared.kept.slice(at, at + batchSize);
      const values = [];

      for (const row of slice) {
        const locationId = locationMap.get(Number(row.location_id));

        // A price whose location is not in this dump has nothing to attach
        // to; counted and reported rather than guessed at.
        if (!locationId) {
          orphans += 1;
          continue;
        }

        values.push({
          siteId: brand.id,
          locationId,
          price: String(Number(row.price)),
          currency: row.currency_id ? (currencies.get(Number(row.currency_id)) ?? null) : null,
          priceDate: readDay(row.pricedate)!,
        });
      }

      if (values.length > 0) {
        await database.insert(prices).values(values);
        written += values.length;
      }
    }

    console.log(
      `prices      ${written} carried  (${prepared.softDeleted} soft-deleted left behind, ` +
        `${prepared.collisions} duplicate location+date collapsed, ${prepared.priceless} with no price, ` +
        `${prepared.undated} undated` +
        (orphans > 0 ? `, ${orphans} with no location` : "") +
        ")",
    );

    if (prepared.outOfRange.length > 0) {
      // Set aside, never clamped: these are typos in the source, and the only
      // honest thing a migration can do with a price it cannot believe is
      // show it to someone.
      console.log(
        `\n${prepared.outOfRange.length} price(s) were left out as impossible — check them by hand:`,
      );

      for (const row of prepared.outOfRange.slice(0, 10)) {
        console.log(
          `  legacy id ${row.id}  location ${row.location_id}  ${readDay(row.pricedate)}  ${row.price}`,
        );
      }
    }

    /* -------------------------------------------------------------- people */

    const [userRows] = await source.query<mysql.RowDataPacket[]>(
      `select id, email, name, first_name, last_name, company_name, mobile, country,
              premium, user_status, isAdmin, expiry_date, created_at, updated_at,
              password, email_verified_at, deleted_at
         from users
        where deleted_at is null
          and email is not null and email <> ''`,
    );

    // Where the real expiry dates are. `users.expiry_date` is NULL for every
    // row in this estate -- 16,557 of them on baseoil -- so reading it gave
    // nobody an end date and every payer looked open-ended. The strongest
    // standing per person is the furthest date they hold.
    const expiries = new Map<number, string>();

    // Asked for unconditionally and guarded by the catch: a dump without the
    // table is a brand with no subscriptions, not a reason to stop.
    {
      try {
        const [expiryRows] = await source.query<mysql.RowDataPacket[]>(
          "select user_id, max(expiry_date) as expiry_date from subscription_users group by user_id",
        );

        for (const row of expiryRows) {
          const day = readDay(row.expiry_date);

          if (day !== null) {
            expiries.set(Number(row.user_id), day);
          }
        }
      } catch (error) {
        // Three of the nine dumps may predate the table; a missing one is a
        // brand with no subscriptions, not a reason to stop.
        console.log(
          `            no subscription_users to read expiries from (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    }

    const readable = (userRows as unknown as LegacyUser[]).map((row) =>
      readUser(row, expiries.get(Number(row.id)) ?? null),
    );

    const standing = { premium: 0, trial: 0, free: 0, dated: 0 };

    for (const person of readable) {
      standing[person.tier] += 1;

      if (person.expiresAt !== null) {
        standing.dated += 1;
      }
    }
    const { kept, merged } = dedupeByEmail(readable);

    // Someone may already exist from another brand's migration: one person,
    // one row, however many brands they read.
    const emails = kept.map((person) => person.email);
    const existing = new Map<string, number>();

    for (let at = 0; at < emails.length; at += 500) {
      const slice = emails.slice(at, at + 500);
      const found = await database
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.email, slice));

      for (const row of found) {
        existing.set(row.email, row.id);
      }
    }

    let created = 0;
    let joined = 0;
    let granted = 0;
    let corrected = 0;
    const admins: string[] = [];

    for (const person of kept) {
      let userId = existing.get(person.email);

      if (!userId) {
        const [row] = await database
          .insert(users)
          .values({
            email: person.email,
            name: person.name,
            company: person.company,
            phone: person.phone,
            country: person.country,
            status: person.status,
            passwordHash: person.passwordHash,
            emailVerifiedAt: person.emailVerifiedAt,
            createdAt: person.createdAt,
          })
          .returning();

        userId = row!.id;
        existing.set(person.email, userId);
        created += 1;
      } else {
        joined += 1;
      }

      if (person.wasAdmin) {
        admins.push(person.email);
      }

      // Everyone arrives as a subscriber. An `isAdmin` row from the old site
      // is reported below and granted by hand: importing staff access is not
      // a decision a migration script should make on its own.
      const [membership] = await database
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.siteId, brand.id)))
        .limit(1);

      if (!membership) {
        await database.insert(memberships).values({
          userId,
          siteId: brand.id,
          role: "subscriber",
          tier: person.tier,
          expiresAt: person.expiresAt,
        });
        granted += 1;
      } else if (opts.fresh) {
        // A re-run with --fresh is how a mistake in these rules gets
        // corrected, and the standing was the mistake: `premium` was read as
        // a boolean and the expiry came from a column that is NULL for every
        // row in the estate. Insert-only meant a second pass recomputed both
        // and threw them away.
        //
        // `role` is never touched. Staff access is granted by hand here and
        // a dump must not be able to take it away.
        if (membership.tier !== person.tier || membership.expiresAt !== person.expiresAt) {
          await database
            .update(memberships)
            .set({ tier: person.tier, expiresAt: person.expiresAt, updatedAt: new Date() })
            .where(eq(memberships.id, membership.id));
          corrected += 1;
        }
      }
    }

    console.log(
      `people      ${created} new, ${joined} already here from another brand, ` +
        `${granted} memberships` +
        (corrected > 0 ? `, ${corrected} standings corrected` : "") +
        `  (${merged} duplicate email rows merged)`,
    );

    const paying = kept.filter((person) => person.tier === "premium").length;
    const trialling = kept.filter((person) => person.tier === "trial").length;
    const dated = kept.filter((person) => person.expiresAt !== null).length;

    console.log(
      `            ${paying} premium (paying or lapsed), ${trialling} on a trial, ` +
        `${dated} with a real expiry date`,
    );
    void standing;

    if (admins.length > 0) {
      console.log(
        `\nNOT granted staff access — ${admins.length} account(s) were admins on the old site.\n` +
          "Grant them by hand once you have decided who still needs it:",
      );

      for (const email of admins.slice(0, 20)) {
        console.log(`  ${email}`);
      }

      if (admins.length > 20) {
        console.log(`  … and ${admins.length - 20} more`);
      }
    }

    console.log("\ndone.");
  } finally {
    await source.end();
    await closeDb();
  }
}

main().catch(async (error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  await closeDb();
  process.exit(1);
});
