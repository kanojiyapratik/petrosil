import json

import pytest
import requests

from scraper.site import SiteClient, SiteError


class FakeResponse:
    def __init__(self, payload=None, status_code=200, text=None):
        self._payload = payload
        self.status_code = status_code
        self.text = text if text is not None else json.dumps(payload)

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

    def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append({"method": method, "url": url, "json": json, "headers": headers or {}})
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
    return SiteClient("https://baseoilreport.com/api/", token, session=session)


class TestSources:
    def test_reads_the_watch_list_and_the_tracked_locations(self):
        session = FakeSession(FakeResponse(SOURCES))

        sources = client(session).sources()

        assert sources.interval_minutes == 15
        assert sources.locations[0] == "Europe SN 500 FOB Group I"
        assert sources.urls[0].id == 7
        assert sources.urls[0].etag == 'W/"abc"'
        assert sources.urls[0].content_hash == "deadbeef"

    def test_calls_the_sources_endpoint_with_the_token(self):
        session = FakeSession(FakeResponse(SOURCES))

        client(session).sources()

        call = session.calls[0]
        assert call["method"] == "GET"
        assert call["url"] == "https://baseoilreport.com/api/price-crawl/sources"
        assert call["headers"]["authorization"] == "Bearer site-token"

    def test_sends_a_browser_user_agent_past_the_htaccess_firewall(self):
        # baseoil's .htaccess 403s non-browser user-agents on /api/*.
        session = FakeSession(FakeResponse(SOURCES))

        client(session).sources()

        assert "Mozilla/5.0" in session.calls[0]["headers"]["user-agent"]

    def test_an_empty_list_is_not_an_error(self):
        session = FakeSession(FakeResponse({"urls": [], "locations": []}))

        assert client(session).sources().urls == []


class TestReport:
    def test_posts_the_whole_pass_in_one_request(self):
        # One call, not one per URL: a crawler that dies halfway then cannot
        # leave half the list looking checked.
        session = FakeSession(FakeResponse({"data": [{"url_id": 7, "status": "updated"}]}))

        recorded = client(session).report(
            [
                {"url_id": 7, "status": "read", "rows": [{"location": "X", "price": 1}]},
                {"url_id": 8, "status": "unchanged"},
            ]
        )

        assert len(session.calls) == 1
        assert session.calls[0]["method"] == "POST"
        assert len(session.calls[0]["json"]["results"]) == 2
        assert recorded[0]["status"] == "updated"

    def test_reports_nothing_without_calling_the_site(self):
        session = FakeSession()

        assert client(session).report([]) == []
        assert session.calls == []


class TestFailures:
    def test_a_refusal_says_it_might_be_the_firewall(self):
        # A blocked user-agent and a bad token both come back 403 and lead to
        # completely different fixes, so the message names both.
        session = FakeSession(FakeResponse(status_code=403, text="Forbidden"))

        with pytest.raises(SiteError) as error:
            client(session).sources()

        assert ".htaccess" in str(error.value)
        assert "SITE_API_TOKEN" in str(error.value)

    def test_an_unreachable_site_raises_rather_than_returning_nothing(self):
        session = FakeSession(requests.ConnectionError("ECONNREFUSED"))

        with pytest.raises(SiteError):
            client(session).sources()

    def test_a_500_carries_the_body_into_the_message(self):
        session = FakeSession(FakeResponse(status_code=500, text="Whoops, something broke"))

        with pytest.raises(SiteError) as error:
            client(session).sources()

        assert "Whoops" in str(error.value)

    def test_html_instead_of_json_is_reported_clearly(self):
        # What a login redirect or an error page actually looks like here.
        session = FakeSession(FakeResponse(status_code=200, text="<!doctype html>"))

        with pytest.raises(SiteError) as error:
            client(session).sources()

        assert "did not return JSON" in str(error.value)
