"""The client for the site the crawler is working on behalf of.

The crawler runs inside this module, not on the site, so it holds no database
credentials and knows nothing about locations, prices or history. It asks the
site what to watch and posts back what it read; every judgement that needs
site data is made on the site's side.

That is what lets one deployed crawler serve every Petrosil site: point it at
a different base URL and token and it works, with no code change.
"""

from __future__ import annotations

from dataclasses import dataclass

import requests

# baseoil's .htaccess firewall answers 403 to non-browser user-agents on
# /api/*. The real fix is an exemption for the module's egress IP or a shared
# header -- until that exists, a browser-shaped UA is what gets through, so it
# is the default here rather than a surprise in production.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class SiteError(RuntimeError):
    """The site could not be reached, or refused the request."""


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


class SiteClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        session: requests.Session | None = None,
        timeout_seconds: int = 60,
        user_agent: str = BROWSER_UA,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._session = session or requests.Session()
        self._timeout = timeout_seconds
        self._user_agent = user_agent

    def sources(self) -> Sources:
        payload = self._request("GET", "/price-crawl/sources")

        urls = [
            WatchedUrl(
                id=int(entry["id"]),
                url=str(entry["url"]),
                label=entry.get("label"),
                etag=entry.get("etag"),
                last_modified=entry.get("last_modified"),
                content_hash=entry.get("content_hash"),
            )
            for entry in payload.get("urls", [])
        ]

        return Sources(
            urls=urls,
            locations=[str(name) for name in payload.get("locations", [])],
            interval_minutes=int(payload.get("interval_minutes", 15)),
        )

    def report(self, results: list[dict]) -> list[dict]:
        """Post a whole pass in one request.

        One call rather than one per URL: a pass is a handful of pages, and
        reporting it in a single request means a crawler that dies halfway
        cannot leave half the list looking checked.
        """
        if not results:
            return []

        payload = self._request("POST", "/price-crawl/results", json={"results": results})

        return payload.get("data", [])

    def _request(self, method: str, path: str, json: dict | None = None) -> dict:
        try:
            response = self._session.request(
                method,
                f"{self._base}{path}",
                json=json,
                headers={
                    "authorization": f"Bearer {self._token}",
                    "accept": "application/json",
                    "user-agent": self._user_agent,
                },
                timeout=self._timeout,
            )
        except requests.RequestException as error:
            raise SiteError(f"{method} {path} failed: {error}") from error

        if response.status_code in (401, 403):
            # 403 here is usually the .htaccess firewall rather than the
            # token: worth saying so, because the two look identical from
            # the outside and lead to very different fixes.
            raise SiteError(
                f"{method} {path} was refused with HTTP {response.status_code}. "
                "Check SITE_API_TOKEN, and whether the site's .htaccess is "
                "blocking this caller on /api/*."
            )

        if not response.ok:
            raise SiteError(
                f"{method} {path} failed with HTTP {response.status_code}: "
                f"{response.text[:500]}"
            )

        try:
            payload = response.json()
        except ValueError as error:
            raise SiteError(f"{method} {path} did not return JSON: {error}") from error

        if not isinstance(payload, dict):
            raise SiteError(f"{method} {path} returned {type(payload).__name__}, not an object")

        return payload
