/**
 * Writing a report: its title and description, who may read it, and the PDF
 * and cover picture behind it.
 *
 * The old form saved whatever file name it was given, so a report could name
 * a PDF that was never uploaded and its readers got a dead link. Here a file
 * has to be in the store, in that brand's report folder, before a report may
 * name it. The names stay bare, as the old rows have them, so the 3,600
 * carried reports and new ones are read the same way.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, mediaFiles, reports, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { requirePermission } from "@/domain/staff/permissions";
import { AccountError } from "@/domain/accounts/register";

/** "premium" shows the title and description to everyone and the file to subscribers. */
export const REPORT_STATUSES = ["draft", "published", "premium"] as const;

export const FILE_FOLDER = "reports/files";
export const THUMBNAIL_FOLDER = "reports/thumbnail";

export type ReportForEdit = {
  id: number;
  site: string;
  site_name: string;
  slug: string;
  title: string;
  description: string | null;
  report_type: string;
  status: string;
  authored_on: string | null;
  file: string | null;
  /** The file's row in the store, or null when the name points at nothing. */
  file_id: number | null;
  thumbnail: string | null;
  thumbnail_id: number | null;
  meta_title: string | null;
  meta_description: string | null;
  clicks: number;
  updated_at: string;
};

type Row = typeof reports.$inferSelect;

const clean = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");

/** Undefined: leave it. Null or blank: clear it. */
function optional(value: unknown, max: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  const text = typeof value === "string" ? value.trim() : "";

  return text === "" ? null : text.slice(0, max);
}

function title(value: unknown): string {
  const text = clean(value);

  if (text === "") {
    throw new AccountError("Give the report a title.", 422, "title");
  }

  return text.slice(0, 255);
}

function status(value: unknown): string {
  if (!(REPORT_STATUSES as readonly string[]).includes(String(value))) {
    throw new AccountError("Choose who may read it.", 422, "status");
  }

  return String(value);
}

function reportType(value: unknown): string {
  const text = clean(value).toLowerCase();

  if (text === "") {
    throw new AccountError("Say what kind of report it is.", 422, "report_type");
  }

  return text.slice(0, 64);
}

/** A calendar date that exists, or null for none. "2026-02-30" is refused, not rolled over. */
function day(value: unknown): string | null {
  const text = String(value ?? "").trim();

  if (text === "") {
    return null;
  }

  const parsed = new Date(`${text}T00:00:00Z`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new AccountError("That is not a date.", 422, "authored_on");
  }

  return text;
}

/** The id of a brand's file in one folder, by bare name, or null. */
async function storedFile(siteId: number, folder: string, name: string, database: Database): Promise<number | null> {
  const [found] = await database
    .select({ id: mediaFiles.id })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.siteId, siteId), eq(mediaFiles.folder, folder), eq(mediaFiles.name, name)))
    .limit(1);

  return found?.id ?? null;
}

/** A file name the report may carry: in the store, in this brand's folder. */
async function attachable(
  siteId: number,
  field: "file" | "thumbnail",
  value: unknown,
  database: Database,
): Promise<string | null | undefined> {
  const name = optional(value, 512);

  if (!name) {
    return name;
  }

  const folder = field === "file" ? FILE_FOLDER : THUMBNAIL_FOLDER;

  if ((await storedFile(siteId, folder, name, database)) === null) {
    throw new AccountError(
      field === "file"
        ? "That PDF is not in this brand's report files. Upload it here first."
        : "That picture is not in this brand's report thumbnails. Upload it here first.",
      422,
      field,
    );
  }

  return name;
}

/** A slug from the title, numbered when the brand already has it. */
async function slugFor(siteId: number, text: string, database: Database): Promise<string> {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 180) || "report";

  // Withdrawn reports keep their slug: the unique index covers them too.
  const taken = await database
    .select({ slug: reports.slug })
    .from(reports)
    .where(and(eq(reports.siteId, siteId), sql`${reports.slug} like ${`${base}%`}`));

  const used = new Set(taken.map((row) => row.slug));

  if (!used.has(base)) {
    return base;
  }

  for (let n = 2; n < 1000; n += 1) {
    if (!used.has(`${base}-${n}`)) {
      return `${base}-${n}`;
    }
  }

  return `${base}-${Date.now()}`;
}

export type ReportSaved = {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  file: string | null;
  thumbnail: string | null;
};

const saved = (row: Row): ReportSaved => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  description: row.description,
  status: row.status,
  file: row.file,
  thumbnail: row.thumbnail,
});

export async function createReport(
  guard: Guarded,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<ReportSaved> {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, String(body.site ?? ""))).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  // The brand comes from the form, so it is checked against the grant.
  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "report-create", database);

  const name = title(body.title);

  const values = {
    siteId: brand.id,
    title: name,
    description: optional(body.description, 20_000) ?? null,
    reportType: reportType(body.report_type),
    status: body.status === undefined ? "draft" : status(body.status),
    authoredOn: day(body.authored_on),
    file: (await attachable(brand.id, "file", body.file, database)) ?? null,
    thumbnail: (await attachable(brand.id, "thumbnail", body.thumbnail, database)) ?? null,
    metaTitle: optional(body.meta_title, 255) ?? null,
    metaDescription: optional(body.meta_description, 2000) ?? null,
  };

  const [row] = await database
    .insert(reports)
    .values({ ...values, slug: await slugFor(brand.id, name, database) })
    .returning();

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "report.create",
    entity: "report",
    entityId: row!.id,
    detail: { title: row!.title, status: row!.status, file: row!.file },
    ip: context.ip ?? null,
  });

  return saved(row!);
}

async function editable(guard: Guarded, id: number, database: Database): Promise<Row | null> {
  const [found] = await database
    .select()
    .from(reports)
    .where(and(eq(reports.id, id), isNull(reports.deletedAt)))
    .limit(1);

  // Another brand's report answers the same as no report.
  return found && (guard.isSuperadmin || guard.siteIds.includes(found.siteId)) ? found : null;
}

/** Changes only what the body names. The slug never moves: shared links keep working. */
export async function updateReport(
  guard: Guarded,
  id: number,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<ReportSaved | null> {
  const found = await editable(guard, id, database);

  if (!found) {
    return null;
  }

  await requirePermission(guard, found.siteId, "report-edit", database);

  const changes: Partial<typeof reports.$inferInsert> = {};

  if (body.title !== undefined) changes.title = title(body.title);
  if (body.description !== undefined) changes.description = optional(body.description, 20_000);
  if (body.report_type !== undefined) changes.reportType = reportType(body.report_type);
  if (body.status !== undefined) changes.status = status(body.status);
  if (body.authored_on !== undefined) changes.authoredOn = day(body.authored_on);
  if (body.file !== undefined) changes.file = await attachable(found.siteId, "file", body.file, database);
  if (body.thumbnail !== undefined) changes.thumbnail = await attachable(found.siteId, "thumbnail", body.thumbnail, database);
  if (body.meta_title !== undefined) changes.metaTitle = optional(body.meta_title, 255);
  if (body.meta_description !== undefined) changes.metaDescription = optional(body.meta_description, 2000);

  const [after] = await database
    .update(reports)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(reports.id, id))
    .returning();

  const fields = Object.keys(changes).filter(
    (key) => changes[key as keyof typeof changes] !== found[key as keyof Row],
  );

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: changes.status !== undefined && changes.status !== found.status ? "report.status" : "report.update",
    entity: "report",
    entityId: id,
    detail: { fields, ...(changes.status !== found.status ? { was: found.status, now: after!.status } : {}) },
    ip: context.ip ?? null,
  });

  return saved(after!);
}

/** Withdraw, not destroy: the row stays, and so does its place in the send history. */
export async function withdrawReport(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const found = await editable(guard, id, database);

  if (!found) {
    return false;
  }

  await requirePermission(guard, found.siteId, "report-delete", database);

  await database.update(reports).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(reports.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "report.withdraw",
    entity: "report",
    entityId: id,
    detail: { title: found.title, slug: found.slug },
    ip: context.ip ?? null,
  });

  return true;
}

/** One report as its editor needs it, scoped like every dashboard read. */
export async function reportForEdit(
  siteIds: number[],
  id: number,
  database: Database = db(),
): Promise<ReportForEdit | null> {
  const [row] = await database
    .select({ report: reports, slug: sites.slug, name: sites.name })
    .from(reports)
    .innerJoin(sites, eq(sites.id, reports.siteId))
    .where(and(eq(reports.id, id), isNull(reports.deletedAt)))
    .limit(1);

  if (!row || (siteIds.length > 0 && !siteIds.includes(row.report.siteId))) {
    return null;
  }

  const { report } = row;

  const [fileId, thumbnailId] = await Promise.all([
    report.file ? storedFile(report.siteId, FILE_FOLDER, report.file, database) : null,
    report.thumbnail ? storedFile(report.siteId, THUMBNAIL_FOLDER, report.thumbnail, database) : null,
  ]);

  return {
    id: report.id,
    site: row.slug,
    site_name: row.name,
    slug: report.slug,
    title: report.title,
    description: report.description,
    report_type: report.reportType,
    status: report.status,
    authored_on: report.authoredOn,
    file: report.file,
    file_id: fileId,
    thumbnail: report.thumbnail,
    thumbnail_id: thumbnailId,
    meta_title: report.metaTitle,
    meta_description: report.metaDescription,
    clicks: report.clicks,
    updated_at: report.updatedAt.toISOString(),
  };
}

/** The kinds in use on a brand, for the form's suggestions. "report" and "sample" are always offered. */
export async function reportTypes(siteId: number, database: Database = db()): Promise<string[]> {
  const rows = await database
    .selectDistinct({ type: reports.reportType })
    .from(reports)
    .where(eq(reports.siteId, siteId));

  return [...new Set(["report", "sample", ...rows.map((row) => row.type)])].sort();
}
