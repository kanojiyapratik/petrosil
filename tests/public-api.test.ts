/**
 * The brand sites' own read API — the paid product, seen from outside.
 *
 * The paywall rule itself is unit-tested in paywall.test.ts. What is checked
 * here is that it actually reaches the wire: that a locked reply carries no
 * figure anywhere in its JSON, not merely a `locked: true` flag next to one.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as brandsRoute } from "@/app/api/public/sites/route";
import { GET as trendsRoute } from "@/app/api/public/[site]/price-trends/route";
import { GET as locationRoute } from "@/app/api/public/[site]/locations/[id]/route";
import { GET as insightsRoute } from "@/app/api/public/[site]/insights/route";
import { GET as searchRoute } from "@/app/api/public/[site]/search/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";

import { db } from "@/db";
import { locations, memberships, priceSummaries, sites, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { today } from "@/domain/price/dates";
import { dayOffset, makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const PASSWORD = "hunter22";
const TODAY = today();

let baseoil: Brand;
let bitumart: Brand;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", ["Singapore SN 150 FOB", "UAE SN 500"]);
  bitumart = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);
});

async function reader(
  email: string,
  grant: { brand: Brand; tier?: string; expiresAt?: string | null; role?: string },
): Promise<void> {
  const [row] = await db()
    .insert(users)
    .values({
      email,
      name: email.split("@")[0]!,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
    })
    .returning();

  await db().insert(memberships).values({
    userId: row!.id,
    siteId: grant.brand.siteId,
    role: grant.role ?? "subscriber",
    tier: grant.tier ?? "free",
    expiresAt: grant.expiresAt ?? null,
  });
}

async function signedIn(email: string): Promise<string> {
  const response = await loginRoute(
    new Request("http://platform.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const visit = (url: string, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, { headers: cookie ? { cookie } : {} });

const context = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

/* ------------------------------------------------------------ price trends */

describe("the price trends page", () => {
  beforeEach(async () => {
    await publishPrice(baseoil, "Singapore SN 150 FOB", 820, "2026-10-09");
    await publishPrice(baseoil, "Singapore SN 150 FOB", 830, "2026-10-16");
    await publishPrice(baseoil, "UAE SN 500", 1340, "2026-10-16");
  });

  it("gives a visitor the names, the dates and which way each price moved", async () => {
    const body = await (
      await trendsRoute(visit("/api/public/baseoil/price-trends"), context({ site: "baseoil" }))
    ).json();

    const row = body.locations.find((l: { title: string }) => l.title === "Singapore SN 150 FOB");

    expect(row.movement).toBe("up");
    expect(row.price_date).toBe("2026-10-16");
    expect(row.locked).toBe(true);
    expect(body.entitlement).toMatchObject({ entitled: false, reason: "anonymous" });
  });

  it("puts no figure anywhere in a locked reply", async () => {
    const response = await trendsRoute(
      visit("/api/public/baseoil/price-trends"),
      context({ site: "baseoil" }),
    );
    const text = await response.text();

    expect(text).not.toContain("830");
    expect(text).not.toContain("820");
    expect(text).not.toContain("1340");
  });

  it("gives a paying reader the figures and the change", async () => {
    await reader("payer@company.example", { brand: baseoil, tier: "premium" });
    const cookie = await signedIn("payer@company.example");

    const body = await (
      await trendsRoute(visit("/api/public/baseoil/price-trends", cookie), context({ site: "baseoil" }))
    ).json();

    const row = body.locations.find((l: { title: string }) => l.title === "Singapore SN 150 FOB");

    expect(row).toMatchObject({
      price: 830,
      previous_price: 820,
      change_pct: 1.22,
      movement: "up",
      locked: false,
    });
    expect(body.entitlement).toMatchObject({ entitled: true, reason: "premium" });
  });

  it("locks the page again once a subscription has lapsed", async () => {
    await reader("lapsed@company.example", {
      brand: baseoil,
      tier: "premium",
      expiresAt: dayOffset(new Date(), -1),
    });
    const cookie = await signedIn("lapsed@company.example");

    const body = await (
      await trendsRoute(visit("/api/public/baseoil/price-trends", cookie), context({ site: "baseoil" }))
    ).json();

    expect(body.entitlement).toMatchObject({ entitled: false, reason: "expired" });
    expect(body.locations[0].price).toBeNull();
  });

  it("does not let a subscription to one brand unlock another", async () => {
    await reader("payer@company.example", { brand: bitumart, tier: "premium" });
    const cookie = await signedIn("payer@company.example");

    const body = await (
      await trendsRoute(visit("/api/public/baseoil/price-trends", cookie), context({ site: "baseoil" }))
    ).json();

    expect(body.entitlement).toMatchObject({ entitled: false, reason: "no_membership" });
    expect(body.locations[0].price).toBeNull();
  });

  it("reads a price that did not move as flat, not as a rise of nothing", async () => {
    await publishPrice(baseoil, "UAE SN 500", 1340, "2026-10-17");
    await reader("payer@company.example", { brand: baseoil, tier: "premium" });
    const cookie = await signedIn("payer@company.example");

    const body = await (
      await trendsRoute(visit("/api/public/baseoil/price-trends", cookie), context({ site: "baseoil" }))
    ).json();
    const row = body.locations.find((l: { title: string }) => l.title === "UAE SN 500");

    expect(row.movement).toBe("flat");
    expect(row.change_pct).toBe(0);
  });

  it("says nothing at all about a location the brand has hidden", async () => {
    await db()
      .update(locations)
      .set({ visible: false })
      .where(eqLocation(baseoil.locationIds["UAE SN 500"]!));

    const body = await (
      await trendsRoute(visit("/api/public/baseoil/price-trends"), context({ site: "baseoil" }))
    ).json();

    expect(body.locations.map((l: { title: string }) => l.title)).toEqual(["Singapore SN 150 FOB"]);
  });

  it("reports the date of the newest figure on the brand as its as-of", async () => {
    const body = await (
      await trendsRoute(visit("/api/public/baseoil/price-trends"), context({ site: "baseoil" }))
    ).json();

    expect(body.as_of).toBe("2026-10-16");
  });

  it("answers 404 for a brand that does not exist", async () => {
    const response = await trendsRoute(
      visit("/api/public/nosuchbrand/price-trends"),
      context({ site: "nosuchbrand" }),
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 for a brand that has been switched off", async () => {
    await db().update(sites).set({ enabled: false }).where(eqSite(baseoil.siteId));

    const response = await trendsRoute(
      visit("/api/public/baseoil/price-trends"),
      context({ site: "baseoil" }),
    );

    expect(response.status).toBe(404);
  });
});

/* --------------------------------------------------------- price history */

describe("one location's history", () => {
  beforeEach(async () => {
    for (let week = 12; week >= 0; week -= 1) {
      await publishPrice(
        baseoil,
        "Singapore SN 150 FOB",
        800 + (12 - week) * 5,
        dayOffset(new Date(), -week * 7),
      );
    }
  });

  it("gives a paying reader the series, newest first", async () => {
    await reader("payer@company.example", { brand: baseoil, tier: "premium" });
    const cookie = await signedIn("payer@company.example");
    const id = baseoil.locationIds["Singapore SN 150 FOB"]!;

    const body = await (
      await locationRoute(
        visit(`/api/public/baseoil/locations/${id}`, cookie),
        context({ site: "baseoil", id: String(id) }),
      )
    ).json();

    expect(body.locked).toBe(false);
    expect(body.points).toHaveLength(13);
    expect(body.points[0].price).toBe(860);
    expect(body.points[0].price_date).toBe(TODAY);
    expect(body.points[1].price).toBe(855);
  });

  it("holds the whole series back from a visitor, and says how much there is", async () => {
    const id = baseoil.locationIds["Singapore SN 150 FOB"]!;

    const response = await locationRoute(
      visit(`/api/public/baseoil/locations/${id}`),
      context({ site: "baseoil", id: String(id) }),
    );
    const text = await response.text();
    const body = JSON.parse(text);

    expect(body.locked).toBe(true);
    expect(body.points).toEqual([]);
    expect(body.points_available).toBe(13);
    expect(body.location.title).toBe("Singapore SN 150 FOB");
    expect(text).not.toContain("860");
  });

  it("narrows the series to the weeks asked for", async () => {
    await reader("payer@company.example", { brand: baseoil, tier: "premium" });
    const cookie = await signedIn("payer@company.example");
    const id = baseoil.locationIds["Singapore SN 150 FOB"]!;

    const body = await (
      await locationRoute(
        visit(`/api/public/baseoil/locations/${id}?weeks=4`, cookie),
        context({ site: "baseoil", id: String(id) }),
      )
    ).json();

    expect(body.points).toHaveLength(5);
  });

  it("answers 404 for a location belonging to another brand", async () => {
    const id = bitumart.locationIds["Bitumen Singapore Drum FOB"]!;

    const response = await locationRoute(
      visit(`/api/public/baseoil/locations/${id}`),
      context({ site: "baseoil", id: String(id) }),
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 for a location the brand has hidden", async () => {
    await db()
      .update(locations)
      .set({ visible: false })
      .where(eqLocation(baseoil.locationIds["Singapore SN 150 FOB"]!));

    const id = baseoil.locationIds["Singapore SN 150 FOB"]!;
    const response = await locationRoute(
      visit(`/api/public/baseoil/locations/${id}`),
      context({ site: "baseoil", id: String(id) }),
    );

    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------- market insights */

describe("AI market insights", () => {
  beforeEach(async () => {
    await db()
      .insert(priceSummaries)
      .values([
        { siteId: baseoil.siteId, summary: "Base oil held firm across Asia.", source: "editorial" },
        { siteId: baseoil.siteId, summary: "Singapore SN 150 edged higher.", source: "editorial" },
        { siteId: bitumart.siteId, summary: "Bitumen eased in the Gulf.", source: "editorial" },
      ]);
  });

  it("is readable by anyone, because the note is written from movements only", async () => {
    const body = await (
      await insightsRoute(visit("/api/public/baseoil/insights"), context({ site: "baseoil" }))
    ).json();

    expect(body.latest.summary).toBe("Singapore SN 150 edged higher.");
    expect(body.archive).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("shows only this brand's notes", async () => {
    const body = await (
      await insightsRoute(visit("/api/public/bitumart/insights"), context({ site: "bitumart" }))
    ).json();

    expect(body.archive.map((note: { summary: string }) => note.summary)).toEqual([
      "Bitumen eased in the Gulf.",
    ]);
  });

  it("says plainly that there is no note yet rather than failing", async () => {
    await makeBrand("fertilizer", ["Urea Middle East"]);

    const body = await (
      await insightsRoute(visit("/api/public/fertilizer/insights"), context({ site: "fertilizer" }))
    ).json();

    expect(body.latest).toBeNull();
    expect(body.archive).toEqual([]);
  });
});

/* -------------------------------------------------------------- the estate */

describe("the brand list behind the umbrella home page", () => {
  it("lists every live brand with how much it tracks", async () => {
    await publishPrice(baseoil, "Singapore SN 150 FOB", 830, "2026-10-16");

    const body = await (await brandsRoute(visit("/api/public/sites"))).json();
    const base = body.sites.find((s: { slug: string }) => s.slug === "baseoil");

    expect(base).toMatchObject({ slug: "baseoil", locations: 2, latest_pricedate: "2026-10-16" });
    expect(body.sites).toHaveLength(2);
  });

  it("leaves a switched-off brand out", async () => {
    await db().update(sites).set({ enabled: false }).where(eqSite(bitumart.siteId));

    const body = await (await brandsRoute(visit("/api/public/sites"))).json();

    expect(body.sites.map((s: { slug: string }) => s.slug)).toEqual(["baseoil"]);
  });

  it("never carries a figure, because the home page is public", async () => {
    await publishPrice(baseoil, "Singapore SN 150 FOB", 830, "2026-10-16");

    const text = await (await brandsRoute(visit("/api/public/sites"))).text();

    expect(text).not.toContain("830");
  });
});

/* ----------------------------------------------------------------- search */

describe("searching one brand", () => {
  beforeEach(async () => {
    await publishPrice(baseoil, "Singapore SN 150 FOB", 830, "2026-10-16");
    await db()
      .insert(priceSummaries)
      .values({ siteId: baseoil.siteId, summary: "Singapore cargoes thinned out.", source: "editorial" });
  });

  it("finds a location by part of its name", async () => {
    const body = await (
      await searchRoute(visit("/api/public/baseoil/search?q=singapore"), context({ site: "baseoil" }))
    ).json();

    expect(body.locations.map((l: { title: string }) => l.title)).toEqual(["Singapore SN 150 FOB"]);
  });

  it("finds a market note by its words", async () => {
    const body = await (
      await searchRoute(visit("/api/public/baseoil/search?q=thinned"), context({ site: "baseoil" }))
    ).json();

    expect(body.insights).toHaveLength(1);
  });

  it("keeps the paywall on in the results a visitor gets back", async () => {
    const text = await (
      await searchRoute(visit("/api/public/baseoil/search?q=singapore"), context({ site: "baseoil" }))
    ).text();

    expect(text).not.toContain("830");
  });

  it("answers with nothing for an empty search rather than the whole brand", async () => {
    const body = await (
      await searchRoute(visit("/api/public/baseoil/search?q="), context({ site: "baseoil" }))
    ).json();

    expect(body.locations).toEqual([]);
    expect(body.insights).toEqual([]);
  });
});

/* Small helpers kept at the bottom: drizzle's eq imported lazily would make
 * the top of this file noisier than the tests themselves. */
import { eq } from "drizzle-orm";

function eqLocation(id: number) {
  return eq(locations.id, id);
}

function eqSite(id: number) {
  return eq(sites.id, id);
}
