import type { Pool } from 'pg'

/**
 * Schema, applied at boot.
 *
 * Migrations run on startup rather than from a laptop because the production
 * database is Railway's, reachable only from inside Railway's network. A
 * deploy is therefore the only thing that can migrate it, so the deploy does.
 *
 * Every migration is applied once, inside a transaction, recorded by id, and
 * never edited afterwards -- to change something, add another one. An edited
 * migration would already have been applied in production and would silently
 * not re-run.
 */

export interface Migration {
  id: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_console',
    sql: `
      CREATE TABLE console_users (
        id            BIGSERIAL PRIMARY KEY,
        email         TEXT NOT NULL,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
        disabled_at   TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Sign-in lowercases the address, so uniqueness has to be on the
      -- lowercased form or two accounts could differ only by capitals.
      CREATE UNIQUE INDEX console_users_email_key ON console_users (lower(email));

      CREATE TABLE console_sites (
        id          BIGSERIAL PRIMARY KEY,
        slug        TEXT NOT NULL,
        name        TEXT NOT NULL,
        api_url     TEXT NOT NULL,
        api_token   TEXT NOT NULL,
        enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX console_sites_slug_key ON console_sites (slug);
    `,
  },
  {
    id: '0002_audit',
    sql: `
      -- Who did what, on which site. The console can commit price changes on
      -- someone else's database; being able to answer "who staged this batch"
      -- afterwards is not optional.
      CREATE TABLE console_audit (
        id         BIGSERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        site_slug  TEXT,
        action     TEXT NOT NULL,
        detail     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX console_audit_created_at_idx ON console_audit (created_at DESC);
      CREATE INDEX console_audit_site_idx ON console_audit (site_slug, created_at DESC);
    `,
  },
]

export async function migrate(pool: Pool, migrations: Migration[] = MIGRATIONS): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const { rows } = await pool.query<{ id: string }>('SELECT id FROM schema_migrations')
  const applied = new Set(rows.map((row) => row.id))
  const ran: string[] = []

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue
    }

    const client = await pool.connect()

    try {
      // One transaction per migration: a failure leaves the database exactly
      // as it was, rather than half-migrated with no record of it.
      await client.query('BEGIN')
      await client.query(migration.sql)
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id])
      await client.query('COMMIT')

      ran.push(migration.id)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)

      throw new Error(
        `Migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      client.release()
    }
  }

  return ran
}
