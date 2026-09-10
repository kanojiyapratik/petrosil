"""The console's own data: who can sign in, and which sites they work on.

This is the only database the module has, and it holds no price data --
prices stay on the sites and are reached over their APIs. What lives here is
the configuration that used to be env vars, now editable from the screens
because adding a site should not need a redeploy.
"""

from __future__ import annotations

import logging

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class StoredUser:
    id: int
    email: str
    name: str
    password_hash: str
    is_admin: bool
    disabled_at: str | None


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
    )


USER_COLUMNS = "id, email, name, password_hash, is_admin, disabled_at"
SITE_COLUMNS = "id, slug, name, api_url, api_token, enabled, editorial_instructions"


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

    def set_editorial_instructions(self, slug: str, text: str) -> None:
        """Saved on every draft, so they are written once and remembered."""
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_sites SET editorial_instructions = %s, updated_at = now() "
                "WHERE slug = %s",
                (text.strip() or None, slug),
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

    for user in users:
        if user["email"] in existing_users:
            continue

        # The first account in has to be able to add the others.
        store.create_user(user["email"], user["name"], user["password_hash"], True)
        added_users += 1

    for site in sites:
        if site["slug"] in existing_sites:
            continue

        store.upsert_site(site["slug"], site["name"], site["api_url"], site["token"], True)
        added_sites += 1

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
        """The site's own provider, or the default when it has not chosen."""
        with self._pool.connection() as connection:
            row = connection.execute(
                f"SELECT p.id, p.name, p.provider, p.api_key, p.model, p.enabled, p.is_default "
                "FROM console_sites s "
                "JOIN console_ai_providers p ON p.id = s.ai_provider_id "
                "WHERE s.slug = %s AND p.enabled",
                (site_slug,),
            ).fetchone()

        return _to_provider(row) if row else self.default()

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

    def assign_to_site(self, site_slug: str, provider_id: int | None) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_sites SET ai_provider_id = %s, updated_at = now() WHERE slug = %s",
                (provider_id, site_slug),
            )
            connection.commit()

    def assignments(self) -> dict[str, int]:
        """Which provider each site has chosen, for the settings screen."""
        with self._pool.connection() as connection:
            rows = connection.execute(
                "SELECT slug, ai_provider_id FROM console_sites WHERE ai_provider_id IS NOT NULL"
            ).fetchall()

        return {row[0]: int(row[1]) for row in rows}


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

    def set_enabled(self, rule_id: int, enabled: bool) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_price_rules SET enabled = %s, updated_at = now() WHERE id = %s",
                (enabled, rule_id),
            )
            connection.commit()

    def delete(self, rule_id: int) -> None:
        with self._pool.connection() as connection:
            connection.execute("DELETE FROM console_price_rules WHERE id = %s", (rule_id,))
            connection.commit()


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
