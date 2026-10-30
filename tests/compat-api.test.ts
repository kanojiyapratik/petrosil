/**
 * The contract tests.
 *
 * Every expectation here was measured against the live Laravel sites on
 * 2026-10-16 through the price module's own SiteClient — baseoil and bitumart,
 * same calls the module makes in production. If one of these fails, the module
 * breaks on cutover, so they assert exact key sets rather than "contains".
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as getLocations } from "@/app/api/compat/[site]/locations/route";
import { GET as listBatchesRoute } from "@/app/api/compat/[site]/price-batches/route";
import { POST as stageRowsRoute } from "@/app/api/compat/[site]/price-batches/rows/route";
import { GET as showBatchRoute } from "@/app/api/compat/[site]/price-batches/[id]/route";
import { POST as commitRoute } from "@/app/api/compat/[site]/price-batches/[id]/commit/route";
import { POST as rollbackRoute } from "@/app/api/compat/[site]/price-batches/[id]/rollback/route";
import { POST as discardRoute } from "@/app/api/compat/[site]/price-batches/[id]/discard/route";
import { PUT as updateItemRoute } from "@/app/api/compat/[site]/price-batches/items/[id]/route";
import { POST as summaryRoute } from "@/app/api/compat/[site]/price-summaries/route";

import { apiRequest, makeBrand, publishPrice, resetDatabase, routeContext, type Brand } from "./helpers";

const TOMORROW = "2099-02-02"; // far enough ahead that the date lock never fires

let brand: Brand;

beforeEach(async () => {
  await resetDatabase();
  brand = await makeBrand("baseoil", ["Singapore SN 150 FOB", "UAE SN 500"]);
});

const ctx = (params: { id?: string } = {}) => routeContext({ site: brand.slug, ...params });

async function stage(rows: unknown[], pricedate = TOMORROW, source?: string) {
  const response = await stageRowsRoute(
    apiRequest(`/api/compat/${brand.slug}/price-batches/rows`, {
      token: brand.token,
      method: "POST",
      body: source ? { rows, pricedate, source } : { rows, pricedate },
    }),
    ctx(),
  );

  return { response, body: await response.json() };
}

describe("authentication", () => {
  it("answers 401 without a token and 401 with an unknown one", async () => {
    const none = await getLocations(apiRequest(`/api/compat/${brand.slug}/locations`), ctx());
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ message: "This endpoint needs a bearer token." });

    const wrong = await getLocations(
      apiRequest(`/api/compat/${brand.slug}/locations`, { token: "nonsense" }),
      ctx(),
    );
    expect(wrong.status).toBe(401);
  });

  it("refuses a valid token used against another brand", async () => {
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);

    const response = await getLocations(
      apiRequest("/api/compat/bitumart/locations", { token: brand.token }),
      routeContext({ site: other.slug }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: "That token does not belong to this site.",
    });
  });
});

describe("GET /locations", () => {
  it("returns the shape the module reads", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1520, "2026-10-09");
    await publishPrice(brand, "Singapore SN 150 FOB", 1535, "2026-10-16");

    const response = await getLocations(
      apiRequest(`/api/compat/${brand.slug}/locations`, { token: brand.token }),
      ctx(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(["data"]);
    expect(Object.keys(body.data[0]).sort()).toEqual([
      "currency",
      "id",
      "latest_price",
      "latest_pricedate",
      "title",
    ]);

    // Newest date wins, and the figure is a number, not a string.
    expect(body.data[0]).toMatchObject({
      title: "Singapore SN 150 FOB",
      latest_price: 1535,
      latest_pricedate: "2026-10-16",
      currency: "USD",
    });

    // A location with no price yet still appears, with nulls.
    expect(body.data[1]).toMatchObject({
      title: "UAE SN 500",
      latest_price: null,
      latest_pricedate: null,
    });
  });
});

describe("POST /price-batches/rows", () => {
  it("returns 201 and the batch envelope", async () => {
    const { response, body } = await stage([
      { location: "Singapore SN 150 FOB", price: 1520 },
      { location: "Atlantis FOB", price: 100 },
    ]);

    expect(response.status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(["batch", "committable", "needs_attention", "summary"]);
    expect(Object.keys(body.batch).sort()).toEqual(["created_at", "id", "source", "status"]);
    expect(body.batch).toMatchObject({ status: "draft", source: "api" });

    // Every status is reported, in this order, whether or not it occurred.
    expect(Object.keys(body.summary)).toEqual([
      "changed",
      "new",
      "unchanged",
      "locked",
      "ambiguous",
      "unmatched",
      "invalid",
      "conflict",
    ]);
    expect(body.summary).toMatchObject({ new: 1, unmatched: 1 });
    expect(body.needs_attention).toBe(1);
    expect(body.committable).toBe(false);
  });

  it("records the source the editorial screen sends", async () => {
    const { body } = await stage([{ location: "Singapore SN 150 FOB", price: 1520 }], TOMORROW, "editorial");

    expect(body.batch.source).toBe("editorial");
  });

  it("rejects a source that would lie about where the rows came from", async () => {
    const { response, body } = await stage(
      [{ location: "Singapore SN 150 FOB", price: 1520 }],
      TOMORROW,
      "upload",
    );

    expect(response.status).toBe(422);
    expect(body.errors.source).toBeDefined();
  });

  it("rejects an empty row list", async () => {
    const { response } = await stage([]);

    expect(response.status).toBe(422);
  });
});

describe("GET /price-batches and /price-batches/{id}", () => {
  it("lists batches with the pagination meta the console reads", async () => {
    await stage([{ location: "Singapore SN 150 FOB", price: 1520 }]);

    const response = await listBatchesRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches`, { token: brand.token }),
      ctx(),
    );
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual(["data", "meta"]);
    expect(Object.keys(body.data[0]).sort()).toEqual([
      "created_at",
      "id",
      "items_count",
      "source",
      "status",
    ]);
    expect(body.data[0].items_count).toBe(1);
    expect(body.meta).toEqual({ current_page: 1, last_page: 1, per_page: 25, total: 1 });
  });

  it("says what a row new on its date is moving from, for the published note", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1490, "2099-01-26");
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, "2099-01-30");
    await publishPrice(brand, "UAE SN 500", 1340, TOMORROW);
    const staged = await stage([
      { location: "Singapore SN 150 FOB", price: 1520 },
      { location: "UAE SN 500", price: 1380 },
    ]);

    const response = await showBatchRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/${staged.body.batch.id}`, { token: brand.token }),
      ctx({ id: String(staged.body.batch.id) }),
    );
    const items = (await response.json()).items as { raw_location: string; old_price: number | null; previous_price?: number | null }[];
    const singapore = items.find((item) => item.raw_location === "Singapore SN 150 FOB")!;
    const uae = items.find((item) => item.raw_location === "UAE SN 500")!;

    // New on its date, so no old_price; the newest price before it is the move's start.
    expect(singapore).toMatchObject({ old_price: null, previous_price: 1500 });
    // Changing a price on its own date already says what it changes from.
    expect(uae.old_price).toBe(1340);
    expect(uae).not.toHaveProperty("previous_price");
  });

  it("returns the envelope plus every item, in the item shape", async () => {
    await publishPrice(brand, "UAE SN 500", 1340, TOMORROW);
    const staged = await stage([
      { location: "Singapore SN 150 FOB", price: 1520 },
      { location: "UAE SN 500", price: 1380 },
    ]);

    const response = await showBatchRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/${staged.body.batch.id}`, {
        token: brand.token,
      }),
      ctx({ id: String(staged.body.batch.id) }),
    );
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual([
      "batch",
      "committable",
      "items",
      "needs_attention",
      "summary",
    ]);
    // The module's keys, every one, byte for byte; previous_price is the one
    // key added beside them (see lib/compat/shapes.ts) and the module ignores it.
    expect(Object.keys(body.items[0]).filter((key) => key !== "previous_price").sort()).toEqual([
      "currency",
      "delta",
      "delta_pct",
      "error_message",
      "id",
      "is_included",
      "location",
      "location_id",
      "new_price",
      "old_price",
      "pricedate",
      "raw_location",
      "status",
    ]);

    expect(Object.keys(body.items[0]).length).toBeLessThanOrEqual(14);

    expect(body.items[0]).toMatchObject({
      raw_location: "Singapore SN 150 FOB",
      location: "Singapore SN 150 FOB",
      pricedate: TOMORROW,
      currency: "USD",
      old_price: null,
      new_price: 1520,
      delta: null,
      delta_pct: null,
      status: "new",
      is_included: true,
      error_message: null,
    });

    // delta and delta_pct are computed only when there is something to compare.
    expect(body.items[1]).toMatchObject({
      old_price: 1340,
      new_price: 1380,
      delta: 40,
      delta_pct: 2.9851,
      status: "changed",
    });
  });

  it("answers 404 for a batch belonging to another brand", async () => {
    const staged = await stage([{ location: "Singapore SN 150 FOB", price: 1520 }]);
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);

    const response = await showBatchRoute(
      apiRequest(`/api/compat/bitumart/price-batches/${staged.body.batch.id}`, {
        token: other.token,
      }),
      routeContext({ site: other.slug, id: String(staged.body.batch.id) }),
    );

    expect(response.status).toBe(404);
  });
});

describe("the round trip the module performs", () => {
  it("stages, edits, commits, posts a note, then rolls back", async () => {
    await publishPrice(brand, "UAE SN 500", 1340, TOMORROW);

    const staged = await stage([
      { location: "Singapore SN 150 FOB", price: 1520 },
      { location: "UAE SN 500", price: 1380 },
    ]);
    const batchId = staged.body.batch.id;

    const show = await showBatchRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/${batchId}`, { token: brand.token }),
      ctx({ id: String(batchId) }),
    );
    const items = (await show.json()).items;

    const edited = await updateItemRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/items/${items[0].id}`, {
        token: brand.token,
        method: "PUT",
        body: { new_price: 1530 },
      }),
      ctx({ id: String(items[0].id) }),
    );
    const editedBody = await edited.json();

    expect(edited.status).toBe(200);
    expect(Object.keys(editedBody)).toEqual(["item"]);
    expect(editedBody.item.new_price).toBe(1530);

    const committed = await commitRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/${batchId}/commit`, {
        token: brand.token,
        method: "POST",
        body: {},
      }),
      ctx({ id: String(batchId) }),
    );

    expect(committed.status).toBe(200);
    expect(await committed.json()).toEqual({ applied: 1, created: 1, conflicts: 0 });

    const summary = await summaryRoute(
      apiRequest(`/api/compat/${brand.slug}/price-summaries`, {
        token: brand.token,
        method: "POST",
        body: {
          summary: "Base oils eased in Asia; the Gulf held.",
          source: "editorial",
          price_batch_id: batchId,
        },
      }),
      ctx(),
    );
    const summaryBody = await summary.json();

    expect(summary.status).toBe(201);
    expect(Object.keys(summaryBody).sort()).toEqual(["created_at", "id", "source", "summary"]);

    const rolled = await rollbackRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/${batchId}/rollback`, {
        token: brand.token,
        method: "POST",
        body: {},
      }),
      ctx({ id: String(batchId) }),
    );

    expect(await rolled.json()).toEqual({ reverted: 1, removed: 1, skipped: 0 });
  });

  it("answers 409 with a readable message when a commit is blocked", async () => {
    const staged = await stage([{ location: "Atlantis FOB", price: 100 }]);

    const response = await commitRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/${staged.body.batch.id}/commit`, {
        token: brand.token,
        method: "POST",
        body: {},
      }),
      ctx({ id: String(staged.body.batch.id) }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe(
      "1 row(s) still need attention. Resolve or exclude them first.",
    );
  });

  it("discards a draft", async () => {
    const staged = await stage([{ location: "Singapore SN 150 FOB", price: 1520 }]);

    const response = await discardRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/${staged.body.batch.id}/discard`, {
        token: brand.token,
        method: "POST",
        body: {},
      }),
      ctx({ id: String(staged.body.batch.id) }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).batch.status).toBe("discarded");
  });
});

describe("POST /price-summaries", () => {
  it("refuses an empty note, because it would blank the banner", async () => {
    const response = await summaryRoute(
      apiRequest(`/api/compat/${brand.slug}/price-summaries`, {
        token: brand.token,
        method: "POST",
        body: { summary: "   ", source: "editorial" },
      }),
      ctx(),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      message: "A summary needs some text.",
      errors: { summary: ["A summary needs some text."] },
    });
  });

  it("refuses a batch id from another brand", async () => {
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);
    const staged = await stage([{ location: "Singapore SN 150 FOB", price: 1520 }]);

    const response = await summaryRoute(
      apiRequest("/api/compat/bitumart/price-summaries", {
        token: other.token,
        method: "POST",
        body: { summary: "Note", price_batch_id: staged.body.batch.id },
      }),
      routeContext({ site: other.slug }),
    );

    expect(response.status).toBe(422);
  });
});
