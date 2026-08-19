import { Pool } from 'pg'

/**
 * The console's database connection.
 *
 * One pool for the process. Railway's Postgres is reached over its internal
 * network in production and a local container in development; the only
 * difference is DATABASE_URL, so there is nothing environment-specific here
 * beyond TLS.
 */
export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    // Small on purpose: this is an admin console used by a handful of people,
    // and Railway's smaller Postgres plans do not have connections to spare.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Railway terminates TLS with its own certificate chain. Verifying it
    // from inside their network buys nothing and breaks the connection, so
    // TLS is on without verification there and off for a local container.
    ...(needsSsl(databaseUrl) ? { ssl: { rejectUnauthorized: false } } : {}),
  })

  // A pool error with no listener takes the process down. An idle client
  // dropped by the database is normal and must not be fatal.
  pool.on('error', (error) => {
    console.error('database pool error:', error.message)
  })

  return pool
}

const needsSsl = (url: string) => {
  if (/[?&]sslmode=disable/.test(url)) {
    return false
  }

  return !/@(localhost|127\.0\.0\.1|module-db|petrosil-module-db)[:/]/.test(url)
}
