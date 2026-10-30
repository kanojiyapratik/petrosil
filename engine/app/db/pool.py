"""The console's database connection.

One pool for the process. Railway's Postgres is reached over its internal
network in production and a local container in development; the only
difference is DATABASE_URL, so there is nothing environment-specific here
beyond TLS.
"""

from __future__ import annotations

import re

from psycopg_pool import ConnectionPool

LOCAL_HOST = re.compile(r"@(localhost|127\.0\.0\.1|module-db|petrosil-module-db)[:/]")


def create_pool(database_url: str) -> ConnectionPool:
    pool = ConnectionPool(
        conninfo=_with_ssl(database_url),
        # Small on purpose: this is an admin console used by a handful of
        # people, and Railway's smaller Postgres plans have few connections
        # to spare.
        min_size=1,
        max_size=5,
        timeout=10,
        open=True,
    )

    return pool


def _with_ssl(url: str) -> str:
    """Railway terminates TLS inside their network. Verifying the chain from
    in there buys nothing and breaks the connection, so TLS is requested
    without verification there and left alone for a local container."""
    if "sslmode=" in url:
        return url

    if LOCAL_HOST.search(url):
        return url

    separator = "&" if "?" in url else "?"

    return f"{url}{separator}sslmode=require"
