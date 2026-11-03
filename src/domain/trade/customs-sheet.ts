/**
 * Reading a customs import sheet: one month of Indian customs data for one
 * product, as the data vendor sends it (49-odd columns, e.g.
 * "PETROLEUM COKE (FEB 26).xlsx").
 *
 * Ported from the trade-ai service's TradeSheetReader, quirks and all, each
 * of which was found in a real sheet:
 *
 *  - Columns are matched by header name, never by position: the "formatted"
 *    sheet has an unlabelled column that shifts every header after it.
 *  - The "formatted" sheet is preferred, then "raw", then the first.
 *  - DATE is an Excel serial (46055), or a real date, or text.
 *  - Numbers carry float noise (451.05903599560003): rounded on the way in.
 *  - "NOT KNOWN", "N/A", "NA" and "-" mean no value.
 *  - Totals and spacer rows sit among the data. A row with nothing in any
 *    known column is skipped; a row with something but no date, description
 *    or quantity is corrupt, and refuses the whole sheet with its row number
 *    — never half an import.
 */

import ExcelJS from "exceljs";

import { readCsv, type Cell } from "@/domain/price/sheet";

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_ROWS = 50_000;

export class CustomsSheetError extends Error {}

/** Field => the vendor's header. */
export const HEADERS = {
  shipmentDate: "DATE",
  hsCode: "HS CODE",
  productDescription: "PRODUCT DESCRIPTION",
  quantity: "QUANTITY",
  unit: "UNIT",
  cifValueUsd: "CIF VALUE (USD)",
  unitPriceUsd: "UNIT PRICE (USD)",
  importerName: "IMPORTER NAME",
  importerCity: "IMPORTER CITY",
  supplierName: "SUPPLIER NAME",
  supplierCountry: "SUPPLIER COUNTRY",
  foreignPort: "FOREIGN PORT",
  foreignCountry: "FOREIGN COUNTRY",
  indianPort: "INDIAN PORT",
  shipmentMode: "SHIPMENT MODE",
  incoterms: "INCOTERMS",
  standardQuantity: "STANDARD QUANTITY",
} as const;

type Field = keyof typeof HEADERS;

/** Without these it is not a customs import sheet at all. */
const REQUIRED: Field[] = ["shipmentDate", "hsCode", "productDescription", "quantity", "unit"];
/** A row is a shipment only with all three. */
const ROW_REQUIRED: Field[] = ["shipmentDate", "productDescription", "quantity"];

const NUMBERS: Field[] = ["quantity", "standardQuantity", "unitPriceUsd", "cifValueUsd"];
const SENTINELS = new Set(["not known", "n/a", "na", "-"]);
const LENGTHS: Partial<Record<Field, number>> = {
  hsCode: 32,
  unit: 24,
  importerName: 255,
  importerCity: 120,
  supplierName: 255,
  supplierCountry: 120,
  foreignPort: 120,
  foreignCountry: 120,
  indianPort: 120,
  shipmentMode: 60,
  incoterms: 24,
};

export type Shipment = {
  shipmentDate: string;
  hsCode: string | null;
  productDescription: string;
  quantity: string;
  unit: string | null;
  standardQuantity: string | null;
  unitPriceUsd: string | null;
  cifValueUsd: string | null;
  importerName: string | null;
  importerCity: string | null;
  supplierName: string | null;
  supplierCountry: string | null;
  foreignCountry: string | null;
  foreignPort: string | null;
  indianPort: string | null;
  shipmentMode: string | null;
  incoterms: string | null;
  raw: Record<string, unknown>;
};

export type CustomsSheet = {
  sheetName: string;
  shipments: Shipment[];
  skipped: number;
  /** Known headers this sheet lacked: a renamed column would otherwise go quietly empty. */
  missingColumns: string[];
};

const squash = (header: unknown) => String(header ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const sentinel = (value: unknown) => typeof value === "string" && SENTINELS.has(value.trim().toLowerCase());

function text(value: unknown, max = 2000): string | null {
  if (value === null || value === undefined || sentinel(value)) {
    return null;
  }

  const said = (value instanceof Date ? value.toISOString().slice(0, 10) : String(value)).trim();

  return said === "" ? null : said.slice(0, max);
}

function decimal(value: unknown): string | null {
  if (value === null || value === undefined || value === "" || sentinel(value)) {
    return null;
  }

  const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());

  // Rounded to six places: float noise in, a clean figure stored.
  return Number.isFinite(number) ? (Math.round(number * 1e6) / 1e6).toFixed(6) : null;
}

/** An Excel serial (days since 1899-12-30), a real date, or text in a form Date can read. */
function day(value: unknown): string | null {
  if (value === null || value === undefined || value === "" || sentinel(value)) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
    const serial = Number(value);

    if (serial < 1 || serial > 100_000) {
      return null;
    }

    return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
  }

  const parsed = new Date(`${String(value).trim()} UTC`);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** What exceljs hands back for one cell, reduced to a value. */
function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date || typeof value === "number" || typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "object") {
    if ("result" in value) {
      return cellValue((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    }

    if ("richText" in value) {
      return value.richText.map((part) => part.text).join("");
    }

    if ("text" in value) {
      return String(value.text);
    }
  }

  return null;
}

async function grid(filename: string, bytes: Buffer): Promise<{ name: string; rows: Cell[][] }> {
  const extension = (filename.split(".").pop() ?? "").toLowerCase();

  if (extension === "csv") {
    return { name: "csv", rows: readCsv(bytes.toString("utf8"), Infinity) };
  }

  if (extension !== "xlsx") {
    throw new CustomsSheetError("Upload the sheet as .xlsx or .csv. An old .xls can be saved as .xlsx from Excel.");
  }

  const book = new ExcelJS.Workbook();

  try {
    await book.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new CustomsSheetError("The file could not be read as a spreadsheet. It may be damaged or password-protected.");
  }

  const sheets = book.worksheets;
  const pick =
    ["formatted", "raw"].map((name) => sheets.find((sheet) => sheet.name.trim().toLowerCase() === name)).find(Boolean) ??
    sheets[0];

  if (!pick) {
    throw new CustomsSheetError("The workbook has no sheets.");
  }

  const rows: Cell[][] = [];

  pick.eachRow({ includeEmpty: true }, (row, number) => {
    const cells: Cell[] = [];

    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cells[column - 1] = cellValue(cell.value);
    });

    rows[number - 1] = cells;
  });

  return { name: pick.name.slice(0, 120), rows: Array.from(rows, (row) => row ?? []) };
}

export async function readCustomsSheet(filename: string, bytes: Buffer): Promise<CustomsSheet> {
  if (bytes.byteLength > MAX_BYTES) {
    throw new CustomsSheetError("The file may not be larger than 20 MB.");
  }

  const { name, rows } = await grid(filename, bytes);
  const header = rows[0] ?? [];

  if (rows.length === 0 || header.every((cell) => text(cell) === null)) {
    throw new CustomsSheetError("The sheet is empty.");
  }

  // Header name => first column carrying it.
  const at = new Map<string, number>();

  header.forEach((cell, index) => {
    const key = squash(cell);

    if (key !== "" && !at.has(key)) {
      at.set(key, index);
    }
  });

  const column = Object.fromEntries(
    (Object.entries(HEADERS) as [Field, string][]).map(([field, label]) => [field, at.get(squash(label))]),
  ) as Record<Field, number | undefined>;

  const lacking = REQUIRED.filter((field) => column[field] === undefined).map((field) => HEADERS[field]);

  if (lacking.length > 0) {
    throw new CustomsSheetError(
      `This does not look like a customs import sheet: it has no ${lacking.join(", ")} column${lacking.length === 1 ? "" : "s"}. ` +
        `Its first row reads: ${header.map((cell) => text(cell)).filter(Boolean).slice(0, 8).join(", ") || "nothing"}.`,
    );
  }

  const shipments: Shipment[] = [];
  let skipped = 0;

  for (let index = 1; index < rows.length; index++) {
    const line = rows[index] ?? [];
    const cell = (field: Field) => {
      const position = column[field];

      return position === undefined ? null : (line[position] ?? null);
    };

    // Judged on the raw cells: a row of "NOT KNOWN" everywhere is corrupt
    // data, not a spacer, and must not be skipped as one.
    const empty = (Object.keys(HEADERS) as Field[]).every((field) => {
      const raw = cell(field);

      return raw === null || String(raw).trim() === "";
    });

    if (empty) {
      skipped++;
      continue;
    }

    const shipmentDate = day(cell("shipmentDate"));
    const productDescription = text(cell("productDescription"));
    const quantity = decimal(cell("quantity"));
    const lackingHere = ROW_REQUIRED.filter(
      (field) => (field === "shipmentDate" ? shipmentDate : field === "quantity" ? quantity : productDescription) === null,
    );

    if (lackingHere.length > 0) {
      throw new CustomsSheetError(
        `Row ${index + 1} has no ${lackingHere.map((field) => HEADERS[field]).join(", ")}. Nothing was imported; correct the sheet and upload it again.`,
      );
    }

    const raw: Record<string, unknown> = {};

    header.forEach((label, position) => {
      const key = text(label);

      if (key) {
        const value = line[position] ?? null;

        raw[key] = value instanceof Date ? value.toISOString().slice(0, 10) : value;
      }
    });

    const value = (field: Field) => (NUMBERS.includes(field) ? decimal(cell(field)) : text(cell(field), LENGTHS[field]));

    shipments.push({
      shipmentDate: shipmentDate!,
      productDescription: productDescription!,
      quantity: quantity!,
      hsCode: value("hsCode"),
      unit: value("unit"),
      standardQuantity: value("standardQuantity"),
      unitPriceUsd: value("unitPriceUsd"),
      cifValueUsd: value("cifValueUsd"),
      importerName: value("importerName"),
      importerCity: value("importerCity"),
      supplierName: value("supplierName"),
      supplierCountry: value("supplierCountry"),
      foreignCountry: value("foreignCountry"),
      foreignPort: value("foreignPort"),
      indianPort: value("indianPort"),
      shipmentMode: value("shipmentMode"),
      incoterms: value("incoterms"),
      raw,
    });

    if (shipments.length > MAX_ROWS) {
      throw new CustomsSheetError(`The sheet has more than ${MAX_ROWS.toLocaleString("en-GB")} shipments; split it by month.`);
    }
  }

  if (shipments.length === 0) {
    throw new CustomsSheetError("The sheet has headings but no shipments.");
  }

  return {
    sheetName: name,
    shipments,
    skipped,
    missingColumns: (Object.entries(HEADERS) as [Field, string][]).filter(([field]) => column[field] === undefined).map(([, label]) => label),
  };
}
