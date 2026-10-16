/**
 * The database handle.
 *
 * One pool per process, created lazily so that importing a domain module in a
 * unit test does not open a connection. `postgres` is used directly rather
 * than through an ORM pool wrapper because the commit path needs real
 * transactions with row locks, and this driver exposes them plainly.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let client: ReturnType<typeof postgres> | undefined;
let database: Database | undefined;

export function connectionString(): string {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env, or run `npm run db:up`.");
  }

  return url;
}

export function db(): Database {
  if (!database) {
    client = postgres(connectionString(), { max: 10, onnotice: () => {} });
    database = drizzle(client, { schema });
  }

  return database;
}

/** Tests and scripts close the pool so the process can exit. */
export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = undefined;
  database = undefined;
}

export { schema };
