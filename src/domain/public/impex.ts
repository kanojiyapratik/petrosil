/**
 * Impex sheets on the brand sites: the list, one sheet, and its spreadsheet.
 *
 * The same paywall as reports (see `./reports.ts`): everyone sees the title
 * and description; the file downloads for anybody when the sheet is open to
 * everyone, and for a paying reader or the team when it is for subscribers.
 */

import { and, count, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { impexSheets, mediaFiles, sites } from "@/db/schema";
import type { FileStore } from "@/lib/files/store";
import type { Entitlement } from "./paywall";
import { refusalFor, REFUSAL_MESSAGES, type Download, type Refusal } from "./reports";

const LISTED = ["published", "premium"] as const;
const FILE_FOLDER = "impex/files";

type Row = typeof impexSheets.$inferSelect;

export type SheetCard = {
  slug: string;
  title: string;
  description: string | null;
  authored_on: string | null;
  premium: boolean;
};

export type SheetDetail = SheetCard & {
  download: { allowed: boolean; reason: Refusal | "no_file" | null; url: string | null };
};

const card = (row: Row): SheetCard => ({
  slug: row.slug,
  title: row.title,
  description: row.description,
  authored_on: row.authoredOn,
  premium: row.status === "premium",
});

const listed = (siteId: number) =>
  and(eq(impexSheets.siteId, siteId), inArray(impexSheets.status, [...LISTED]), isNull(impexSheets.deletedAt));

export async function publishedSheets(
  siteId: number,
  options: { search?: string; limit?: number; offset?: number },
  database: Database = db(),
): Promise<{ sheets: SheetCard[]; total: number }> {
  const where = and(listed(siteId), options.search ? ilike(impexSheets.title, `%${options.search}%`) : undefined);
  const [counted] = await database.select({ n: count() }).from(impexSheets).where(where);
  const rows = await database
    .select()
    .from(impexSheets)
    .where(where)
    .orderBy(desc(sql`coalesce(${impexSheets.authoredOn}, ${impexSheets.createdAt}::date)`), desc(impexSheets.id))
    .limit(Math.min(100, Math.max(1, options.limit ?? 20)))
    .offset(Math.max(0, options.offset ?? 0));

  return { sheets: rows.map(card), total: Number(counted?.n ?? 0) };
}

async function findListed(siteId: number, slug: string, database: Database): Promise<Row | null> {
  const [row] = await database.select().from(impexSheets).where(and(listed(siteId), eq(impexSheets.slug, slug))).limit(1);

  return row ?? null;
}

async function storedPath(siteId: number, name: string | null, database: Database): Promise<string | null> {
  if (!name) {
    return null;
  }

  const [found] = await database
    .select({ path: mediaFiles.path })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.siteId, siteId), eq(mediaFiles.folder, FILE_FOLDER), eq(mediaFiles.name, name)))
    .limit(1);

  return found?.path ?? null;
}

export async function publishedSheet(
  siteId: number,
  slug: string,
  entitlement: Entitlement,
  database: Database = db(),
): Promise<SheetDetail | null> {
  const row = await findListed(siteId, slug, database);

  if (!row) {
    return null;
  }

  const [brand] = await database.select({ slug: sites.slug }).from(sites).where(eq(sites.id, siteId)).limit(1);
  const hasFile = (await storedPath(siteId, row.file, database)) !== null;
  const refusal = refusalFor(row, entitlement);

  return {
    ...card(row),
    download: hasFile
      ? { allowed: refusal === null, reason: refusal, url: `/api/public/${brand?.slug}/impex/${row.slug}/download` }
      : { allowed: false, reason: "no_file", url: null },
  };
}

/** The spreadsheet, when this reader may have it; counted as one opening when handed over. */
export async function impexDownload(
  siteId: number,
  slug: string,
  entitlement: Entitlement,
  store: FileStore,
  database: Database = db(),
): Promise<Download> {
  const missing = { ok: false, status: 404, reason: "not_found", message: "No such sheet." } as const;
  const row = await findListed(siteId, slug, database);

  if (!row) {
    return missing;
  }

  const refusal = refusalFor(row, entitlement);

  if (refusal) {
    return { ok: false, status: refusal === "sign_in" ? 401 : 403, reason: refusal, message: REFUSAL_MESSAGES[refusal] };
  }

  const path = await storedPath(siteId, row.file, database);
  const file = path ? await store.get(path) : null;

  if (!file) {
    return missing;
  }

  try {
    await database
      .update(impexSheets)
      .set({ clicks: sql`${impexSheets.clicks} + 1` })
      .where(eq(impexSheets.id, row.id));
  } catch (error) {
    console.error("could not count an impex download", { id: row.id, error });
  }

  const extension = (row.file ?? "").split(".").pop()?.toLowerCase() || "xlsx";

  return { ok: true, file, filename: `${row.slug}.${extension}` };
}
