"""Copy the live price console's AI settings into the Petrosil app's engine.

The standalone module (its own Postgres, tables in `public`) holds what the
client and the editors have set up over months: the AI providers and their
keys, each site's instructions to the AI, its rounding and its model, the
price rules, and the per-location rounding. The app's engine keeps the same
tables in the `engine` schema of the app's database. This carries the
settings across, once, when a brand moves to the app.

What it does NOT carry, on purpose:

- a site's api_url and api_token. Those say where the site's prices live,
  and for the app that is the app -- `npm run engine:link` writes them.
  Copying the old ones would point the engine back at the PHP sites.
- history: readings, drafts, usage, the audit trail. A kept draft names the
  PHP site's price update by its id, which means nothing in the app; the old
  module keeps that history for as long as it runs.
- console users and their site grants: the app has its own people.

Dry run unless --apply: it reports, table by table, what would change. With
--apply everything happens in one transaction, so it lands whole or not at
all. Safe to run again: each table is replaced, not appended to.

    python -m app.db.copy_live --from "$LIVE_MODULE_DATABASE_URL" \\
        --to "$APP_DATABASE_URL?options=-csearch_path%3Dengine" [--apply]

Run `npm run engine:link` against the app first, so every brand exists in
the engine to receive its settings.
"""

from __future__ import annotations

import argparse
import sys

import psycopg

from .pool import _with_ssl

#: Per site, the settings carried. Never the address or the token.
SITE_SETTINGS = ("editorial_instructions", "round_to_nearest", "round_direction", "ai_provider_id", "ai_model")

#: Tables replaced whole, in the order they are written.
REPLACED = ("console_ai_providers", "console_price_rules", "console_location_rounding")


def columns(connection, table: str) -> list[str]:
    rows = connection.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = %s AND table_schema = current_schema() ORDER BY ordinal_position",
        (table,),
    ).fetchall()

    return [row[0] for row in rows]


def shared(source_columns: list[str], target_columns: list[str]) -> list[str]:
    """The columns both sides have, in the target's order. The two can be a
    migration apart; a column only one side has is left to its default."""
    have = set(source_columns)

    return [name for name in target_columns if name in have]


def copy(source, target, apply: bool, out=print) -> dict:
    """Carry the settings. Answers what was (or would be) written, per table."""
    report: dict = {}

    # ---- which sites can receive their settings
    target_sites = {row[0] for row in target.execute("SELECT slug FROM console_sites").fetchall()}
    site_cols = [name for name in SITE_SETTINGS if name in set(columns(source, "console_sites")) & set(columns(target, "console_sites"))]
    source_sites = source.execute(
        f"SELECT slug, {', '.join(site_cols)} FROM console_sites ORDER BY slug"
    ).fetchall()
    missing = [row[0] for row in source_sites if row[0] not in target_sites]

    if missing:
        out(f"  not in the app's engine yet (run `npm run engine:link` first): {', '.join(missing)}")

    # ---- the tables replaced whole
    rows_by_table = {}

    for table in REPLACED:
        cols = shared(columns(source, table), columns(target, table))
        rows_by_table[table] = (cols, source.execute(f"SELECT {', '.join(cols)} FROM {table} ORDER BY id").fetchall())
        before = target.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        report[table] = {"before": before, "after": len(rows_by_table[table][1])}
        out(f"  {table}: {before} -> {len(rows_by_table[table][1])} row(s)")

    for row in source_sites:
        if row[0] in target_sites:
            values = dict(zip(site_cols, row[1:]))
            instructions = values.get("editorial_instructions") or ""
            out(
                f"  {row[0]}: instructions {len(instructions)} chars, round {values.get('round_to_nearest')} "
                f"{values.get('round_direction')}, provider #{values.get('ai_provider_id')} {values.get('ai_model') or ''}".rstrip()
            )

    report["sites"] = {"updated": len(source_sites) - len(missing), "missing": missing}

    if not apply:
        out("Dry run: nothing written. Add --apply to write it.")
        return report

    with target.transaction():
        # A site points at a provider; let go of them before they are replaced.
        target.execute("UPDATE console_sites SET ai_provider_id = NULL")

        for table in reversed(REPLACED):
            target.execute(f"DELETE FROM {table}")

        for table in REPLACED:
            cols, rows = rows_by_table[table]

            if rows:
                marks = ", ".join(["%s"] * len(cols))

                with target.cursor() as cursor:
                    cursor.executemany(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({marks})", rows)

            # The ids came across as they were; the next one added must not collide.
            target.execute(
                f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), coalesce((SELECT max(id) FROM {table}), 0) + 1, false)"
            )

        for row in source_sites:
            if row[0] in target_sites:
                assignments = ", ".join(f"{name} = %s" for name in site_cols)
                target.execute(
                    f"UPDATE console_sites SET {assignments}, updated_at = now() WHERE slug = %s",
                    (*row[1:], row[0]),
                )

    out("Written.")

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Copy the live console's AI settings into the app's engine")
    parser.add_argument("--from", dest="source", required=True, help="the live standalone module's DATABASE_URL")
    parser.add_argument("--to", dest="target", required=True, help="the app's database, search_path=engine")
    parser.add_argument("--apply", action="store_true", help="write; without it, only report")
    args = parser.parse_args(argv)

    with psycopg.connect(_with_ssl(args.source)) as source, psycopg.connect(_with_ssl(args.target), autocommit=True) as target:
        schema = target.execute("SELECT current_schema()").fetchone()[0]

        # Writing into the app's own `public` schema would put console tables
        # beside the app's; the target must be the engine's.
        if schema != "engine":
            print(f"The target's schema is {schema!r}; add ?options=-csearch_path%3Dengine to --to.", file=sys.stderr)
            return 1

        print(f"{'Copying' if args.apply else 'Would copy'} the live console's AI settings:")
        copy(source, target, args.apply)

    return 0


if __name__ == "__main__":
    sys.exit(main())
