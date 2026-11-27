/**
 * Copies files indexed locally since a given time to another file store (the live bucket),
 * and writes the matching media_files rows as pure-ASCII SQL for the live database.
 *
 *   FILES_S3_*=<live values> npx tsx --env-file-if-exists=.env scripts/push-files-live.mts <since-iso> <out.sql>
 *
 * Reads each file from the local disk store (FILES_DIR / default folder), puts it in the
 * S3 store the FILES_S3_* variables name. A key already there at the same size is skipped,
 * so it is safe to run again. The SQL inserts only rows whose path is not indexed yet.
 */
import fs from "node:fs";

import { closeDb, db } from "@/db";
import { sql } from "drizzle-orm";
import { fileStore } from "@/lib/files/store";

const [since, outFile] = process.argv.slice(2);

if (!since || !outFile) {
  throw new Error("usage: push-files-live.mts <since-iso> <out.sql>");
}

// SQL_ONLY=1 writes the SQL without uploading anything (for rehearsing it locally).
const sqlOnly = process.env.SQL_ONLY === "1";

if (!sqlOnly && !process.env.FILES_S3_BUCKET) {
  throw new Error("FILES_S3_BUCKET is not set: this would copy the disk store onto itself");
}

const rows = (await db().execute(sql`
  select m.path, m.name, m.kind, m.bytes, m.folder, s.slug
    from media_files m join sites s on s.id = m.site_id
   where m.created_at >= ${since}::timestamptz
   order by m.id`)) as unknown as { path: string; name: string; kind: string; bytes: number; folder: string; slug: string }[];

// The local disk store: same code, without the S3 variables.
const saved = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("FILES_S3_")) delete process.env[key];
const local = fileStore();
Object.assign(process.env, saved);
const live = sqlOnly ? local : fileStore();
console.log(`${rows.length} files: ${local.name} -> ${sqlOnly ? "(SQL only, nothing uploaded)" : live.name}`);

let put = 0;
let already = 0;
for (const [index, row] of (sqlOnly ? [] : rows).entries()) {
  const there = await live.get(row.path);
  if (there && there.bytes === row.bytes) {
    already++;
  } else {
    const file = await local.get(row.path);
    if (!file) throw new Error(`not in the local store: ${row.path}`);
    await live.put(row.path, file.body, row.kind);
    put++;
  }
  if ((index + 1) % 25 === 0 || index + 1 === rows.length) process.stdout.write(`\r  ${index + 1} / ${rows.length}`);
}
console.log(`\n  uploaded ${put}, already there ${already}`);

// Pure ASCII: anything else goes in as a U& escape (PowerShell 5.1 pipes ASCII only).
const literal = (value: string) => {
  let out = "";
  let escaped = false;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (ch === "\\") { out += "\\\\"; escaped = true; }
    else if (code < 0x20 || code > 0x7e) {
      escaped = true;
      out += code > 0xffff ? "\\+" + code.toString(16).padStart(6, "0") : "\\" + code.toString(16).padStart(4, "0");
    } else out += ch;
  }
  return escaped ? `U&'${out}'` : `'${out}'`;
};

const lines = [
  "-- Indexes the files recovered from the old sites on 2026-11-27 (already uploaded to the bucket).",
  "-- Only paths not indexed yet are added, so it is safe to run twice.",
  "\\set ON_ERROR_STOP on",
  "set client_encoding = 'UTF8';",
  "begin;",
  "create temp table add_files (slug text, path text, name text, kind text, bytes int, folder text);",
  "insert into add_files values",
  rows
    .map((r) => `(${[r.slug, r.path, r.name, r.kind, r.folder].map(literal).slice(0, 4).join(", ")}, ${r.bytes}, ${literal(r.folder)})`)
    .join(",\n") + ";",
  "with added as (insert into media_files (site_id, path, name, kind, bytes, folder)",
  "  select s.id, f.path, f.name, f.kind, f.bytes, f.folder from add_files f join sites s on s.slug = f.slug",
  "   where not exists (select 1 from media_files m where m.path = f.path) returning 1)",
  "select count(*) as files_indexed from added;",
  "select s.slug, count(*) as recovered_files_now_indexed from add_files f join sites s on s.slug = f.slug",
  " where exists (select 1 from media_files m where m.path = f.path) group by 1 order by 1;",
  "commit;",
];
const text = lines.join("\n") + "\n";
if (/[^\x00-\x7f]/.test(text)) throw new Error("SQL is not pure ASCII");
fs.writeFileSync(outFile, text);
console.log(`wrote ${outFile} (${rows.length} rows)`);
await closeDb();
