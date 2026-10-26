/**
 * The admin screens' own domain functions.
 *
 * Everything here is scoped the same way the API is: `siteIds` empty means
 * superadmin, a non-empty list means exactly those brands and no others. Each
 * of these is the estate-wide version of something the nine PHP admins each
 * showed only for themselves, so the scoping test is the one that matters.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { resetDatabase, makeBrand } from "./helpers";
import { db } from "@/db";
import {
  announcements,
  articleCategories,
  articles,
  coupons,
  memberships,
  orders,
  pages,
  planPrices,
  plans,
  priceCrawlUrls,
  users,
} from "@/db/schema";
import { brandsFor } from "@/domain/dashboard/brands";
import {
  articleTally,
  listAnnouncements,
  listCategories,
  listCoupons,
  listPlans,
  listStaff,
  listTransactions,
  listWatchedUrls,
  staffPages,
} from "@/domain/dashboard/catalogue";

beforeEach(resetDatabase);

describe("the brand picker", () => {
  test("a superadmin can filter by every brand, named and in order", async () => {
    await makeBrand("waxreport", []);
    await makeBrand("baseoil", []);

    const brands = await brandsFor([]);

    expect(brands.map((brand) => brand.slug)).toEqual(["baseoil", "waxreport"]);
  });

  test("staff are only offered the brands they were granted", async () => {
    const baseoil = await makeBrand("baseoil", []);
    await makeBrand("bitumart", []);

    const brands = await brandsFor([baseoil.siteId]);

    expect(brands.map((brand) => brand.slug)).toEqual(["baseoil"]);
  });
});

describe("content pages, from the team's side", () => {
  test("lists every brand's pages with the brand named", async () => {
    const baseoil = await makeBrand("baseoil", []);
    const wax = await makeBrand("waxreport", []);

    await db()
      .insert(pages)
      .values([
        { siteId: baseoil.siteId, slug: "about", title: "About us", body: "Hello" },
        { siteId: wax.siteId, slug: "terms", title: "Terms", body: "Legal", visible: false },
      ]);

    const rows = await staffPages([]);

    expect(rows.map((row) => [row.site, row.slug, row.visible])).toEqual([
      ["baseoil", "about", true],
      ["waxreport", "terms", false],
    ]);
  });

  test("staff see only their own brand's pages", async () => {
    const baseoil = await makeBrand("baseoil", []);
    const wax = await makeBrand("waxreport", []);

    await db()
      .insert(pages)
      .values([
        { siteId: baseoil.siteId, slug: "about", title: "About us", body: "Hello" },
        { siteId: wax.siteId, slug: "terms", title: "Terms", body: "Legal" },
      ]);

    expect((await staffPages([baseoil.siteId])).map((row) => row.slug)).toEqual(["about"]);
  });
});

describe("the announcement strip", () => {
  test("says which ones are actually showing today", async () => {
    const brand = await makeBrand("baseoil", []);

    await db()
      .insert(announcements)
      .values([
        { siteId: brand.siteId, body: "Running", startsAt: "2020-01-01", endsAt: "2099-01-01" },
        { siteId: brand.siteId, body: "Over", startsAt: "2020-01-01", endsAt: "2020-02-01" },
        { siteId: brand.siteId, body: "Switched off", enabled: false },
      ]);

    const byBody = new Map((await listAnnouncements([])).map((row) => [row.body, row.live]));

    expect(byBody.get("Running")).toBe(true);
    expect(byBody.get("Over")).toBe(false);
    expect(byBody.get("Switched off")).toBe(false);
  });
});

describe("the plan catalogue", () => {
  test("carries each plan's terms and what it has sold", async () => {
    const brand = await makeBrand("baseoil", []);

    const [plan] = await db()
      .insert(plans)
      .values({ siteId: brand.siteId, code: "pro", name: "Professional", currency: "USD" })
      .returning();

    await db()
      .insert(planPrices)
      .values([
        { planId: plan!.id, years: 1, amount: "1200.00" },
        { planId: plan!.id, years: 2, amount: "2200.00" },
      ]);

    const [person] = await db()
      .insert(users)
      .values({ email: "buyer@x.example", name: "Buyer" })
      .returning();

    await db()
      .insert(orders)
      .values([
        {
          siteId: brand.siteId,
          userId: person!.id,
          planId: plan!.id,
          planName: "Professional",
          years: 1,
          currency: "USD",
          listAmount: "1200.00",
          amount: "1200.00",
          status: "paid",
        },
        {
          siteId: brand.siteId,
          userId: person!.id,
          planId: plan!.id,
          planName: "Professional",
          years: 1,
          currency: "USD",
          listAmount: "1200.00",
          amount: "1200.00",
          status: "pending",
        },
      ]);

    const [row] = await listPlans([]);

    expect(row!.terms).toEqual([
      { years: 1, amount: 1200 },
      { years: 2, amount: 2200 },
    ]);
    // Paid only: a pending order has sold nothing yet.
    expect(row!.sold).toBe(1);
  });
});

describe("coupons", () => {
  test("a code past its expiry reads as expired, not merely enabled", async () => {
    await db()
      .insert(coupons)
      .values([
        { code: "LIVE10", percentOff: 10, expiresAt: "2099-01-01" },
        { code: "OLD10", percentOff: 10, expiresAt: "2020-01-01" },
        { code: "OFF10", percentOff: 10, enabled: false },
        { code: "USEDUP", percentOff: 10, maxRedemptions: 2, redeemed: 2 },
      ]);

    const byCode = new Map((await listCoupons([])).map((row) => [row.code, row.state]));

    expect(byCode.get("LIVE10")).toBe("live");
    expect(byCode.get("OLD10")).toBe("expired");
    expect(byCode.get("OFF10")).toBe("off");
    expect(byCode.get("USEDUP")).toBe("used up");
  });
});

describe("transactions", () => {
  test("pages orders newest first, with the buyer attached", async () => {
    const brand = await makeBrand("baseoil", []);
    const [person] = await db()
      .insert(users)
      .values({ email: "buyer@x.example", name: "Buyer", company: "Buyer Ltd" })
      .returning();

    for (const amount of ["100.00", "200.00"]) {
      await db().insert(orders).values({
        siteId: brand.siteId,
        userId: person!.id,
        planName: "Professional",
        years: 1,
        currency: "USD",
        listAmount: amount,
        amount,
        status: "paid",
      });
    }

    const paged = await listTransactions([], { perPage: 1 });

    expect(paged.total).toBe(2);
    expect(paged.rows).toHaveLength(1);
    expect(paged.rows[0]!.who).toBe("Buyer");
    expect(paged.rows[0]!.amount).toBe(200);
  });
});

describe("article categories", () => {
  test("counts the articles filed under each", async () => {
    const brand = await makeBrand("baseoil", []);
    const [category] = await db()
      .insert(articleCategories)
      .values({ siteId: brand.siteId, slug: "news", name: "News" })
      .returning();

    await db()
      .insert(articles)
      .values([
        {
          siteId: brand.siteId,
          categoryId: category!.id,
          slug: "one",
          title: "One",
          body: "x",
          status: "published",
        },
        { siteId: brand.siteId, slug: "two", title: "Two", body: "x", status: "published" },
      ]);

    const [row] = await listCategories([]);

    expect(row!.articles).toBe(1);
  });
});

describe("the staff list", () => {
  test("shows team members and leaves readers out", async () => {
    const brand = await makeBrand("baseoil", []);

    const [editor] = await db()
      .insert(users)
      .values({ email: "editor@x.example", name: "Editor" })
      .returning();
    const [reader] = await db()
      .insert(users)
      .values({ email: "reader@x.example", name: "Reader" })
      .returning();

    await db()
      .insert(memberships)
      .values([
        { userId: editor!.id, siteId: brand.siteId, role: "staff" },
        { userId: reader!.id, siteId: brand.siteId, role: "subscriber" },
      ]);

    const rows = await listStaff([]);

    expect(rows.map((row) => row.email)).toEqual(["editor@x.example"]);
    // No named role: full access to the brand.
    expect(rows[0]!.brands).toEqual([{ slug: "baseoil", name: "baseoil", role: "staff", roleId: null, roleName: null }]);
  });
});

describe("the watch list", () => {
  test("gathers every brand's watched URLs into one screen", async () => {
    const baseoil = await makeBrand("baseoil", []);
    const wax = await makeBrand("waxreport", []);

    await db()
      .insert(priceCrawlUrls)
      .values([
        { siteId: baseoil.siteId, url: "https://a.example/prices", lastStatus: "updated" },
        { siteId: wax.siteId, url: "https://b.example/prices", enabled: false },
      ]);

    const rows = await listWatchedUrls([]);

    expect(rows.map((row) => [row.site, row.enabled])).toEqual([
      ["baseoil", true],
      ["waxreport", false],
    ]);
    expect(rows[0]!.status_label).toBe("Price change found");
  });
});

describe("the article counts behind the filter chips", () => {
  test("count every article, not just the page being shown", async () => {
    const brand = await makeBrand("baseoil", []);

    await db()
      .insert(articles)
      .values(
        Array.from({ length: 30 }, (_, at) => ({
          siteId: brand.siteId,
          slug: `piece-${at}`,
          title: `Piece ${at}`,
          body: "x",
          status: at < 20 ? "published" : "draft",
        })),
      );

    const tally = await articleTally([], {});

    expect(tally).toEqual({ all: 30, published: 20, draft: 10, withdrawn: 0 });
  });

  test("respect the search the chips are sitting next to", async () => {
    const brand = await makeBrand("baseoil", []);

    await db()
      .insert(articles)
      .values([
        { siteId: brand.siteId, slug: "a", title: "Singapore eases", body: "x", status: "published" },
        { siteId: brand.siteId, slug: "b", title: "Mumbai firms", body: "x", status: "published" },
      ]);

    expect((await articleTally([], { search: "Singapore" })).all).toBe(1);
  });
});
