/**
 * Carry one brand's files from its old site into the file store.
 *
 *   npm run import:files -- --site baseoil --from ../htdocs/baseoil/baseoil/file_manager
 *
 * The store is whatever FILES_S3_BUCKET / FILES_DIR say (see lib/files/store.ts).
 * Safe to run again: a file already carried at the same size is skipped. It
 * prints what it carried, what it left (files outside the old folders, names
 * the store refuses) and which content names a file that is not there.
 */

import { closeDb, db } from "@/db";
import { sites } from "@/db/schema";
import { eq } from "drizzle-orm";
import { folderCounts, importFiles } from "@/domain/files/import";
import { fileStore } from "@/lib/files/store";

function option(name: string): string | undefined {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);

  return at === -1 ? undefined : args[at + 1];
}

async function main(): Promise<void> {
  const site = option("site");
  const from = option("from");

  if (!site || !from) {
    throw new Error("usage: import-files --site <slug> --from <old site's file_manager directory>");
  }

  const store = fileStore();
  let last = 0;

  console.log(`\n${from}  ->  ${site}  (${store.name} store)`);

  const result = await importFiles({
    site,
    from,
    store,
    onProgress: (done, total) => {
      if (done - last >= 250 || done === total) {
        last = done;
        process.stdout.write(`\r  ${done} / ${total}`);
      }
    },
  });

  console.log(`\n  carried ${result.imported}, already here ${result.alreadyHere}`);

  const [brand] = await db().select().from(sites).where(eq(sites.slug, site)).limit(1);

  for (const row of await folderCounts(db(), brand!.id)) {
    console.log(`  ${row.folder.padEnd(24)} ${String(row.n).padStart(6)} files  ${(Number(row.bytes) / 1048576).toFixed(0)} MB`);
  }

  const sample = (list: string[]) => list.slice(0, 8).join(", ") + (list.length > 8 ? `, … (${list.length - 8} more)` : "");

  if (result.unknown.length > 0) {
    console.log(`  left ${result.unknown.length} outside the known folders: ${sample(result.unknown)}`);
  }

  if (result.refused.length > 0) {
    console.log(`  refused ${result.refused.length} (name or type): ${sample(result.refused)}`);
  }

  console.log(
    result.missing.length === 0
      ? "  every file named by content is here"
      : `  ${result.missing.length} named by content but missing: ${sample(result.missing)}`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    await closeDb();
    process.exit(1);
  });
