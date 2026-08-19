"""The crawler's view of the site it works for.

Thin on purpose: the transport, the auth header, the browser user-agent and
the error handling all live in app.console.site_client now, shared with the
console. This module only shapes what the crawler wants out of it.

That shared client is the point of the consolidation -- the same contract used
to be implemented twice, once here and once in TypeScript for the console,
free to drift apart with nothing to catch it.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.console.site_client import BROWSER_UA, SiteClient, SiteError

__all__ = ["BROWSER_UA", "SiteClient", "SiteError", "Sources", "WatchedUrl", "CrawlerSiteClient"]


@dataclass(frozen=True)
class WatchedUrl:
    id: int
    url: str
    label: str | None
    etag: str | None
    last_modified: str | None
    content_hash: str | None


@dataclass(frozen=True)
class Sources:
    urls: list[WatchedUrl]
    locations: list[str]
    interval_minutes: int


class CrawlerSiteClient:
    """What run_once() talks to: the two calls a crawl pass needs."""

    def __init__(self, client: SiteClient) -> None:
        self._client = client

    def sources(self) -> Sources:
        payload = self._client.sources()

        return Sources(
            urls=[
                WatchedUrl(
                    id=int(entry["id"]),
                    url=str(entry["url"]),
                    label=entry.get("label"),
                    etag=entry.get("etag"),
                    last_modified=entry.get("last_modified"),
                    content_hash=entry.get("content_hash"),
                )
                for entry in payload.get("urls", [])
            ],
            locations=[str(name) for name in payload.get("locations", [])],
            interval_minutes=int(payload.get("interval_minutes", 15)),
        )

    def report(self, results: list[dict]) -> list[dict]:
        return self._client.report(results)
