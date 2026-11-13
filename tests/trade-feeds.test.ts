/**
 * Trade feeds: months read from government statistics, staged, matched,
 * published into the sheets, and narrated.
 *
 * The figures are the real ones the live sources were checked against: in
 * April 2026 Thailand imported 31,106,885 litres of base oil from Singapore,
 * which baseoil holds as 31,107.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { tradeLocationAliases, tradeLocations, tradeQuantities, tradeUpdates, users } from "@/db/schema";
import { saveSheet, saveTradePlace } from "@/domain/trade/sheets";
import {
  PartnerResolver,
  discardUpdate,
  feedsDue,
  insightFigures,
  listFeeds,
  parseCodes,
  publishUpdate,
  recordFeedResults,
  saveFeed,
  tradeUpdate,
  writeInsight,
} from "@/domain/trade/feeds";
import { countryCode } from "@/domain/trade/countries";
import { tradeYear } from "@/domain/public/trade";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

const calls: { path: string; json: unknown }[] = [];

vi.mock("@/lib/engine/client", async (original) => {
  const real = await original<typeof import("@/lib/engine/client")>();

  return {
    ...real,
    engine: vi.fn(async (_slug: string | null, path: string, call: { json?: unknown }) => {
      calls.push({ path, json: call.json });

      return { analysis: { status: "complete", output_markdown: "Imports from Singapore led the month.", model: "gpt-4.1", error: null } };
    }),
  };
});

let baseoil: Brand;
let staff: number;
let thailand: number;
let singapore: number;
let korea: number;
let qatar: number;

const guard = (siteIds: number[] = []) =>
  ({ identity: { user: { id: staff, email: "editor@petrosil.example" }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const place = async (title: string) => (await saveTradePlace(guard(), { site: "baseoil", title, visible: true }))!.id;

beforeEach(async () => {
  calls.length = 0;
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
  thailand = await place("Thailand");
  singapore = await place("Singapore");
  korea = await place("South Korea");
  qatar = await place("Qatar");
});

const feed = (extra: Record<string, unknown> = {}) =>
  saveFeed(guard(), {
    site: "baseoil",
    location: thailand,
    kind: "import",
    source: "thailand",
    hs_codes: "27101941000",
    product: "Lubricating base oil",
    ...extra,
  });

const read = (feedId: number, month: string, partners: { partner: string; iso2?: string | null; qty: string }[]) =>
  recordFeedResults(baseoil.siteId, [{ feed_id: feedId, month, status: "read", partners, unit: "LTR", source_url: "https://www.customs.go.th/x" }]);

const sheet = (date: string) =>
  db()
    .select()
    .from(tradeQuantities)
    .where(and(eq(tradeQuantities.siteId, baseoil.siteId), eq(tradeQuantities.kind, "import"), eq(tradeQuantities.qtyDate, date)));

describe("country names", () => {
  it("folds the sources' and the sheets' spellings onto one code", () => {
    expect(countryCode("Korea,Republic Of")).toBe("KR");
    expect(countryCode("Republic of Korea")).toBe("KR");
    expect(countryCode("South Korea")).toBe("KR");
    expect(countryCode("U Arab Emts")).toBe("AE");
    expect(countryCode("Kenya (60)")).toBe("KE");
    expect(countryCode("Türkiye")).toBe("TR");
    expect(countryCode("People's Republic of China")).toBe("CN");
    expect(countryCode("United States of America")).toBe("US");
    expect(countryCode("Atlantis")).toBeNull();
  });

  it("prefers the place the sheets actually use when two share a country", async () => {
    const turkey = await place("Turkey");
    const turkiye = await place("Republic of Turkiye");

    await saveSheet(guard(), { site: "baseoil", kind: "import", location: thailand, date: "2026-01-01", quantities: { [turkiye]: "5" } });

    const resolver = await PartnerResolver.forSite(baseoil.siteId);

    expect(resolver.resolve("TÜRKIYE", "TR")).toBe(turkiye);
    expect(turkey).not.toBe(turkiye);
  });

  it("prefers the place this sheet has used, even when another sheet uses its twin more", async () => {
    const laos = await place("Laos");
    const laoRepublic = await place("Lao Republic");

    await saveSheet(guard(), { site: "baseoil", kind: "export", location: singapore, date: "2026-01-01", quantities: { [laos]: "1" } });
    await saveSheet(guard(), { site: "baseoil", kind: "export", location: korea, date: "2026-01-01", quantities: { [laos]: "1" } });
    await saveSheet(guard(), { site: "baseoil", kind: "import", location: thailand, date: "2026-01-01", quantities: { [laoRepublic]: "1" } });

    const { id } = await feed();
    const [outcome] = await read(id, "2026-04", [{ partner: "Lao Pdr", iso2: "LA", qty: "1038" }]);
    const view = await tradeUpdate(guard(), "baseoil", Number(outcome!.update_id));

    expect(view.rows[0]).toMatchObject({ partner: "Lao Pdr", place: "Lao Republic" });
  });
});

describe("a feed", () => {
  it("takes product codes as digits and refuses anything else", () => {
    expect(parseCodes("2710.19.41, 27101946\n27101941")).toEqual(["27101941", "27101946"]);
    expect(() => parseCodes("base oil")).toThrow(/not a product code/);
    expect(() => parseCodes("")).toThrow(/at least one/);
  });

  it("is one per sheet", async () => {
    await feed();

    await expect(feed()).rejects.toThrow(/already have a feed/);
  });

  it("asks for the months after the latest the sheet holds, up to last month", async () => {
    const { id } = await feed();

    await saveSheet(guard(), { site: "baseoil", kind: "import", location: thailand, date: "2026-07-01", quantities: { [singapore]: "10" } });

    const [due] = await feedsDue(baseoil.siteId, new Date("2026-11-13T00:00:00Z"));

    expect(due).toMatchObject({ id, source: "thailand", kind: "import", hs_codes: ["27101941000"], reporter_iso2: "TH" });
    expect(due!.months).toEqual(["2026-08", "2026-09", "2026-10"]);
  });

  it("does not ask again for a month already waiting, and starts three months back on an empty sheet", async () => {
    const { id } = await feed();

    await read(id, "2026-08", [{ partner: "Singapore", iso2: "SG", qty: "100" }]);

    const [due] = await feedsDue(baseoil.siteId, new Date("2026-11-13T00:00:00Z"));

    expect(due!.months).toEqual(["2026-09", "2026-10"]);
  });
});

describe("a month the engine read", () => {
  it("is staged with each partner matched to the brand's place", async () => {
    const { id } = await feed();
    const [outcome] = await read(id, "2026-04", [
      { partner: "Singapore", iso2: "SG", qty: "31107" },
      { partner: "Korea,Republic Of", iso2: "KR", qty: "8614" },
      { partner: "Germany", iso2: "DE", qty: "43" },
    ]);

    expect(outcome).toMatchObject({ status: "staged", unmatched: 1 });

    const view = await tradeUpdate(guard(), "baseoil", Number(outcome!.update_id));

    expect(view.rows.map((row) => [row.partner, row.place, row.qty])).toEqual([
      ["Singapore", "Singapore", 31107],
      ["Korea,Republic Of", "South Korea", 8614],
      ["Germany", null, 43],
    ]);
    expect(await sheet("2026-04-01")).toEqual([]);
  });

  it("replaces a month still waiting rather than piling up a second", async () => {
    const { id } = await feed();

    await read(id, "2026-04", [{ partner: "Singapore", iso2: "SG", qty: "1" }]);
    await read(id, "2026-04", [{ partner: "Singapore", iso2: "SG", qty: "2" }]);

    const waiting = await db().select().from(tradeUpdates).where(eq(tradeUpdates.status, "pending"));

    expect(waiting.map((row) => row.rows[0]!.qty)).toEqual(["2.000"]);
  });

  it("records a failure on the feed without staging anything", async () => {
    const { id } = await feed();

    await recordFeedResults(baseoil.siteId, [{ feed_id: id, month: "2026-10", status: "failed", error: "Thai Customs answered HTTP 503." }]);

    const { feeds } = await listFeeds(guard(), "baseoil");

    expect(feeds[0]).toMatchObject({ last_status: "failed", last_error: "Thai Customs answered HTTP 503." });
    expect(await db().select().from(tradeUpdates)).toEqual([]);
  });
});

describe("publishing", () => {
  it("needs every partner matched, added or left out", async () => {
    const { id } = await feed();
    const [outcome] = await read(id, "2026-04", [{ partner: "Germany", iso2: "DE", qty: "43" }]);

    await expect(publishUpdate(guard(), { site: "baseoil", id: outcome!.update_id })).rejects.toThrow(/Match Germany/);
  });

  it("writes the month whole, adds a new country, remembers a hand match, and removes what the source dropped", async () => {
    const { id } = await feed();

    // Typed in by hand before the feed existed: Qatar, which the source no longer lists.
    await saveSheet(guard(), { site: "baseoil", kind: "import", location: thailand, date: "2026-04-01", quantities: { [qatar]: "9", [singapore]: "30000" } });

    const [outcome] = await read(id, "2026-04", [
      { partner: "Singapore", iso2: "SG", qty: "31107" },
      { partner: "Germany", iso2: "DE", qty: "43" },
      { partner: "Kor. Rep.", iso2: null, qty: "8614" },
      { partner: "Free zone", iso2: null, qty: "5" },
    ]);

    const result = await publishUpdate(guard(), {
      site: "baseoil",
      id: outcome!.update_id,
      matches: { "1": "new", "2": String(korea), "3": "skip" },
    });

    expect(result).toMatchObject({ written: 3, removed: 1 });

    const [germany] = await db().select().from(tradeLocations).where(eq(tradeLocations.title, "Germany"));
    const rows = await sheet("2026-04-01");

    expect(rows.map((row) => [row.fromLocationId, row.toLocationId, row.qty]).sort()).toEqual(
      [
        [singapore, thailand, "31107.000"],
        [germany!.id, thailand, "43.000"],
        [korea, thailand, "8614.000"],
      ].sort(),
    );

    const [alias] = await db().select().from(tradeLocationAliases);

    expect(alias).toMatchObject({ alias: "Kor. Rep.", locationId: korea });

    // Next month the hand match is already known.
    const [next] = await read(id, "2026-05", [{ partner: "Kor. Rep.", qty: "100" }]);

    expect(next).toMatchObject({ status: "staged", unmatched: 0 });
  });

  it("happens on its own for a feed set to, when every partner matched", async () => {
    const { id } = await feed({ auto_publish: true });
    const [outcome] = await read(id, "2026-04", [{ partner: "Singapore", iso2: "SG", qty: "31107" }]);

    expect(outcome).toMatchObject({ status: "published" });
    expect((await sheet("2026-04-01")).map((row) => row.qty)).toEqual(["31107.000"]);

    const [held] = await read(id, "2026-05", [{ partner: "Germany", iso2: "DE", qty: "1" }]);

    expect(held).toMatchObject({ status: "staged", unmatched: 1 });
  });

  it("cannot happen twice, and a discarded month writes nothing", async () => {
    const { id } = await feed();
    const [first] = await read(id, "2026-04", [{ partner: "Singapore", iso2: "SG", qty: "1" }]);

    await publishUpdate(guard(), { site: "baseoil", id: first!.update_id });
    await expect(publishUpdate(guard(), { site: "baseoil", id: first!.update_id })).rejects.toThrow(/already been decided/);

    const [second] = await read(id, "2026-05", [{ partner: "Singapore", iso2: "SG", qty: "1" }]);

    await discardUpdate(guard(), { site: "baseoil", id: second!.update_id });
    expect(await sheet("2026-05-01")).toEqual([]);
  });

  it("is refused to staff of another brand", async () => {
    const bitumart = await makeBrand("bitumart", []);
    const { id } = await feed();
    const [outcome] = await read(id, "2026-04", [{ partner: "Singapore", iso2: "SG", qty: "1" }]);

    await expect(publishUpdate(guard([bitumart.siteId]), { site: "baseoil", id: outcome!.update_id })).rejects.toThrow(/access/);
  });
});

describe("the market insight", () => {
  it("is narrated from figures worked out here, against last month and last year", async () => {
    const { id } = await feed();

    await saveSheet(guard(), { site: "baseoil", kind: "import", location: thailand, date: "2026-03-01", quantities: { [singapore]: "20000", [qatar]: "500" } });
    await saveSheet(guard(), { site: "baseoil", kind: "import", location: thailand, date: "2025-04-01", quantities: { [singapore]: "25000" } });

    const [outcome] = await read(id, "2026-04", [
      { partner: "Singapore", iso2: "SG", qty: "31107" },
      { partner: "Korea", iso2: "KR", qty: "8614" },
    ]);

    await publishUpdate(guard(), { site: "baseoil", id: outcome!.update_id });

    const figures = await insightFigures(baseoil.siteId, { kind: "import", locationId: thailand, product: "Lubricating base oil" }, "2026-04", "LTR");

    expect(figures).toMatchObject({
      total: 39721,
      unit: "thousand litres (kilolitres)",
      previous_month: { total: 20500, change_percent: 93.8 },
      same_month_last_year: { total: 25000, change_percent: 58.9 },
      new_this_month: [{ partner: "South Korea", quantity: 8614 }],
      absent_this_month: [{ partner: "Qatar", previous_month: 500 }],
    });
    expect(figures.leading_partners[0]).toMatchObject({ partner: "Singapore", quantity: 31107, share_percent: 78.3, change_percent: 55.5 });

    const said = await writeInsight(baseoil.siteId, Number(outcome!.update_id), "editor@petrosil.example");

    expect(said.status).toBe("complete");
    expect(calls[0]).toMatchObject({ path: "trade-insight", json: { title: "Thailand Lubricating base oil imports — April 2026" } });

    const view = await tradeUpdate(guard(), "baseoil", Number(outcome!.update_id));

    expect(view.insight).toMatchObject({ status: "complete", text: "Imports from Singapore led the month.", model: "gpt-4.1" });

    // On the brand site, beside the month, for a reader who may see the figures.
    const paying = { entitled: true, tier: "premium", reason: "premium" } as const;
    const free = { entitled: false, tier: "free", reason: "free" } as const;
    const year = (await tradeYear(baseoil.siteId, { location: thailand, kind: "import", year: 2026 }, paying))!;

    expect(year.months.find((m) => m.month === "2026-04")!.insight).toBe("Imports from Singapore led the month.");
    expect(year.months.find((m) => m.month === "2026-03")!.insight).toBeNull();

    const locked = (await tradeYear(baseoil.siteId, { location: thailand, kind: "import", year: 2026 }, free))!;

    expect(locked.months.every((m) => m.insight === null)).toBe(true);
  });
});
