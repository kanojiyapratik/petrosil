import json

import pytest
import requests

from scraper.ai import (
    AiProviderError,
    GeminiExtractor,
    build_prompt,
    clean_rows,
    to_price,
)

LOCATIONS = ["Gulf Coast", "West Coast", "Singapore"]
TODAY = "2026-08-18"


class FakeResponse:
    def __init__(self, payload=None, status_code=200, text=""):
        self._payload = payload
        self.status_code = status_code
        self.text = text or json.dumps(payload or {})

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

    def post(self, url, json=None, timeout=None):
        self.calls.append({"url": url, "json": json})
        result = self._responses.pop(0)

        if isinstance(result, Exception):
            raise result

        return result


def answering(text):
    return FakeResponse(
        {"candidates": [{"content": {"parts": [{"text": text}]}}]}
    )


def extractor(session, api_key="secret-key"):
    return GeminiExtractor(
        api_key=api_key, session=session, backoff_seconds=0, sleep=lambda _s: None
    )


class TestToPrice:
    def test_accepts_numbers_and_numeric_strings(self):
        assert to_price(3.69) == 3.69
        assert to_price(845) == 845.0
        assert to_price("845.5") == 845.5

    def test_strips_currency_symbols_and_separators(self):
        assert to_price("$1,234.50") == 1234.5
        assert to_price("INR 96,500.00") == 96500.0

    def test_rejects_blanks_rather_than_reading_them_as_zero(self):
        assert to_price("") is None
        assert to_price("   ") is None
        assert to_price(None) is None

    def test_rejects_a_boolean_which_is_an_int_in_python(self):
        assert to_price(True) is None

    def test_rejects_negatives_rather_than_clamping(self):
        assert to_price(-3.69) is None
        assert to_price("-3.69") is None

    def test_rejects_unreadable_values(self):
        assert to_price("n/a") is None
        assert to_price(float("nan")) is None
        assert to_price(float("inf")) is None
        assert to_price({"price": 3}) is None


class TestBuildPrompt:
    def test_names_the_locations_the_site_tracks(self):
        prompt = build_prompt("https://example.com", "text", LOCATIONS, TODAY)

        assert "Gulf Coast, West Coast, Singapore" in prompt
        assert TODAY in prompt
        assert "EVERY published price" in prompt

    def test_says_when_the_site_tracks_nothing(self):
        assert "the site tracks none" in build_prompt("u", "t", [], TODAY)

    def test_carries_the_sites_instructions_when_given(self):
        # The person watching these URLs knows their quirks ("the bottom table
        # is last year's") -- their free-text instructions ride along.
        prompt = build_prompt(
            "https://example.com",
            "text",
            LOCATIONS,
            TODAY,
            instructions="The bottom table is historical - read only the top one.",
        )

        assert "The bottom table is historical - read only the top one." in prompt
        assert "Site instructions" in prompt
        # Guidance only: the JSON contract still stands.
        assert "cannot change" in prompt

    def test_without_instructions_there_is_no_instructions_section(self):
        assert "Site instructions" not in build_prompt("u", "t", LOCATIONS, TODAY)
        assert "Site instructions" not in build_prompt("u", "t", LOCATIONS, TODAY, instructions=" ")


class TestCleanRows:
    def test_keeps_a_clean_row(self):
        rows = clean_rows(
            [{"location": "Gulf Coast", "date": "2026-08-17", "price": 3.69}],
            LOCATIONS,
            TODAY,
        )

        assert rows[0].location == "Gulf Coast"
        assert rows[0].date == "2026-08-17"
        assert rows[0].price == 3.69

    def test_falls_back_to_today_without_a_usable_date(self):
        rows = clean_rows([{"location": "Gulf Coast", "price": 3.69}], LOCATIONS, TODAY)

        assert rows[0].date == TODAY

    def test_snaps_a_location_back_to_the_site_spelling(self):
        rows = clean_rows(
            [{"location": "  gulf   coast ", "price": 3.69}], LOCATIONS, TODAY
        )

        assert rows[0].location == "Gulf Coast"

    def test_keeps_a_label_the_site_does_not_have(self):
        # It used to be dropped, which meant a page quoting "China 445"
        # reported nothing at all and looked broken. What to do with an
        # unfamiliar label is the site's decision, not this one's.
        rows = clean_rows([{"location": "China", "price": 445}], LOCATIONS, TODAY)

        assert len(rows) == 1
        assert rows[0].location == "China"
        assert rows[0].price == 445

    def test_snaps_to_site_wording_when_it_matches_and_keeps_page_wording_when_it_does_not(self):
        rows = clean_rows(
            [
                {"location": "gulf coast", "price": 3.69},
                {"location": "Base Oil UAE CFR", "price": 1937.55},
            ],
            LOCATIONS,
            TODAY,
        )

        assert [row.location for row in rows] == ["Gulf Coast", "Base Oil UAE CFR"]

    def test_still_drops_a_row_with_no_label_at_all(self):
        assert clean_rows([{"location": "  ", "price": 9.0}], LOCATIONS, TODAY) == []

    def test_drops_a_blank_price_instead_of_publishing_a_zero(self):
        rows = clean_rows(
            [
                {"location": "Gulf Coast", "price": ""},
                {"location": "West Coast", "price": None},
            ],
            LOCATIONS,
            TODAY,
        )

        assert rows == []

    def test_keeps_the_first_of_two_rows_for_one_location_and_date(self):
        rows = clean_rows(
            [
                {"location": "Gulf Coast", "price": 3.69},
                {"location": "Gulf Coast", "price": 3.99},
            ],
            LOCATIONS,
            TODAY,
        )

        assert len(rows) == 1
        assert rows[0].price == 3.69

    def test_ignores_entries_that_are_not_objects(self):
        assert clean_rows(["Gulf Coast 3.69", 42, None], LOCATIONS, TODAY) == []


class TestGeminiExtractor:
    def test_reads_rows_out_of_a_clean_answer(self):
        session = FakeSession(
            answering('{"rows":[{"location":"Gulf Coast","price":3.69}]}')
        )

        result = extractor(session).extract("u", "text", LOCATIONS, TODAY)

        assert result.error is None
        assert result.rows[0].price == 3.69

    def test_digs_json_out_of_a_fenced_chatty_answer(self):
        session = FakeSession(
            answering(
                'Sure:\n```json\n{"rows":[{"location":"Gulf Coast","price":3.69}]}\n```'
            )
        )

        assert len(extractor(session).extract("u", "t", LOCATIONS, TODAY).rows) == 1

    def test_passes_notes_through(self):
        session = FakeSession(answering('{"rows":[],"notes":"table was an image"}'))

        result = extractor(session).extract("u", "t", LOCATIONS, TODAY)

        assert result.notes == "table was an image"
        assert result.rows == []

    def test_treats_a_block_reason_as_a_decline_not_a_crash(self):
        # Gemini answers HTTP 200 with an empty candidates list and a
        # blockReason. Indexing candidates[0] first would raise instead.
        session = FakeSession(
            FakeResponse({"candidates": [], "promptFeedback": {"blockReason": "SAFETY"}})
        )

        result = extractor(session).extract("u", "t", LOCATIONS, TODAY)

        assert result.declined is True
        assert "SAFETY" in result.error

    def test_treats_a_non_json_answer_as_a_decline(self):
        session = FakeSession(answering("I could not find any prices."))

        result = extractor(session).extract("u", "t", LOCATIONS, TODAY)

        assert result.declined is True
        assert "did not return JSON" in result.error

    def test_retries_a_500_then_succeeds(self):
        session = FakeSession(
            FakeResponse(status_code=500, text="upstream"),
            answering('{"rows":[{"location":"Gulf Coast","price":3.69}]}'),
        )

        result = extractor(session).extract("u", "t", LOCATIONS, TODAY)

        assert len(session.calls) == 2
        assert result.rows

    def test_does_not_retry_a_400(self):
        session = FakeSession(FakeResponse(status_code=400, text="bad request"))

        result = extractor(session).extract("u", "t", LOCATIONS, TODAY)

        assert len(session.calls) == 1
        assert result.error is not None

    def test_redacts_the_key_out_of_an_http_error(self):
        # The key rides in the query string, so it turns up in error text —
        # and that text lands in last_error, on an admin's screen.
        session = FakeSession(FakeResponse(status_code=400, text="bad key secret-key"))

        result = extractor(session).extract("u", "t", LOCATIONS, TODAY)

        assert "secret-key" not in result.error
        assert "***" in result.error

    def test_redacts_the_key_out_of_a_transport_error(self):
        # This one never produced a response at all, and the message still
        # embeds the full request URL.
        session = FakeSession(
            requests.ConnectionError("failed to reach ...?key=secret-key"),
            requests.ConnectionError("failed to reach ...?key=secret-key"),
            requests.ConnectionError("failed to reach ...?key=secret-key"),
        )

        result = extractor(session).extract("u", "t", LOCATIONS, TODAY)

        assert "secret-key" not in result.error

    def test_raises_are_caught_and_reported_as_an_error_not_a_decline(self):
        session = FakeSession(
            requests.Timeout("t"), requests.Timeout("t"), requests.Timeout("t")
        )

        result = extractor(session).extract("u", "t", LOCATIONS, TODAY)

        assert result.declined is False
        assert result.error is not None


def test_ai_provider_error_is_a_runtime_error():
    with pytest.raises(RuntimeError):
        raise AiProviderError("x")


class TestExplainFailure:
    """A provider error goes on a screen, so it has to fit on one."""

    class FakeResponse:
        def __init__(self, status_code, payload=None, text=""):
            self.status_code = status_code
            self._payload = payload
            self.text = text

        def json(self):
            if self._payload is None:
                raise ValueError("no json")

            return self._payload

    def test_a_quota_refusal_becomes_one_sentence_with_the_wait(self):
        # Google sends about a thousand characters of nested JSON for this.
        from scraper.ai import explain_failure

        message = explain_failure(
            self.FakeResponse(
                429,
                {
                    "error": {
                        "message": "You exceeded your current quota...\n* Quota exceeded for metric",
                        "details": [
                            {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "31s"}
                        ],
                    }
                },
            )
        )

        assert message == "Gemini quota exceeded — the API key has hit its limit. Try again in about 31s."
        assert len(message) < 120

    def test_a_rejected_key_says_so_plainly(self):
        from scraper.ai import explain_failure

        assert explain_failure(self.FakeResponse(403, {"error": {"message": "bad key"}})) == (
            "Gemini rejected the API key."
        )

    def test_any_other_failure_keeps_the_first_line_of_the_detail(self):
        from scraper.ai import explain_failure

        message = explain_failure(
            self.FakeResponse(400, {"error": {"message": "Invalid argument\nsecond line"}})
        )

        assert "Invalid argument" in message
        assert "second line" not in message

    def test_a_non_json_body_is_still_reported(self):
        from scraper.ai import explain_failure

        message = explain_failure(self.FakeResponse(502, None, "<html>gateway</html>"))

        assert "502" in message
        assert len(message) <= 300


class TestDriverExtractorInstructions:
    class FakeDriver:
        def __init__(self):
            self.prompts = []

        def generate(self, prompt):
            from types import SimpleNamespace

            self.prompts.append(prompt)

            return SimpleNamespace(status="complete", text='{"rows":[]}', error=None)

    def test_the_sites_instructions_ride_into_the_prompt(self):
        from scraper.ai import DriverExtractor

        driver = self.FakeDriver()

        DriverExtractor(driver).extract(
            "https://example.com",
            "text",
            LOCATIONS,
            TODAY,
            instructions="Read only the FOB table.",
        )

        assert "Read only the FOB table." in driver.prompts[0]
