/**
 * The crawler half of the contract: what the pass is told to fetch, what is
 * recorded from what it read, and how a finding becomes a reviewable batch.
 *
 * Shapes here were measured against live baseoil on 2026-10-16 through the
 * module's own SiteClient.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as sourcesRoute } from "@/app/api/compat/[site]/price-crawl/sources/route";
import { POST as resultsRoute } from "@/app/api/compat/[site]/price-crawl/results/route";
import {
  GET as urlsRoute,
  PUT as replaceUrlsRoute,
} from "@/app/api/compat/[site]/price-crawl/urls/route";
import { GET as activityRoute } from "@/app/api/compat/[site]/price-crawl/activity/route";
import { POST as stageRoute } from "@/app/api/compat/[site]/price-crawl/activity/stage/route";
import { POST as clearRoute } from "@/app/api/compat/[site]/price-crawl/activity/clear/route";
import { GET as showBatchRoute } from "@/app/api/compat/[site]/price-batches/[id]/route";

import { db } from "@/db";
import { locations, priceCrawlUrls } from "@/db/schema";
import { eq } from "drizzle-orm";
import { apiRequest, makeBrand, publishPrice, resetDatabase, routeContext, type Brand } from "./helpers";

let brand: Brand;

const ctx = (params: { id?: string } = {}) => routeContext({ site: brand.slug, ...params });

beforeEach(async () => {
  await resetDatabase();
  brand = await makeBrand("baseoil", ["Singapore SN 150 FOB", "UAE SN 500"]);
});

async function watch(urls: string[], instructions?: string) {
  const response = await replaceUrlsRoute(
    apiRequest(`/api/compat/${brand.slug}/price-crawl/urls`, {
      token: brand.token,
      method: "PUT",
      body: instructions === undefined ? { text: urls.join("\n") } : { text: urls.join("\n"), instructions },
    }),
    ctx(),
  );

  return { response, body: await response.json() };
}

async function report(results: unknown[]) {
  const response = await resultsRoute(
    apiRequest(`/api/compat/${brand.slug}/price-crawl/results`, {
      token: brand.token,
      method: "POST",
      body: { results },
    }),
    ctx(),
  );

  return { response, body: await response.json() };
}

async function urlId(url: string): Promise<number> {
  const [row] = await db().select().from(priceCrawlUrls).where(eq(priceCrawlUrls.url, url));

  return row!.id;
}

async function activity() {
  const response = await activityRoute(
    apiRequest(`/api/compat/${brand.slug}/price-crawl/activity?limit=50`, { token: brand.token }),
    ctx(),
  );

  return (await response.json()).data;
}

describe("the watch list", () => {
  it("adds, stops and re-enables rather than deleting", async () => {
    expect((await watch(["https://a.example/prices", "https://b.example/prices"])).body).toEqual({
      watched: 2,
      added: 2,
      reenabled: 0,
      stopped: 0,
    });

    // b disappears from the list: stopped, not deleted — its history is the
    // point of the feature.
    expect((await watch(["https://a.example/prices"])).body).toMatchObject({ stopped: 1 });

    const all = await db().select().from(priceCrawlUrls);
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.url.includes("b.example"))!.enabled).toBe(false);

    expect((await watch(["https://a.example/prices", "https://b.example/prices"])).body).toMatchObject({
      reenabled: 1,
      added: 0,
    });
  });

  it("refuses anything that is not an http(s) URL, and saves nothing", async () => {
    const { response, body } = await watch([
      "https://good.example/prices",
      "file:///etc/passwd",
      "not a url",
    ]);

    expect(response.status).toBe(422);
    expect(body.invalid).toEqual(["file:///etc/passwd", "not a url"]);
    expect(await db().select().from(priceCrawlUrls)).toHaveLength(0);
  });

  it("keeps the instructions unless the field is sent", async () => {
    await watch(["https://a.example/prices"], "Read the table under 'Base oils'.");

    let listed = await urlsRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/urls`, { token: brand.token }),
      ctx(),
    );
    expect((await listed.json()).instructions).toBe("Read the table under 'Base oils'.");

    // No `instructions` key at all: left alone.
    await watch(["https://a.example/prices"]);
    listed = await urlsRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/urls`, { token: brand.token }),
      ctx(),
    );
    expect((await listed.json()).instructions).toBe("Read the table under 'Base oils'.");

    // Sent blank: cleared on purpose.
    await watch(["https://a.example/prices"], "");
    listed = await urlsRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/urls`, { token: brand.token }),
      ctx(),
    );
    expect((await listed.json()).instructions).toBeNull();
  });

  it("lists in the shape the console reads", async () => {
    await watch(["https://a.example/prices"]);

    const response = await urlsRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/urls`, { token: brand.token }),
      ctx(),
    );
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual(["data", "instructions", "interval_minutes"]);
    expect(Object.keys(body.data[0]).sort()).toEqual([
      "enabled",
      "id",
      "label",
      "last_changed_at",
      "last_checked_at",
      "last_error",
      "last_notes",
      "last_row_count",
      "last_status",
      "last_status_text",
      "url",
    ]);
    expect(body.data[0].last_status_text).toBe("Not checked yet");
  });
});

describe("GET /price-crawl/sources", () => {
  it("gives the crawler the pass it needs, enabled URLs only", async () => {
    await watch(["https://a.example/prices", "https://b.example/prices"], "Look for the weekly table.");
    await watch(["https://a.example/prices"], "Look for the weekly table.");

    const response = await sourcesRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/sources`, { token: brand.token }),
      ctx(),
    );
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual([
      "instructions",
      "interval_minutes",
      "locations",
      "urls",
    ]);
    expect(body.interval_minutes).toBe(15);
    expect(body.urls).toHaveLength(1);
    expect(Object.keys(body.urls[0]).sort()).toEqual([
      "content_hash",
      "etag",
      "id",
      "label",
      "last_modified",
      "url",
    ]);
    expect(body.locations).toEqual(["Singapore SN 150 FOB", "UAE SN 500"]);
  });

  it("does not offer a retired location, which could only come back unmatched", async () => {
    await db()
      .update(locations)
      .set({ deletedAt: new Date() })
      .where(eq(locations.id, brand.locationIds["UAE SN 500"]!));

    const response = await sourcesRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/sources`, { token: brand.token }),
      ctx(),
    );

    expect((await response.json()).locations).toEqual(["Singapore SN 150 FOB"]);
  });
});

describe("POST /price-crawl/results", () => {
  beforeEach(async () => {
    await watch(["https://a.example/prices"]);
  });

  it("records a first reading as a new finding and remembers the page state", async () => {
    const id = await urlId("https://a.example/prices");

    const { response, body } = await report([
      {
        url_id: id,
        status: "read",
        content_hash: "abc123",
        etag: 'W/"v1"',
        rows: [{ location: "Singapore SN 150 FOB", price: 1520, date: "2026-10-16" }],
      },
    ]);

    expect(response.status).toBe(201);
    expect(body.data[0]).toEqual({
      url_id: id,
      status: "updated",
      rows: 1,
      activities: 1,
      unmatched: 0,
    });

    const [row] = await db().select().from(priceCrawlUrls).where(eq(priceCrawlUrls.id, id));
    expect(row!.contentHash).toBe("abc123");
    expect(row!.etag).toBe('W/"v1"');
    expect(row!.lastRowCount).toBe(1);
    expect(row!.lastChangedAt).not.toBeNull();

    const found = await activity();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      location: "Singapore SN 150 FOB",
      price: 1520,
      previous_price: null,
      change_type: "new",
      differs_from_site: true,
    });
  });

  it("records only movement — a price that has not changed is not logged again", async () => {
    const id = await urlId("https://a.example/prices");
    const rows = [{ location: "Singapore SN 150 FOB", price: 1520, date: "2026-10-16" }];

    await report([{ url_id: id, status: "read", rows }]);
    const second = await report([{ url_id: id, status: "read", rows }]);

    expect(second.body.data[0]).toMatchObject({ status: "no_change", rows: 1, activities: 0 });
    expect(await activity()).toHaveLength(1);

    const third = await report([
      {
        url_id: id,
        status: "read",
        rows: [{ location: "Singapore SN 150 FOB", price: 1545, date: "2026-10-16" }],
      },
    ]);

    expect(third.body.data[0]).toMatchObject({ status: "updated", activities: 1 });

    const found = await activity();
    expect(found[0]).toMatchObject({ price: 1545, previous_price: 1520, change_type: "changed" });
    expect(found[0].change_pct).toBeCloseTo(1.64, 2);
  });

  it("stores no content hash for a page it could not read", async () => {
    const id = await urlId("https://a.example/prices");

    const { body } = await report([
      { url_id: id, status: "failed", content_hash: "should-be-ignored", error: "timeout" },
    ]);

    expect(body.data[0]).toEqual({ url_id: id, status: "failed", rows: 0, activities: 0, unmatched: 0 });

    // Storing one would mark the page "seen" and every later check would skip it.
    const [row] = await db().select().from(priceCrawlUrls).where(eq(priceCrawlUrls.id, id));
    expect(row!.contentHash).toBeNull();
    expect(row!.lastError).toBe("timeout");
  });

  it("records an unrecognised label under the page's own wording, with no location", async () => {
    const id = await urlId("https://a.example/prices");

    const { body } = await report([
      {
        url_id: id,
        status: "read",
        rows: [
          { location: "Singapore SN 150 FOB", price: 1520 },
          { location: "China 445 ex-works", price: 445 },
        ],
      },
    ]);

    expect(body.data[0]).toMatchObject({ rows: 2, activities: 2, unmatched: 1 });

    const found = await activity();
    const unmatched = found.find((row: { location: string }) => row.location === "China 445 ex-works");
    expect(unmatched).toMatchObject({ location_id: null, price: 445 });
  });

  it("drops a row whose price cannot be read rather than recording a zero", async () => {
    const id = await urlId("https://a.example/prices");

    const { body } = await report([
      {
        url_id: id,
        status: "read",
        rows: [
          { location: "Singapore SN 150 FOB", price: "" },
          { location: "UAE SN 500", price: "1,340" },
        ],
      },
    ]);

    expect(body.data[0]).toMatchObject({ rows: 1, activities: 1, unmatched: 1 });
    expect((await activity())[0]).toMatchObject({ location: "UAE SN 500", price: 1340 });
  });

  it("shows what this brand publishes for the same date, and whether it differs", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, "2026-10-16");
    const id = await urlId("https://a.example/prices");

    await report([
      {
        url_id: id,
        status: "read",
        rows: [{ location: "Singapore SN 150 FOB", price: 1500, date: "2026-10-16" }],
      },
    ]);

    expect((await activity())[0]).toMatchObject({
      price: 1500,
      site_price: 1500,
      differs_from_site: false,
    });
  });

  it("ignores an unknown, stopped or foreign url id instead of failing the pass", async () => {
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);
    const mine = await urlId("https://a.example/prices");

    const [foreign] = await db()
      .insert(priceCrawlUrls)
      .values({ siteId: other.siteId, url: "https://other.example/prices" })
      .returning();

    const { body } = await report([
      { url_id: mine, status: "read", rows: [] },
      { url_id: 99999, status: "read", rows: [] },
      { url_id: foreign!.id, status: "read", rows: [] },
      { url_id: mine, status: "teleported" },
    ]);

    expect(body.data.map((row: { status: string }) => row.status)).toEqual([
      "no_rows",
      "ignored",
      "ignored",
      "ignored",
    ]);
  });
});

describe("staging findings", () => {
  it("turns chosen findings into a crawl batch and skips the unrecognised ones", async () => {
    await watch(["https://a.example/prices"]);
    const id = await urlId("https://a.example/prices");

    await report([
      {
        url_id: id,
        status: "read",
        rows: [
          { location: "Singapore SN 150 FOB", price: 1520, date: "2099-02-02" },
          { location: "China 445 ex-works", price: 445, date: "2099-02-02" },
        ],
      },
    ]);

    const found = await activity();

    const response = await stageRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/activity/stage`, {
        token: brand.token,
        method: "POST",
        body: { activity_ids: found.map((row: { id: number }) => row.id) },
      }),
      ctx(),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ rows: 1, skipped: 1, status: "draft" });

    const batch = await showBatchRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/${body.batch_id}`, { token: brand.token }),
      ctx({ id: String(body.batch_id) }),
    );
    const detail = await batch.json();

    expect(detail.batch.source).toBe("crawl");
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({
      location: "Singapore SN 150 FOB",
      new_price: 1520,
      pricedate: "2099-02-02",
      status: "new",
    });
  });

  it("refuses when nothing selected can be staged", async () => {
    await watch(["https://a.example/prices"]);
    const id = await urlId("https://a.example/prices");

    await report([
      { url_id: id, status: "read", rows: [{ location: "China 445 ex-works", price: 445 }] },
    ]);

    const found = await activity();
    const response = await stageRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/activity/stage`, {
        token: brand.token,
        method: "POST",
        body: { activity_ids: found.map((row: { id: number }) => row.id) },
      }),
      ctx(),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ skipped: 1 });
  });

  it("will not stage another brand's findings", async () => {
    await watch(["https://a.example/prices"]);
    const id = await urlId("https://a.example/prices");
    await report([
      { url_id: id, status: "read", rows: [{ location: "Singapore SN 150 FOB", price: 1520 }] },
    ]);

    const found = await activity();
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);

    const response = await stageRoute(
      apiRequest("/api/compat/bitumart/price-crawl/activity/stage", {
        token: other.token,
        method: "POST",
        body: { activity_ids: found.map((row: { id: number }) => row.id) },
      }),
      routeContext({ site: other.slug }),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).message).toBe("Those findings no longer exist.");
  });
});

describe("clearing activity", () => {
  it("forgets the findings and the page hashes, so every page is read again", async () => {
    await watch(["https://a.example/prices"]);
    const id = await urlId("https://a.example/prices");

    await report([
      {
        url_id: id,
        status: "read",
        content_hash: "abc123",
        rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      },
    ]);

    const response = await clearRoute(
      apiRequest(`/api/compat/${brand.slug}/price-crawl/activity/clear`, {
        token: brand.token,
        method: "POST",
        body: {},
      }),
      ctx(),
    );

    expect(await response.json()).toEqual({ removed: 1 });
    expect(await activity()).toHaveLength(0);

    const [row] = await db().select().from(priceCrawlUrls).where(eq(priceCrawlUrls.id, id));
    expect(row!.contentHash).toBeNull();
    expect(row!.lastRowCount).toBe(0);
  });

  it("leaves another brand's findings alone", async () => {
    await watch(["https://a.example/prices"]);
    const id = await urlId("https://a.example/prices");
    await report([
      { url_id: id, status: "read", rows: [{ location: "Singapore SN 150 FOB", price: 1520 }] },
    ]);

    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);
    const response = await clearRoute(
      apiRequest("/api/compat/bitumart/price-crawl/activity/clear", {
        token: other.token,
        method: "POST",
        body: {},
      }),
      routeContext({ site: other.slug }),
    );

    expect(await response.json()).toEqual({ removed: 0 });
    expect(await activity()).toHaveLength(1);
  });
});
