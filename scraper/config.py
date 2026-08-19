"""Configuration, read once from the environment.

The crawler is part of this module and holds no site credentials beyond one
API token, so pointing it at a different Petrosil site is two env vars and no
code change.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (compatible; PetrosilPriceBot/0.1; +https://petrosil.com)"
)


class ConfigError(RuntimeError):
    """Raised at boot for a missing setting, rather than at 3am mid-pass."""


@dataclass(frozen=True)
class Config:
    site_api_url: str
    site_api_token: str

    api_key: str
    model: str

    interval_seconds: int
    timeout_seconds: int
    site_timeout_seconds: int
    user_agent: str
    max_region_chars: int
    max_urls_per_run: int


def load(env: dict[str, str] | None = None) -> Config:
    source = os.environ if env is None else env

    config = Config(
        # e.g. https://baseoilreport.com/api -- the crawler appends
        # /price-crawl/sources and /price-crawl/results.
        site_api_url=source.get("SITE_API_URL", "").rstrip("/"),
        site_api_token=source.get("SITE_API_TOKEN", ""),
        api_key=source.get("GOOGLE_GENERATIVE_AI_API_KEY", ""),
        model=source.get("AI_MODEL", "gemini-2.5-flash"),
        # Fifteen minutes is the owner's cadence. It is only affordable
        # because a check that finds nothing new never reaches the model:
        # see fetcher.fetch's conditional request and normalise.price_region.
        interval_seconds=int(source.get("CRAWL_INTERVAL_SECONDS", "900")),
        timeout_seconds=int(source.get("CRAWL_TIMEOUT_SECONDS", "30")),
        # The site gets its own, longer budget: a watched page either answers
        # promptly or is not worth waiting for, but baseoil itself is a cold
        # Laravel 7 that regularly takes 15-20s to render a request.
        site_timeout_seconds=int(source.get("SITE_API_TIMEOUT_SECONDS", "120")),
        user_agent=source.get("CRAWL_USER_AGENT", DEFAULT_USER_AGENT),
        max_region_chars=int(source.get("CRAWL_MAX_REGION_CHARS", "8000")),
        # A backstop, not a policy: the URL list is a textarea an admin can
        # paste anything into, and one runaway paste should not become a
        # thousand outbound requests every quarter of an hour.
        max_urls_per_run=int(source.get("CRAWL_MAX_URLS", "50")),
    )

    required = [
        ("SITE_API_URL", config.site_api_url),
        ("SITE_API_TOKEN", config.site_api_token),
    ]

    # The key is only needed when the model is the one reading. A rules pass
    # is meant to run without one -- that is the whole point of it.
    if source.get("CRAWL_EXTRACTOR", "ai").lower() != "rules":
        required.append(("GOOGLE_GENERATIVE_AI_API_KEY", config.api_key))

    missing = [name for name, value in required if value == ""]

    if missing:
        raise ConfigError(
            "The crawler needs " + ", ".join(missing) + ". It reads pages and "
            "reports to the site over the API, so it will not start without them."
        )

    return config
