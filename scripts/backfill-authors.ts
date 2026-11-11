/**
 * Fill in who wrote each carried article, from one brand's old `articles`.
 *
 *   npx tsx --env-file-if-exists=.env scripts/backfill-authors.ts --from baseoil --site baseoil [--sql out.sql] [--port 3399]
 *
 * The site migration left authors empty: the old `authored_by` is a user id
 * in that brand's own users table, and no legacy ids came across. That id's
 * email does, though (asmita@petrosil.com and the rest are users here), and
 * the migration's slugs can be replayed exactly (same rows, same order, same
 * uniqueSlug), so each old article finds its new row by slug.
 *
 * Blanks only: an author already set here is never overwritten. `--sql`
 * appends the same update as SQL, for a database this machine cannot reach.
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

async function main(): Promise<void> {
  const from = option("from");
  const site = option("site") ?? from;
  const sqlOut = option("sql");

  if (!from || !site) {
    throw new Error("usage: backfill-authors --from <mysql database> --site <platform slug> [--sql out.sql] [--port p]");
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
    // Exactly the rows and order migrate-content read, so the slugs match.
    const [rows] = await source.query<mysql.RowDataPacket[]>(
      `select a.id, a.title, a.path, lower(trim(u.email)) as email
         from articles a left join users u on u.id = a.authored_by
        where a.deleted_at is null
        order by a.id`,
    );

    const seen = new Set<string>();
    const pairs: Array<{ slug: string; email: string }> = [];

    for (const row of rows) {
      const title = (text(row.title) ?? `Untitled ${row.id}`).slice(0, 255);
      const slug = uniqueSlug(text(row.path) ?? title, Number(row.id), seen);
      const email = text(row.email);

      if (email) {
        pairs.push({ slug, email });
      }
    }

    if (pairs.length === 0) {
      console.log(`${from}: no article names an author`);
      return;
    }

    // One update per brand, joining a list of (slug, email).
    const values = pairs.map((p) => `(${quote(p.slug)}, ${quote(p.email)})`).join(",\n  ");
    const statement = `update articles a
   set author_id = u.id
  from (values
  ${values}
  ) as v(slug, email)
  join users u on u.email = v.email
  join sites s on s.slug = ${quote(site)}
 where a.site_id = s.id and a.slug = v.slug and a.author_id is null;`;

    const result = await db().execute(sql.raw(statement));
    const updated = Number((result as unknown as { count?: number }).count ?? 0);

    if (sqlOut) {
      fs.appendFileSync(sqlOut, `-- ${site}: ${pairs.length} articles name an author\n${statement}\n`);
    }

    console.log(`${from} -> ${site}: ${rows.length} old articles, ${pairs.length} with an author; ${updated} filled in here`);
  } finally {
    await source.end();
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
