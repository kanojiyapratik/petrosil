/**
 * The published price note: the paragraph the price module's AI writes
 * about an update, shown above the brand's price table. The newest note is
 * the one on the site.
 *
 * The platform never writes these itself; staff can only correct, remove,
 * or write one by hand when the module sent none. A correction or removal
 * keeps the original text in the audit trail, so "what did the AI actually
 * say?" always has an answer.
 */

import { desc, eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, priceSummaries, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";

const PERMISSION = "price-note-edit";

export type NoteRow = {
  id: number;
  summary: string;
  source: string;
  batch_id: number | null;
  created_at: string;
  /** The newest: what readers see now. */
  live: boolean;
};

function text(value: unknown): string {
  const summary = String(value ?? "").trim();

  if (summary === "") {
    throw new AccountError("A note needs some text: an empty one would blank the banner above the prices.", 422, "summary");
  }

  return summary.slice(0, 10_000);
}

/** A brand's notes, newest first. Empty for a brand the viewer cannot see. */
export async function listNotes(siteIds: number[], slug: string, limit = 50, database: Database = db()): Promise<NoteRow[]> {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand || (siteIds.length > 0 && !siteIds.includes(brand.id))) {
    return [];
  }

  const rows = await database
    .select()
    .from(priceSummaries)
    .where(eq(priceSummaries.siteId, brand.id))
    .orderBy(desc(priceSummaries.createdAt), desc(priceSummaries.id))
    .limit(limit);

  return rows.map((row, at) => ({
    id: row.id,
    summary: row.summary,
    source: row.source,
    batch_id: row.priceBatchId,
    created_at: row.createdAt.toISOString(),
    live: at === 0,
  }));
}

async function editable(guard: Guarded, id: number, database: Database) {
  const [found] = await database.select().from(priceSummaries).where(eq(priceSummaries.id, id)).limit(1);

  return found && (guard.isSuperadmin || guard.siteIds.includes(found.siteId)) ? found : null;
}

/** Fix a note's wording. Null when it is another brand's. */
export async function correctNote(
  guard: Guarded,
  id: number,
  input: { summary: unknown },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ id: number } | null> {
  const found = await editable(guard, id, database);

  if (!found) {
    return null;
  }

  await requirePermission(guard, found.siteId, PERMISSION, database);

  const summary = text(input.summary);

  await database.update(priceSummaries).set({ summary }).where(eq(priceSummaries.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "price-note.correct",
    entity: "price_summary",
    entityId: id,
    detail: { was: found.summary, now: summary, source: found.source },
    ip: context.ip ?? null,
  });

  return { id };
}

/** Take a note off the site; the one before it shows instead. False when it is another brand's. */
export async function removeNote(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const found = await editable(guard, id, database);

  if (!found) {
    return false;
  }

  await requirePermission(guard, found.siteId, PERMISSION, database);

  await database.delete(priceSummaries).where(eq(priceSummaries.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "price-note.remove",
    entity: "price_summary",
    entityId: id,
    detail: { summary: found.summary, source: found.source, batch: found.priceBatchId, written: found.createdAt.toISOString() },
    ip: context.ip ?? null,
  });

  return true;
}

/** A note written by hand, when the module sent none. It goes straight to the top. */
export async function writeNote(
  guard: Guarded,
  input: { site: string; summary: unknown },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ id: number }> {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, input.site)).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, PERMISSION, database);

  const [row] = await database
    .insert(priceSummaries)
    .values({ siteId: brand.id, source: "staff", summary: text(input.summary) })
    .returning();

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "price-note.write",
    entity: "price_summary",
    entityId: row!.id,
    detail: { summary: row!.summary },
    ip: context.ip ?? null,
  });

  return { id: row!.id };
}
