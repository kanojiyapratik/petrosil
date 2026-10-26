/**
 * Carrying one old site's `file_manager` directory into the store.
 *
 * Every file in a known folder is copied to `<brand>/<folder>/<name>` and
 * indexed in `media_files`; the folders were the old layout, and keeping them
 * means a carried row's bare "584.pdf" still names its file. Safe to run
 * again: a file already indexed at the same size is not copied twice.
 *
 * It also answers the question the old file browser never could: which
 * content names a file that is not there.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { mediaFiles, sites } from "@/db/schema";
import { safeKey, type FileStore } from "@/lib/files/store";
import { FOLDERS, REFERENCES, isLitter, typeFor } from "./folders";

export type ImportResult = {
  imported: number;
  alreadyHere: number;
  /** Files outside the known folders, relative to the source. */
  unknown: string[];
  /** Files with a name the store will not take, or a type it will not serve. */
  refused: string[];
  /** `folder/name` named by content but absent. */
  missing: string[];
};

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];

  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      found.push(...(await walk(join(dir, entry.name), relative)));
    } else if (entry.isFile() && !isLitter(entry.name)) {
      found.push(relative);
    }
  }

  return found;
}

export async function importFiles(options: {
  site: string;
  from: string;
  store: FileStore;
  database?: Database;
  onProgress?: (done: number, total: number) => void;
}): Promise<ImportResult> {
  const database = options.database ?? db();
  const [brand] = await database.select().from(sites).where(eq(sites.slug, options.site)).limit(1);

  if (!brand) {
    throw new Error(`no site "${options.site}" on the platform`);
  }

  const result: ImportResult = { imported: 0, alreadyHere: 0, unknown: [], refused: [], missing: [] };
  const files = await walk(options.from);
  const known = files.filter((file) => FOLDERS.some((folder) => file.startsWith(`${folder}/`)));

  result.unknown = files.filter((file) => !known.includes(file)).sort();

  const indexed = new Map(
    (
      await database
        .select({ path: mediaFiles.path, bytes: mediaFiles.bytes })
        .from(mediaFiles)
        .where(eq(mediaFiles.siteId, brand.id))
    ).map((row) => [row.path, row.bytes]),
  );

  let done = 0;

  for (const file of known) {
    const slash = file.lastIndexOf("/");
    const folder = file.slice(0, slash);
    const name = file.slice(slash + 1);
    const key = safeKey(`${brand.slug}/${folder}/${name}`);
    const type = typeFor(name);

    // A nested folder below a known one is not part of the layout either.
    if (!FOLDERS.includes(folder)) {
      result.unknown.push(file);
      continue;
    }

    if (!key || !type) {
      result.refused.push(file);
      continue;
    }

    const body = new Uint8Array(await readFile(join(options.from, file)));

    if (indexed.get(key) === body.byteLength && (await options.store.exists(key))) {
      result.alreadyHere++;
    } else {
      await options.store.put(key, body, type);
      await database
        .insert(mediaFiles)
        .values({ siteId: brand.id, path: key, folder, name, kind: type, bytes: body.byteLength })
        .onConflictDoUpdate({
          target: mediaFiles.path,
          set: { folder, name, kind: type, bytes: body.byteLength },
        });

      result.imported++;
    }

    options.onProgress?.(++done, known.length);
  }

  result.unknown.sort();
  result.refused.sort();
  result.missing = await missingReferences(database, brand.id);

  return result;
}

/** `folder/name` for every file content names that the index does not have. */
export async function missingReferences(database: Database, siteId: number): Promise<string[]> {
  const missing: string[] = [];

  for (const ref of REFERENCES) {
    const rows = (await database.execute(sql`
      select distinct t.${sql.identifier(ref.column)} as name
        from ${sql.identifier(ref.table)} t
       where t.site_id = ${siteId}
         and coalesce(t.${sql.identifier(ref.column)}, '') <> ''
         and not exists (
           select 1 from media_files m
            where m.site_id = ${siteId}
              and m.folder = ${ref.folder}
              and m.name = t.${sql.identifier(ref.column)}
         )
    `)) as unknown as { name: string }[];

    missing.push(...rows.map((row) => `${ref.folder}/${row.name}`));
  }

  return missing.sort();
}

/** How many files a brand has indexed in each folder — for the import's summary. */
export async function folderCounts(database: Database, siteId: number) {
  return database
    .select({ folder: mediaFiles.folder, n: sql<number>`count(*)`, bytes: sql<number>`sum(${mediaFiles.bytes})` })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.siteId, siteId)))
    .groupBy(mediaFiles.folder)
    .orderBy(mediaFiles.folder);
}
