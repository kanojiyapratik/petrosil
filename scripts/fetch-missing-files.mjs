// Fetches every file the content names but the file store does not have, from the brand's
// old live site (https://www.<legacy_domain>/file_manager/<folder>/<name>), into
// <out>/<slug>/file_manager/<folder>/<name> — the layout `npm run import:files` reads.
//
//   node scripts/fetch-missing-files.mjs <out-dir>
//
// Safe to run again: a file already downloaded is skipped. Prints what it could not get.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(process.cwd() + "/package.json");
const postgres = require("postgres");
const url = fs.readFileSync(".env", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].trim();
const sql = postgres(url, { max: 1 });
const out = process.argv[2];
if (!out) throw new Error("usage: fetch-missing-files.mjs <out-dir>");

// Same list as src/domain/files/folders.ts REFERENCES.
const REFERENCES = [
  ["articles", "hero_image", "articles/thumbnail"],
  ["reports", "file", "reports/files"],
  ["reports", "thumbnail", "reports/thumbnail"],
  ["offers", "image", "offers/images"],
  ["offers", "file", "offers/files"],
  ["impex_sheets", "file", "impex/files"],
  ["ads", "image", "ads/images"],
  ["ads", "video", "ads/video"],
];
// The store's own rule (src/lib/files/store.ts SEGMENT): no slashes or control characters, no leading dot.
const SAFE = /^[^./\\\u0000-\u001f\u007f][^/\\\u0000-\u001f\u007f]*$/u;

const wanted = [];
for (const [table, column, folder] of REFERENCES) {
  const rows = await sql.unsafe(`
    select distinct s.slug, s.legacy_domain, t.${column} as name
      from ${table} t join sites s on s.id = t.site_id
     where coalesce(t.${column}, '') <> ''
       and not exists (select 1 from media_files m where m.site_id = t.site_id and m.folder = $1 and m.name = t.${column})`, [folder]);
  for (const r of rows) wanted.push({ ...r, folder });
}
await sql.end();

const failed = [];
let got = 0, skipped = 0, bytes = 0, i = 0;
async function worker() {
  while (i < wanted.length) {
    const w = wanted[i++];
    if (!SAFE.test(w.name)) { failed.push(`${w.slug}/${w.folder}/${w.name}  unsafe name`); continue; }
    const dest = path.join(out, w.slug, "file_manager", ...w.folder.split("/"), w.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { skipped++; continue; }
    const src = `https://www.${w.legacy_domain}/file_manager/${w.folder}/${encodeURIComponent(w.name)}`;
    try {
      const res = await fetch(src, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60_000) });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (type.includes("text/html")) throw new Error("got an HTML page, not the file");
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0) throw new Error("empty");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      got++; bytes += body.length;
    } catch (e) {
      failed.push(`${w.slug}/${w.folder}/${w.name}  ${e.message}`);
    }
    if ((got + skipped + failed.length) % 50 === 0) process.stderr.write(`\r  ${got + skipped + failed.length} / ${wanted.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`\nwanted ${wanted.length}, downloaded ${got} (${(bytes / 1048576).toFixed(0)} MB), already here ${skipped}, failed ${failed.length}`);
for (const f of failed) console.log("  " + f);
