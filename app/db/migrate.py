"""Schema, applied at boot.

Migrations run on startup rather than from a laptop because the production
database is Railway's, reachable only from inside Railway's network. A deploy
is therefore the only thing that can migrate it, so the deploy does.

Every migration is applied once, inside a transaction, recorded by id, and
never edited afterwards -- to change something, add another one. An edited
migration would already have been applied in production and would silently
not re-run.

The ids match the TypeScript version's exactly, so a database migrated by the
old implementation is already up to date and this re-runs nothing.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Migration:
    id: str
    sql: str


MIGRATIONS: list[Migration] = [
    Migration(
        id="0001_console",
        sql="""
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
        """,
    ),
    Migration(
        id="0002_audit",
        sql="""
        -- Who did what, on which site. The console can commit price changes
        -- on someone else's database; being able to answer "who staged this
        -- batch" afterwards is not optional.
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
        """,
    ),
    Migration(
        id="0003_ai_providers",
        sql="""
        -- Which AI reads pages and narrates batches, chosen from the screens
        -- rather than baked into a deployment's environment.
        CREATE TABLE console_ai_providers (
          id          BIGSERIAL PRIMARY KEY,
          name        TEXT NOT NULL,
          provider    TEXT NOT NULL,
          api_key     TEXT NOT NULL,
          model       TEXT NOT NULL,
          enabled     BOOLEAN NOT NULL DEFAULT TRUE,
          is_default  BOOLEAN NOT NULL DEFAULT FALSE,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- Exactly one default, enforced by the database rather than by
        -- remembering to clear the old one.
        CREATE UNIQUE INDEX console_ai_one_default
            ON console_ai_providers ((is_default)) WHERE is_default;

        -- Which provider a site uses. NULL means the default.
        ALTER TABLE console_sites
            ADD COLUMN ai_provider_id BIGINT REFERENCES console_ai_providers(id);
        """,
    ),
    Migration(
        id="0004_ai_usage",
        sql="""
        -- Every model call, recorded: what was spent, when, by which feature.
        -- The providers offer no "balance" API, so the module's own ledger is
        -- the only view of usage there is.
        CREATE TABLE console_ai_usage (
          id                BIGSERIAL PRIMARY KEY,
          provider          TEXT NOT NULL,
          model             TEXT NOT NULL,
          kind              TEXT NOT NULL,
          site_slug         TEXT,
          status            TEXT NOT NULL,
          prompt_tokens     INTEGER,
          completion_tokens INTEGER,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX console_ai_usage_created_idx ON console_ai_usage (created_at DESC);
        """,
    ),
    Migration(
        id="0005_price_rules",
        sql="""
        -- The derived-price rulebook: "South Korea FOB = Singapore FOB - 10%".
        -- Stored data, not prompt text, so the owner can change a percentage
        -- without anyone rewriting anything. Applied by code after the AI
        -- draft; the AI never does this arithmetic.
        CREATE TABLE console_price_rules (
          id                 BIGSERIAL PRIMARY KEY,
          site_slug          TEXT NOT NULL,
          derived_location   TEXT NOT NULL,
          reference_location TEXT NOT NULL,
          adjustment_pct     NUMERIC NOT NULL,
          enabled            BOOLEAN NOT NULL DEFAULT TRUE,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- One rule per derived location per site: two formulas for the same
        -- price would silently disagree.
        CREATE UNIQUE INDEX console_price_rules_target_key
            ON console_price_rules (site_slug, derived_location);
        """,
    ),
    Migration(
        id="0006_editorial_instructions",
        sql="""
        -- The editor's free-text instructions to the AI on the editorial
        -- screen ("the USA prices sit in the picture table"). Remembered per
        -- site so they are written once, not retyped every week.
        ALTER TABLE console_sites ADD COLUMN editorial_instructions TEXT;
        """,
    ),
]


def migrate(pool, migrations: list[Migration] | None = None) -> list[str]:
    migrations = MIGRATIONS if migrations is None else migrations
    ran: list[str] = []

    with pool.connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              id         TEXT PRIMARY KEY,
              applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        connection.commit()

        applied = {row[0] for row in connection.execute("SELECT id FROM schema_migrations")}

    for migration in migrations:
        if migration.id in applied:
            continue

        # One transaction per migration: a failure leaves the database exactly
        # as it was, rather than half-migrated with no record of it.
        with pool.connection() as connection:
            try:
                connection.execute(migration.sql)
                connection.execute(
                    "INSERT INTO schema_migrations (id) VALUES (%s)", (migration.id,)
                )
                connection.commit()
            except Exception as error:
                connection.rollback()

                raise RuntimeError(f"Migration {migration.id} failed: {error}") from error

        ran.append(migration.id)

    return ran
