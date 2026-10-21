/**
 * The screens the platform had no tables for until now: reports, offers,
 * impex sheets, trade flows, ads, newsletters, currencies, uploaded files,
 * roles and settings.
 *
 * The tests worth having here are the ones with a decision in them — is an
 * ad running today, does a brand's setting override the estate's, which
 * fields does a free reader see — rather than the plain joins.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { resetDatabase, makeBrand } from "./helpers";
import { db } from "@/db";
import {
  adPlacements,
  ads,
  currencies,
  formFields,
  impexSheets,
  mediaFiles,
  memberships,
  newsletters,
  offers,
  rolePermissions,
  roles,
  settings,
  tradeLocations,
  tradeQuantities,
  users,
  reports,
} from "@/db/schema";
import { listImpex, listOffers, listReports } from "@/domain/dashboard/publishing";
import { tradeMatrix, tradePlaces, tradeSeries } from "@/domain/dashboard/trade";
import { listAds, listNewsletters, listPlacements } from "@/domain/dashboard/promotion";
import { listCurrencies, listFormFields, listMedia } from "@/domain/dashboard/masters";
import { PERMISSIONS, listRoles } from "@/domain/dashboard/permissions";
import { SETTINGS, settingsFor } from "@/domain/dashboard/settings";

beforeEach(resetDatabase);

describe("reports", () => {
  test("staff see only their own brand's", async () => {
    const baseoil = await makeBrand("baseoil", []);
    const wax = await makeBrand("waxreport", []);

    await db()
      .insert(reports)
      .values([
        {
          siteId: baseoil.siteId,
          slug: "week-40",
          title: "Week 40",
          reportType: "weekly",
          status: "published",
        },
        {
          siteId: wax.siteId,
          slug: "week-40",
          title: "Week 40",
          reportType: "weekly",
          status: "published",
        },
      ]);

    const mine = await listReports([baseoil.siteId]);

    expect(mine.total).toBe(1);
    expect(mine.rows[0]!.site).toBe("baseoil");
  });
});

describe("offers", () => {
  test("can be narrowed to buyers or sellers", async () => {
    const brand = await makeBrand("baseoil", []);

    await db()
      .insert(offers)
      .values([
        { siteId: brand.siteId, subject: "Wanted SN150", offerType: "buy" },
        { siteId: brand.siteId, subject: "SN500 available", offerType: "sell" },
      ]);

    const buying = await listOffers([], { type: "buy" });

    expect(buying.rows.map((row) => row.subject)).toEqual(["Wanted SN150"]);
  });
});

describe("impex sheets", () => {
  test("are listed newest first", async () => {
    const brand = await makeBrand("baseoil", []);

    await db()
      .insert(impexSheets)
      .values([
        { siteId: brand.siteId, slug: "jan", title: "January", authoredOn: "2026-01-31" },
        { siteId: brand.siteId, slug: "feb", title: "February", authoredOn: "2026-02-28" },
      ]);

    const sheets = await listImpex([]);

    expect(sheets.rows.map((row) => row.title)).toEqual(["February", "January"]);
  });
});

describe("trade flows", () => {
  test("totals a day's quantities and lays the pairs out as a matrix", async () => {
    const brand = await makeBrand("baseoil", []);

    const places = await db()
      .insert(tradeLocations)
      .values([
        { siteId: brand.siteId, title: "Singapore" },
        { siteId: brand.siteId, title: "Korea" },
        { siteId: brand.siteId, title: "India" },
      ])
      .returning();

    const [singapore, korea, india] = places;

    await db()
      .insert(tradeQuantities)
      .values([
        {
          siteId: brand.siteId,
          kind: "export",
          fromLocationId: singapore!.id,
          toLocationId: india!.id,
          qty: "1200.000",
          qtyDate: "2026-09-30",
        },
        {
          siteId: brand.siteId,
          kind: "export",
          fromLocationId: korea!.id,
          toLocationId: india!.id,
          qty: "800.000",
          qtyDate: "2026-09-30",
        },
        {
          siteId: brand.siteId,
          kind: "export",
          fromLocationId: singapore!.id,
          toLocationId: india!.id,
          qty: "900.000",
          qtyDate: "2026-08-31",
        },
      ]);

    const series = await tradeSeries([], { kind: "export" });

    expect(series).toEqual([
      { date: "2026-08-31", total: 900, pairs: 1 },
      { date: "2026-09-30", total: 2000, pairs: 2 },
    ]);

    // No date asked for: the newest one, which is what the screen opens on.
    const matrix = await tradeMatrix([], { kind: "export" });

    expect(matrix.date).toBe("2026-09-30");
    expect(matrix.rows).toEqual([
      { from: "Korea", cells: [{ to: "India", qty: 800 }], total: 800 },
      { from: "Singapore", cells: [{ to: "India", qty: 1200 }], total: 1200 },
    ]);
  });

  test("a place belongs to a kind because a flow of that kind names it", async () => {
    const brand = await makeBrand("baseoil", []);

    const places = await db()
      .insert(tradeLocations)
      .values([
        { siteId: brand.siteId, title: "Mumbai" },
        { siteId: brand.siteId, title: "Singapore" },
      ])
      .returning();

    await db().insert(tradeQuantities).values({
      siteId: brand.siteId,
      kind: "qty",
      fromLocationId: places[0]!.id,
      qty: "10.000",
      qtyDate: "2026-09-30",
    });

    // One place list, three kinds of flow over it: Singapore is a place but
    // took no part in a qty flow, so it is not on the qty screen.
    expect((await tradePlaces([], "qty")).map((row) => [row.title, row.flows])).toEqual([
      ["Mumbai", 1],
    ]);
    expect(await tradePlaces([], "export")).toEqual([]);
  });
});

describe("ads", () => {
  test("an ad outside its dates is not running, whatever its flag says", async () => {
    const brand = await makeBrand("baseoil", []);

    const [slot] = await db()
      .insert(adPlacements)
      .values({ siteId: brand.siteId, title: "Leaderboard" })
      .returning();

    await db()
      .insert(ads)
      .values([
        {
          siteId: brand.siteId,
          placementId: slot!.id,
          title: "Running",
          startsAt: "2020-01-01",
          endsAt: "2099-01-01",
        },
        {
          siteId: brand.siteId,
          placementId: slot!.id,
          title: "Finished",
          startsAt: "2020-01-01",
          endsAt: "2021-01-01",
        },
        { siteId: brand.siteId, placementId: slot!.id, title: "Paused", enabled: false },
      ]);

    const byTitle = new Map((await listAds([])).map((row) => [row.title, row.live]));

    expect(byTitle.get("Running")).toBe(true);
    expect(byTitle.get("Finished")).toBe(false);
    expect(byTitle.get("Paused")).toBe(false);
  });

  test("a placement carries how many ads are in it and how many are running", async () => {
    const brand = await makeBrand("baseoil", []);

    const [slot] = await db()
      .insert(adPlacements)
      .values({ siteId: brand.siteId, title: "Leaderboard" })
      .returning();

    await db()
      .insert(ads)
      .values([
        { siteId: brand.siteId, placementId: slot!.id, title: "One" },
        { siteId: brand.siteId, placementId: slot!.id, title: "Two", enabled: false },
      ]);

    const [row] = await listPlacements([]);

    expect(row!.ads).toBe(2);
    expect(row!.live).toBe(1);
  });
});

describe("newsletters", () => {
  test("a sent issue reports who it reached", async () => {
    const brand = await makeBrand("baseoil", []);

    await db()
      .insert(newsletters)
      .values({
        siteId: brand.siteId,
        title: "Week 40",
        body: "<p>Prices</p>",
        status: "sent",
        sentAt: new Date("2026-10-03T06:00:00Z"),
        recipients: 8931,
      });

    const [row] = (await listNewsletters([])).rows;

    expect(row!.recipients).toBe(8931);
    expect(row!.sent_at).toBe("2026-10-03T06:00:00.000Z");
  });
});

describe("currencies", () => {
  test("are one estate-wide list, counting the locations priced in each", async () => {
    await makeBrand("baseoil", ["Singapore SN 150"], "USD");
    await makeBrand("bitumart", ["Mumbai Bulk"], "INR");

    await db()
      .insert(currencies)
      .values([
        { code: "USD", title: "US Dollar", symbol: "$" },
        { code: "INR", title: "Indian Rupee", symbol: "₹" },
        { code: "EUR", title: "Euro", symbol: "€" },
      ]);

    const byCode = new Map((await listCurrencies()).map((row) => [row.code, row.locations]));

    expect(byCode.get("USD")).toBe(1);
    expect(byCode.get("INR")).toBe(1);
    expect(byCode.get("EUR")).toBe(0);
  });
});

describe("the paywalled fields of a directory entry", () => {
  test("says plainly which tier sees each field", async () => {
    const brand = await makeBrand("baseoil", []);

    await db()
      .insert(formFields)
      .values([
        {
          siteId: brand.siteId,
          form: "directory",
          key: "company_name",
          label: "Company",
          showFree: true,
          showPremium: true,
          sortOrder: 1,
        },
        {
          siteId: brand.siteId,
          form: "directory",
          key: "mobile",
          label: "Mobile",
          showFree: false,
          showPremium: true,
          sortOrder: 2,
        },
        { siteId: brand.siteId, form: "offer", key: "offer_value", label: "Value", sortOrder: 1 },
      ]);

    const rows = await listFormFields([], "directory");

    expect(rows.map((row) => [row.key, row.show_free, row.show_premium])).toEqual([
      ["company_name", true, true],
      ["mobile", false, true],
    ]);
  });
});

describe("roles", () => {
  test("the permission catalogue covers every screen the admin has", () => {
    const keys = PERMISSIONS.flatMap((group) => group.items.map((item) => item.key));

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("price-batch-commit");
    expect(keys).toContain("trade-analysis-view");
  });

  test("a role carries its permissions and how many people hold it", async () => {
    const brand = await makeBrand("baseoil", []);

    const [role] = await db()
      .insert(roles)
      .values({ name: "Content Management", description: "Writes, does not price" })
      .returning();

    await db()
      .insert(rolePermissions)
      .values([
        { roleId: role!.id, permission: "article-create" },
        { roleId: role!.id, permission: "article-edit" },
      ]);

    const [person] = await db()
      .insert(users)
      .values({ email: "writer@x.example", name: "Writer" })
      .returning();

    await db()
      .insert(memberships)
      .values({ userId: person!.id, siteId: brand.siteId, role: "staff", roleId: role!.id });

    const [row] = await listRoles([]);

    expect(row!.permissions).toEqual(["article-create", "article-edit"]);
    expect(row!.holders).toBe(1);
  });
});

describe("settings", () => {
  test("a brand's value overrides the estate's, and the screen says which it used", async () => {
    const brand = await makeBrand("baseoil", []);

    await db()
      .insert(settings)
      .values([
        { siteId: null, key: "site_support_email", value: "info@petrosil.com" },
        { siteId: brand.siteId, key: "site_support_email", value: "info@baseoilreport.com" },
        { siteId: null, key: "site_title", value: "Petrosil" },
      ]);

    const forBrand = new Map(
      (await settingsFor([], { site: "baseoil" })).map((row) => [row.key, row]),
    );

    expect(forBrand.get("site_support_email")!.value).toBe("info@baseoilreport.com");
    expect(forBrand.get("site_support_email")!.source).toBe("brand");
    expect(forBrand.get("site_title")!.value).toBe("Petrosil");
    expect(forBrand.get("site_title")!.source).toBe("estate");
  });

  test("a secret is never handed to the screen in full", async () => {
    await db().insert(settings).values({ siteId: null, key: "smtp_password", value: "SG.abc123xyz" });

    const row = (await settingsFor([], {})).find((item) => item.key === "smtp_password");

    expect(row!.secret).toBe(true);
    expect(row!.value).not.toContain("abc123");
    expect(row!.set).toBe(true);
  });

  test("the catalogue is the whole list, whether a value has been saved or not", async () => {
    const rows = await settingsFor([], {});

    expect(rows).toHaveLength(SETTINGS.length);
    expect(rows.every((row) => row.source === "unset")).toBe(true);
  });
});

describe("uploaded files", () => {
  test("staff see the estate's files and their own brand's, and no other brand's", async () => {
    const baseoil = await makeBrand("baseoil", []);
    const wax = await makeBrand("waxreport", []);

    await db()
      .insert(mediaFiles)
      .values([
        { siteId: null, path: "shared/logo.png", name: "logo.png", kind: "image/png", bytes: 100 },
        { siteId: baseoil.siteId, path: "baseoil/week-40.pdf", name: "week-40.pdf", kind: "application/pdf", bytes: 2048 },
        { siteId: wax.siteId, path: "wax/week-40.pdf", name: "week-40.pdf", kind: "application/pdf", bytes: 2048 },
      ]);

    const mine = await listMedia([baseoil.siteId]);

    expect(mine.rows.map((row) => row.path).sort()).toEqual([
      "baseoil/week-40.pdf",
      "shared/logo.png",
    ]);
    expect(mine.total).toBe(2);
  });
});
