from dataclasses import dataclass

from scraper.ai import Extraction, ExtractedRow
from scraper.fetcher import FetchResult
from scraper.normalise import hash_text, html_to_text, price_region
from scraper.runner import (
    STATUS_BLOCKED,
    STATUS_DISALLOWED,
    STATUS_FAILED,
    STATUS_NO_ROWS,
    STATUS_READ,
    STATUS_UNCHANGED,
    run_once,
)
from scraper.site import Sources, WatchedUrl

PRICED_HTML = "<body><p>Europe SN 500 FOB Group I 845.00</p></body>"
LOCATIONS = ["Europe SN 500 FOB Group I", "Japan SN 150 FOB Group I"]
TODAY = "2026-08-18"


@dataclass
class FakeConfig:
    max_urls_per_run: int = 50
    max_region_chars: int = 8000


class FakeClient:
    def __init__(self, *urls, locations=None, instructions=None):
        self._sources = Sources(
            urls=list(urls),
            locations=locations or LOCATIONS,
            interval_minutes=15,
            instructions=instructions,
        )
        self.reported = None

    def sources(self):
        return self._sources

    def report(self, results):
        self.reported = results
        return []


class FakeFetcher:
    def __init__(self, *results):
        self._results = list(results)
        self.calls = []

    def fetch(self, url, etag=None, last_modified=None):
        self.calls.append({"url": url, "etag": etag, "last_modified": last_modified})

        return self._results.pop(0)


class FakeExtractor:
    def __init__(self, *results):
        self._results = list(results)
        self.calls = []

    def extract(self, url, text, locations, today, instructions=None):
        self.calls.append(
            {
                "url": url,
                "text": text,
                "locations": locations,
                "today": today,
                "instructions": instructions,
            }
        )

        return self._results.pop(0)


def watched(url_id=7, content_hash=None, etag=None):
    return WatchedUrl(
        id=url_id,
        url="https://example.com/prices",
        label=None,
        etag=etag,
        last_modified=None,
        content_hash=content_hash,
    )


def ok_page(html=PRICED_HTML, etag='W/"new"'):
    return FetchResult(status="ok", http_status=200, html=html, etag=etag)


def hash_of(html, max_chars=8000):
    return hash_text(price_region(html_to_text(html), max_chars).text)


def rows(*pairs):
    return Extraction(
        rows=[ExtractedRow(location=name, date=TODAY, price=price) for name, price in pairs]
    )


def run(client, fetcher, extractor):
    return run_once(client, fetcher, extractor, FakeConfig(), today=TODAY)


class TestCheapPaths:
    def test_a_304_costs_no_ai_call(self):
        client = FakeClient(watched(etag='W/"abc"'))
        extractor = FakeExtractor()

        outcomes = run(client, FakeFetcher(FetchResult(status="not_modified")), extractor)

        assert outcomes[0].status == STATUS_UNCHANGED
        assert extractor.calls == []
        assert client.reported == [{"url_id": 7, "status": "unchanged"}]

    def test_the_sites_validators_are_sent_back_on_the_next_visit(self):
        fetcher = FakeFetcher(FetchResult(status="not_modified"))

        run(FakeClient(watched(etag='W/"abc"')), fetcher, FakeExtractor())

        assert fetcher.calls[0]["etag"] == 'W/"abc"'

    def test_an_unchanged_hash_costs_no_ai_call(self):
        client = FakeClient(watched(content_hash=hash_of(PRICED_HTML)))
        extractor = FakeExtractor()

        outcomes = run(client, FakeFetcher(ok_page()), extractor)

        assert outcomes[0].status == STATUS_UNCHANGED
        assert extractor.calls == []

    def test_an_unchanged_hash_still_returns_fresh_validators(self):
        # So the *next* check can be a 304 and not even carry a body.
        client = FakeClient(watched(content_hash=hash_of(PRICED_HTML)))

        run(client, FakeFetcher(ok_page(etag='W/"fresh"')), FakeExtractor())

        assert client.reported[0]["etag"] == 'W/"fresh"'
        assert "content_hash" not in client.reported[0]


class TestReading:
    def test_a_read_page_reports_its_rows_and_its_hash(self):
        client = FakeClient(watched())

        outcomes = run(
            client, FakeFetcher(ok_page()), FakeExtractor(rows(("Europe SN 500 FOB Group I", 845.0)))
        )

        assert outcomes[0].status == STATUS_READ
        assert outcomes[0].row_count == 1

        payload = client.reported[0]
        assert payload["content_hash"] == hash_of(PRICED_HTML)
        assert payload["rows"] == [
            {"location": "Europe SN 500 FOB Group I", "date": TODAY, "price": 845.0}
        ]

    def test_the_crawler_does_not_decide_whether_a_price_moved(self):
        # It reports `read`; only the site knows what it was told last time.
        client = FakeClient(watched())

        run(client, FakeFetcher(ok_page()), FakeExtractor(rows(("Europe SN 500 FOB Group I", 845.0))))

        assert client.reported[0]["status"] == STATUS_READ

    def test_the_model_is_told_which_locations_the_site_tracks(self):
        extractor = FakeExtractor(rows(("Europe SN 500 FOB Group I", 845.0)))

        run(FakeClient(watched()), FakeFetcher(ok_page()), extractor)

        assert extractor.calls[0]["locations"] == LOCATIONS
        assert extractor.calls[0]["today"] == TODAY

    def test_model_notes_are_passed_on_for_the_admin_to_see(self):
        client = FakeClient(watched())
        extraction = Extraction(
            rows=[ExtractedRow("Europe SN 500 FOB Group I", TODAY, 845.0)],
            notes="the diesel table was an image",
        )

        run(client, FakeFetcher(ok_page()), FakeExtractor(extraction))

        assert client.reported[0]["notes"] == "the diesel table was an image"


class TestFailures:
    def test_a_disallowed_url_never_reaches_the_model(self):
        client = FakeClient(watched())
        extractor = FakeExtractor()

        outcomes = run(
            client,
            FakeFetcher(FetchResult(status="disallowed", error="robots.txt disallows /p")),
            extractor,
        )

        assert outcomes[0].status == STATUS_DISALLOWED
        assert extractor.calls == []
        assert "content_hash" not in client.reported[0]

    def test_a_blocked_url_never_reaches_the_model(self):
        client = FakeClient(watched())
        extractor = FakeExtractor()

        outcomes = run(
            client,
            FakeFetcher(FetchResult(status="blocked", http_status=403, error="HTTP 403")),
            extractor,
        )

        assert outcomes[0].status == STATUS_BLOCKED
        assert extractor.calls == []

    def test_a_provider_failure_reports_no_hash_so_the_site_retries(self):
        # A hash for a page that was never read would mark it "seen", and
        # every later check would call it unchanged and skip it.
        client = FakeClient(watched())

        outcomes = run(
            client,
            FakeFetcher(ok_page()),
            FakeExtractor(Extraction(error="Gemini request failed: ECONNRESET")),
        )

        assert outcomes[0].status == STATUS_FAILED
        assert "content_hash" not in client.reported[0]

    def test_a_model_decline_is_no_rows_not_a_failure(self):
        client = FakeClient(watched())

        outcomes = run(
            client,
            FakeFetcher(ok_page()),
            FakeExtractor(Extraction(declined=True, error="The model did not return JSON.")),
        )

        assert outcomes[0].status == STATUS_NO_ROWS

    def test_one_broken_url_does_not_end_the_pass(self):
        client = FakeClient(watched(1), watched(2))

        outcomes = run(
            client,
            FakeFetcher(RuntimeError("kaboom"), ok_page()),
            FakeExtractor(rows(("Europe SN 500 FOB Group I", 845.0))),
        )

        assert [outcome.status for outcome in outcomes] == [STATUS_FAILED, STATUS_READ]
        assert len(client.reported) == 2

    def test_an_empty_watch_list_reports_nothing(self):
        client = FakeClient()

        assert run(client, FakeFetcher(), FakeExtractor()) == []
        assert client.reported is None

    def test_the_url_cap_is_respected(self):
        client = FakeClient(watched(1), watched(2), watched(3))
        config = FakeConfig(max_urls_per_run=2)

        outcomes = run_once(
            client,
            FakeFetcher(FetchResult(status="not_modified"), FetchResult(status="not_modified")),
            FakeExtractor(),
            config,
            today=TODAY,
        )

        assert len(outcomes) == 2


class TestPdfSources:
    """A PDF source behaves like any other watched URL once it is read."""

    def _pdf_page(self):
        from tests.test_pdf import build_pdf

        return FetchResult(
            status="ok",
            http_status=200,
            html="",  # requests decodes the bytes as mojibake; nothing usable
            body=build_pdf(["Europe SN 500 FOB Group I 845.00"]),
            content_type="application/pdf",
            etag='W/"pdf"',
        )

    def test_a_pdf_is_read_and_its_rows_reported(self):
        client = FakeClient(watched())
        extractor = FakeExtractor(rows(("Europe SN 500 FOB Group I", 845.0)))

        outcomes = run(client, FakeFetcher(self._pdf_page()), extractor)

        assert outcomes[0].status == STATUS_READ
        # What reached the model was the PDF's text, not the empty html field.
        assert "845.00" in extractor.calls[0]["text"]
        assert client.reported[0]["rows"][0]["price"] == 845.0

    def test_an_unchanged_pdf_costs_no_ai_call(self):
        from scraper.normalise import hash_text, price_regions
        from scraper.pdf import pdf_to_text

        page = self._pdf_page()
        text = pdf_to_text(page.body)
        digest = hash_text("\n".join(r.text for r in price_regions(text, 8000, 4)))

        client = FakeClient(watched(content_hash=digest))
        extractor = FakeExtractor()

        outcomes = run(client, FakeFetcher(page), extractor)

        assert outcomes[0].status == STATUS_UNCHANGED
        assert extractor.calls == []


class TestDeadPagesAndQuota:
    def _page(self, html):
        return FetchResult(status="ok", http_status=200, html=html, etag='W/"x"')

    def test_a_404_served_with_a_200_is_called_out(self):
        # Seen live: a watched URL started returning "Page Not Found" with a
        # 200, and the screen said "no prices found" for days.
        from scraper.runner import STATUS_GONE

        client = FakeClient(watched())
        extractor = FakeExtractor()

        outcomes = run(client, FakeFetcher(self._page("<h1>Page Not Found</h1>")), extractor)

        assert outcomes[0].status == STATUS_GONE
        assert "does not exist" in outcomes[0].error
        # No model call, and no hash: the URL is not "seen", it is wrong.
        assert extractor.calls == []
        assert "content_hash" not in client.reported[0]

    def test_a_live_page_with_no_prices_is_not_called_dead(self):
        from scraper.runner import STATUS_NO_ROWS

        client = FakeClient(watched())
        page = self._page("<p>Our weekly assessment will be published on Friday.</p>")

        outcomes = run(client, FakeFetcher(page), FakeExtractor())

        assert outcomes[0].status != "gone"

    def test_the_pass_stops_asking_once_the_quota_is_gone(self):
        # Each further call is refused anyway, and on a free tier of twenty a
        # day, spending them to find that out again is the whole problem.
        from scraper.ai import AiQuotaExhausted

        class QuotaExtractor:
            def __init__(self):
                self.calls = 0

            def extract(self, url, text, locations, today, instructions=None):
                self.calls += 1
                raise AiQuotaExhausted("Gemini quota exceeded — the API key has hit its limit.")

        client = FakeClient(watched(1), watched(2), watched(3))
        extractor = QuotaExtractor()

        outcomes = run(
            client,
            FakeFetcher(ok_page(), ok_page(), ok_page()),
            extractor,
        )

        assert extractor.calls == 1
        assert len(outcomes) == 3
        # Still fetched — everything before the model is free — but not read.
        assert "not read" in (outcomes[1].error or "")
        assert "quota" in (outcomes[2].error or "").lower()

    def test_nothing_is_marked_seen_when_the_quota_ran_out(self):
        from scraper.ai import AiQuotaExhausted

        class QuotaExtractor:
            def extract(self, url, text, locations, today, instructions=None):
                raise AiQuotaExhausted("out of quota")

        client = FakeClient(watched(1), watched(2))

        run(client, FakeFetcher(ok_page(), ok_page()), QuotaExtractor())

        for report in client.reported:
            assert "content_hash" not in report


class TestQuotaStillDoesTheFreeWork:
    """Running out of quota must not blind the crawler to everything else."""

    def test_a_dead_url_is_still_spotted_with_no_quota_left(self):
        from scraper.ai import AiQuotaExhausted
        from scraper.runner import STATUS_GONE

        class QuotaExtractor:
            def extract(self, url, text, locations, today, instructions=None):
                raise AiQuotaExhausted("out of quota")

        client = FakeClient(watched(1), watched(2))
        pages = FakeFetcher(
            ok_page(),  # first URL burns the quota
            FetchResult(status="ok", http_status=200, html="<h1>Page Not Found</h1>"),
        )

        outcomes = run(client, pages, QuotaExtractor())

        assert outcomes[1].status == STATUS_GONE

    def test_an_unchanged_page_is_still_reported_unchanged(self):
        from scraper.ai import AiQuotaExhausted

        class QuotaExtractor:
            def extract(self, url, text, locations, today, instructions=None):
                raise AiQuotaExhausted("out of quota")

        client = FakeClient(watched(1), watched(2, content_hash=hash_of(PRICED_HTML)))

        outcomes = run(client, FakeFetcher(ok_page(), ok_page()), QuotaExtractor())

        assert outcomes[1].status == STATUS_UNCHANGED


class TestSiteInstructions:
    def test_the_sites_instructions_reach_the_model(self):
        # The person watching the URLs wrote them on the crawler screen; they
        # ride from the site's sources call into every extraction.
        client = FakeClient(watched(), instructions="Read only the top table.")
        extractor = FakeExtractor(rows(("Europe SN 500 FOB Group I", 845.0)))

        run(client, FakeFetcher(ok_page()), extractor)

        assert extractor.calls[0]["instructions"] == "Read only the top table."

    def test_a_site_without_instructions_sends_none(self):
        extractor = FakeExtractor(rows(("Europe SN 500 FOB Group I", 845.0)))

        run(FakeClient(watched()), FakeFetcher(ok_page()), extractor)

        assert extractor.calls[0]["instructions"] is None
