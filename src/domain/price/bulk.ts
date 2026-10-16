/**
 * Bulk edits: set, adjust, or copy prices across many locations at once.
 *
 * None of these write anything. Each one stages an ordinary draft batch that
 * goes through the same preview and the same manual commit as an upload —
 * which is what makes a sweeping change reviewable before it is published.
 *
 * Two rules carried over from the Laravel builder, both learned the hard way:
 *
 *  - `set` and `adjust` only touch dates that ALREADY have a price, and
 *    collapse to one item per (location, date). Two items for the same cell
 *    meant the second re-read a price the first had just changed and was
 *    reported as a conflict.
 *  - an adjustment that would make a price negative is staged `invalid`, not
 *    clamped to zero. Zero is a plausible-looking figure in a commodity
 *    report, so a silent clamp could be published as though it were real.
 */

import { and, asc, between, desc, eq, inArray, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { locations, priceBatchItems, priceBatches, prices } from "@/db/schema";

import { diff, type Batch, type BatchItem } from "./batches";
import { parseDate } from "./dates";

export const MAX_ROWS = 5000;

export type BulkOperation = "set" | "adjust" | "copy";

export type BulkParams = {
  location_ids?: unknown;
  operation?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  value?: unknown;
  source_date?: unknown;
  target_date_from?: unknown;
  target_date_to?: unknown;
};

export class BulkError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

type Validated =
  | { operation: "set" | "adjust"; locationIds: number[]; from: string; to: string; value: number }
  | {
      operation: "copy";
      locationIds: number[];
      sourceDate: string;
      targetFrom: string;
      targetTo: string;
    };

export function validate(params: BulkParams): Validated {
  const locationIds = Array.isArray(params.location_ids)
    ? params.location_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];

  if (locationIds.length === 0) {
    throw new BulkError("Pick at least one location.", "location_ids");
  }

  const operation = String(params.operation ?? "");

  if (operation !== "set" && operation !== "adjust" && operation !== "copy") {
    throw new BulkError("operation must be one of: set, adjust, copy.", "operation");
  }

  if (operation === "copy") {
    const sourceDate = date(params.source_date, "source_date");
    const targetFrom = date(params.target_date_from, "target_date_from");
    const targetTo = date(params.target_date_to, "target_date_to");

    if (targetTo < targetFrom) {
      throw new BulkError("target_date_to must not be before target_date_from.", "target_date_to");
    }

    return { operation, locationIds, sourceDate, targetFrom, targetTo };
  }

  const from = date(params.date_from, "date_from");
  const to = date(params.date_to, "date_to");

  if (to < from) {
    throw new BulkError("date_to must not be before date_from.", "date_to");
  }

  const value = Number(params.value);

  if (params.value === undefined || params.value === null || params.value === "" || Number.isNaN(value)) {
    throw new BulkError("value must be a number.", "value");
  }

  return { operation, locationIds, from, to, value };
}

function date(value: unknown, field: string): string {
  const parsed = parseDate(value);

  if (parsed === null) {
    throw new BulkError(`${field} must be a date.`, field);
  }

  return parsed;
}

export async function stageBulkEdit(
  siteId: number,
  params: BulkParams,
  database: Database = db(),
  now: Date = new Date(),
  userId: number | null = null,
): Promise<{ batch: Batch; items: BatchItem[] }> {
  const plan = validate(params);

  // Only this brand's locations, whatever ids were sent.
  const mine = await database
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.siteId, siteId),
        inArray(locations.id, plan.locationIds),
        isNull(locations.deletedAt),
      ),
    );

  if (mine.length === 0) {
    throw new BulkError("None of those locations belong to this site.", "location_ids");
  }

  const byId = new Map(mine.map((row) => [row.id, row]));
  const ids = [...byId.keys()];

  const rows =
    plan.operation === "copy"
      ? await copyRows(siteId, ids, plan.sourceDate, plan.targetFrom, plan.targetTo, database)
      : await setOrAdjustRows(siteId, ids, plan, database);

  // Counted before the batch exists, so a rejected request leaves no orphan draft.
  if (rows.length > MAX_ROWS) {
    throw new BulkError(`This would stage ${rows.length} rows; the maximum is ${MAX_ROWS}.`);
  }

  if (rows.length === 0) {
    throw new BulkError(
      plan.operation === "copy"
        ? "No prices exist on the source date for those locations."
        : "No prices exist in that date range for those locations.",
    );
  }

  const [batch] = await database
    .insert(priceBatches)
    .values({ siteId, source: "bulk_edit", status: "draft", createdBy: userId })
    .returning();

  const items: BatchItem[] = [];

  for (const row of rows) {
    const location = byId.get(row.locationId)!;

    if (row.invalid) {
      items.push(
        await add(database, {
          batchId: batch!.id,
          rawLocation: location.title,
          locationId: location.id,
          currency: location.currency,
          priceDate: row.priceDate,
          newPrice: String(row.newPrice),
          status: "invalid",
          errorMessage: row.invalid,
        }),
      );
      continue;
    }

    const result = await diff(location.id, row.priceDate, row.newPrice, database, now);

    items.push(
      await add(database, {
        batchId: batch!.id,
        rawLocation: location.title,
        locationId: location.id,
        currency: location.currency,
        priceDate: row.priceDate,
        priceId: result.priceId,
        oldPrice: result.oldPrice,
        newPrice: String(row.newPrice),
        status: result.status,
      }),
    );
  }

  return { batch: batch!, items };
}

type PlannedRow = {
  locationId: number;
  priceDate: string;
  newPrice: number;
  invalid?: string;
};

async function setOrAdjustRows(
  siteId: number,
  locationIds: number[],
  plan: Extract<Validated, { operation: "set" | "adjust" }>,
  database: Database,
): Promise<PlannedRow[]> {
  const existing = await database
    .select()
    .from(prices)
    .where(
      and(
        eq(prices.siteId, siteId),
        inArray(prices.locationId, locationIds),
        between(prices.priceDate, plan.from, plan.to),
        isNull(prices.deletedAt),
      ),
    )
    .orderBy(desc(prices.id));

  const seen = new Set<string>();
  const rows: PlannedRow[] = [];

  for (const price of existing) {
    // Newest row wins per cell — the same "current price" rule the differ
    // applies — so one cell can never produce two items.
    const key = `${price.locationId}|${price.priceDate}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    if (plan.operation === "set") {
      rows.push({ locationId: price.locationId, priceDate: price.priceDate, newPrice: plan.value });
      continue;
    }

    const next = Number(price.price) + plan.value;

    rows.push({
      locationId: price.locationId,
      priceDate: price.priceDate,
      newPrice: next,
      invalid:
        next < 0
          ? `Adjusting by ${plan.value} would make this price negative (current ${price.price}).`
          : undefined,
    });
  }

  return rows;
}

async function copyRows(
  siteId: number,
  locationIds: number[],
  sourceDate: string,
  targetFrom: string,
  targetTo: string,
  database: Database,
): Promise<PlannedRow[]> {
  const sources = await database
    .select()
    .from(prices)
    .where(
      and(
        eq(prices.siteId, siteId),
        inArray(prices.locationId, locationIds),
        eq(prices.priceDate, sourceDate),
        isNull(prices.deletedAt),
      ),
    )
    .orderBy(asc(prices.id));

  const byLocation = new Map<number, number>();

  for (const price of sources) {
    byLocation.set(price.locationId, Number(price.price));
  }

  const rows: PlannedRow[] = [];

  for (const day of dateRange(targetFrom, targetTo)) {
    for (const [locationId, price] of byLocation) {
      rows.push({ locationId, priceDate: day, newPrice: price });
    }
  }

  return rows;
}

/** Inclusive, in whole days. */
export function dateRange(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);

  while (cursor <= end) {
    days.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`,
    );
    cursor.setDate(cursor.getDate() + 1);

    // A malformed range would otherwise spin forever; the validator already
    // rejects to < from, so this only catches a date that is not a date.
    if (days.length > MAX_ROWS) {
      break;
    }
  }

  return days;
}

async function add(
  database: Database,
  values: typeof priceBatchItems.$inferInsert,
): Promise<BatchItem> {
  const [row] = await database.insert(priceBatchItems).values(values).returning();

  return row!;
}
