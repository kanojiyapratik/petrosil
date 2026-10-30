import requests

from scraper.fetcher import Fetcher

UA = "PetrosilPriceBot/0.1"
ROBOTS_OPEN = "User-agent: *\nDisallow: /admin"


class FakeResponse:
    def __init__(self, status_code=200, text="", headers=None, content=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}
        # The fetcher keeps the raw bytes as well as the decoded text, so a
        # PDF can be read as one.
        self.content = content if content is not None else text.encode("utf-8")

    @property
    def ok(self):
        return 200 <= self.status_code < 300


class FakeSession:
    """Answers robots.txt from a fixed body and pages from a queue."""

    def __init__(self, robots=ROBOTS_OPEN, pages=None, robots_error=None):
        self._robots = robots
        self._robots_error = robots_error
        self._pages = list(pages or [])
        self.calls = []

    def get(self, url, headers=None, timeout=None, allow_redirects=False):
        self.calls.append({"url": url, "headers": headers or {}})

        if url.endswith("/robots.txt"):
            if self._robots_error:
                raise self._robots_error

            if isinstance(self._robots, int):
                return FakeResponse(status_code=self._robots)

            return FakeResponse(status_code=200, text=self._robots)

        result = self._pages.pop(0)

        if isinstance(result, Exception):
            raise result

        return result


class TestRobots:
    def test_allows_a_path_robots_does_not_forbid(self):
        fetcher = Fetcher(UA, session=FakeSession(pages=[FakeResponse(text="<p>ok</p>")]))

        assert fetcher.fetch("https://example.com/prices").status == "ok"

    def test_refuses_a_disallowed_path_without_fetching_it(self):
        session = FakeSession(robots="User-agent: *\nDisallow: /prices")
        result = Fetcher(UA, session=session).fetch("https://example.com/prices/today")

        assert result.status == "disallowed"
        assert "robots.txt" in result.error
        assert [call["url"] for call in session.calls] == [
            "https://example.com/robots.txt"
        ]

    def test_treats_a_missing_robots_as_permission(self):
        session = FakeSession(robots=404, pages=[FakeResponse(text="<p>ok</p>")])

        assert Fetcher(UA, session=session).fetch("https://example.com/p").status == "ok"

    def test_treats_an_unreachable_robots_as_a_block(self):
        # Ninety-six visits a day, unattended: "their server is broken" is
        # not the same as "they said yes".
        session = FakeSession(robots_error=requests.ConnectionError("boom"))
        result = Fetcher(UA, session=session).fetch("https://example.com/p")

        assert result.status == "disallowed"

    def test_treats_a_5xx_robots_as_a_block(self):
        session = FakeSession(robots=503)

        assert Fetcher(UA, session=session).fetch("https://e.com/p").status == "disallowed"

    def test_refuses_anything_that_is_not_a_web_url(self):
        fetcher = Fetcher(UA, session=FakeSession())

        assert fetcher.fetch("file:///c:/windows/win.ini").status == "disallowed"
        assert fetcher.fetch("javascript:alert(1)").status == "disallowed"

    def test_reads_robots_once_per_host(self):
        session = FakeSession(
            pages=[FakeResponse(text="a"), FakeResponse(text="b")]
        )
        fetcher = Fetcher(UA, session=session)

        fetcher.fetch("https://example.com/a")
        fetcher.fetch("https://example.com/b")

        robots_calls = [c for c in session.calls if c["url"].endswith("robots.txt")]
        assert len(robots_calls) == 1


class TestConditionalGet:
    def test_sends_no_validators_on_a_first_visit(self):
        session = FakeSession(pages=[FakeResponse(text="<p>ok</p>")])

        Fetcher(UA, session=session).fetch("https://example.com/p")

        headers = session.calls[-1]["headers"]
        assert "if-none-match" not in headers
        assert "if-modified-since" not in headers

    def test_sends_the_validators_it_was_given(self):
        session = FakeSession(pages=[FakeResponse(status_code=304)])

        Fetcher(UA, session=session).fetch(
            "https://example.com/p", etag='W/"abc"', last_modified="Mon, 17 Aug 2026 09:00:00 GMT"
        )

        headers = session.calls[-1]["headers"]
        assert headers["if-none-match"] == 'W/"abc"'
        assert headers["if-modified-since"] == "Mon, 17 Aug 2026 09:00:00 GMT"

    def test_reports_304_as_not_modified_and_keeps_the_validators(self):
        # The cheapest outcome there is, and the usual one at this cadence.
        session = FakeSession(pages=[FakeResponse(status_code=304)])

        result = Fetcher(UA, session=session).fetch(
            "https://example.com/p", etag='W/"abc"'
        )

        assert result.status == "not_modified"
        assert result.etag == 'W/"abc"'
        assert result.html == ""

    def test_returns_the_new_validators_from_a_200(self):
        session = FakeSession(
            pages=[
                FakeResponse(
                    text="<p>ok</p>",
                    headers={"etag": 'W/"new"', "last-modified": "Tue, 18 Aug 2026"},
                )
            ]
        )

        result = Fetcher(UA, session=session).fetch("https://example.com/p")

        assert result.etag == 'W/"new"'
        assert result.last_modified == "Tue, 18 Aug 2026"


class TestFailures:
    def test_reports_a_refusal_as_blocked(self):
        for status in (403, 429, 503):
            session = FakeSession(pages=[FakeResponse(status_code=status)])
            result = Fetcher(UA, session=session).fetch("https://example.com/p")

            assert result.status == "blocked"
            assert result.http_status == status

    def test_reports_a_404_as_failed(self):
        session = FakeSession(pages=[FakeResponse(status_code=404)])

        assert Fetcher(UA, session=session).fetch("https://e.com/p").status == "failed"

    def test_reports_a_transport_error_as_failed(self):
        session = FakeSession(pages=[requests.Timeout("timed out")])
        result = Fetcher(UA, session=session).fetch("https://example.com/p")

        assert result.status == "failed"
        assert "timed out" in result.error

    def test_identifies_itself_honestly(self):
        session = FakeSession(pages=[FakeResponse(text="ok")])

        Fetcher(UA, session=session).fetch("https://example.com/p")

        assert session.calls[-1]["headers"]["user-agent"] == UA
