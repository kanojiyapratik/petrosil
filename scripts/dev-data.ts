/**
 * Demo data for local work: a couple of brands with real-looking locations
 * and prices, a staff member scoped to one brand, and a handful of clients
 * in every segment. Run after `db:seed`.
 *
 * Never point this at anything but a local database — it writes people.
 */
import { eq } from "drizzle-orm";

import { closeDb, db } from "@/db";
import {
  announcements,
  articleCategories,
  articles,
  coupons,
  locations,
  memberships,
  pages,
  planPrices,
  plans,
  priceSummaries,
  prices,
  sites,
  users,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";

const PASSWORD = process.env.DEV_PASSWORD ?? "petrosil-dev";

const BRANDS: Record<string, [string, number][]> = {
  baseoil: [
    ["Singapore SN 150 FOB Group I", 1520],
    ["UAE SN 500 Group II", 1340],
    ["Europe Domestic SN 150 Group I", 1490],
    ["Turkey Domestic Group I", 580],
    ["India Ex-tank Mumbai SN 500", 128500],
  ],
  bitumart: [
    ["Singapore Drum FOB", 830],
    ["China North CFR", 825],
    ["Turkey Domestic EUR", 560],
    ["India Drums CFR", 425],
  ],
};

const PEOPLE: [string, string, string, [string, string, string | null][]][] = [
  // email, name, company, [[brand, tier, expiry]]
  ["tanvi@ebo.example", "Tanvi Sharma", "Emirates Base Oils DMCC", [["baseoil", "premium", null], ["bitumart", "premium", null]]],
  ["rahul@apexlubes.example", "Rahul Menon", "Apex Lubricants Pvt Ltd", [["baseoil", "premium", null]]],
  ["ops@goldenbitumen.example", "Omar Haddad", "Golden Bitumen Trading FZE", [["bitumart", "premium", null]]],
  ["s.alrashid@gulfbitumen.example", "Salim Al-Rashid", "Gulf Bitumen Co", [["bitumart", "trial", "2099-01-01"]]],
  ["admin@pcinsights.example", "Priya Nair", "PetroChem Insights Ltd", [["baseoil", "premium", "2025-08-12"]]],
  ["info@krishnapetro.example", "Krishna Rao", "Krishna Petrochem", [["baseoil", "free", null]]],
];

async function main(): Promise<void> {
  const database = db();
  const today = new Date();

  for (const [slug, rows] of Object.entries(BRANDS)) {
    const [site] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

    if (!site) {
      console.log(`no ${slug} site — run db:seed first`);
      continue;
    }

    for (const [title, price] of rows) {
      const [location] = await database
        .insert(locations)
        .values({ siteId: site.id, title, currency: title.includes("EUR") ? "EUR" : "USD" })
        .onConflictDoNothing()
        .returning();

      const id =
        location?.id ??
        (
          await database
            .select()
            .from(locations)
            .where(eq(locations.title, title))
            .limit(1)
        )[0]?.id;

      if (!id) {
        continue;
      }

      // Twelve weeks of history, so the charts and freshness have something
      // to say.
      for (let week = 11; week >= 0; week -= 1) {
        const when = new Date(today.getTime() - week * 7 * 86_400_000);
        const drift = 1 + Math.sin(week / 2) * 0.02;

        await database
          .insert(prices)
          .values({
            siteId: site.id,
            locationId: id,
            price: (price * drift).toFixed(2),
            currency: title.includes("EUR") ? "EUR" : "USD",
            priceDate: when.toISOString().slice(0, 10),
          })
          .onConflictDoNothing();
      }
    }
  }

  const hash = await hashPassword(PASSWORD);

  for (const [email, name, company, grants] of PEOPLE) {
    const [person] = await database
      .insert(users)
      .values({ email, name, company, passwordHash: hash, emailVerifiedAt: new Date() })
      .onConflictDoNothing({ target: users.email })
      .returning();

    const id =
      person?.id ??
      (await database.select().from(users).where(eq(users.email, email)).limit(1))[0]?.id;

    if (!id) {
      continue;
    }

    for (const [slug, tier, expiresAt] of grants) {
      const [site] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

      if (site) {
        await database
          .insert(memberships)
          .values({ userId: id, siteId: site.id, role: "subscriber", tier, expiresAt })
          .onConflictDoNothing();
      }
    }
  }

  // A staff member scoped to one brand, to exercise the scoping by hand.
  const [editor] = await database
    .insert(users)
    .values({
      email: "editor@petrosil.example",
      name: "Sagufta",
      passwordHash: hash,
      emailVerifiedAt: new Date(),
    })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (editor) {
    const [site] = await database.select().from(sites).where(eq(sites.slug, "baseoil")).limit(1);

    if (site) {
      await database
        .insert(memberships)
        .values({ userId: editor.id, siteId: site.id, role: "staff" })
        .onConflictDoNothing();
    }
  }

  // Everything the brand sites read: something to sell, something to read,
  // and the pages the footer links to. Without these the public API answers
  // correctly but with empty arrays, which looks the same as broken.
  for (const slug of Object.keys(BRANDS)) {
    const [site] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

    if (!site) {
      continue;
    }

    const [plan] = await database
      .insert(plans)
      .values({
        siteId: site.id,
        code: "annual",
        name: `${site.name} Price Service`,
        description: "Full access to every assessment, the history and the weekly note.",
        currency: site.defaultCurrency,
      })
      .onConflictDoNothing()
      .returning();

    if (plan) {
      await database
        .insert(planPrices)
        .values([
          { planId: plan.id, years: 1, amount: "1200.00" },
          { planId: plan.id, years: 2, amount: "2100.00" },
          { planId: plan.id, years: 3, amount: "2900.00" },
        ])
        .onConflictDoNothing();
    }

    const [category] = await database
      .insert(articleCategories)
      .values({ siteId: site.id, slug: "market-news", name: "Market news" })
      .onConflictDoNothing()
      .returning();

    await database
      .insert(articles)
      .values([
        {
          siteId: site.id,
          categoryId: category?.id ?? null,
          slug: "weekly-wrap-asia-holds-firm",
          title: "Weekly wrap: Asia holds firm as cargoes thin out",
          excerpt: "Buyers stayed on the sidelines, and sellers saw no reason to move.",
          body: "The week opened quietly and ended quieter still. " .repeat(20),
          status: "published",
          publishedAt: new Date(Date.now() - 2 * 86_400_000),
        },
        {
          siteId: site.id,
          categoryId: category?.id ?? null,
          slug: "quarterly-outlook",
          title: "Quarterly outlook: where margins go from here",
          excerpt: "Our read on the next three months, and what would change it.",
          body: "SUBSCRIBER ANALYSIS. " .repeat(40),
          status: "published",
          premiumOnly: true,
          publishedAt: new Date(Date.now() - 86_400_000),
        },
        {
          siteId: site.id,
          categoryId: category?.id ?? null,
          slug: "not-published-yet",
          title: "A draft nobody outside should see",
          excerpt: "If this is reachable from /api/public, something is wrong.",
          body: "Draft.",
          status: "draft",
        },
      ])
      .onConflictDoNothing();

    await database
      .insert(pages)
      .values([
        {
          siteId: site.id,
          slug: "methodology",
          title: "Methodology",
          body: "How each assessment is made, and what goes into it.",
        },
        {
          siteId: site.id,
          slug: "about-us",
          title: "About us",
          body: "Petrosil has published price assessments since 1996.",
        },
      ])
      .onConflictDoNothing();

    await database
      .insert(announcements)
      .values({ siteId: site.id, body: "Assessments now published twice weekly." })
      .onConflictDoNothing();

    await database
      .insert(priceSummaries)
      .values({
        siteId: site.id,
        source: "editorial",
        summary:
          "Prices were mostly steady this week, with the Asian markers firmer and Europe unchanged.",
      })
      .onConflictDoNothing();
  }

  await database
    .insert(coupons)
    .values({ code: "WELCOME10", percentOff: 10, maxRedemptions: 100 })
    .onConflictDoNothing();

  console.log(`demo data in place — every account's password is: ${PASSWORD}`);
  console.log("  editor@petrosil.example  staff, baseoil only");
  console.log("  tanvi@ebo.example        premium on two brands");
  console.log("coupon WELCOME10 (10%), one annual plan per brand, 2 published articles + 1 draft");

  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
