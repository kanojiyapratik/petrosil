/**
 * How to configure the driver, which depends on where this is running.
 *
 * Two decisions, made from two different things, which is why they are here
 * rather than inline in `db()`.
 *
 * **How many connections.** One pool of ten is right for a long-lived Node
 * server: ten concurrent statements and no handshake per request. It is
 * wrong for functions, where every instance opens its own pool and thirty
 * instances ask Postgres for three hundred connections. The symptom is
 * `sorry, too many clients already`, which this estate met for real on a
 * single dev server that had leaked pools across hot reloads — on one
 * process. So anything that announces itself as serverless gets one.
 *
 * **Whether to prepare statements.** A connection pooler in transaction mode
 * (PgBouncer, which is what Neon puts in front of Postgres on its `-pooler`
 * endpoint) hands a different backend connection to each transaction, so a
 * statement prepared on one is not there on the next. Prepared statements
 * must be off against a pooler and are a straight win against a direct
 * connection — and that is a property of the URL, not of the platform.
 */

export type PoolOptions = { max: number; prepare?: false };

/** Hosts that run code as functions rather than as a server. */
const SERVERLESS = [
  "NETLIFY",
  "VERCEL",
  "AWS_LAMBDA_FUNCTION_NAME",
  "FUNCTIONS_WORKER_RUNTIME",
  "K_SERVICE",
] as const;

export function poolOptions(
  env: Record<string, string | undefined> = process.env,
): PoolOptions {
  const serverless = SERVERLESS.some((name) => (env[name] ?? "") !== "");

  // The same URL `databaseUrl` would pick, not `DATABASE_URL` alone: on
  // Netlify that one is unset, so reading it here left prepared statements on
  // against a transaction pooler -- the exact fault this guards against.
  //
  // Swallowed rather than thrown: this runs before anything connects, and
  // `databaseUrl` is the right place to complain about a missing database.
  let url = "";

  try {
    url = databaseUrl(env);
  } catch {
    url = "";
  }

  // `-pooler` is Neon's naming for its PgBouncer endpoint; `pgbouncer=true`
  // is the query flag several providers document for the same thing.
  const pooled = url.includes("-pooler") || url.includes("pgbouncer=true");

  return {
    max: serverless ? 1 : 10,
    ...(pooled ? { prepare: false as const } : {}),
  };
}

/**
 * Where the connection string comes from.
 *
 * `DATABASE_URL` first: that is what this laptop, the Docker compose file and
 * any container host set, and an explicit one must always win.
 *
 * Then the pair Netlify Database provisions for itself on the first deploy.
 * The pooled one is for the app — functions must go through the pooler — and
 * the unpooled one is the fallback and what migrations should be pointed at
 * by hand, since a schema change wants a direct connection.
 */
const URL_NAMES = [
  "DATABASE_URL",
  "NETLIFY_DATABASE_URL",
  "NETLIFY_DATABASE_URL_UNPOOLED",
] as const;

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  for (const name of URL_NAMES) {
    const value = (env[name] ?? "").trim();

    if (value !== "") {
      return value;
    }
  }

  throw new Error(
    `No database to connect to: none of ${URL_NAMES.join(", ")} is set. ` +
      "Locally, copy .env.example to .env or run `npm run db:up`.",
  );
}
