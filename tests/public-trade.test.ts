/**
 * Monthly import and export quantities on the brand sites.
 *
 * Movement and names are public, figures are paid for: anyone sees which
 * countries report and which months are on record; only a paying reader
 * gets the quantities. An export runs from the reporting country, an import
 * into it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { tradeLocations, tradeQuantities } from "@/db/schema";
import { tradeCountries, tradeYear } from "@/domain/public/trade";
import { GET as countryRoute } from "@/app/api/public/[site]/trade/[id]/[kind]/route";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let place: Record<string, number>;

const anonymous = { entitled: false, tier: "anonymous", reason: "anonymous" } as const;
const free = { entitled: false, tier: "free", reason: "free" } as const;
const lapsed = { entitled: false, tier: "free", reason: "expired" } as const;
const paying = { entitled: true, tier: "premium", reason: "premium" } as const;

async function places(brand: Brand, titles: string[], visible = true) {
  const rows = await db()
    .insert(tradeLocations)
    .values(titles.map((title) => ({ siteId: brand.siteId, title, visible })))
    .returning();

  return Object.fromEntries(rows.map((row) => [row.title, row.id]));
}

async function flow(kind: "import" | "export" | "qty", from: number, to: number, qtyDate: string, qty: string | null, brand = baseoil) {
  await db().insert(tradeQuantities).values({ siteId: brand.siteId, kind, fromLocationId: from, toLocationId: to, qtyDate, qty });
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  place = await places(baseoil, ["India", "Singapore", "Korea", "UAE"]);
  Object.assign(place, await places(baseoil, ["Hidden"], false));

  // India imports from Singapore and Korea.
  await flow("import", place.Singapore!, place.India!, "2025-11-01", "1200.500");
  await flow("import", place.Korea!, place.India!, "2025-11-01", "800");
  await flow("import", place.Singapore!, place.India!, "2026-01-01", "950");
  // An empty cell is no figure.
  await flow("import", place.UAE!, place.India!, "2026-01-01", null);
  // Singapore exports to UAE.
  await flow("export", place.Singapore!, place.UAE!, "2026-02-01", "300");
  // The dead "qty" set, and a hidden country, are not served.
  await flow("qty", place.Korea!, place.UAE!, "2021-05-01", "10");
  await flow("export", place.Hidden!, place.UAE!, "2026-02-01", "5");
});

describe("the countries that report", () => {
  it("lists visible reporting countries by what they report, with no figures", async () => {
    const countries = await tradeCountries(baseoil.siteId);

    expect(countries).toEqual([
      { id: place.India, title: "India", import: { months: 2, latest_month: "2026-01" }, export: null },
      { id: place.Singapore, title: "Singapore", import: null, export: { months: 1, latest_month: "2026-02" } },
    ]);
    expect(await tradeCountries(bitumart.siteId)).toEqual([]);
  });
});

describe("a country's year", () => {
  it("gives a paying reader each month's partners and total, largest first, in the latest year by default", async () => {
    const sheet = (await tradeYear(baseoil.siteId, { location: place.India!, kind: "import" }, paying))!;

    expect(sheet).toMatchObject({ country: { title: "India" }, unit: "MT", years: [2026, 2025], year: 2026, figures: { allowed: true, reason: null } });
    expect(sheet.months).toEqual([{ month: "2026-01", partners: 1, total: 950, flows: [{ country: "Singapore", qty: 950 }] }]);

    const before = (await tradeYear(baseoil.siteId, { location: place.India!, kind: "import", year: 2025 }, paying))!;

    expect(before.months).toEqual([
      {
        month: "2025-11",
        partners: 2,
        total: 2000.5,
        flows: [
          { country: "Singapore", qty: 1200.5 },
          { country: "Korea", qty: 800 },
        ],
      },
    ]);
  });

  it("gives everyone else the months without a figure, and says why", async () => {
    const sheet = (await tradeYear(baseoil.siteId, { location: place.India!, kind: "import", year: 2025 }, free))!;

    expect(sheet.months).toEqual([{ month: "2025-11", partners: 2, total: null, flows: [] }]);
    expect(sheet.figures).toEqual({ allowed: false, reason: "subscribe" });
    expect(JSON.stringify(sheet)).not.toContain("1200");
    expect((await tradeYear(baseoil.siteId, { location: place.India!, kind: "import" }, anonymous))!.figures.reason).toBe("sign_in");
    expect((await tradeYear(baseoil.siteId, { location: place.India!, kind: "import" }, lapsed))!.figures.reason).toBe("renew");
  });

  it("runs an export from the reporting country", async () => {
    const sheet = (await tradeYear(baseoil.siteId, { location: place.Singapore!, kind: "export" }, paying))!;

    expect(sheet.months).toEqual([{ month: "2026-02", partners: 1, total: 300, flows: [{ country: "UAE", qty: 300 }] }]);
  });

  it("falls back to the latest year for a year not on record", async () => {
    expect((await tradeYear(baseoil.siteId, { location: place.India!, kind: "import", year: 1999 }, paying))!.year).toBe(2026);
  });

  it("has nothing for a hidden country, a kind it does not report, or another brand", async () => {
    expect(await tradeYear(baseoil.siteId, { location: place.Hidden!, kind: "export" }, paying)).toBeNull();
    expect(await tradeYear(baseoil.siteId, { location: place.India!, kind: "export" }, paying)).toBeNull();
    expect(await tradeYear(bitumart.siteId, { location: place.India!, kind: "import" }, paying)).toBeNull();
  });

  it("counts a look at the country", async () => {
    await tradeYear(baseoil.siteId, { location: place.India!, kind: "import" }, anonymous);

    const [row] = await db().select().from(tradeLocations).where(eq(tradeLocations.id, place.India!));

    expect(row!.clicks).toBe(1);
  });
});

describe("over HTTP", () => {
  it("answers a country's year, and 404 for an unknown kind", async () => {
    const call = (kind: string) =>
      countryRoute(new Request(`http://localhost/api/public/baseoil/trade/${place.India}/${kind}?year=2025`), {
        params: Promise.resolve({ site: "baseoil", id: String(place.India), kind }),
      });

    const ok = await call("import");

    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ year: 2025, months: [{ month: "2025-11", total: null }], figures: { reason: "sign_in" } });
    expect((await call("qty")).status).toBe(404);
  });
});
