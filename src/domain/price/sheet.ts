/**
 * Staging a batch from a spreadsheet.
 *
 * The console never reads the file: it relays whatever the editor picked,
 * because the site is what knows its own location names and date formats.
 * This is where that file is read.
 *
 * The one rule that is easy to get wrong, and was got wrong once already:
 * **the shape of the sheet is decided once for the whole file, not per row.**
 * Deciding per row let a blank price cell in an otherwise three-column sheet
 * look like a dateless two-column row, which shift-read its DATE cell as the
 * price — and an Excel date serial is a number, so it sailed through the
 * numeric check and staged as a real price.
 */

import ExcelJS from "exceljs";

import type { Database } from "@/db";
import { db } from "@/db";
import { priceBatchItems, priceBatches } from "@/db/schema";

import { parseDate } from "./dates";
import { diff } from "./batches";
import { LocationResolver } from "./locations";
import type { Batch, BatchItem } from "./batches";

export const MAX_ROWS = 5000;
export const MAX_BYTES = 10 * 1024 * 1024;

/** One cell as read off the sheet: text, a number, or a real date. */
export type Cell = string | number | Date | null;

export class SheetError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------- reading it */

export async function readRows(filename: string, bytes: Buffer): Promise<Cell[][]> {
  const extension = (filename.split(".").pop() ?? "").toLowerCase();

  if (extension === "csv") {
    return readCsv(bytes.toString("utf8"));
  }

  if (extension === "xlsx") {
    return readXlsx(bytes);
  }

  if (extension === "xls") {
    // The one deliberate difference from the PHP sites, which accepted the
    // 1997 binary format through PhpSpreadsheet. Every maintained Node reader
    // for it is either unmaintained or carries parser advisories, and this
    // file arrives from outside. Saying so beats parsing it badly.
    throw new SheetError(
      "This is an old .xls file. Save it as .xlsx or .csv and upload it again.",
    );
  }

  throw new SheetError("The file must be a file of type: xlsx, csv.");
}

async function readXlsx(bytes: Buffer): Promise<Cell[][]> {
  const workbook = new ExcelJS.Workbook();

  try {
    // `bytes.buffer` would hand over the whole pool slab; this is the file.
    await workbook.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  } catch {
    throw new SheetError("That file could not be read as a spreadsheet.");
  }

  const sheet = workbook.worksheets[0];

  if (!sheet) {
    throw new SheetError("That workbook has no sheets.");
  }

  const rows: Cell[][] = [];

  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: Cell[] = [];

    // 1-based, and `values[0]` is always empty in exceljs.
    for (let column = 1; column <= 3; column += 1) {
      cells.push(cellValue(row.getCell(column).value));
    }

    rows.push(cells);
  });

  return rows;
}

function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date || typeof value === "number" || typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    // Formulas, rich text and hyperlinks all carry their readable value.
    if ("result" in value && value.result !== undefined) {
      return cellValue(value.result as ExcelJS.CellValue);
    }

    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }

    if ("text" in value && typeof value.text === "string") {
      return value.text;
    }
  }

  return String(value);
}

/**
 * CSV, read by hand rather than with a dependency: quoted fields, doubled
 * quotes inside them, and CRLF. Only the first three columns are used, but
 * the parser reads whole rows so a comma inside a quoted name cannot shift
 * the columns.
 */
export function readCsv(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };

  const endRow = (): void => {
    endField();

    if (row.some((cell) => cell.trim() !== "")) {
      rows.push([row[0] ?? null, row[1] ?? null, row[2] ?? null].map(clean));
    }

    row = [];
  };

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;

    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          field += '"';
          at += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }

      continue;
    }

    if (char === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (char === ",") {
      endField();
    } else if (char === "\n") {
      endRow();
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    endRow();
  }

  return rows;
}

function clean(value: string | null): Cell {
  if (value === null) {
    return null;
  }

  const text = value.trim();

  return text === "" ? null : text;
}

/* ------------------------------------------------------------- staging it */

const asText = (cell: Cell): string =>
  cell === null ? "" : cell instanceof Date ? cell.toISOString() : String(cell);

const filled = (cell: Cell): boolean => asText(cell).trim() !== "";

/** A row is three-column when its third cell has something in it. */
const hasDateColumn = (row: Cell[]): boolean => filled(row[2] ?? null);

/**
 * Drop a header row: one whose price cell is not a number AND whose name does
 * not resolve to a live location. Both conditions matter — a real data row can
 * carry an unreadable price, and if its name is a known location it must be
 * kept as an `invalid` item rather than silently discarded as a header.
 */
export function stripHeader(rows: Cell[][], resolver: LocationResolver): Cell[][] {
  const kept = [...rows];
  const first = kept[0];

  if (first) {
    const priceCell = hasDateColumn(first) ? first[2] : first[1];
    const name = asText(first[0] ?? null);
    const unknownName = resolver.resolve(name).status === "unmatched";

    if (!isNumeric(priceCell ?? null) && unknownName) {
      kept.shift();
    }
  }

  return kept.filter((row) => filled(row[0] ?? null));
}

function isNumeric(cell: Cell): boolean {
  if (cell === null || cell instanceof Date) {
    return false;
  }

  if (typeof cell === "number") {
    return Number.isFinite(cell);
  }

  const text = cell.trim();

  return text !== "" && !Number.isNaN(Number(text));
}

export type UploadOptions = {
  siteId: number;
  filename: string;
  bytes: Buffer;
  priceDate?: unknown;
  userId?: number | null;
  now?: Date;
};

export async function stageUpload(
  options: UploadOptions,
  database: Database = db(),
): Promise<{ batch: Batch; items: BatchItem[] }> {
  const { siteId, filename, bytes, userId = null, now = new Date() } = options;

  if (bytes.byteLength > MAX_BYTES) {
    throw new SheetError("The file may not be greater than 10 MB.");
  }

  const resolver = await LocationResolver.forSite(siteId, database);
  const rows = stripHeader(await readRows(filename, bytes), resolver);

  if (rows.length === 0) {
    throw new SheetError("That file has no rows.");
  }

  if (rows.length > MAX_ROWS) {
    throw new SheetError(`File has ${rows.length} rows; the maximum is ${MAX_ROWS}.`);
  }

  const defaultDate =
    options.priceDate === undefined || options.priceDate === null || options.priceDate === ""
      ? null
      : parseDate(options.priceDate);

  const threeColumn = rows.some(hasDateColumn);

  // A two-column sheet carries no dates of its own, so it cannot be staged
  // without one. Refused before the batch is created, rather than filling a
  // preview with rows that are all invalid.
  if (!threeColumn && defaultDate === null) {
    throw new SheetError("This file has no date column, so choose the price date for the upload.");
  }

  const [batch] = await database
    .insert(priceBatches)
    .values({ siteId, source: "upload", status: "draft", createdBy: userId })
    .returning();

  const items: BatchItem[] = [];

  for (const row of rows) {
    const rawLocation = asText(row[0] ?? null);
    const date = threeColumn ? parseDate(row[1] ?? null) : defaultDate;
    const priceCell = threeColumn ? (row[2] ?? null) : (row[1] ?? null);
    const price = isNumeric(priceCell) ? Number(priceCell) : null;

    const base = {
      batchId: batch!.id,
      rawLocation,
      priceDate: date ?? "1970-01-01",
      newPrice: String(price ?? 0),
    };

    if (date === null) {
      items.push(await add(database, { ...base, status: "invalid", errorMessage: "Could not read the date." }));
      continue;
    }

    if (price === null || price < 0) {
      items.push(
        await add(database, {
          ...base,
          status: "invalid",
          errorMessage: "Price must be a number, zero or more.",
        }),
      );
      continue;
    }

    const match = resolver.resolve(rawLocation);

    if (match.status === "unmatched") {
      items.push(
        await add(database, {
          ...base,
          status: "unmatched",
          errorMessage: "No location matches this name.",
        }),
      );
      continue;
    }

    if (match.status === "ambiguous") {
      items.push(
        await add(database, {
          ...base,
          status: "ambiguous",
          errorMessage: "This name matches more than one location.",
        }),
      );
      continue;
    }

    const result = await diff(match.location.id, date, price, database, now);

    items.push(
      await add(database, {
        ...base,
        locationId: match.location.id,
        currency: match.location.currency,
        priceId: result.priceId,
        oldPrice: result.oldPrice,
        status: result.status,
      }),
    );
  }

  return { batch: batch!, items };
}

async function add(
  database: Database,
  values: typeof priceBatchItems.$inferInsert,
): Promise<BatchItem> {
  const [row] = await database.insert(priceBatchItems).values(values).returning();

  return row!;
}
