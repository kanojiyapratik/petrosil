/**
 * Writing an impex sheet: the import and export spreadsheets a brand
 * publishes per period.
 *
 * The same shape and rules as a report. The file must be in the brand's
 * impex folder before a sheet may name it, the slug never moves, and
 * withdrawing keeps the row. "premium" shows the title and description to
 * everyone and the file to subscribers.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, impexSheets, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { attachable, storedFileId } from "@/domain/files/attach";
import { dateInput } from "@/domain/billing/inputs";

export const IMPEX_STATUSES = ["draft", "published", "premium"] as const;
export const FILE_FOLDER = "impex/files";

type Row = typeof impexSheets.$inferSelect;

export type ImpexSaved = { id: number; slug: string; title: string; description: string | null; status: string; file: string | null };

const saved = (row: Row): ImpexSaved => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  description: row.description,
  status: row.status,
  file: row.file,
});

function title(value: unknown): string {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");

  if (text === "") {
    throw new AccountError("Give the sheet a title.", 422, "title");
  }

  return text.slice(0, 255);
}

function status(value: unknown): string {
  if (!(IMPEX_STATUSES as readonly string[]).includes(String(value))) {
    throw new AccountError("Choose who may read it.", 422, "status");
  }

  return String(value);
}

const description = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";

  return text === "" ? null : text.slice(0, 20_000);
};

const attach = (siteId: number, value: unknown, database: Database) =>
  attachable(siteId, FILE_FOLDER, "file", value, "file", database);

async function slugFor(siteId: number, text: string, database: Database): Promise<string> {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 180) || "sheet";

  const taken = await database
    .select({ slug: impexSheets.slug })
    .from(impexSheets)
    .where(and(eq(impexSheets.siteId, siteId), sql`${impexSheets.slug} like ${`${base}%`}`));

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

export async function createImpex(
  guard: Guarded,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<ImpexSaved> {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, String(body.site ?? ""))).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "impex-create", database);

  const name = title(body.title);

  const [row] = await database
    .insert(impexSheets)
    .values({
      siteId: brand.id,
      slug: await slugFor(brand.id, name, database),
      title: name,
      description: description(body.description),
      status: body.status === undefined ? "draft" : status(body.status),
      authoredOn: dateInput(body.authored_on, "authored_on"),
      file: (await attach(brand.id, body.file, database)) ?? null,
    })
    .returning();

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "impex.create",
    entity: "impex_sheet",
    entityId: row!.id,
    detail: { title: row!.title, status: row!.status, file: row!.file },
    ip: context.ip ?? null,
  });

  return saved(row!);
}

async function editable(guard: Guarded, id: number, database: Database): Promise<Row | null> {
  const [found] = await database
    .select()
    .from(impexSheets)
    .where(and(eq(impexSheets.id, id), isNull(impexSheets.deletedAt)))
    .limit(1);

  return found && (guard.isSuperadmin || guard.siteIds.includes(found.siteId)) ? found : null;
}

export async function updateImpex(
  guard: Guarded,
  id: number,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<ImpexSaved | null> {
  const found = await editable(guard, id, database);

  if (!found) {
    return null;
  }

  await requirePermission(guard, found.siteId, "impex-edit", database);

  const changes: Partial<typeof impexSheets.$inferInsert> = {};

  if (body.title !== undefined) changes.title = title(body.title);
  if (body.description !== undefined) changes.description = description(body.description);
  if (body.status !== undefined) changes.status = status(body.status);
  if (body.authored_on !== undefined) changes.authoredOn = dateInput(body.authored_on, "authored_on");
  if (body.file !== undefined) changes.file = await attach(found.siteId, body.file, database);

  const [after] = await database
    .update(impexSheets)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(impexSheets.id, id))
    .returning();

  const statusChanged = changes.status !== undefined && changes.status !== found.status;

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: statusChanged ? "impex.status" : "impex.update",
    entity: "impex_sheet",
    entityId: id,
    detail: {
      fields: Object.keys(changes).filter((key) => changes[key as keyof typeof changes] !== found[key as keyof Row]),
      ...(statusChanged ? { was: found.status, now: after!.status } : {}),
    },
    ip: context.ip ?? null,
  });

  return saved(after!);
}

export async function withdrawImpex(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const found = await editable(guard, id, database);

  if (!found) {
    return false;
  }

  await requirePermission(guard, found.siteId, "impex-delete", database);

  await database.update(impexSheets).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(impexSheets.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "impex.withdraw",
    entity: "impex_sheet",
    entityId: id,
    detail: { title: found.title, slug: found.slug },
    ip: context.ip ?? null,
  });

  return true;
}

export async function impexForEdit(siteIds: number[], id: number, database: Database = db()) {
  const [row] = await database
    .select({ sheet: impexSheets, slug: sites.slug, name: sites.name })
    .from(impexSheets)
    .innerJoin(sites, eq(sites.id, impexSheets.siteId))
    .where(and(eq(impexSheets.id, id), isNull(impexSheets.deletedAt)))
    .limit(1);

  if (!row || (siteIds.length > 0 && !siteIds.includes(row.sheet.siteId))) {
    return null;
  }

  const { sheet } = row;

  return {
    id: sheet.id,
    site: row.slug,
    site_name: row.name,
    slug: sheet.slug,
    title: sheet.title,
    description: sheet.description,
    status: sheet.status,
    authored_on: sheet.authoredOn,
    file: sheet.file,
    file_id: sheet.file ? await storedFileId(sheet.siteId, FILE_FOLDER, sheet.file, database) : null,
    clicks: sheet.clicks,
    updated_at: sheet.updatedAt.toISOString(),
  };
}

export type ImpexForEdit = NonNullable<Awaited<ReturnType<typeof impexForEdit>>>;
