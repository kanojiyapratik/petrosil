"""The shared site client, and the crawler's thin shim over it.

There used to be two implementations of this contract -- one here in Python
for the crawler, one in TypeScript for the console. There is now one, so these
tests cover the transport once and the crawler's shaping separately.
"""

import pytest
import requests

from app.console.site_client import SiteClient, SiteError
from scraper.site import CrawlerSiteClient


class FakeResponse:
    def __init__(self, payload=None, status_code=200, text=None):
        self._payload = payload
        self.status_code = status_code
        self.text = text if text is not None else "{}"
        self.content = b"x" if status_code != 204 else b""

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    def json(self):
        if self._payload is None:
            raise ValueError("no json")

        return self._payload


class FakeSession:
    def __init__(self, *responses):
        self._responses = list(responses)
        self.calls = []

    def request(self, method, url, json=None, files=None, data=None, headers=None, timeout=None):
        self.calls.append(
            {"method": method, "url": url, "json": json, "files": files, "headers": headers or {}}
        )
        result = self._responses.pop(0)

        if isinstance(result, Exception):
            raise result

        return result


SOURCES = {
    "interval_minutes": 15,
    "locations": ["Europe SN 500 FOB Group I", "Japan SN 150 FOB Group I"],
    "urls": [
        {
            "id": 7,
            "url": "https://example.com/prices",
            "label": "Weekly",
            "etag": 'W/"abc"',
            "last_modified": None,
            "content_hash": "deadbeef",
        }
    ],
}


def client(session, token="site-token"):
    return SiteClient("https://baseoilreport.com/api/", token, name="Base Oil Report", session=session)


class TestTransport:
    def test_sends_the_site_token_and_a_browser_user_agent(self):
        # baseoil's .htaccess 403s non-browser user-agents on /api/*.
        session = FakeSession(FakeResponse(SOURCES))

        client(session).sources()

        call = session.calls[0]
        assert call["url"] == "https://baseoilreport.com/api/price-crawl/sources"
        assert call["headers"]["authorization"] == "Bearer site-token"
        assert "Mozilla/5.0" in call["headers"]["user-agent"]

    def test_a_refusal_names_both_possible_causes(self):
        # A blocked user-agent and a bad token look identical from out here
        # and lead to entirely different fixes.
        session = FakeSession(FakeResponse(status_code=403, text="Forbidden"))

        with pytest.raises(SiteError) as error:
            client(session).sources()

        assert ".htaccess" in str(error.value)
        assert "API token" in str(error.value)

    def test_an_unreachable_site_raises_rather_than_returning_nothing(self):
        session = FakeSession(requests.ConnectionError("ECONNREFUSED"))

        with pytest.raises(SiteError):
            client(session).sources()

    def test_a_500_carries_the_body_into_the_message(self):
        session = FakeSession(FakeResponse(status_code=500, text="Whoops, something broke"))

        with pytest.raises(SiteError) as error:
            client(session).sources()

        assert "Whoops" in str(error.value)

    def test_the_sites_own_validation_message_is_preferred(self):
        # "the file must be xlsx, xls or csv" beats "HTTP 422".
        session = FakeSession(
            FakeResponse({"message": "The file must be a file of type: xlsx, xls, csv."}, 422)
        )

        with pytest.raises(SiteError) as error:
            client(session).upload_batch("prices.txt", b"x", "")

        assert "xlsx, xls, csv" in str(error.value)

    def test_html_instead_of_json_is_reported_clearly(self):
        # What a login redirect or an error page actually looks like here.
        session = FakeSession(FakeResponse(status_code=200, text="<!doctype html>"))

        with pytest.raises(SiteError) as error:
            client(session).sources()

        assert "did not return JSON" in str(error.value)

    def test_an_upload_goes_as_multipart(self):
        session = FakeSession(FakeResponse({"batch": {"id": 3}}))

        client(session).upload_batch("prices.csv", b"a,b", "2026-08-20")

        call = session.calls[0]
        assert call["files"]["file"][0] == "prices.csv"
        assert "content-type" not in {k.lower() for k in call["headers"]}


class TestConsoleCalls:
    def test_each_screen_hits_the_endpoint_it_should(self):
        for call, path, method in [
            (lambda c: c.watched_urls(), "/price-crawl/urls", "GET"),
            (lambda c: c.activity(10), "/price-crawl/activity?limit=10", "GET"),
            (lambda c: c.batches(), "/price-batches", "GET"),
            (lambda c: c.batch(4), "/price-batches/4", "GET"),
            (lambda c: c.locations(), "/locations", "GET"),
            (lambda c: c.commit_batch(4), "/price-batches/4/commit", "POST"),
            (lambda c: c.rollback_batch(4), "/price-batches/4/rollback", "POST"),
            (lambda c: c.discard_batch(4), "/price-batches/4/discard", "POST"),
            (lambda c: c.update_item(9, {"new_price": 1}), "/price-batches/items/9", "PUT"),
        ]:
            session = FakeSession(FakeResponse({}))
            call(client(session))

            assert session.calls[0]["url"].endswith(path), path
            assert session.calls[0]["method"] == method, path

    def test_replacing_urls_sends_the_textarea_text(self):
        session = FakeSession(FakeResponse({"watched": 1}))

        client(session).replace_watched_urls("https://example.com/a")

        assert session.calls[0]["json"] == {"text": "https://example.com/a"}


class TestCrawlerShim:
    def test_shapes_sources_for_the_crawler(self):
        crawler = CrawlerSiteClient(client(FakeSession(FakeResponse(SOURCES))))
        sources = crawler.sources()

        assert sources.interval_minutes == 15
        assert sources.locations[0] == "Europe SN 500 FOB Group I"
        assert sources.urls[0].id == 7
        assert sources.urls[0].etag == 'W/"abc"'
        assert sources.urls[0].content_hash == "deadbeef"

    def test_an_empty_watch_list_is_not_an_error(self):
        crawler = CrawlerSiteClient(client(FakeSession(FakeResponse({"urls": [], "locations": []}))))

        assert crawler.sources().urls == []

    def test_posts_the_whole_pass_in_one_request(self):
        # One call, not one per URL: a crawler that dies halfway then cannot
        # leave half the list looking checked.
        session = FakeSession(FakeResponse({"data": [{"url_id": 7, "status": "updated"}]}))
        crawler = CrawlerSiteClient(client(session))

        recorded = crawler.report(
            [
                {"url_id": 7, "status": "read", "rows": [{"location": "X", "price": 1}]},
                {"url_id": 8, "status": "unchanged"},
            ]
        )

        assert len(session.calls) == 1
        assert len(session.calls[0]["json"]["results"]) == 2
        assert recorded[0]["status"] == "updated"

    def test_reports_nothing_without_calling_the_site(self):
        session = FakeSession()

        assert CrawlerSiteClient(client(session)).report([]) == []
        assert session.calls == []


def test_an_ngrok_tunnel_does_not_serve_its_interstitial_instead_of_json():
    """We send a browser user-agent to get past baseoil's .htaccess, and ngrok
    answers browser-shaped requests with its own HTML warning page carrying a
    200. The two workarounds cancel out unless the skip header goes too."""
    session = FakeSession(FakeResponse({"data": []}))

    client(session).locations()

    assert session.calls[0]["headers"]["ngrok-skip-browser-warning"] == "true"
