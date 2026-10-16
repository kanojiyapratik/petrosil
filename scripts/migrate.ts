/* Applies every generated migration. Run at boot in production, and by the
   test setup before the first suite. */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://petrosil:petrosil@127.0.0.1:5434/petrosil";
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await sql.end({ timeout: 5 });
  console.log("migrations applied");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
