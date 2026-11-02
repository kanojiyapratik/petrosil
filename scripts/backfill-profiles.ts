/**
 * Fill in each person's state and "about the company" from one brand's old
 * `profiles`, for people already on the platform. The site migration carries
 * both from now on; this is for the data that arrived before it did.
 *
 *   npm run backfill:profiles -- --from baseoilreport [--sql out.sql]
 *
 * Matched by email, blanks only: a value already here (typed in the new
 * admin, or carried by another brand) is never overwritten. `--sql` also
 * appends the same updates as SQL, for a database this machine cannot reach.
 */
import fs from "node:fs";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

import { closeDb, db } from "@/db";
import { aboutText } from "@/domain/migrate/transform";

function option(name: string): string | undefined {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);

  return at === -1 ? undefined : args[at + 1];
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function main(): Promise<void> {
  const from = option("from");
  const sqlOut = option("sql");

  if (!from) {
    throw new Error("usage: backfill-profiles --from <mysql database> [--sql out.sql] [--host h] [--port p]");
  }

  const source = await mysql.createConnection({
    host: option("host") ?? "127.0.0.1",
    port: Number(option("port") ?? 3307),
    user: process.env.SOURCE_USER ?? "root",
    password: process.env.SOURCE_PASSWORD ?? "scratch",
    database: from,
    dateStrings: true,
  });

  try {
    const has = async (table: string, column?: string) => {
      const [rows] = await source.query<mysql.RowDataPacket[]>(
        column
          ? "select count(*) as n from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?"
          : "select count(*) as n from information_schema.tables where table_schema = ? and table_name = ?",
        column ? [from, table, column] : [from, table],
      );

      return Number(rows[0]?.n ?? 0) > 0;
    };

    if (!(await has("profiles", "profile")) || !(await has("profiles", "state_id"))) {
      console.log(`${from}: no state or about text in its profiles; nothing to do`);
      return;
    }

    const states = new Map<number, string>();

    if (await has("states")) {
      const [rows] = await source.query<mysql.RowDataPacket[]>("select id, name from states");

      for (const row of rows) {
        const name = String(row.name ?? "").trim();

        if (name !== "") {
          states.set(Number(row.id), name.slice(0, 96));
        }
      }
    }

    // Newest first, so the first row met for an email is the one they last touched.
    const [rows] = await source.query<mysql.RowDataPacket[]>(
      `select lower(trim(u.email)) as email, p.state_id, p.profile
         from profiles p join users u on u.id = p.user_id
        where p.deleted_at is null and u.email is not null and trim(u.email) <> ''
        order by p.updated_at desc, p.id desc`,
    );

    const found = new Map<string, { state: string | null; about: string | null }>();

    for (const row of rows) {
      const email = String(row.email);
      const kept = found.get(email) ?? { state: null, about: null };

      kept.state ??= row.state_id ? (states.get(Number(row.state_id)) ?? null) : null;
      kept.about ??= aboutText(row.profile);
      found.set(email, kept);
    }

    const database = db();
    let updated = 0;
    const statements: string[] = [];

    for (const [email, { state, about }] of found) {
      if (state === null && about === null) {
        continue;
      }

      const result = await database.execute(sql`
        update users
           set state = coalesce(state, ${state}), about = coalesce(about, ${about}), updated_at = now()
         where lower(email) = ${email} and ((state is null and ${state}::text is not null) or (about is null and ${about}::text is not null))
      `);

      updated += Number((result as unknown as { count?: number }).count ?? 0);

      if (sqlOut) {
        const s = state === null ? "null" : quote(state);
        const a = about === null ? "null" : quote(about);

        statements.push(
          `update users set state = coalesce(state, ${s}), about = coalesce(about, ${a}), updated_at = now() where lower(email) = ${quote(email)} and ((state is null and ${s}::text is not null) or (about is null and ${a}::text is not null));`,
        );
      }
    }

    if (sqlOut && statements.length) {
      fs.appendFileSync(sqlOut, `-- ${from}\n${statements.join("\n")}\n`);
    }

    const withAbout = [...found.values()].filter((v) => v.about).length;
    const withState = [...found.values()].filter((v) => v.state).length;

    console.log(`${from}: ${found.size} people with a profile, ${withAbout} with about text, ${withState} with a state; ${updated} updated here`);
  } finally {
    await source.end();
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
