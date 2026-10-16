/**
 * The two paths that take a file or a form rather than JSON.
 *
 * The upload rules here are the ones a spreadsheet gets wrong in practice:
 * header rows, a sheet with its own date column, and the blank-cell trap that
 * once shift-read a date serial as a price.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";

import { POST as uploadRoute } from "@/app/api/compat/[site]/price-batches/upload/route";
import { POST as bulkRoute } from "@/app/api/compat/[site]/price-batches/bulk/route";
import { GET as showBatchRoute } from "@/app/api/compat/[site]/price-batches/[id]/route";
import { PUT as updateItemRoute } from "@/app/api/compat/[site]/price-batches/items/[id]/route";

import { readCsv } from "@/domain/price/sheet";
import { dateRange } from "@/domain/price/bulk";
import { apiRequest, makeBrand, publishPrice, resetDatabase, routeContext, type Brand } from "./helpers";

let brand: Brand;

const ctx = (params: { id?: string } = {}) => routeContext({ site: brand.slug, ...params });

beforeEach(async () => {
  await resetDatabase();
  brand = await makeBrand("baseoil", ["Singapore SN 150 FOB", "UAE SN 500"]);
});

/** A multipart request shaped the way SiteClient.upload_batch sends one. */
function uploadRequest(filename: string, bytes: Buffer | string, priceDate?: string): Request {
  const form = new FormData();
  const blob = new Blob([typeof bytes === "string" ? Buffer.from(bytes) : bytes]);

  form.append("file", new File([blob], filename));

  if (priceDate !== undefined) {
    form.append("pricedate", priceDate);
  }

  return new Request(`http://platform.test/api/compat/${brand.slug}/price-batches/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${brand.token}`, accept: "application/json" },
    body: form,
  });
}

async function upload(filename: string, bytes: Buffer | string, priceDate?: string) {
  const response = await uploadRoute(uploadRequest(filename, bytes, priceDate), ctx());

  return { response, body: await response.json() };
}

async function itemsOf(batchId: number) {
  const response = await showBatchRoute(
    apiRequest(`/api/compat/${brand.slug}/price-batches/${batchId}`, { token: brand.token }),
    ctx({ id: String(batchId) }),
  );

  return (await response.json()).items;
}

async function xlsx(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Prices");

  for (const row of rows) {
    sheet.addRow(row);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("reading a CSV", () => {
  it("handles quotes, doubled quotes and CRLF", () => {
    expect(readCsv('a,1\r\n"b, with comma",2\r\n"say ""hi""",3\r\n')).toEqual([
      ["a", "1", null],
      ["b, with comma", "2", null],
      ['say "hi"', "3", null],
    ]);
  });

  it("drops blank lines", () => {
    expect(readCsv("a,1\n\n\nb,2\n")).toHaveLength(2);
  });
});

describe("POST /price-batches/upload", () => {
  it("stages a two-column sheet against the date the editor chose", async () => {
    const { response, body } = await upload(
      "prices.csv",
      "Location,Price\nSingapore SN 150 FOB,1520\nUAE SN 500,1340\n",
      "2099-02-02",
    );

    expect(response.status).toBe(201);
    expect(body.batch.source).toBe("upload");
    expect(body.summary).toMatchObject({ new: 2 });

    const items = await itemsOf(body.batch.id);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ location: "Singapore SN 150 FOB", new_price: 1520, pricedate: "2099-02-02" });
  });

  it("refuses a two-column sheet with no date, before creating a batch", async () => {
    const { response, body } = await upload("prices.csv", "Singapore SN 150 FOB,1520\n");

    expect(response.status).toBe(422);
    expect(body.message).toBe(
      "This file has no date column, so choose the price date for the upload.",
    );
  });

  it("takes each row's own date from a three-column sheet", async () => {
    const { body } = await upload(
      "prices.csv",
      "Location,Date,Price\nSingapore SN 150 FOB,2099-02-02,1520\nUAE SN 500,2099-03-03,1340\n",
    );

    const items = await itemsOf(body.batch.id);
    expect(items.map((i: { pricedate: string }) => i.pricedate)).toEqual(["2099-02-02", "2099-03-03"]);
  });

  it("decides the sheet's shape once, so a blank price cell cannot shift the columns", async () => {
    // The trap: row two has no price. Deciding shape per row would read it as
    // a two-column row and take its DATE cell as the price.
    const { body } = await upload(
      "prices.csv",
      "Location,Date,Price\nSingapore SN 150 FOB,2099-02-02,1520\nUAE SN 500,2099-02-02,\n",
    );

    const items = await itemsOf(body.batch.id);

    expect(items[1]).toMatchObject({
      location_id: null,
      status: "invalid",
      error_message: "Price must be a number, zero or more.",
    });
    expect(items[1].new_price).toBe(0);
  });

  it("keeps a header-looking row when its name is a real location", async () => {
    const { body } = await upload(
      "prices.csv",
      "Singapore SN 150 FOB,abc\nUAE SN 500,1340\n",
      "2099-02-02",
    );

    const items = await itemsOf(body.batch.id);

    // Not discarded as a header: it is a known location with an unreadable
    // price, which an editor needs to see.
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ raw_location: "Singapore SN 150 FOB", status: "invalid" });
  });

  it("reads an xlsx, including a real date cell", async () => {
    const file = await xlsx([
      ["Location", "Date", "Price"],
      ["Singapore SN 150 FOB", new Date(2099, 1, 2), 1520],
      ["Atlantis FOB", new Date(2099, 1, 2), 999],
    ]);

    const { response, body } = await upload("prices.xlsx", file);

    expect(response.status).toBe(201);
    expect(body.summary).toMatchObject({ new: 1, unmatched: 1 });

    const items = await itemsOf(body.batch.id);
    expect(items[0]).toMatchObject({ pricedate: "2099-02-02", new_price: 1520 });
  });

  it("says plainly that an old .xls must be re-saved", async () => {
    const { response, body } = await upload("prices.xls", "Singapore SN 150 FOB,1520\n", "2099-02-02");

    expect(response.status).toBe(422);
    expect(body.message).toContain("Save it as .xlsx or .csv");
  });

  it("refuses a file type it does not read at all", async () => {
    const { response } = await upload("prices.pdf", "nope", "2099-02-02");

    expect(response.status).toBe(422);
  });

  it("refuses an empty sheet", async () => {
    const { response, body } = await upload("prices.csv", "Location,Price\n", "2099-02-02");

    expect(response.status).toBe(422);
    expect(body.message).toBe("That file has no rows.");
  });
});

describe("POST /price-batches/bulk", () => {
  const FUTURE = "2099-02-02";

  async function bulk(params: Record<string, unknown>) {
    const response = await bulkRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/bulk`, {
        token: brand.token,
        method: "POST",
        body: params,
      }),
      ctx(),
    );

    return { response, body: await response.json() };
  }

  it("sets a value on every date that already has a price", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, FUTURE);
    await publishPrice(brand, "UAE SN 500", 1300, FUTURE);

    const { response, body } = await bulk({
      location_ids: [brand.locationIds["Singapore SN 150 FOB"], brand.locationIds["UAE SN 500"]],
      operation: "set",
      date_from: FUTURE,
      date_to: FUTURE,
      value: 1600,
    });

    expect(response.status).toBe(201);
    expect(body.batch.source).toBe("bulk_edit");
    expect(body.summary).toMatchObject({ changed: 2 });

    const items = await itemsOf(body.batch.id);
    expect(items.map((i: { new_price: number }) => i.new_price)).toEqual([1600, 1600]);
  });

  it("never invents a row for a date with no price", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, FUTURE);

    const { body } = await bulk({
      location_ids: [brand.locationIds["Singapore SN 150 FOB"], brand.locationIds["UAE SN 500"]],
      operation: "set",
      date_from: FUTURE,
      date_to: "2099-02-09",
      value: 1600,
    });

    expect(await itemsOf(body.batch.id)).toHaveLength(1);
  });

  it("adjusts by a delta, and stages a negative result as invalid rather than clamping it", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, FUTURE);
    await publishPrice(brand, "UAE SN 500", 30, FUTURE);

    const { body } = await bulk({
      location_ids: [brand.locationIds["Singapore SN 150 FOB"], brand.locationIds["UAE SN 500"]],
      operation: "adjust",
      date_from: FUTURE,
      date_to: FUTURE,
      value: -50,
    });

    const items = await itemsOf(body.batch.id);
    const singapore = items.find((i: { location: string }) => i.location === "Singapore SN 150 FOB");
    const uae = items.find((i: { location: string }) => i.location === "UAE SN 500");

    expect(singapore).toMatchObject({ new_price: 1450, status: "changed" });
    // Zero is a plausible-looking price in a commodity report, so it is never
    // produced silently.
    expect(uae).toMatchObject({ new_price: -20, status: "invalid" });
    expect(uae.error_message).toContain("would make this price negative");
    expect(body.committable).toBe(false);
  });

  it("copies one date's prices across a target range", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, "2099-01-01");
    await publishPrice(brand, "UAE SN 500", 1300, "2099-01-01");

    const { body } = await bulk({
      location_ids: [brand.locationIds["Singapore SN 150 FOB"], brand.locationIds["UAE SN 500"]],
      operation: "copy",
      source_date: "2099-01-01",
      target_date_from: "2099-03-01",
      target_date_to: "2099-03-03",
    });

    const items = await itemsOf(body.batch.id);

    expect(items).toHaveLength(6); // 2 locations x 3 days
    expect(new Set(items.map((i: { pricedate: string }) => i.pricedate))).toEqual(
      new Set(["2099-03-01", "2099-03-02", "2099-03-03"]),
    );
    expect(items.every((i: { status: string }) => i.status === "new")).toBe(true);
  });

  it("refuses to stage more rows than the ceiling, leaving no draft behind", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, "2099-01-01");

    const { response, body } = await bulk({
      location_ids: [brand.locationIds["Singapore SN 150 FOB"]],
      operation: "copy",
      source_date: "2099-01-01",
      target_date_from: "2099-01-01",
      target_date_to: "2199-01-01",
    });

    expect(response.status).toBe(422);
    expect(body.message).toContain("the maximum is 5000");
  });

  it("will not touch another brand's locations", async () => {
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);
    await publishPrice(other, "Bitumen Singapore Drum FOB", 830, FUTURE);

    const { response, body } = await bulk({
      location_ids: [other.locationIds["Bitumen Singapore Drum FOB"]],
      operation: "set",
      date_from: FUTURE,
      date_to: FUTURE,
      value: 900,
    });

    expect(response.status).toBe(422);
    expect(body.message).toBe("None of those locations belong to this site.");
  });

  it("validates the request before touching anything", async () => {
    expect((await bulk({ operation: "set" })).response.status).toBe(422);
    expect(
      (await bulk({ location_ids: [1], operation: "teleport" })).response.status,
    ).toBe(422);
    expect(
      (
        await bulk({
          location_ids: [brand.locationIds["Singapore SN 150 FOB"]],
          operation: "set",
          date_from: FUTURE,
          date_to: "2099-01-01",
          value: 10,
        })
      ).response.status,
    ).toBe(422);
  });

  it("counts a date range inclusively", () => {
    expect(dateRange("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });
});

describe("editing a row the file got wrong", () => {
  it("refuses a value edit on a row that cannot be edited, but still lets it be excluded", async () => {
    const { body } = await upload(
      "prices.csv",
      "Location,Price\nSingapore SN 150 FOB,abc\n",
      "2099-02-02",
    );

    const [item] = await itemsOf(body.batch.id);
    expect(item.status).toBe("invalid");

    const refused = await updateItemRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/items/${item.id}`, {
        token: brand.token,
        method: "PUT",
        body: { new_price: 1520 },
      }),
      ctx({ id: String(item.id) }),
    );

    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe("That row cannot be edited.");

    const excluded = await updateItemRoute(
      apiRequest(`/api/compat/${brand.slug}/price-batches/items/${item.id}`, {
        token: brand.token,
        method: "PUT",
        body: { is_included: false },
      }),
      ctx({ id: String(item.id) }),
    );

    expect(excluded.status).toBe(200);
    expect((await excluded.json()).item.is_included).toBe(false);
  });
});
