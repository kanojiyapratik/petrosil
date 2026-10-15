"""The console's own data: who can sign in, and which sites they work on.

This is the only database the module has, and it holds no price data --
prices stay on the sites and are reached over their APIs. What lives here is
the configuration that used to be env vars, now editable from the screens
because adding a site should not need a redeploy.
"""

from __future__ import annotations

import json
import logging

from dataclasses import dataclass, replace
from datetime import datetime


# The one account that sees every website without being granted any of them,
# and the only one that can say who else sees what. Named here rather than in
# a screen because both the migration and the boot-time seeding have to agree
# on it.
SUPERADMIN_EMAIL = "superadmin@petrocil.in"


@dataclass(frozen=True)
class StoredUser:
    id: int
    email: str
    name: str
    password_hash: str
    is_admin: bool
    disabled_at: str | None
    # The tier above administrator: sees and manages every site. is_admin is
    # left meaning what it always meant -- may change settings -- because
    # "may change settings" and "may see every site" are different questions.
    is_superadmin: bool = False


@dataclass(frozen=True)
class StoredSite:
    db_id: int
    slug: str
    name: str
    api_url: str
    token: str
    enabled: bool
    # The editor's saved instructions to the AI on the editorial screen.
    editorial_instructions: str | None = None
    # The site-wide rounding step ("round off closest multiple of 5").
    # None or 0 means no rounding -- today's behaviour. A location may
    # override this; see RoundingStore below.
    round_to_nearest: float | None = None
    # Which way the site-wide step goes: "nearest" (the rulebook's "closest
    # multiple of"), "up" or "down". A location's override carries its own.
    round_direction: str = "nearest"


@dataclass(frozen=True)
class AuditEntry:
    user_email: str
    site_slug: str | None
    action: str
    detail: str | None
    created_at: str


def _iso(value) -> str | None:
    if value is None:
        return None

    return value.isoformat() if isinstance(value, datetime) else str(value)


def _to_user(row) -> StoredUser:
    return StoredUser(
        id=int(row[0]),
        email=row[1],
        name=row[2],
        password_hash=row[3],
        is_admin=bool(row[4]),
        disabled_at=_iso(row[5]),
        is_superadmin=bool(row[6]) if len(row) > 6 else False,
    )


def _to_site(row) -> StoredSite:
    return StoredSite(
        db_id=int(row[0]),
        slug=row[1],
        name=row[2],
        api_url=row[3],
        token=row[4],
        enabled=bool(row[5]),
        editorial_instructions=row[6],
        round_to_nearest=float(row[7]) if row[7] is not None else None,
        round_direction=(row[8] or "nearest") if len(row) > 8 else "nearest",
    )


USER_COLUMNS = "id, email, name, password_hash, is_admin, disabled_at, is_superadmin"
SITE_COLUMNS = (
    "id, slug, name, api_url, api_token, enabled, editorial_instructions, round_to_nearest, "
    "round_direction"
)


class Store:
    def __init__(self, pool) -> None:
        self._pool = pool

    # ---- users -----------------------------------------------------------

    def users(self) -> list[StoredUser]:
        with self._pool.connection() as connection:
            rows = connection.execute(
                f"SELECT {USER_COLUMNS} FROM console_users ORDER BY lower(email)"
            ).fetchall()

        return [_to_user(row) for row in rows]

    def active_users(self) -> list[StoredUser]:
        """Only accounts that can actually sign in.

        Disabling rather than deleting keeps the audit trail readable: a
        deleted user's actions would otherwise point at nobody.
        """
        with self._pool.connection() as connection:
            rows = connection.execute(
                f"SELECT {USER_COLUMNS} FROM console_users "
                "WHERE disabled_at IS NULL ORDER BY lower(email)"
            ).fetchall()

        return [_to_user(row) for row in rows]

    def create_user(self, email: str, name: str, password_hash: str, is_admin: bool) -> StoredUser:
        with self._pool.connection() as connection:
            row = connection.execute(
                f"INSERT INTO console_users (email, name, password_hash, is_admin) "
                f"VALUES (%s, %s, %s, %s) RETURNING {USER_COLUMNS}",
                (email.strip().lower(), name, password_hash, is_admin),
            ).fetchone()
            connection.commit()

        return _to_user(row)

    def set_user_password(self, user_id: int, password_hash: str) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_users SET password_hash = %s, updated_at = now() WHERE id = %s",
                (password_hash, user_id),
            )
            connection.commit()

    def set_user_disabled(self, user_id: int, disabled: bool) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_users SET disabled_at = CASE WHEN %s THEN now() ELSE NULL END, "
                "updated_at = now() WHERE id = %s",
                (disabled, user_id),
            )
            connection.commit()

    def ensure_superadmin(self, email: str = SUPERADMIN_EMAIL) -> None:
        """Makes the named account the superadmin, if it exists.

        Idempotent, and a no-op on a database that has no such account yet --
        the migration marks the account this console already has, and this
        catches the install where the account arrives afterwards, from the
        seeding environment variables.
        """
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_users SET is_superadmin = TRUE, is_admin = TRUE, "
                "updated_at = now() WHERE lower(email) = %s AND NOT is_superadmin",
                (email.strip().lower(),),
            )
            connection.commit()

    # ---- who may use which site -------------------------------------------

    def granted_slugs(self, user_id: int) -> set[str]:
        """The sites this user has been given. A superadmin never reaches
        here: they see everything without a row, see app/console/access.py."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT site_slug FROM console_site_access WHERE user_id = %s",
                (user_id,),
            ).fetchall()

        return {row[0] for row in rows}

    def all_grants(self) -> dict[int, set[str]]:
        """Every grant, for the screen that shows the whole grid at once."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT user_id, site_slug FROM console_site_access"
            ).fetchall()

        grants: dict[int, set[str]] = {}

        for row in rows:
            grants.setdefault(int(row[0]), set()).add(row[1])

        return grants

    def grant_site(self, user_id: int, slug: str, granted_by: str) -> None:
        # WHERE NOT EXISTS rather than ON CONFLICT: granting twice must be
        # harmless, and this stays correct whatever indexes the table carries.
        with self._pool.connection() as connection:
            connection.execute(
                "INSERT INTO console_site_access (user_id, site_slug, granted_by) "
                "SELECT %s, %s, %s WHERE NOT EXISTS ("
                "  SELECT 1 FROM console_site_access WHERE user_id = %s AND site_slug = %s)",
                (user_id, slug, granted_by, user_id, slug),
            )
            connection.commit()

    def revoke_site(self, user_id: int, slug: str) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "DELETE FROM console_site_access WHERE user_id = %s AND site_slug = %s",
                (user_id, slug),
            )
            connection.commit()

    # ---- sites -----------------------------------------------------------

    def sites(self) -> list[StoredSite]:
        with self._pool.connection() as connection:
            rows = connection.execute(
                f"SELECT {SITE_COLUMNS} FROM console_sites ORDER BY name"
            ).fetchall()

        return [_to_site(row) for row in rows]

    def enabled_sites(self) -> list[StoredSite]:
        with self._pool.connection() as connection:
            rows = connection.execute(
                f"SELECT {SITE_COLUMNS} FROM console_sites WHERE enabled ORDER BY name"
            ).fetchall()

        return [_to_site(row) for row in rows]

    def site_by_slug(self, slug: str) -> StoredSite | None:
        with self._pool.connection() as connection:
            row = connection.execute(
                f"SELECT {SITE_COLUMNS} FROM console_sites WHERE slug = %s", (slug,)
            ).fetchone()

        return _to_site(row) if row else None

    def upsert_site(
        self, slug: str, name: str, api_url: str, api_token: str, enabled: bool
    ) -> StoredSite:
        # An empty token on an update means "leave the stored one alone", so a
        # rename never silently wipes the credential the screens depend on.
        with self._pool.connection() as connection:
            row = connection.execute(
                f"""INSERT INTO console_sites (slug, name, api_url, api_token, enabled)
                         VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (slug) DO UPDATE
                           SET name = EXCLUDED.name,
                               api_url = EXCLUDED.api_url,
                               api_token = CASE WHEN EXCLUDED.api_token = ''
                                                THEN console_sites.api_token
                                                ELSE EXCLUDED.api_token END,
                               enabled = EXCLUDED.enabled,
                               updated_at = now()
                      RETURNING {SITE_COLUMNS}""",
                (slug, name, api_url, api_token, enabled),
            ).fetchone()
            connection.commit()

        return _to_site(row)

    def set_site_enabled(self, slug: str, enabled: bool) -> StoredSite | None:
        """Turn one site on or off, touching nothing else about it.

        upsert_site can do this too, but only by being handed the site's whole
        configuration again -- name, address and token -- which makes flipping
        a switch a chance to overwrite the credential every screen depends on.
        A site is hidden and shown far more often than it is reconfigured, so
        that deserves its own door.
        """
        with self._pool.connection() as connection:
            row = connection.execute(
                f"UPDATE console_sites SET enabled = %s, updated_at = now() "
                f"WHERE slug = %s RETURNING {SITE_COLUMNS}",
                (enabled, slug),
            ).fetchone()
            connection.commit()

        return _to_site(row) if row else None

    def set_editorial_instructions(self, slug: str, text: str) -> None:
        """Saved on every draft, so they are written once and remembered."""
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_sites SET editorial_instructions = %s, updated_at = now() "
                "WHERE slug = %s",
                (text.strip() or None, slug),
            )
            connection.commit()

    def set_round_to_nearest(
        self, slug: str, step: float | None, direction: str = "nearest"
    ) -> None:
        """The site-wide rounding step and which way it goes. None or 0
        clears the step -- no rounding, today's behaviour -- rather than
        being refused as invalid."""
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_sites SET round_to_nearest = %s, round_direction = %s, "
                "updated_at = now() WHERE slug = %s",
                (step if step else None, direction, slug),
            )
            connection.commit()

    # ---- audit -----------------------------------------------------------

    def record(
        self, user_email: str, action: str, site_slug: str | None = None, detail: str | None = None
    ) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "INSERT INTO console_audit (user_email, site_slug, action, detail) "
                "VALUES (%s, %s, %s, %s)",
                (user_email, site_slug, action, detail),
            )
            connection.commit()

    def audit(self, limit: int = 100, site_slug: str | None = None) -> list[AuditEntry]:
        with self._pool.connection() as connection:
            if site_slug is None:
                rows = connection.execute(
                    "SELECT user_email, site_slug, action, detail, created_at "
                    "FROM console_audit ORDER BY id DESC LIMIT %s",
                    (limit,),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT user_email, site_slug, action, detail, created_at "
                    "FROM console_audit WHERE site_slug = %s ORDER BY id DESC LIMIT %s",
                    (site_slug, limit),
                ).fetchall()

        return [
            AuditEntry(
                user_email=row[0],
                site_slug=row[1],
                action=row[2],
                detail=row[3],
                created_at=_iso(row[4]) or "",
            )
            for row in rows
        ]


def seed(store: Store, users: list[dict], sites: list[dict]) -> dict[str, int]:
    """Copies CONSOLE_USERS / CONSOLE_SITES into the database once.

    Only ever adds what is missing: those env vars were how this was
    configured before, and a boot that overwrote an edit made through the
    screens would undo the point of moving configuration into the database.
    """
    existing_users = {user.email for user in store.users()}
    existing_sites = {site.slug for site in store.sites()}
    added_users = 0
    added_sites = 0
    seeded_emails = set()

    for user in users:
        if user["email"] in existing_users:
            continue

        # The first account in has to be able to add the others.
        store.create_user(user["email"], user["name"], user["password_hash"], True)
        seeded_emails.add(user["email"])
        added_users += 1

    for site in sites:
        if site["slug"] in existing_sites:
            continue

        store.upsert_site(site["slug"], site["name"], site["api_url"], site["token"], True)
        added_sites += 1

    store.ensure_superadmin()

    # Accounts seeded from the environment could use every site before the
    # grants table existed, so a freshly seeded account is given every site
    # here for the same reason migration 0012 gives one to every account that
    # was already there: nobody should be locked out by a change they cannot
    # see. The superadmin is skipped -- it needs no grant.
    if seeded_emails:
        slugs = [site.slug for site in store.sites()]

        for row in store.users():
            if row.is_superadmin or row.email not in seeded_emails:
                continue

            for slug in slugs:
                store.grant_site(row.id, slug, "seed")

    return {"users": added_users, "sites": added_sites}


@dataclass(frozen=True)
class StoredProvider:
    id: int
    name: str
    provider: str
    api_key: str
    model: str
    enabled: bool
    is_default: bool

    @property
    def masked_key(self) -> str:
        """What the screen shows. The key is never rendered in full: it is on
        a page an admin might screen-share, and it can be copied out of a form
        field far more easily than it can be put back."""
        if len(self.api_key) <= 8:
            return "••••"

        return f"{self.api_key[:4]}••••{self.api_key[-4:]}"


PROVIDER_COLUMNS = "id, name, provider, api_key, model, enabled, is_default"


def _to_provider(row) -> StoredProvider:
    return StoredProvider(
        id=int(row[0]),
        name=row[1],
        provider=row[2],
        api_key=row[3],
        model=row[4],
        enabled=bool(row[5]),
        is_default=bool(row[6]),
    )


class ProviderStore:
    """The AI providers the console knows about.

    Separate from Store only for readability; it shares the same pool.
    """

    def __init__(self, pool) -> None:
        self._pool = pool

    def all(self) -> list[StoredProvider]:
        with self._pool.connection() as connection:
            rows = connection.execute(
                f"SELECT {PROVIDER_COLUMNS} FROM console_ai_providers "
                "ORDER BY is_default DESC, lower(name)"
            ).fetchall()

        return [_to_provider(row) for row in rows]

    def get(self, provider_id: int) -> StoredProvider | None:
        with self._pool.connection() as connection:
            row = connection.execute(
                f"SELECT {PROVIDER_COLUMNS} FROM console_ai_providers WHERE id = %s",
                (provider_id,),
            ).fetchone()

        return _to_provider(row) if row else None

    def default(self) -> StoredProvider | None:
        with self._pool.connection() as connection:
            row = connection.execute(
                f"SELECT {PROVIDER_COLUMNS} FROM console_ai_providers "
                "WHERE is_default AND enabled"
            ).fetchone()

        return _to_provider(row) if row else None

    def for_site(self, site_slug: str) -> StoredProvider | None:
        """The site's own provider, or the default when it has not chosen --
        on the site's own model when it has set one."""
        with self._pool.connection() as connection:
            site = connection.execute(
                "SELECT ai_provider_id, ai_model FROM console_sites WHERE slug = %s",
                (site_slug,),
            ).fetchone()
            row = (
                connection.execute(
                    f"SELECT {PROVIDER_COLUMNS} FROM console_ai_providers "
                    "WHERE id = %s AND enabled",
                    (site[0],),
                ).fetchone()
                if site and site[0] is not None
                else None
            )

        if row is None:
            return self.default()

        chosen = _to_provider(row)
        model = (site[1] or "").strip()

        # The model belongs to the provider picked for this site. When that
        # provider is off the site falls back to the default -- a different
        # key that may not run the model -- so the default keeps its own.
        return replace(chosen, model=model) if model else chosen

    def create(
        self, name: str, provider: str, api_key: str, model: str, make_default: bool
    ) -> StoredProvider:
        with self._pool.connection() as connection:
            if make_default:
                # One default at a time; the unique index would refuse a
                # second, so the old one steps down first.
                connection.execute("UPDATE console_ai_providers SET is_default = FALSE")

            row = connection.execute(
                f"INSERT INTO console_ai_providers (name, provider, api_key, model, is_default) "
                f"VALUES (%s, %s, %s, %s, %s) RETURNING {PROVIDER_COLUMNS}",
                (name, provider, api_key, model, make_default),
            ).fetchone()
            connection.commit()

        return _to_provider(row)

    def update(
        self, provider_id: int, name: str, model: str, api_key: str, enabled: bool
    ) -> None:
        # An empty key means "keep the stored one": the screen shows only a
        # masked version, so an edit that submitted the mask would otherwise
        # overwrite the real key with dots.
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_ai_providers SET name = %s, model = %s, enabled = %s, "
                "api_key = CASE WHEN %s = '' THEN api_key ELSE %s END, updated_at = now() "
                "WHERE id = %s",
                (name, model, enabled, api_key, api_key, provider_id),
            )
            connection.commit()

    def make_default(self, provider_id: int) -> None:
        with self._pool.connection() as connection:
            connection.execute("UPDATE console_ai_providers SET is_default = FALSE")
            connection.execute(
                "UPDATE console_ai_providers SET is_default = TRUE, enabled = TRUE, "
                "updated_at = now() WHERE id = %s",
                (provider_id,),
            )
            connection.commit()

    def delete(self, provider_id: int) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_sites SET ai_provider_id = NULL WHERE ai_provider_id = %s",
                (provider_id,),
            )
            connection.execute("DELETE FROM console_ai_providers WHERE id = %s", (provider_id,))
            connection.commit()

    def assign_to_site(
        self, site_slug: str, provider_id: int | None, model: str | None = None
    ) -> None:
        # No provider of its own means no model of its own either.
        model = (model or "").strip() or None if provider_id is not None else None

        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_sites SET ai_provider_id = %s, ai_model = %s, updated_at = now() "
                "WHERE slug = %s",
                (provider_id, model, site_slug),
            )
            connection.commit()

    def assignments(self) -> dict[str, int]:
        """Which provider each site has chosen, for the settings screen."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT slug, ai_provider_id FROM console_sites WHERE ai_provider_id IS NOT NULL"
            ).fetchall()

        return {row[0]: int(row[1]) for row in rows}

    def site_models(self) -> dict[str, str]:
        """The model each site has set on its own provider, if any."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT slug, ai_model FROM console_sites "
                "WHERE ai_provider_id IS NOT NULL AND ai_model IS NOT NULL"
            ).fetchall()

        return {row[0]: row[1] for row in rows}


@dataclass(frozen=True)
class UsageDay:
    day: str
    provider: str
    model: str
    calls: int
    prompt_tokens: int
    completion_tokens: int


class UsageStore:
    """The ledger of model calls: what was spent, when, by which feature.

    Recording must never break the work being recorded -- a full disk or a
    missing table costs the ledger entry, not the price draft -- so record()
    swallows its own failures and logs them instead.
    """

    def __init__(self, pool) -> None:
        self._pool = pool

    def record(
        self,
        *,
        kind: str,
        provider: str,
        model: str,
        status: str,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        site_slug: str | None = None,
    ) -> None:
        try:
            with self._pool.connection() as connection:
                connection.execute(
                    "INSERT INTO console_ai_usage "
                    "(provider, model, kind, site_slug, status, prompt_tokens, completion_tokens) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (provider, model, kind, site_slug, status, prompt_tokens, completion_tokens),
                )
                connection.commit()
        except Exception:  # noqa: BLE001 - the ledger must never break the work
            logging.getLogger("module").exception("could not record AI usage")

    def by_day(self, days: int = 14) -> list[UsageDay]:
        """Daily totals per provider and model, newest day first."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, provider, model, "
                "       COUNT(*), COALESCE(SUM(prompt_tokens), 0), "
                "       COALESCE(SUM(completion_tokens), 0) "
                "FROM console_ai_usage "
                "WHERE created_at >= now() - make_interval(days => %s) "
                "GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3",
                (days,),
            ).fetchall()

        return [
            UsageDay(
                day=row[0],
                provider=row[1],
                model=row[2],
                calls=int(row[3]),
                prompt_tokens=int(row[4]),
                completion_tokens=int(row[5]),
            )
            for row in rows
        ]


class RulesStore:
    """The derived-price rulebook, per site. See app/editorial/rules.py for
    how the rules are applied; this class only keeps them."""

    def __init__(self, pool) -> None:
        self._pool = pool

    def for_site(self, site_slug: str) -> list:
        from ..editorial.rules import PriceRule

        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT id, derived_location, reference_location, adjustment_value, "
                "adjustment_kind, enabled "
                "FROM console_price_rules WHERE site_slug = %s ORDER BY derived_location",
                (site_slug,),
            ).fetchall()

        return [
            PriceRule(
                id=int(row[0]),
                derived_location=row[1],
                reference_location=row[2],
                adjustment_value=float(row[3]),
                adjustment_kind=row[4],
                enabled=bool(row[5]),
            )
            for row in rows
        ]

    def create(
        self,
        site_slug: str,
        derived_location: str,
        reference_location: str,
        adjustment_value: float,
        adjustment_kind: str = "percent",
    ) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "INSERT INTO console_price_rules "
                "(site_slug, derived_location, reference_location, adjustment_value, "
                "adjustment_kind) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT (site_slug, derived_location) DO UPDATE SET "
                "reference_location = EXCLUDED.reference_location, "
                "adjustment_value = EXCLUDED.adjustment_value, "
                "adjustment_kind = EXCLUDED.adjustment_kind, updated_at = now()",
                (site_slug, derived_location, reference_location, adjustment_value, adjustment_kind),
            )
            connection.commit()

    # The site is in the WHERE clause, not only in the URL the screen was
    # reached by. A rule id is a small sequential integer, so without it
    # anyone who may use one site could turn off or delete another site's
    # rules by posting a number -- and the audit row would name the wrong
    # site. Both return whether a row was actually theirs to change, so the
    # screen refuses rather than reporting work it did not do.

    def set_enabled(self, site_slug: str, rule_id: int, enabled: bool) -> bool:
        with self._pool.connection() as connection:
            row = connection.execute(
                "UPDATE console_price_rules SET enabled = %s, updated_at = now() "
                "WHERE id = %s AND site_slug = %s RETURNING id",
                (enabled, rule_id, site_slug),
            ).fetchone()
            connection.commit()

        return row is not None

    def delete(self, site_slug: str, rule_id: int) -> bool:
        with self._pool.connection() as connection:
            row = connection.execute(
                "DELETE FROM console_price_rules WHERE id = %s AND site_slug = %s RETURNING id",
                (rule_id, site_slug),
            ).fetchone()
            connection.commit()

        return row is not None


@dataclass(frozen=True)
class LocationRounding:
    id: int
    location: str
    round_to_nearest: float
    # "nearest" | "up" | "down". Defaulted so a row built before this
    # existed -- and every test that names only a step -- still reads as
    # the rulebook's "closest multiple of".
    direction: str = "nearest"
    # "Whatever currency this figure is printed in, for this location it is
    # already a price -- convert nothing." UK South, where Argus marks the
    # row £/t and the client's published euro price is that number as
    # printed. See app/editorial/fx.py and migration 0016.
    as_printed: bool = False


class RoundingStore:
    """Per-location overrides of a site's rounding step -- Turkey's own-
    currency price rounds to 10 where everything else on the site rounds to
    5. Its own table rather than a column on console_price_rules: most
    locations that need a step (nearly all of them) carry no price rule at
    all, so a rule row is the wrong place to hang it. See
    app/editorial/rounding.py for how these are applied."""

    def __init__(self, pool) -> None:
        self._pool = pool

    def for_site(self, site_slug: str) -> dict[str, tuple[float, str]]:
        """`{location: (step, direction)}`, the shape apply_rounding wants."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT location, round_to_nearest, direction FROM console_location_rounding "
                "WHERE site_slug = %s",
                (site_slug,),
            ).fetchall()

        return {row[0]: (float(row[1]), row[2] or "nearest") for row in rows}

    def as_printed_for_site(self, site_slug: str) -> set[str]:
        """The locations whose figures are never to be converted, the shape
        convert_rows wants. A separate query from for_site because the FX
        step runs before rounding and has no business reading a step."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT location FROM console_location_rounding "
                "WHERE site_slug = %s AND as_printed",
                (site_slug,),
            ).fetchall()

        return {row[0] for row in rows}

    def list_for_site(self, site_slug: str) -> list[LocationRounding]:
        """The same overrides, with their ids, for the settings screen."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT id, location, round_to_nearest, direction, as_printed "
                "FROM console_location_rounding WHERE site_slug = %s ORDER BY location",
                (site_slug,),
            ).fetchall()

        return [
            LocationRounding(
                id=int(row[0]),
                location=row[1],
                round_to_nearest=float(row[2]),
                direction=row[3] or "nearest",
                as_printed=bool(row[4]),
            )
            for row in rows
        ]

    def set_override(
        self,
        site_slug: str,
        location: str,
        step: float,
        direction: str = "nearest",
        as_printed: bool = False,
    ) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "INSERT INTO console_location_rounding "
                "(site_slug, location, round_to_nearest, direction, as_printed) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT (site_slug, location) DO UPDATE SET "
                "round_to_nearest = EXCLUDED.round_to_nearest, "
                "direction = EXCLUDED.direction, "
                "as_printed = EXCLUDED.as_printed, updated_at = now()",
                (site_slug, location, step, direction, as_printed),
            )
            connection.commit()

    def delete(self, site_slug: str, override_id: int) -> bool:
        """Scoped by site for the same reason the rules are: see RulesStore."""
        with self._pool.connection() as connection:
            row = connection.execute(
                "DELETE FROM console_location_rounding WHERE id = %s AND site_slug = %s "
                "RETURNING id",
                (override_id, site_slug),
            ).fetchone()
            connection.commit()

        return row is not None


class FxStore:
    """Exchange rates the editorial draft has cited. See app/editorial/fx.py
    (CachedRates) for why they are kept."""

    def __init__(self, pool) -> None:
        self._pool = pool

    def get(self, currency: str, asked_date: str):
        from ..editorial.fx import FxRate

        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT rate, rate_date, source FROM console_fx_rates "
                "WHERE currency = %s AND asked_date = %s",
                (currency, asked_date),
            ).fetchone()

        if row is None:
            return None

        return FxRate(
            currency=currency, rate=float(row[0]), rate_date=row[1].isoformat(), source=row[2]
        )

    def put(self, asked_date: str, rate) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "INSERT INTO console_fx_rates (currency, asked_date, rate_date, rate, source) "
                "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (currency, asked_date) DO NOTHING",
                (rate.currency, asked_date, rate.rate_date, rate.rate, rate.source),
            )
            connection.commit()


@dataclass(frozen=True)
class ReadFile:
    """One upload, as its own row of console_reading_files.

    Two reports can arrive in the same upload both called report.docx; they
    are two files and get two panels on the check screen, so the identity of
    a file is this row, never its name.
    """

    id: int
    filename: str


@dataclass(frozen=True)
class ReadingSet:
    id: int
    site_slug: str
    created_by: str
    created_at: object
    files: list[ReadFile]
    # None until analyse() claims the reading (claim_set). Kept off the
    # constructor's required list so open_set() and every existing test
    # construction, which never had a reason to know about it, still work.
    used_at: object = None


@dataclass(frozen=True)
class ReadRow:
    id: int
    set_id: int
    filename: str
    name: str
    price: float
    price_min: float | None
    price_max: float | None
    currency: str | None
    unit: str | None
    basis: str | None
    price_date: str | None
    note: str | None
    kept: bool
    # Which upload this row came out of. Null only for rows written before
    # the column existed, which fall back to grouping by filename.
    file_id: int | None = None


READ_ROW_COLUMNS = (
    "id, set_id, filename, name, price, price_min, price_max, currency, unit, "
    "basis, price_date, note, kept, file_id"
)


class ExtractionStore:
    """What step one read, kept until step two uses it.

    See app/editorial/reading.py for what a row means: the report's own
    words, no site location attached and no arithmetic applied.
    """

    def __init__(self, pool) -> None:
        self._pool = pool

    def open_set(self, site_slug: str, created_by: str) -> ReadingSet:
        with self._pool.connection() as connection:
            row = connection.execute(
                "INSERT INTO console_reading_sets (site_slug, created_by) "
                "VALUES (%s, %s) RETURNING id, site_slug, created_by, created_at",
                (site_slug, created_by),
            ).fetchone()
            connection.commit()

        return ReadingSet(
            id=int(row[0]), site_slug=row[1], created_by=row[2], created_at=row[3], files=[]
        )

    _ROW_INSERT = (
        "INSERT INTO console_reading_rows (set_id, file_id, filename, name, price, "
        "price_min, price_max, currency, unit, basis, price_date, note, kept) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
    )

    @staticmethod
    def _row_values(set_id: int, file_id: int | None, filename: str, row: dict) -> tuple:
        return (
            set_id, file_id, filename, row["name"], row["price"], row.get("price_min"),
            row.get("price_max"), row.get("currency"), row.get("unit"),
            row.get("basis"), row.get("price_date"), row.get("note"),
            row.get("kept", True),
        )

    def add_rows(self, set_id: int, filename: str, rows: list[dict]) -> None:
        with self._pool.connection() as connection:
            file_row = connection.execute(
                "INSERT INTO console_reading_files (set_id, filename) VALUES (%s, %s) "
                "RETURNING id",
                (set_id, filename),
            ).fetchone()
            file_id = int(file_row[0]) if file_row else None

            for row in rows:
                connection.execute(
                    self._ROW_INSERT, self._row_values(set_id, file_id, filename, row)
                )

            connection.commit()

    def add_row(
        self, set_id: int, filename: str, row: dict, file_id: int | None = None
    ) -> None:
        """One price the editor typed because the model missed it."""
        with self._pool.connection() as connection:
            connection.execute(
                self._ROW_INSERT, self._row_values(set_id, file_id, filename, row)
            )
            connection.commit()

    def set_by_id(self, set_id: int) -> ReadingSet | None:
        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT id, site_slug, created_by, created_at, used_at FROM console_reading_sets "
                "WHERE id = %s",
                (set_id,),
            ).fetchone()

            if row is None:
                return None

            files = connection.execute(
                "SELECT id, filename FROM console_reading_files WHERE set_id = %s ORDER BY id",
                (set_id,),
            ).fetchall()

        return ReadingSet(
            id=int(row[0]), site_slug=row[1], created_by=row[2], created_at=row[3],
            files=[ReadFile(id=int(entry[0]), filename=entry[1]) for entry in files],
            used_at=row[4],
        )

    def latest_open(self, site_slug: str) -> ReadingSet | None:
        """The newest reading this site has read and not yet used.

        The only other way to a reading is the 303 straight after the upload,
        so without this a closed tab loses a reading that has already been
        paid for -- against the whole point that four reports can be read,
        left, and come back to.
        """
        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT id FROM console_reading_sets WHERE site_slug = %s AND used_at IS NULL "
                "ORDER BY id DESC LIMIT 1",
                (site_slug,),
            ).fetchone()

        return self.set_by_id(int(row[0])) if row else None

    def latest_used(self, site_slug: str) -> ReadingSet | None:
        """The newest reading this site has already used.

        Claiming before the first model call means a reading can be spent and
        still have produced nothing the editor can save -- a provider failure
        releases it again, but a failure at stage time happens in another
        route entirely, long after the draft was rendered and with no set id
        to hand. This is how that reading stays findable from the editorial
        screen, without anybody having to know a URL.
        """
        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT id FROM console_reading_sets WHERE site_slug = %s "
                "AND used_at IS NOT NULL ORDER BY id DESC LIMIT 1",
                (site_slug,),
            ).fetchone()

        return self.set_by_id(int(row[0])) if row else None

    def rows_for(self, set_id: int) -> list[ReadRow]:
        with self._pool.connection() as connection:
            rows = connection.execute(
                f"SELECT {READ_ROW_COLUMNS} FROM console_reading_rows "
                "WHERE set_id = %s ORDER BY filename, id",
                (set_id,),
            ).fetchall()

        return [
            ReadRow(
                id=int(row[0]), set_id=int(row[1]), filename=row[2], name=row[3],
                price=float(row[4]),
                price_min=float(row[5]) if row[5] is not None else None,
                price_max=float(row[6]) if row[6] is not None else None,
                currency=row[7], unit=row[8], basis=row[9],
                price_date=row[10].isoformat() if row[10] is not None else None,
                note=row[11], kept=bool(row[12]),
                file_id=int(row[13]) if row[13] is not None else None,
            )
            for row in rows
        ]

    def update_row(self, row_id: int, **fields) -> None:
        allowed = ("name", "price", "price_min", "price_max", "currency", "unit",
                   "basis", "price_date", "note", "kept")
        changes = {key: value for key, value in fields.items() if key in allowed}

        if not changes:
            return

        assignments = ", ".join(f"{key} = %s" for key in changes)

        with self._pool.connection() as connection:
            connection.execute(
                f"UPDATE console_reading_rows SET {assignments} WHERE id = %s",
                (*changes.values(), row_id),
            )
            connection.commit()

    def claim_set(self, set_id: int) -> bool:
        """Spend the reading, atomically, and say whether this caller got it.

        Reading used_at, deciding, then spending it many AI-seconds later let
        two concurrent submits both pass the check and both buy a full draft
        -- the very thing the guard exists to stop. The database decides
        instead: exactly one UPDATE can find used_at still NULL.
        """
        with self._pool.connection() as connection:
            row = connection.execute(
                "UPDATE console_reading_sets SET used_at = now() "
                "WHERE id = %s AND used_at IS NULL RETURNING id",
                (set_id,),
            ).fetchone()
            connection.commit()

        return row is not None

    def reclaim_set(self, set_id: int, used_at: str) -> bool:
        """Spend an already-spent reading again, on purpose, exactly once.

        A staging failure used to destroy a whole draft: the reading was
        closed, the uploaded reports were never stored, and going back got a
        refusal -- five files re-uploaded and every correction retyped. This
        is what the "Use these prices again" button calls, and nothing else.

        It is a compare-and-swap, not a plain update: the button carries the
        used_at it was drawn with, and only that value can be swapped. A
        refresh or a back-forward re-POST of the same form therefore arrives
        holding a stale value and buys nothing -- otherwise the one screen
        that exists to recover a lost draft was also the one screen where a
        reload bought a second one.
        """
        with self._pool.connection() as connection:
            row = connection.execute(
                "UPDATE console_reading_sets SET used_at = now() "
                "WHERE id = %s AND used_at = %s::timestamptz RETURNING id",
                (set_id, used_at),
            ).fetchone()
            connection.commit()

        return row is not None

    def release_set(self, set_id: int) -> None:
        """Hand a claimed reading back, because nothing was made with it.

        The claim is taken before the first model call, which is the only
        place it is worth anything -- so a provider failure leaves a reading
        spent on a draft that does not exist. No draft, nothing used: the
        reading goes back to waiting, and the editor can simply try again.
        """
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_reading_sets SET used_at = NULL WHERE id = %s", (set_id,)
            )
            connection.commit()


# The row keys that get their own column; everything else a row carries
# (conversion, fx rate, rule unit) rides in `detail` so nothing is lost.
DRAFT_ROW_FIELDS = (
    "status", "reported_as", "current_price", "suggested_min", "suggested_max",
    "suggested_price", "change_pct", "confidence", "basis", "source", "rationale",
    "flag", "derived_from",
)


@dataclass(frozen=True)
class DraftRow:
    location: str
    is_benchmark: bool
    status: str
    reported_as: str | None
    current_price: float | None
    suggested_min: float | None
    suggested_max: float | None
    suggested_price: float | None
    change_pct: float | None
    confidence: str | None
    basis: str | None
    source: str | None
    rationale: str | None
    flag: str | None
    derived_from: str | None
    ticked: bool | None
    saved_price: float | None


@dataclass(frozen=True)
class StoredDraft:
    id: int
    site_slug: str
    reading_set_id: int | None
    created_by: str
    created_at: object
    price_date: str | None
    provider: str | None
    model: str | None
    analysis_status: str | None
    batch_id: int | None
    saved_by: str | None
    saved_at: object
    rows: list[DraftRow]


def _number(value) -> float | None:
    return float(value) if value is not None else None


class DraftStore:
    """Every AI draft, row by row, and what the editor did with it.

    Like the usage ledger, keeping the record must never cost the editor the
    work: a failed insert loses the record, not the draft on screen, and a
    failed update loses the link, not the saved prices. Both swallow and log.
    """

    def __init__(self, pool) -> None:
        self._pool = pool

    def create(
        self,
        *,
        site_slug: str,
        created_by: str,
        rows: list[dict],
        benchmark_rows: list[dict] | None = None,
        reading_set_id: int | None = None,
        price_date: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        analysis_status: str | None = None,
    ) -> int | None:
        entries = [(row, False) for row in rows] + [
            (row, True) for row in benchmark_rows or []
        ]

        try:
            with self._pool.connection() as connection:
                draft = connection.execute(
                    "INSERT INTO console_editorial_drafts (site_slug, reading_set_id, "
                    "created_by, price_date, provider, model, analysis_status) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
                    (site_slug, reading_set_id, created_by, price_date or None, provider,
                     model, analysis_status),
                ).fetchone()
                draft_id = int(draft[0])

                for position, (row, is_benchmark) in enumerate(entries):
                    connection.execute(
                        "INSERT INTO console_editorial_draft_rows (draft_id, position, "
                        "location, is_benchmark, " + ", ".join(DRAFT_ROW_FIELDS) + ", detail) "
                        "VALUES (%s, %s, %s, %s, "
                        + ", ".join("%s" for _ in DRAFT_ROW_FIELDS) + ", %s::jsonb)",
                        (
                            draft_id, position, str(row.get("location") or ""), is_benchmark,
                            *(row.get(field) for field in DRAFT_ROW_FIELDS),
                            json.dumps(row, default=str),
                        ),
                    )

                connection.commit()
        except Exception:  # noqa: BLE001 - the record must never break the draft
            logging.getLogger("module").exception("could not keep the AI draft")

            return None

        return draft_id

    def mark_saved(
        self,
        draft_id: int,
        site_slug: str,
        *,
        batch_id,
        saved_by: str,
        prices: dict[str, float],
    ) -> bool:
        """Say which price update the draft became, and row by row whether
        the editor kept it and at what price. Only a draft of this site is
        touched -- the id arrives from a form and is not to be trusted."""
        try:
            with self._pool.connection() as connection:
                found = connection.execute(
                    "UPDATE console_editorial_drafts SET batch_id = %s, saved_by = %s, "
                    "saved_at = now() WHERE id = %s AND site_slug = %s RETURNING id",
                    (batch_id, saved_by, draft_id, site_slug),
                ).fetchone()

                if found is None:
                    connection.rollback()

                    return False

                connection.execute(
                    "UPDATE console_editorial_draft_rows SET ticked = FALSE, saved_price = NULL "
                    "WHERE draft_id = %s AND NOT is_benchmark",
                    (draft_id,),
                )

                for location, price in prices.items():
                    connection.execute(
                        "UPDATE console_editorial_draft_rows SET ticked = TRUE, saved_price = %s "
                        "WHERE draft_id = %s AND location = %s AND NOT is_benchmark",
                        (price, draft_id, location),
                    )

                connection.commit()
        except Exception:  # noqa: BLE001 - the prices are saved; only the link is lost
            logging.getLogger("module").exception("could not mark the AI draft saved")

            return False

        return True

    def draft(self, draft_id: int, site_slug: str) -> StoredDraft | None:
        """One draft with its rows, only if it belongs to this site."""
        with self._pool.connection() as connection:
            head = connection.execute(
                "SELECT id, site_slug, reading_set_id, created_by, created_at, price_date, "
                "provider, model, analysis_status, batch_id, saved_by, saved_at "
                "FROM console_editorial_drafts WHERE id = %s AND site_slug = %s",
                (draft_id, site_slug),
            ).fetchone()

            if head is None:
                return None

            rows = connection.execute(
                "SELECT location, is_benchmark, status, reported_as, current_price, "
                "suggested_min, suggested_max, suggested_price, change_pct, confidence, "
                "basis, source, rationale, flag, derived_from, ticked, saved_price "
                "FROM console_editorial_draft_rows WHERE draft_id = %s ORDER BY position",
                (draft_id,),
            ).fetchall()

        return StoredDraft(
            id=int(head[0]), site_slug=head[1],
            reading_set_id=int(head[2]) if head[2] is not None else None,
            created_by=head[3], created_at=head[4],
            price_date=head[5].isoformat() if head[5] is not None else None,
            provider=head[6], model=head[7], analysis_status=head[8],
            batch_id=int(head[9]) if head[9] is not None else None,
            saved_by=head[10], saved_at=head[11],
            rows=[
                DraftRow(
                    location=row[0], is_benchmark=bool(row[1]), status=row[2],
                    reported_as=row[3], current_price=_number(row[4]),
                    suggested_min=_number(row[5]), suggested_max=_number(row[6]),
                    suggested_price=_number(row[7]), change_pct=_number(row[8]),
                    confidence=row[9], basis=row[10], source=row[11], rationale=row[12],
                    flag=row[13], derived_from=row[14], ticked=row[15],
                    saved_price=_number(row[16]),
                )
                for row in rows
            ],
        )

    def priced_last_time(self, site_slug: str) -> set[str]:
        """The locations the previous draft for this site found a figure for.

        Used to tell a location that has gone quiet (Taiwan FOB, priced on
        four drafts and then missed by one reading) from one that is blank
        every week on purpose (the refinery rows, with no circular
        uploaded). Deliberately the previous DRAFT and not the site's own
        prices: every location the editor types in by hand has a price, and
        comparing against those would flag all of them, every week.

        Benchmarks are left out -- they are not site prices -- and so is a
        row a rule filled in, which says nothing about what was read.
        """
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT location FROM console_editorial_draft_rows "
                "WHERE draft_id = (SELECT id FROM console_editorial_drafts "
                "                  WHERE site_slug = %s ORDER BY id DESC LIMIT 1) "
                "AND NOT is_benchmark AND status = 'suggested' "
                "AND suggested_price IS NOT NULL",
                (site_slug,),
            ).fetchall()

        return {row[0] for row in rows}

    def ids_for_batches(self, site_slug: str, batch_ids: list[int]) -> dict[int, int]:
        """Which draft each price update came from: {batch_id: draft_id}.
        Two drafts saved into one batch (a re-save) answer with the newest."""
        if not batch_ids:
            return {}

        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT batch_id, max(id) FROM console_editorial_drafts "
                "WHERE site_slug = %s AND batch_id = ANY(%s) GROUP BY batch_id",
                (site_slug, list(batch_ids)),
            ).fetchall()

        return {int(row[0]): int(row[1]) for row in rows}

    def latest_for_reading(self, site_slug: str, reading_set_id: int) -> int | None:
        """The newest draft made from a reading -- the only way back to one
        that was never saved, since it has no price update to hang off."""
        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT max(id) FROM console_editorial_drafts "
                "WHERE site_slug = %s AND reading_set_id = %s",
                (site_slug, reading_set_id),
            ).fetchone()

        return int(row[0]) if row and row[0] is not None else None
