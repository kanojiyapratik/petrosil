/**
 * Staff staging a price update from a spreadsheet, and correcting its rows:
 * the old admin's "Upload" on the price-batch screen (baseoil's only), now on
 * every brand.
 *
 * The reading is `sheet.ts`, shared with the console's relay, so a file
 * stages the same rows whichever way it arrives. Nothing here publishes: an
 * upload is a draft batch, and the batch page's Commit is the only way out.
 *
 * Editing a row is `updateItem`'s rules unchanged — a price, a date, which
 * market the row means, or whether it is in. That is how an unmatched row
 * ("Mumbai FOB" where the brand says "Mumbai, FOB") is mended without
 * uploading the whole sheet again.
 */

import { and, asc, eq, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, locations, priceBatchItems } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";

import { BatchError, itemOnSite, updateItem, type ItemPatch } from "./batches";
import { brandForBatch } from "./entry";
import { MAX_BYTES, SheetError, stageUpload } from "./sheet";

export const ALLOWED_EXTENSIONS = ["xlsx", "csv"] as const;

type Context = { ip?: string | null };

export type Uploaded = { batchId: number; rows: number; needsLook: number };

const NEEDS_LOOK = new Set(["ambiguous", "unmatched", "invalid", "conflict", "locked"]);

export async function uploadSheet(
  guard: Guarded,
  slug: string,
  file: { name: string; bytes: Buffer },
  priceDate: string | null,
  context: Context = {},
  database: Database = db(),
): Promise<Uploaded> {
  const brand = await brandForBatch(guard, slug, "price-batch-create", database);
  const extension = (file.name.split(".").pop() ?? "").toLowerCase();

  // .xls is refused by the reader with its reason; said here first so the
  // message names what IS accepted.
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new AccountError("Upload an .xlsx or .csv file. An old .xls can be saved as .xlsx from Excel.", 422, "file");
  }

  if (file.bytes.byteLength === 0) {
    throw new AccountError("That file is empty.", 422, "file");
  }

  if (file.bytes.byteLength > MAX_BYTES) {
    throw new AccountError("The file may not be greater than 10 MB.", 422, "file");
  }

  let staged;

  try {
    staged = await stageUpload(
      { siteId: brand.id, filename: file.name, bytes: file.bytes, priceDate: priceDate || undefined, userId: guard.identity.user.id },
      database,
    );
  } catch (error) {
    if (error instanceof SheetError) {
      throw new AccountError(error.message, 422, "file");
    }

    throw error;
  }

  const { batch, items } = staged;
  const needsLook = items.filter((item) => NEEDS_LOOK.has(item.status)).length;

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "price_batch.upload",
    entity: "price_batch",
    entityId: batch.id,
    detail: { file: file.name.slice(0, 191), rows: items.length, needs_look: needsLook },
    ip: context.ip ?? null,
  });

  return { batchId: batch.id, rows: items.length, needsLook };
}

/** One row of a draft batch, changed. Answers the batch the row belongs to. */
export async function editRow(
  guard: Guarded,
  input: { site: string; itemId: number; patch: ItemPatch },
  context: Context = {},
  database: Database = db(),
): Promise<{ batchId: number }> {
  const brand = await brandForBatch(guard, input.site, "price-batch-create", database);
  const before = await itemOnSite(brand.id, input.itemId, database);

  if (!before) {
    throw new AccountError("No such row on this brand.", 404, "item");
  }

  let after: typeof priceBatchItems.$inferSelect;

  try {
    after = await updateItem(brand.id, input.itemId, input.patch, database);
  } catch (error) {
    if (error instanceof BatchError) {
      throw new AccountError(error.message, error.status === 404 ? 404 : 422, "item");
    }

    throw error;
  }

  const changed: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of ["locationId", "priceDate", "newPrice", "isIncluded"] as const) {
    if (String(before[key]) !== String(after[key])) {
      changed[key] = { from: before[key], to: after[key] };
    }
  }

  if (Object.keys(changed).length > 0) {
    await database.insert(auditLog).values({
      siteId: brand.id,
      userId: guard.identity.user.id,
      action: "price_batch.edit_row",
      entity: "price_batch",
      entityId: after.batchId,
      detail: { item: after.id, changed, status: after.status },
      ip: context.ip ?? null,
    });
  }

  return { batchId: after.batchId };
}

/** The brand's markets, for pointing a row at the right one. */
export async function marketsToPick(siteId: number, database: Database = db()): Promise<{ id: number; title: string }[]> {
  return database
    .select({ id: locations.id, title: locations.title })
    .from(locations)
    .where(and(eq(locations.siteId, siteId), isNull(locations.deletedAt)))
    .orderBy(asc(locations.title));
}
