"""The console's own data: who can sign in, and which sites they work on.

This is the only database the module has, and it holds no price data --
prices stay on the sites and are reached over their APIs. What lives here is
the configuration that used to be env vars, now editable from the screens
because adding a site should not need a redeploy.
"""

from __future__ import annotations

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
    )


USER_COLUMNS = "id, email, name, password_hash, is_admin, disabled_at"
SITE_COLUMNS = "id, slug, name, api_url, api_token, enabled"


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
