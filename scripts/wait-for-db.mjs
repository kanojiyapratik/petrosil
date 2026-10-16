/* Blocks until the platform's Postgres answers, so `npm run db:up` is honest. */
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://petrosil:petrosil@127.0.0.1:5434/petrosil";
const deadline = Date.now() + 60_000;

for (;;) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select 1`;
    await sql.end({ timeout: 5 });
    console.log("database ready");
    process.exit(0);
  } catch (error) {
    await sql.end({ timeout: 5 }).catch(() => {});
    if (Date.now() > deadline) {
      console.error("database did not come up:", error.message);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
