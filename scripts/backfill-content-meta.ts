/**
 * Fill in what the first migration left behind, from one brand's old tables:
 * article keywords, and who wrote each report and impex sheet.
 *
 *   npx tsx --env-file-if-exists=.env scripts/backfill-content-meta.ts --from baseoil --site baseoil [--sql out.sql] [--port 3399]
 *
 * Rows are matched the way backfill-authors does it: the migration's slugs
 * are replayed exactly (same rows, same order, same uniqueSlug), so each old
 * row finds its new one by slug. An author is the old `authored_by` user's
 * account here, matched by email.
 *
 * Blanks only: anything already set here is never overwritten. `--sql`
 * appends the same updates as SQL, for a database this machine cannot reach.
 */
import fs from "node:fs";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

import { closeDb, db } from "@/db";
import { uniqueSlug } from "@/domain/migrate/content";

function option(name: string): string | undefined {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);

  return at === -1 ? undefined : args[at + 1];
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const text = (value: unknown) => {
  const s = value === null || value === undefined ? "" : String(value).trim();

  return s === "" ? null : s;
};

type Pass = {
  /** The old table, and the title a row without one was given. */
  old: string;
  untitled: string;
  /** The new table and column, and what is copied into it. */
  table: string;
  column: string;
  /** The SQL that reads the value from the old row, aliased `value`. */
  read: string;
  /** How the value lands: as text, or as the user with that email. */
  as: "text" | "author";
};

const PASSES: Pass[] = [
  { old: "articles", untitled: "Untitled", table: "articles", column: "keywords", read: "keywords", as: "text" },
  {
    old: "reports",
    untitled: "Report",
    table: "reports",
    column: "author_id",
    read: "(select lower(trim(u.email)) from users u where u.id = t.authored_by)",
    as: "author",
  },
  {
    old: "impexes",
    untitled: "Sheet",
    table: "impex_sheets",
    column: "author_id",
    read: "(select lower(trim(u.email)) from users u where u.id = t.authored_by)",
    as: "author",
  },
];

async function main(): Promise<void> {
  const from = option("from");
  const site = option("site") ?? from;
  const sqlOut = option("sql");

  if (!from || !site) {
    throw new Error("usage: backfill-content-meta --from <mysql database> --site <platform slug> [--sql out.sql] [--port p]");
  }

  const source = await mysql.createConnection({
    host: option("host") ?? "127.0.0.1",
    port: Number(option("port") ?? 3399),
    user: process.env.SOURCE_USER ?? "root",
    password: process.env.SOURCE_PASSWORD ?? "scratch",
    database: from,
    dateStrings: true,
  });

  try {
    const [tables] = await source.query<mysql.RowDataPacket[]>("show tables");
    const have = new Set(tables.map((row) => String(Object.values(row)[0])));

    for (const pass of PASSES) {
      if (!have.has(pass.old)) {
        continue;
      }

      // Exactly the rows and order migrate-content read, so the slugs match.
      const [rows] = await source.query<mysql.RowDataPacket[]>(
        `select t.id, t.title, t.path, ${pass.read} as value from ${pass.old} t where t.deleted_at is null order by t.id`,
      );

      const seen = new Set<string>();
      const pairs: Array<{ slug: string; value: string }> = [];

      for (const row of rows) {
        const title = (text(row.title) ?? `${pass.untitled} ${row.id}`).slice(0, 255);
        const slug = uniqueSlug(text(row.path) ?? title, Number(row.id), seen);
        const value = text(row.value);

        if (value) {
          pairs.push({ slug, value: pass.as === "text" ? value.replace(/\s+/g, " ").slice(0, 255) : value });
        }
      }

      if (pairs.length === 0) {
        console.log(`${from} ${pass.table}.${pass.column}: nothing to fill`);
        continue;
      }

      const values = pairs.map((p) => `(${quote(p.slug)}, ${quote(p.value)})`).join(",\n  ");
      const statement =
        pass.as === "text"
          ? `update ${pass.table} a
   set ${pass.column} = v.value
  from (values
  ${values}
  ) as v(slug, value)
  join sites s on s.slug = ${quote(site)}
 where a.site_id = s.id and a.slug = v.slug and a.${pass.column} is null;`
          : `update ${pass.table} a
   set ${pass.column} = u.id
  from (values
  ${values}
  ) as v(slug, value)
  join users u on u.email = v.value
  join sites s on s.slug = ${quote(site)}
 where a.site_id = s.id and a.slug = v.slug and a.${pass.column} is null;`;

      const result = await db().execute(sql.raw(statement));
      const updated = Number((result as unknown as { count?: number }).count ?? 0);

      if (sqlOut) {
        fs.appendFileSync(sqlOut, `-- ${site}: ${pairs.length} ${pass.table} with ${pass.column}\n${statement}\n`);
      }

      console.log(`${from} -> ${site} ${pass.table}.${pass.column}: ${rows.length} old rows, ${pairs.length} with a value; ${updated} filled in here`);
    }
  } finally {
    await source.end();
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
