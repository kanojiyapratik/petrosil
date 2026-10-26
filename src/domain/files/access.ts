/**
 * Who may open which file, and putting a new one in.
 *
 * Three ways in:
 * - The public, by brand and path, for the folders that hold pictures on
 *   public pages. Never a report PDF or a trade sheet: those are what people
 *   pay for, and will be served through a download that checks the paywall.
 * - Staff, by the file's id, for anything in a brand they work on.
 * - Staff uploading, into one of the known folders, under a name that cannot
 *   collide with what is already there.
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, mediaFiles, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { safeKey, type FileStore, type StoredFile } from "@/lib/files/store";
import { FOLDERS, extensionOf, isPublicFolder, typeFor } from "./folders";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** A public file by brand and `folder/name`, or null for anything it may not see. */
export async function readPublicFile(
  slug: string,
  relativePath: string,
  store: FileStore,
  database: Database = db(),
): Promise<StoredFile | null> {
  const slash = relativePath.lastIndexOf("/");
  const folder = relativePath.slice(0, slash);
  const key = safeKey(`${slug}/${relativePath}`);

  if (slash < 0 || !key || !isPublicFolder(folder)) {
    return null;
  }

  // The index, not the disk, decides what exists: a stray file in the store
  // that nothing indexed is not published.
  const [indexed] = await database
    .select({ id: mediaFiles.id })
    .from(mediaFiles)
    .innerJoin(sites, eq(sites.id, mediaFiles.siteId))
    .where(and(eq(mediaFiles.path, key), eq(sites.slug, slug), eq(sites.enabled, true)))
    .limit(1);

  return indexed ? store.get(key) : null;
}

/** Any of a brand's files, for its staff. */
export async function openFile(
  guard: Pick<Guarded, "siteIds" | "isSuperadmin">,
  id: number,
  store: FileStore,
  database: Database = db(),
): Promise<(StoredFile & { name: string }) | null> {
  const [row] = await database.select().from(mediaFiles).where(eq(mediaFiles.id, id)).limit(1);

  if (!row) {
    return null;
  }

  const allowed =
    guard.isSuperadmin || (row.siteId !== null && guard.siteIds.includes(row.siteId));

  if (!allowed) {
    return null;
  }

  const file = await store.get(row.path);

  return file ? { ...file, name: row.name } : null;
}

/** "October Report 2026.PDF" → "october-report-2026-k3x9qa.pdf" */
function storedName(original: string): string {
  const extension = extensionOf(original);
  const base = original
    .slice(0, original.length - (extension ? extension.length + 1 : 0))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
  const tag = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 6);

  return `${base}-${tag}.${extension}`;
}

export type Uploaded = { ok: true; id: number; name: string; path: string } | { ok: false; message: string };

export async function uploadFile(
  guard: Guarded,
  input: { site: string; folder: string; name: string; type: string; body: Uint8Array },
  store: FileStore,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<Uploaded> {
  if (!FOLDERS.includes(input.folder)) {
    return { ok: false, message: "Choose one of the folders." };
  }

  const [brand] = await database.select().from(sites).where(eq(sites.slug, input.site)).limit(1);

  if (!brand || (!guard.isSuperadmin && !guard.siteIds.includes(brand.id))) {
    return { ok: false, message: "That brand is not yours to upload to." };
  }

  // The type comes from the name, which is what the file will be served as;
  // what the browser claimed is not trusted.
  const type = typeFor(input.name);

  if (!type) {
    return { ok: false, message: "That kind of file is not accepted. PDF, images, video, Office and CSV files are." };
  }

  if (input.body.byteLength === 0) {
    return { ok: false, message: "That file is empty." };
  }

  if (input.body.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, message: `That file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` };
  }

  const name = storedName(input.name);
  const path = `${brand.slug}/${input.folder}/${name}`;

  await store.put(path, input.body, type);

  const [row] = await database
    .insert(mediaFiles)
    .values({
      siteId: brand.id,
      path,
      folder: input.folder,
      name,
      kind: type,
      bytes: input.body.byteLength,
      uploadedBy: guard.identity.user.id,
    })
    .returning({ id: mediaFiles.id });

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "file.upload",
    entity: "media_file",
    entityId: row!.id,
    detail: { path, original: input.name.slice(0, 255), bytes: input.body.byteLength },
    ip: context.ip ?? null,
  });

  return { ok: true, id: row!.id, name, path };
}
