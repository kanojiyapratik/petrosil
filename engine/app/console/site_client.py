"""One site's API, from this module.

This replaces both halves of what used to be duplicated: the crawler's
scraper/site.py and the console's src/console/site-client.ts implemented the
same contract in two languages, free to drift apart with nothing to catch it.
There is now one.

The module holds no site database credentials and no price data. Every screen
and every crawl is built from these calls, which is what lets one deployment
serve every Petrosil site: change the base URL and the token, no code change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import requests

# baseoil's .htaccess firewall answers 403 to non-browser user-agents on
# /api/*. The real fix is an exemption for this module's egress IP or a shared
# header; until then a browser-shaped UA is what gets through, so it is the
# default rather than a surprise in production.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class SiteError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class WatchedUrl:
    id: int
    url: str
    label: str | None
    enabled: bool
    last_status: str | None
    last_status_text: str
    last_error: str | None
    last_notes: str | None
    last_row_count: int
    last_checked_at: str | None
    last_changed_at: str | None
    content_hash: str | None = None
    last_modified: str | None = None
    etag: str | None = None


class SiteClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        name: str = "the site",
        session: requests.Session | None = None,
        timeout_seconds: int = 120,
        user_agent: str = BROWSER_UA,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._name = name
        self._session = session or requests.Session()
        self._timeout = timeout_seconds
        self._user_agent = user_agent

    # ---- crawler ---------------------------------------------------------

    def sources(self) -> dict:
        return self._request("GET", "/price-crawl/sources")

    def report(self, results: list[dict]) -> list[dict]:
        """Posts a whole crawl pass in one request.

        One call rather than one per URL: a pass is a handful of pages, and
        reporting it in a single request means a crawler that dies halfway
        cannot leave half the list looking checked.
        """
        if not results:
            return []

        return self._request("POST", "/price-crawl/results", json={"results": results}).get(
            "data", []
        )

    # ---- console: crawler screens ---------------------------------------

    def watched_urls(self) -> dict:
        return self._request("GET", "/price-crawl/urls")

    def replace_watched_urls(self, text: str, instructions: str | None = None) -> dict:
        payload: dict = {"text": text}

        # Sent only when the screen carries the field, so an older site that
        # never learned it is not asked to validate it.
        if instructions is not None:
            payload["instructions"] = instructions

        return self._request("PUT", "/price-crawl/urls", json=payload)

    def activity(self, limit: int = 50) -> dict:
        return self._request("GET", f"/price-crawl/activity?limit={limit}")

    def clear_activity(self) -> dict:
        return self._request("POST", "/price-crawl/activity/clear", json={})

    def stage(self, activity_ids: list[int]) -> dict:
        return self._request(
            "POST", "/price-crawl/activity/stage", json={"activity_ids": activity_ids}
        )

    # ---- console: price screens -----------------------------------------

    def batches(self) -> dict:
        return self._request("GET", "/price-batches")

    def batch(self, batch_id: int) -> dict:
        return self._request("GET", f"/price-batches/{batch_id}")

    def locations(self) -> dict:
        return self._request("GET", "/locations")

    def upload_batch(self, filename: str, content: bytes, price_date: str) -> dict:
        """Forwards the admin's file to the site untouched.

        The console never reads the spreadsheet: parsing it is the site's job,
        because the site is what knows its own locations and date formats.
        This is a relay, not a parser.
        """
        files = {"file": (filename, content)}
        data = {"pricedate": price_date} if price_date else {}

        return self._request("POST", "/price-batches/upload", files=files, data=data)

    def bulk_batch(self, params: dict) -> dict:
        return self._request("POST", "/price-batches/bulk", json=params)

    def stage_rows(
        self, rows: list[dict], price_date: str | None = None, source: str | None = None
    ) -> dict:
        """Stages structured rows as a draft batch on the site -- how the
        editorial screen hands over the rows the editor kept. The source
        travels along so the site's batch list says where they came from."""
        payload: dict = {"rows": rows}

        if price_date:
            payload["pricedate"] = price_date

        if source:
            payload["source"] = source

        return self._request("POST", "/price-batches/rows", json=payload)

    def update_item(self, item_id: int, patch: dict) -> dict:
        return self._request("PUT", f"/price-batches/items/{item_id}", json=patch)

    def commit_batch(self, batch_id: int) -> dict:
        return self._request("POST", f"/price-batches/{batch_id}/commit", json={})

    def post_summary(self, summary: str, source: str, batch_id: int | None = None) -> dict:
        """Hand the site the note to show above its price trends table.

        The site has no AI of its own, so the text is written here and only
        stored there.
        """
        return self._request(
            "POST",
            "/price-summaries",
            json={"summary": summary, "source": source, "price_batch_id": batch_id},
        )

    def rollback_batch(self, batch_id: int) -> dict:
        return self._request("POST", f"/price-batches/{batch_id}/rollback", json={})

    def discard_batch(self, batch_id: int) -> dict:
        return self._request("POST", f"/price-batches/{batch_id}/discard", json={})

    # ---- transport -------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        json: Any = None,
        files: Any = None,
        data: Any = None,
    ) -> dict:
        headers = {
            "authorization": f"Bearer {self._token}",
            "accept": "application/json",
            "user-agent": self._user_agent,
            # A site reached through an ngrok tunnel would otherwise answer
            # ngrok's own interstitial page -- HTML, with a 200 -- because we
            # send a browser user-agent to get past baseoil's .htaccess
            # firewall. Two workarounds that cancel each other out. Harmless
            # anywhere else: an unknown request header is ignored.
            "ngrok-skip-browser-warning": "true",
        }

        try:
            response = self._session.request(
                method,
                f"{self._base}{path}",
                json=json,
                files=files,
                data=data,
                headers=headers,
                timeout=self._timeout,
            )
        except requests.RequestException as error:
            raise SiteError(f"{self._name} could not be reached: {error}") from error

        if response.status_code in (401, 403):
            # These two look identical from out here and lead to completely
            # different fixes, so the message names both.
            raise SiteError(
                f"{self._name} refused the request (HTTP {response.status_code}). Check the "
                "site's API token, and whether its .htaccess is blocking this caller on /api/*.",
                response.status_code,
            )

        if not response.ok:
            # The site's own validation message is the useful part -- "the
            # file must be xlsx, xls or csv" beats "HTTP 422".
            message = None

            try:
                body = response.json()
                message = body.get("message") if isinstance(body, dict) else None
            except ValueError:
                message = None

            raise SiteError(
                f"{self._name} answered HTTP {response.status_code}: "
                f"{message or response.text[:300]}",
                response.status_code,
            )

        if response.status_code == 204 or not response.content:
            return {}

        try:
            payload = response.json()
        except ValueError as error:
            raise SiteError(f"{self._name} did not return JSON: {error}") from error

        if not isinstance(payload, dict):
            return {"data": payload}

        return payload
