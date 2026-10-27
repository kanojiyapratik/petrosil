/**
 * Reports on the brand sites: the list, one report, and its PDF.
 *
 * Everyone sees a report's title, description and cover. The PDF is the
 * paid part. A report open to everyone (a sample, say) downloads for anybody;
 * one for subscribers only downloads for a paying reader or the team. Anyone
 * else is told why not — sign in, subscribe, or renew — so the brand site can
 * say the right thing instead of handing over a link that fails.
 *
 * The old sites served report PDFs from a public folder, so knowing the file
 * name was enough to read any report: the address was the whole paywall.
 * Here the file is only ever streamed from behind the check, and its name
 * never appears in a list.
 */

import { and, count, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { mediaFiles, reports, sites } from "@/db/schema";
import type { FileStore, StoredFile } from "@/lib/files/store";
import type { Entitlement } from "./paywall";

/** What a reader may see listed. A draft or a withdrawn report never is. */
const LISTED = ["published", "premium"] as const;

const FILE_FOLDER = "reports/files";
const THUMBNAIL_FOLDER = "reports/thumbnail";

export type ReportCard = {
  slug: string;
  title: string;
  description: string | null;
  report_type: string;
  authored_on: string | null;
  /** Subscribers only. */
  premium: boolean;
  thumbnail_url: string | null;
};

/** Why a reader may not download: what the brand site should invite them to do. */
export type Refusal = "sign_in" | "subscribe" | "renew";

export type ReportDetail = ReportCard & {
  meta_title: string | null;
  meta_description: string | null;
  download: { allowed: boolean; reason: Refusal | "no_file" | null; url: string | null };
};

type Row = typeof reports.$inferSelect;

async function slugOf(siteId: number, database: Database): Promise<string> {
  const [brand] = await database.select({ slug: sites.slug }).from(sites).where(eq(sites.id, siteId)).limit(1);

  return brand?.slug ?? "";
}

const card = (row: Row, brand: string): ReportCard => ({
  slug: row.slug,
  title: row.title,
  description: row.description,
  report_type: row.reportType,
  authored_on: row.authoredOn,
  premium: row.status === "premium",
  // Covers are pictures on public pages, served from the public files route.
  thumbnail_url: row.thumbnail ? `/api/public/${brand}/files/${THUMBNAIL_FOLDER}/${encodeURIComponent(row.thumbnail)}` : null,
});

const listed = (siteId: number) =>
  and(eq(reports.siteId, siteId), inArray(reports.status, [...LISTED]), isNull(reports.deletedAt));

export async function publishedReports(
  siteId: number,
  options: { type?: string; search?: string; limit?: number; offset?: number } = {},
  database: Database = db(),
): Promise<{ reports: ReportCard[]; total: number }> {
  const where = and(
    listed(siteId),
    options.type ? eq(reports.reportType, options.type) : undefined,
    options.search ? ilike(reports.title, `%${options.search}%`) : undefined,
  );

  const [counted] = await database.select({ n: count() }).from(reports).where(where);
  const rows = await database
    .select()
    .from(reports)
    .where(where)
    .orderBy(desc(sql`coalesce(${reports.authoredOn}, ${reports.createdAt}::date)`), desc(reports.id))
    .limit(Math.min(100, Math.max(1, options.limit ?? 20)))
    .offset(Math.max(0, options.offset ?? 0));
  const brand = await slugOf(siteId, database);

  return { reports: rows.map((row) => card(row, brand)), total: Number(counted?.n ?? 0) };
}

/** The refusal for a reader who may not download, or null when they may. */
export function refusalFor(row: Pick<Row, "status">, entitlement: Entitlement): Refusal | null {
  if (row.status !== "premium" || entitlement.entitled) {
    return null;
  }

  if (entitlement.reason === "anonymous") {
    return "sign_in";
  }

  return entitlement.reason === "expired" ? "renew" : "subscribe";
}

async function findListed(siteId: number, slug: string, database: Database): Promise<Row | null> {
  const [row] = await database
    .select()
    .from(reports)
    .where(and(listed(siteId), eq(reports.slug, slug)))
    .limit(1);

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

/** One report as a reader sees it. Null for a draft, a withdrawn one, or one that is not this brand's. */
export async function publishedReport(
  siteId: number,
  slug: string,
  entitlement: Entitlement,
  database: Database = db(),
): Promise<ReportDetail | null> {
  const row = await findListed(siteId, slug, database);

  if (!row) {
    return null;
  }

  const brand = await slugOf(siteId, database);
  const hasFile = (await storedPath(siteId, row.file, database)) !== null;
  const refusal = refusalFor(row, entitlement);

  return {
    ...card(row, brand),
    meta_title: row.metaTitle,
    meta_description: row.metaDescription,
    download: hasFile
      ? { allowed: refusal === null, reason: refusal, url: `/api/public/${brand}/reports/${row.slug}/download` }
      : { allowed: false, reason: "no_file", url: null },
  };
}

export type Download =
  | { ok: true; file: StoredFile; filename: string }
  | { ok: false; status: 401 | 403 | 404; reason: Refusal | "not_found"; message: string };

const MESSAGES: Record<Refusal, string> = {
  sign_in: "Sign in to download this report.",
  subscribe: "This report is for subscribers. Subscribe to download it.",
  renew: "Your subscription has ended. Renew to download this report.",
};

/**
 * The PDF, when this reader may have it. Counted as one opening of the
 * report — the figure the Reports screen ranks by — only when it is handed over.
 */
export async function reportDownload(
  siteId: number,
  slug: string,
  entitlement: Entitlement,
  store: FileStore,
  database: Database = db(),
): Promise<Download> {
  const missing = { ok: false, status: 404, reason: "not_found", message: "No such report." } as const;
  const row = await findListed(siteId, slug, database);

  if (!row) {
    return missing;
  }

  // Who may, before whether the file is there: a refused reader learns
  // nothing about the file from the answer.
  const refusal = refusalFor(row, entitlement);

  if (refusal) {
    return { ok: false, status: refusal === "sign_in" ? 401 : 403, reason: refusal, message: MESSAGES[refusal] };
  }

  const path = await storedPath(siteId, row.file, database);
  const file = path ? await store.get(path) : null;

  if (!file) {
    return missing;
  }

  try {
    await database
      .update(reports)
      .set({ clicks: sql`${reports.clicks} + 1` })
      .where(eq(reports.id, row.id));
  } catch (error) {
    console.error("could not count a report download", { id: row.id, error });
  }

  const extension = (row.file ?? "").split(".").pop()?.toLowerCase() || "pdf";

  return { ok: true, file, filename: `${row.slug}.${extension}` };
}
