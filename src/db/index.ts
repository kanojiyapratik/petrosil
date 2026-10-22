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
import { databaseUrl, poolOptions } from "./pool";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let client: ReturnType<typeof postgres> | undefined;
let database: Database | undefined;

/** See ./pool: DATABASE_URL first, then the pair Netlify provisions. */
export function connectionString(): string {
  return databaseUrl();
}

export function db(): Database {
  if (!database) {
    // See ./pool: the pool size depends on whether this is a server or a
    // function, and prepared statements on whether a pooler is in the way.
    client = postgres(connectionString(), { ...poolOptions(), onnotice: () => {} });
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
