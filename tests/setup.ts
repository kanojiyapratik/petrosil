/**
 * Tests run against a real Postgres, not a mock.
 *
 * Every rule worth testing here — the date lock, the conflict check, the
 * unique index on a live price — is enforced by the database or by a
 * transaction, and a fake would simply agree with whatever the code did.
 *
 * They run against their OWN database, `petrosil_test`, created here if it is
 * missing. The suites truncate between tests, and the first time they shared
 * the development database they quietly deleted the demo data someone was
 * working with. `npm test` must never cost you your dev data.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";

import { closeDb } from "@/db";

const DEV = process.env.DATABASE_URL ?? "postgres://petrosil:petrosil@127.0.0.1:5434/petrosil";
const TEST_DB = process.env.TEST_DATABASE_NAME ?? "petrosil_test";

function swapDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;

  return parsed.toString();
}

process.env.DATABASE_URL = swapDatabase(DEV, TEST_DB);

beforeAll(async () => {
  const admin = postgres(swapDatabase(DEV, "postgres"), { max: 1, onnotice: () => {} });

  try {
    const [existing] = await admin`select 1 from pg_database where datname = ${TEST_DB}`;

    if (!existing) {
      // `create database` cannot be parameterised, and TEST_DB is ours, not
      // a caller's — but keep it to a plain identifier all the same.
      if (!/^[a-z_][a-z0-9_]*$/i.test(TEST_DB)) {
        throw new Error(`refusing to create a database named ${TEST_DB}`);
      }

      await admin.unsafe(`create database "${TEST_DB}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

  try {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

afterAll(async () => {
  await closeDb();
});
