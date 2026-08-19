"""One pass over the site's watched-URL list.

The order of the steps is the whole design. robots.txt before the fetch, a
conditional request before the body, the content hash before the model -- so
a check that finds nothing new costs one small HTTP request and nothing else.
At ninety-six checks a day per URL that difference is the feature, not a
micro-optimisation.

Nothing here decides whether a price "changed": the crawler reports what the
page said and the site works out the rest, because only the site knows what
it was told last time and what it currently holds.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date

from .normalise import hash_text, html_to_text, price_regions
from .pdf import looks_like_pdf, pdf_to_text
from .ai import Extraction
from .site import Sources, WatchedUrl

logger = logging.getLogger(__name__)

# What the crawler is allowed to report. `read` means the page was read and
# the rows are attached; the site turns that into updated / no_change /
# no_rows once it has compared them against what it already knew.
STATUS_READ = "read"
STATUS_UNCHANGED = "unchanged"
STATUS_NO_ROWS = "no_rows"
STATUS_DISALLOWED = "disallowed"
STATUS_BLOCKED = "blocked"
STATUS_FAILED = "failed"


@dataclass(frozen=True)
class Outcome:
    url_id: int
    url: str
    status: str
    row_count: int = 0
    used_ai: bool = False
    error: str | None = None
    notes: str | None = None

    def to_payload(
        self,
        content_hash: str | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
        rows: list | None = None,
    ) -> dict:
        payload: dict = {"url_id": self.url_id, "status": self.status}

        # Only send what this check actually established. A hash for a page
        # that could not be read would mark it "seen" on the site, and every
        # later check would call it unchanged and skip it.
        if content_hash:
            payload["content_hash"] = content_hash
        if etag:
            payload["etag"] = etag
        if last_modified:
            payload["last_modified"] = last_modified
        if rows:
            payload["rows"] = rows
        if self.error:
            payload["error"] = self.error
        if self.notes:
            payload["notes"] = self.notes

        return payload


def run_once(client, fetcher, extractor, config, today: str | None = None) -> list[Outcome]:
    today = today or date.today().isoformat()
    sources: Sources = client.sources()

    if not sources.urls:
        return []

    outcomes: list[Outcome] = []
    payloads: list[dict] = []

    for watched in sources.urls[: config.max_urls_per_run]:
        try:
            outcome, payload = _check(
                watched, fetcher, extractor, sources.locations, today, config
            )
        except Exception as error:  # noqa: BLE001 - one bad URL must not end the pass
            logger.exception("Checking %s failed", watched.url)
            outcome = Outcome(watched.id, watched.url, STATUS_FAILED, error=str(error))
            payload = outcome.to_payload()

        outcomes.append(outcome)
        payloads.append(payload)

    client.report(payloads)

    return outcomes


def _check(
    watched: WatchedUrl, fetcher, extractor, locations: list[str], today: str, config
) -> tuple[Outcome, dict]:
    fetched = fetcher.fetch(
        watched.url, etag=watched.etag, last_modified=watched.last_modified
    )

    if fetched.status == "not_modified":
        # The publisher answered "nothing changed" without sending the body.
        # The cheapest possible outcome, and the usual one.
        outcome = Outcome(watched.id, watched.url, STATUS_UNCHANGED)
        return outcome, outcome.to_payload()

    if fetched.status in ("disallowed", "blocked", "failed"):
        outcome = Outcome(
            watched.id,
            watched.url,
            {"disallowed": STATUS_DISALLOWED, "blocked": STATUS_BLOCKED, "failed": STATUS_FAILED}[
                fetched.status
            ],
            error=fetched.error,
        )
        return outcome, outcome.to_payload()

    # A PDF is read as a PDF and then treated exactly like a page: same price
    # regions, same hash, same model. Some publishers put their assessments in
    # one, and those sources used to read as nothing at all.
    if looks_like_pdf(fetched.content_type, fetched.body):
        text = pdf_to_text(fetched.body)
    else:
        text = html_to_text(fetched.html)

    # Every part of the page that carries prices, not only the densest. One
    # window silently missed prices that sat elsewhere; the hash covers all of
    # them, so a change anywhere in what we read is a change.
    regions = price_regions(
        text,
        config.max_region_chars,
        getattr(config, "max_regions", 4),
    )
    content_hash = hash_text("\n".join(region.text for region in regions))

    if content_hash == watched.content_hash:
        # Served again, but the part carrying prices is byte-identical.
        # Refresh the validators so the next check can be a 304, and stop
        # before the model.
        outcome = Outcome(watched.id, watched.url, STATUS_UNCHANGED)
        return outcome, outcome.to_payload(
            etag=fetched.etag, last_modified=fetched.last_modified
        )

    # One extraction per window, merged. A page whose prices span two tables
    # costs two calls, and only on a check where it actually changed.
    rows_by_key: dict = {}
    notes: list[str] = []
    error = None
    declined = False

    for region in regions:
        if region.price_tokens == 0:
            continue

        extraction = extractor.extract(watched.url, region.text, locations, today)

        if extraction.error:
            error = extraction.error
            declined = extraction.declined

        if extraction.notes:
            notes.append(extraction.notes)

        for row in extraction.rows:
            rows_by_key.setdefault((row.location, row.date), row)

    extraction = Extraction(
        rows=list(rows_by_key.values()),
        notes=" ".join(notes) or None,
        declined=declined,
        error=error,
    )

    if extraction.error and not extraction.rows:
        outcome = Outcome(
            watched.id,
            watched.url,
            STATUS_NO_ROWS if extraction.declined else STATUS_FAILED,
            used_ai=True,
            error=extraction.error,
            notes=extraction.notes,
        )
        return outcome, outcome.to_payload()

    rows = [
        {"location": row.location, "date": row.date, "price": row.price}
        for row in extraction.rows
    ]

    outcome = Outcome(
        url_id=watched.id,
        url=watched.url,
        status=STATUS_READ,
        row_count=len(rows),
        used_ai=True,
        notes=extraction.notes,
    )

    return outcome, outcome.to_payload(
        content_hash=content_hash,
        etag=fetched.etag,
        last_modified=fetched.last_modified,
        rows=rows,
    )
