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
    Migration(
        id="0007_fx_rates",
        sql="""
        -- Exchange rates the editorial draft used to turn a report figure
        -- printed in another currency (Turkey's lira prices) into USD. Kept
        -- so the audit line "TRY 81,212 / 40.92" is reproducible later and a
        -- redraft does not re-ask the internet for a rate it already cited.
        CREATE TABLE console_fx_rates (
          id         BIGSERIAL PRIMARY KEY,
          currency   TEXT NOT NULL,
          asked_date DATE NOT NULL,
          rate_date  DATE NOT NULL,
          rate       NUMERIC NOT NULL,
          source     TEXT NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE UNIQUE INDEX console_fx_rates_key ON console_fx_rates (currency, asked_date);
        """,
    ),
    Migration(
        id="0008_rule_adjustment_kind",
        sql="""
        -- A rule may now be a flat US dollar difference as well as a
        -- percentage, so the column no longer holds only percentages and is
        -- renamed to say so. Everything already stored is a percentage.
        ALTER TABLE console_price_rules RENAME COLUMN adjustment_pct TO adjustment_value;

        ALTER TABLE console_price_rules
            ADD COLUMN adjustment_kind TEXT NOT NULL DEFAULT 'percent';
        """,
    ),
    Migration(
        id="0009_reading_sets",
        sql="""
        -- Step one of the editorial update: what the AI read out of each
        -- uploaded report, in the report's own words, waiting for the editor
        -- to check it. Kept in the database rather than in the page so that
        -- four reports read and a reload does not lose them, and so there is
        -- a record of what each report actually said.
        CREATE TABLE console_reading_sets (
          id         BIGSERIAL PRIMARY KEY,
          site_slug  TEXT NOT NULL,
          created_by TEXT NOT NULL,
          used_at    TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE console_reading_rows (
          id         BIGSERIAL PRIMARY KEY,
          set_id     BIGINT NOT NULL REFERENCES console_reading_sets(id) ON DELETE CASCADE,
          filename   TEXT NOT NULL,
          name       TEXT NOT NULL,
          price      NUMERIC NOT NULL,
          price_min  NUMERIC,
          price_max  NUMERIC,
          currency   TEXT,
          unit       TEXT,
          basis      TEXT,
          price_date DATE,
          note       TEXT,
          kept       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- A file that yielded no prices still has to appear on the screen as
        -- read, so the file list cannot be derived from the rows alone.
        CREATE TABLE console_reading_files (
          id       BIGSERIAL PRIMARY KEY,
          set_id   BIGINT NOT NULL REFERENCES console_reading_sets(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          read_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX console_reading_rows_set ON console_reading_rows (set_id);
        CREATE INDEX console_reading_sets_open ON console_reading_sets (site_slug)
            WHERE used_at IS NULL;
        """,
    ),
    Migration(
        id="0010_reading_rows_know_their_file",
        sql="""
        -- A row knew only the NAME of the file it came from, so two reports
        -- uploaded together and both called report.docx were one panel on
        -- the check screen with both files' prices in it. The file is the
        -- row of console_reading_files, not the name on it.
        ALTER TABLE console_reading_rows
            ADD COLUMN file_id BIGINT REFERENCES console_reading_files(id) ON DELETE CASCADE;

        CREATE INDEX console_reading_rows_file ON console_reading_rows (file_id);
        """,
    ),
    Migration(
        id="0011_price_rounding",
        sql="""
        -- The client's rulebook rounds nearly every price it derives from a
        -- report ("round off closest multiple of 5"; Turkey's own-currency
        -- price rounds to 10 instead). A site-wide step covers most
        -- locations; NULL/0 means "do not round", today's behaviour.
        ALTER TABLE console_sites ADD COLUMN round_to_nearest NUMERIC;

        -- A location's own step, for the handful that differ from the
        -- site's default. Its own table, not console_price_rules, because
        -- most locations needing a step carry no price rule at all --
        -- console_price_rules is keyed by site and DERIVED location, and
        -- only ever exists for one.
        CREATE TABLE console_location_rounding (
          id               BIGSERIAL PRIMARY KEY,
          site_slug        TEXT NOT NULL,
          location         TEXT NOT NULL,
          round_to_nearest NUMERIC NOT NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE UNIQUE INDEX console_location_rounding_key
            ON console_location_rounding (site_slug, location);
        """,
    ),
    Migration(
        id="0012_site_access",
        sql="""
        -- The tier above administrator. is_admin still answers "may change
        -- settings" and is left exactly as it was; this answers the separate
        -- question of who may see every website and say who else can.
        ALTER TABLE console_users
            ADD COLUMN is_superadmin BOOLEAN NOT NULL DEFAULT FALSE;

        -- Superadmin implies administrator, so the flag is set here rather
        -- than left to be remembered at every check.
        UPDATE console_users
           SET is_superadmin = TRUE, is_admin = TRUE, updated_at = now()
         WHERE lower(email) = 'superadmin@petrocil.in';

        -- Which user may use which website. A superadmin is never given rows
        -- here -- they see everything by being a superadmin -- so there is
        -- one source of truth rather than two to keep in step.
        CREATE TABLE console_site_access (
          id         BIGSERIAL PRIMARY KEY,
          user_id    BIGINT NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
          site_slug  TEXT NOT NULL,
          granted_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE UNIQUE INDEX console_site_access_key
            ON console_site_access (user_id, site_slug);
        CREATE INDEX console_site_access_user_idx ON console_site_access (user_id);

        -- MIGRATION SAFETY. Until this migration every signed-in user could
        -- use every enabled website. Landing with an empty grants table would
        -- silently lock every existing user out of all nine sites on a live
        -- console, with nothing on screen to say why. So every existing
        -- non-superadmin user is granted every existing site right here: the
        -- change is invisible until a superadmin deliberately revokes
        -- something, which is the only way it should ever become visible.
        INSERT INTO console_site_access (user_id, site_slug, granted_by)
        SELECT u.id, s.slug, 'migration 0012_site_access'
          FROM console_users u
         CROSS JOIN console_sites s
         WHERE NOT u.is_superadmin;
        """,
    ),
    Migration(
        id="0013_editorial_drafts",
        sql="""
        -- What the AI recommended, kept. The draft used to live only on the
        -- screen: the model's range, confidence and reasoning, every row the
        -- editor left unticked, and what the editor changed a price to were
        -- all gone the moment the tab closed. A saved price could not be told
        -- apart from one typed by hand, and nobody could ask how often the
        -- AI had been right. One row per draft, one per location in it.
        CREATE TABLE console_editorial_drafts (
          id              BIGSERIAL PRIMARY KEY,
          site_slug       TEXT NOT NULL,
          reading_set_id  BIGINT,
          created_by      TEXT NOT NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          price_date      DATE,
          provider        TEXT,
          model           TEXT,
          analysis_status TEXT,
          -- Filled when the editor saves: which price update it became.
          batch_id        BIGINT,
          saved_by        TEXT,
          saved_at        TIMESTAMPTZ
        );

        CREATE INDEX console_editorial_drafts_site
            ON console_editorial_drafts (site_slug, id DESC);

        CREATE TABLE console_editorial_draft_rows (
          id              BIGSERIAL PRIMARY KEY,
          draft_id        BIGINT NOT NULL
                          REFERENCES console_editorial_drafts(id) ON DELETE CASCADE,
          position        INT NOT NULL,
          location        TEXT NOT NULL,
          -- A report figure a rule works from, not a site price; never saved.
          is_benchmark    BOOLEAN NOT NULL DEFAULT FALSE,
          status          TEXT NOT NULL,
          reported_as     TEXT,
          current_price   NUMERIC,
          suggested_min   NUMERIC,
          suggested_max   NUMERIC,
          suggested_price NUMERIC,
          change_pct      NUMERIC,
          confidence      TEXT,
          basis           TEXT,
          source          TEXT,
          rationale       TEXT,
          flag            TEXT,
          derived_from    TEXT,
          -- The whole row as the screen got it: conversion, rate, rule unit.
          detail          JSONB,
          -- Filled when the draft is saved. NULL means never saved at all.
          ticked          BOOLEAN,
          saved_price     NUMERIC
        );

        CREATE INDEX console_editorial_draft_rows_draft
            ON console_editorial_draft_rows (draft_id, position);
        """,
    ),
    Migration(
        id="0014_site_ai_model",
        sql="""
        -- A site can run its provider on a model of its own (a cheaper one
        -- for a simple site, a stronger one for a hard report), without a
        -- second copy of the key. NULL means the provider's own model.
        ALTER TABLE console_sites ADD COLUMN IF NOT EXISTS ai_model TEXT;
        """,
    ),
    Migration(
        id="0015_rounding_direction",
        sql="""
        -- Which way a location's price goes when it sits between two
        -- multiples of its step: the nearest one (the client's rulebook,
        -- and what every existing override already did), or always up, or
        -- always down. See app/editorial/rounding.py.
        ALTER TABLE console_location_rounding
            ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'nearest';

        -- The same choice for the site-wide step.
        ALTER TABLE console_sites
            ADD COLUMN IF NOT EXISTS round_direction TEXT NOT NULL DEFAULT 'nearest';
        """,
    ),
    Migration(
        id="0016_currency_as_printed",
        sql="""
        -- "Uk south is already in euro in argus.. No need to convert" --
        -- the client, 14.10.2026. Argus marks that row £/t, but his
        -- published euro price is that number unconverted, and no wording
        -- in his instructions could produce it: the model reports the
        -- currency the figure is printed in (it is told to, and it should),
        -- and the FX step then does exactly what it is for. Twice the
        -- instructions were rewritten to say "with currency EUR" and twice
        -- the draft came back converted, the second time narrating "left in
        -- GBP as instructed".
        --
        -- So it stops being a matter of wording. This is the editor saying,
        -- per location, that whatever currency a figure is printed in, for
        -- THIS location it is already a price in the location's own
        -- currency and nothing is to be converted. Code honours it; the
        -- model is not asked to.
        ALTER TABLE console_location_rounding
            ADD COLUMN IF NOT EXISTS as_printed BOOLEAN NOT NULL DEFAULT FALSE;
        """,
    ),
    Migration(
        id="0017_instructions_used",
        sql="""
        -- What a run was actually told.
        --
        -- Four rounds of mismatch files with the client in October 2026
        -- turned on exactly this: whether the model knew to leave the Iran
        -- locations blank, whether it knew to read Japan's dollar column.
        -- Going back afterwards, it could not be answered. The instructions
        -- live in console_sites and are edited in place, so by the time
        -- anyone asks "what was this run told?", the column holds whatever
        -- it was last edited to -- not what was sent a week ago. The
        -- question "did the model disobey, or was it never told?" had no
        -- answer at all, and those are very different faults.
        --
        -- Recorded in both places, because the instructions are sent twice
        -- and the two can now differ: once when the reports are read, and
        -- again when the draft is built.
        --
        -- NULL means a run from before this column, or an upload where the
        -- editor untticked the box. The screens tell those apart by the
        -- reading set's own age, not by guessing here.
        ALTER TABLE console_reading_sets
            ADD COLUMN IF NOT EXISTS instructions TEXT;

        ALTER TABLE console_editorial_drafts
            ADD COLUMN IF NOT EXISTS instructions TEXT;
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
