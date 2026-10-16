/**
 * Tests run against a real Postgres, not a mock.
 *
 * Every rule worth testing here — the date lock, the conflict check, the
 * unique index on a live price — is enforced by the database or by a
 * transaction, and a fake would simply agree with whatever the code did.
 * `npm run db:up` starts the container; this file applies migrations once.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";

import { closeDb } from "@/db";

process.env.DATABASE_URL ??= "postgres://petrosil:petrosil@127.0.0.1:5434/petrosil";

beforeAll(async () => {
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
