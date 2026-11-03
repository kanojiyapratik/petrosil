/**
 * Customs sheets: reading the vendor's sheet, the figures, and the AI's
 * reading of them.
 *
 * The sheets are built here with the quirks real ones have (verified on
 * "PETROLEUM COKE (FEB 26).xlsx"): a "formatted" sheet whose unlabelled
 * column shifts every header after it, Excel date serials, mixed MTS/KGS
 * quantities, "NOT KNOWN" suppliers, and a totals row among the data.
 * The engine is stood in for.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, tradeImports, tradeShipments, users } from "@/db/schema";
import { readCustomsSheet } from "@/domain/trade/customs-sheet";
import { analyseCustomsSheet, customsSheet, listCustomsSheets, shipmentsOf, uploadCustomsSheet } from "@/domain/trade/customs";
import { AccountError } from "@/domain/accounts/register";
import { makeBrand, resetDatabase } from "./helpers";

const calls: { path: string; json: unknown }[] = [];
let answer: () => unknown = () => ({ analysis: { status: "complete", output_markdown: "Imports rose.", model: "gpt-4.1", error: null } });

vi.mock("@/lib/engine/client", async (original) => {
  const real = await original<typeof import("@/lib/engine/client")>();

  return {
    ...real,
    engine: vi.fn(async (_slug: string | null, path: string, call: { json?: unknown }) => {
      calls.push({ path, json: call.json });

      return answer();
    }),
  };
});

const HEAD = ["DATE", "HS CODE", "PRODUCT DESCRIPTION", "QUANTITY", "UNIT", "CIF VALUE (USD)", "UNIT PRICE (USD)", "IMPORTER NAME", "SUPPLIER NAME", "FOREIGN COUNTRY", "INDIAN PORT", "STANDARD QUANTITY"];

// 46056 = 2026-02-03. Two importers; one undisclosed supplier; MTS and KGS mixed.
const ROWS: unknown[][] = [
  [46056, "27131290", "CALCINED PETROLEUM COKE", 1000, "MTS", 450000, 450.0000000001, "GRAPHITE INDIA LTD", "OXBOW", "USA", "VIZAG", 1_000_000],
  [46060, "27131190", "RAW PETROLEUM COKE", 3_000_000, "KGS", 600000, 200, "ULTRATECH", "NOT KNOWN", "SAUDI ARABIA", "KANDLA", 3_000_000],
  [46061, "27131290", "CALCINED PETROLEUM COKE", 1.75, "MTS", 1557.5, 890, "GRAPHITE INDIA LTD", "RAIN CARBON", "UNITED KINGDOM", "DURGAPUR ICD", 1750],
];

/** A workbook shaped like the vendor's: "raw" first, then "formatted" with a blank column at E. */
async function workbook(rows = ROWS, extra: unknown[][] = []): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const raw = book.addWorksheet("raw");
  raw.addRow(["SOMETHING ELSE"]);

  const formatted = book.addWorksheet("formatted");
  const shift = (line: unknown[]) => [...line.slice(0, 4), line[3], ...line.slice(4)];
  formatted.addRow(shift(HEAD).map((cell, at) => (at === 4 ? null : cell)));

  for (const line of [...rows, ...extra]) {
    formatted.addRow(shift(line));
  }

  // The unlabelled totals row: a figure only in the unmapped column.
  formatted.addRow([null, null, null, null, 4_001_001.75]);

  return Buffer.from(await book.xlsx.writeBuffer());
}

let siteId: number;
let staff: number;

const guard = () => ({ identity: { user: { id: staff, email: "editor@petrosil.example" }, memberships: [] }, siteIds: [], isSuperadmin: true }) as never;

const upload = async (productLabel = "Petroleum Coke", periodMonth = "2026-02", bytes?: Buffer) =>
  uploadCustomsSheet(guard(), "baseoil", { productLabel, periodMonth, file: { name: "PETROLEUM COKE (FEB 26).xlsx", bytes: bytes ?? (await workbook()) } });

beforeEach(async () => {
  calls.length = 0;
  await resetDatabase();
  siteId = (await makeBrand("baseoil", [])).siteId;

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

describe("reading the sheet", () => {
  it("prefers the formatted sheet, matches columns by name, and reads the quirks", async () => {
    const sheet = await readCustomsSheet("x.xlsx", await workbook());

    expect(sheet).toMatchObject({ sheetName: "formatted", skipped: 1 });
    expect(sheet.shipments).toHaveLength(3);
    expect(sheet.shipments[0]).toMatchObject({
      shipmentDate: "2026-02-03",
      productDescription: "CALCINED PETROLEUM COKE",
      quantity: "1000.000000",
      unit: "MTS",
      unitPriceUsd: "450.000000",
      standardQuantity: "1000000.000000",
      importerName: "GRAPHITE INDIA LTD",
    });
    expect(sheet.shipments[1]!.supplierName).toBeNull();
    expect(sheet.missingColumns).toContain("SUPPLIER COUNTRY");
  });

  it("refuses a sheet that is not a customs sheet, and a corrupt row, naming it", async () => {
    await expect(readCustomsSheet("x.csv", Buffer.from("Market,Price\nA,1\n"))).rejects.toThrow(/no DATE, HS CODE, PRODUCT DESCRIPTION, QUANTITY, UNIT columns/);
    await expect(readCustomsSheet("x.xlsx", await workbook(ROWS, [[46062, "2713", "", 5, "MTS"]]))).rejects.toThrow(/Row 5 has no PRODUCT DESCRIPTION/);
    await expect(readCustomsSheet("x.xls", Buffer.from("x"))).rejects.toThrow(/\.xlsx or \.csv/);
  });

  it("reads a CSV the same way", async () => {
    const csv = [HEAD.join(","), "2026-02-03,2713,COKE,5,MTS,,100,A LTD,NOT KNOWN,USA,VIZAG,5000"].join("\n");
    const sheet = await readCustomsSheet("x.csv", Buffer.from(csv));

    expect(sheet.shipments[0]).toMatchObject({ shipmentDate: "2026-02-03", standardQuantity: "5000.000000", supplierName: null });
  });
});

describe("uploading and the figures", () => {
  it("stores the shipments and works every figure out in SQL, on kilograms, volume-weighted", async () => {
    const made = await upload();
    expect(made).toMatchObject({ shipments: 3, skipped: 1, replaced: false });

    const { figures } = await customsSheet(guard(), "baseoil", made.id);

    // 1,000 t + 3,000 t + 1.75 t — from standard_quantity, not the mixed-unit quantity.
    expect(figures.totals).toMatchObject({ shipments: 3, tonnes: 4001.75, first_date: "2026-02-03", last_date: "2026-02-08" });
    // (450×1,000,000 + 200×3,000,000 + 890×1,750) / 4,001,750 = 262.77, not the plain mean of 513.33.
    expect(figures.totals.avg_price_usd).toBe(262.77);
    expect(figures.by_supplier.find((g) => g.name === "Not disclosed")).toMatchObject({ tonnes: 3000, share_pct: 75 });
    expect(figures.by_importer[0]).toMatchObject({ name: "ULTRATECH", tonnes: 3000 });
    expect(figures.notable.map((row) => row.reason)).toEqual(["largest shipment", "highest unit price", "lowest unit price"]);

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "trade.import"));
    expect(entry).toMatchObject({ entityId: made.id, userId: staff });
  });

  it("lists the shipments by date, without the raw row", async () => {
    const made = await upload();
    const page = await shipmentsOf(guard(), "baseoil", made.id);

    expect(page).toMatchObject({ total: 3, page: 1, per_page: 50 });
    expect(page.rows.map((row) => row.shipmentDate)).toEqual(["2026-02-03", "2026-02-07", "2026-02-08"]);
    expect(page.rows[0]).not.toHaveProperty("raw");
  });

  it("replaces the current sheet for the same product and month, whatever the case", async () => {
    const first = await upload("Petroleum Coke");
    const second = await upload("PETROLEUM COKE");

    expect(second.replaced).toBe(true);

    const list = await listCustomsSheets(guard(), "baseoil");
    expect(list.map((row) => [row.id, row.superseded])).toEqual([
      [second.id, false],
      [first.id, true],
    ]);
    // The old one's shipments are kept with it.
    expect(await db().select().from(tradeShipments).where(eq(tradeShipments.importId, first.id))).toHaveLength(3);
  });

  it("writes nothing for a bad sheet, and checks the label and month", async () => {
    await expect(upload("Coke", "2026-02", Buffer.from("not a spreadsheet"))).rejects.toBeInstanceOf(AccountError);
    await expect(upload("  ", "2026-02")).rejects.toThrow(/Name the product/);
    await expect(upload("Coke", "2026-13")).rejects.toThrow(/month/);
    expect(await db().select().from(tradeImports)).toHaveLength(0);
  });

  it("is for the brand's own staff with the trade-analysis permission", async () => {
    const other = (await makeBrand("waxreport", [])).siteId;
    const outsider = { identity: { user: { id: staff, email: "x@y.z" }, memberships: [] }, siteIds: [other], isSuperadmin: false } as never;

    await expect(listCustomsSheets(outsider, "baseoil")).rejects.toThrow(/access to that brand/);

    const made = await upload();
    await expect(customsSheet(guard(), "waxreport", made.id)).rejects.toThrow(/No such customs sheet/);
    void siteId;
  });
});

describe("the AI analysis", () => {
  it("hands the engine the figures, not the rows, and keeps what it says", async () => {
    const made = await upload();

    expect(await analyseCustomsSheet(guard(), "baseoil", made.id)).toEqual({ status: "complete", error: null });

    const sent = calls[0]!.json as { title: string; figures: { totals: { tonnes: number } } };
    expect(calls[0]!.path).toBe("trade-analysis");
    expect(sent.title).toBe("Petroleum Coke imports into India — February 2026");
    expect(sent.figures.totals.tonnes).toBe(4001.75);
    expect(JSON.stringify(sent)).not.toContain("raw");

    expect((await customsSheet(guard(), "baseoil", made.id)).analysis).toMatchObject({ status: "complete", text: "Imports rose.", model: "gpt-4.1" });
  });

  it("keeps a failure as the analysis", async () => {
    const { EngineError } = await import("@/lib/engine/client");
    const made = await upload();

    answer = () => {
      throw new EngineError("The AI engine could not be reached. Try again in a minute.", 502);
    };

    expect((await analyseCustomsSheet(guard(), "baseoil", made.id)).status).toBe("failed");
    expect((await customsSheet(guard(), "baseoil", made.id)).analysis).toMatchObject({ status: "failed", error: "The AI engine could not be reached. Try again in a minute." });
  });
});
