"""Fetching a page politely, and as cheaply as a 15-minute cadence demands.

Ninety-six visits a day to someone else's server is a lot more than the
daily crawl this started as, so two things are not optional here:

* **robots.txt is consulted before the page is fetched**, and a robots.txt
  that cannot be read counts as a refusal. This job runs unattended; reading
  "the server is broken" as consent is how a crawler gets banned.
* **Every request after the first is conditional** (``If-None-Match`` /
  ``If-Modified-Since``). A publisher who supports it answers ``304`` with an
  empty body, which costs them almost nothing and costs us no parsing, no
  hashing and no AI call.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import requests

ROBOTS_TTL_SECONDS = 3600

# 403/429 are refusals; 503 is what Cloudflare returns while challenging.
REFUSAL_STATUSES = {403, 429, 503}


@dataclass(frozen=True)
class FetchResult:
    status: str  # ok | not_modified | disallowed | blocked | failed
    http_status: int | None = None
    html: str = ""
    etag: str | None = None
    last_modified: str | None = None
    error: str | None = None


class Fetcher:
    def __init__(
        self,
        user_agent: str,
        timeout_seconds: int = 30,
        session: requests.Session | None = None,
        clock=time.monotonic,
    ) -> None:
        self._user_agent = user_agent
        self._timeout = timeout_seconds
        self._session = session or requests.Session()
        self._clock = clock
        self._robots: dict[str, tuple[float, RobotFileParser | None]] = {}

    def fetch(
        self,
        url: str,
        etag: str | None = None,
        last_modified: str | None = None,
    ) -> FetchResult:
        allowed, reason = self.is_allowed(url)

        if not allowed:
            return FetchResult(status="disallowed", error=reason)

        headers = {
            "user-agent": self._user_agent,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
        }

        # Only send validators we were actually given. Sending an empty one
        # makes some servers answer 412 instead of 200.
        if etag:
            headers["if-none-match"] = etag
        if last_modified:
            headers["if-modified-since"] = last_modified

        try:
            response = self._session.get(
                url, headers=headers, timeout=self._timeout, allow_redirects=True
            )
        except requests.RequestException as error:
            return FetchResult(status="failed", error=str(error))

        if response.status_code == 304:
            # The publisher says nothing changed. Keep the validators we
            # already hold; a 304 carries no fresh ones.
            return FetchResult(
                status="not_modified",
                http_status=304,
                etag=etag,
                last_modified=last_modified,
            )

        if response.status_code in REFUSAL_STATUSES:
            return FetchResult(
                status="blocked",
                http_status=response.status_code,
                error=f"HTTP {response.status_code}",
            )

        if not response.ok:
            return FetchResult(
                status="failed",
                http_status=response.status_code,
                error=f"HTTP {response.status_code}",
            )

        return FetchResult(
            status="ok",
            http_status=response.status_code,
            html=response.text,
            etag=response.headers.get("etag"),
            last_modified=response.headers.get("last-modified"),
        )

    def is_allowed(self, url: str) -> tuple[bool, str | None]:
        parsed = urlparse(url)

        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return False, f"Only http and https URLs are crawled: {url}"

        origin = f"{parsed.scheme}://{parsed.netloc}"
        rules = self._robots_for(origin)

        if rules is None:
            return False, f"robots.txt at {origin} could not be read"

        if not rules.can_fetch(self._user_agent, url):
            return False, f"robots.txt disallows {parsed.path or '/'} for this crawler"

        return True, None

    def _robots_for(self, origin: str) -> RobotFileParser | None:
        cached = self._robots.get(origin)
        now = self._clock()

        if cached and now - cached[0] < ROBOTS_TTL_SECONDS:
            return cached[1]

        rules = self._load_robots(origin)
        self._robots[origin] = (now, rules)

        return rules

    def _load_robots(self, origin: str) -> RobotFileParser | None:
        parser = RobotFileParser()

        try:
            response = self._session.get(
                f"{origin}/robots.txt",
                headers={"user-agent": self._user_agent},
                timeout=self._timeout,
            )
        except requests.RequestException:
            return None

        # A missing robots.txt means the publisher has no rules, so crawling
        # is allowed. A 5xx means their server is unwell, which is not the
        # same as permission.
        if response.status_code >= 500:
            return None

        if not response.ok:
            parser.parse([])
            return parser

        parser.parse(response.text.splitlines())

        return parser
