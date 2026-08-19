"""Validation for configuration that arrives from a screen or the environment.

The console sends a site's token to whatever address the site record names, so
a site added through the UI has to be exactly as trustworthy as one that came
from the environment. Both go through here.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from urllib.parse import urlparse

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class ConsoleConfigError(ValueError):
    pass


@dataclass(frozen=True)
class SiteInput:
    slug: str
    name: str
    api_url: str
    api_token: str
    enabled: bool


def normalise_site_input(
    slug: str, name: str, api_url: str, api_token: str, enabled: bool
) -> SiteInput:
    slug = slug.strip().lower()
    api_url = api_url.strip().rstrip("/")

    if not SLUG.match(slug):
        raise ConsoleConfigError(
            "The short name must be lowercase letters, digits and dashes — it appears in the "
            "address bar."
        )

    parsed = urlparse(api_url)

    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ConsoleConfigError("The API address must be a full http or https URL.")

    if name.strip() == "":
        raise ConsoleConfigError("Give the site a name.")

    return SiteInput(
        slug=slug,
        name=name.strip(),
        api_url=api_url,
        api_token=api_token.strip(),
        enabled=enabled,
    )


def parse_seed_sites(raw: str | None) -> list[dict]:
    """CONSOLE_SITES, applied once to a fresh database.

    Kept in the TypeScript version's shape so an existing deployment's
    environment still seeds correctly after the port.
    """
    entries = _json_array(raw, "CONSOLE_SITES")
    sites = []

    for at, entry in enumerate(entries):
        where = f"CONSOLE_SITES[{at}]"
        site = normalise_site_input(
            slug=_require(entry, "id", where),
            name=str(entry.get("name") or entry.get("id")),
            api_url=_require(entry, "apiUrl", where),
            api_token=_require(entry, "token", where),
            enabled=True,
        )
        sites.append(
            {
                "slug": site.slug,
                "name": site.name,
                "api_url": site.api_url,
                "token": site.api_token,
            }
        )

    return sites


def parse_seed_users(raw: str | None) -> list[dict]:
    entries = _json_array(raw, "CONSOLE_USERS")
    users = []

    for at, entry in enumerate(entries):
        where = f"CONSOLE_USERS[{at}]"
        email = _require(entry, "email", where).strip().lower()
        password_hash = _require(entry, "passwordHash", where)

        if not password_hash.startswith("scrypt:"):
            raise ConsoleConfigError(
                f"{where}.passwordHash must be a scrypt hash — generate one with "
                "`python -m app.console.hash_password`, never store a plain password"
            )

        users.append(
            {"email": email, "name": str(entry.get("name") or email), "password_hash": password_hash}
        )

    return users


def _json_array(raw: str | None, name: str) -> list[dict]:
    if not raw or raw.strip() == "":
        return []

    try:
        parsed = json.loads(raw)
    except ValueError as error:
        raise ConsoleConfigError(f"{name} is not valid JSON: {error}") from error

    if not isinstance(parsed, list):
        raise ConsoleConfigError(f"{name} must be a JSON array")

    return [entry for entry in parsed if isinstance(entry, dict)]


def _require(entry: dict, key: str, where: str) -> str:
    value = entry.get(key)

    if not isinstance(value, str) or value.strip() == "":
        raise ConsoleConfigError(f"{where}.{key} is required")

    return value
