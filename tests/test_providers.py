"""Several providers behind one interface.

The provider used to be written into the code in two places. These tests pin
the thing that makes it configurable: every driver answers the same shape, and
the differences between the three APIs stay inside their own classes.
"""

import pytest
import requests

from app.ai.providers import (
    IMAGE_TIMEOUT_SECONDS,
    PROVIDERS,
    AiProviderError,
    AiQuotaExhausted,
    create_driver,
)


class FakeResponse:
    def __init__(self, payload=None, status_code=200, text=""):
        self._payload = payload
        self.status_code = status_code
        self.text = text

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

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers or {}, "timeout": timeout})
        result = self._responses.pop(0)

        if isinstance(result, Exception):
            raise result

        return result


def driver(provider, session, model=None, key="secret-key"):
    return create_driver(
        provider,
        key,
        model or PROVIDERS[provider]["models"][0],
        session=session,
        backoff_seconds=0,
        sleep=lambda _s: None,
    )


GEMINI_OK = {
    "candidates": [{"content": {"parts": [{"text": "hello"}]}}],
    "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 3},
}
OPENAI_OK = {
    "choices": [{"message": {"content": "hello"}}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 3},
}
CLAUDE_OK = {
    "content": [{"type": "text", "text": "hello"}],
    "usage": {"input_tokens": 10, "output_tokens": 3},
}


class TestEveryProviderAnswersTheSameShape:
    def test_each_returns_a_completion(self):
        for provider, payload in (
            ("gemini", GEMINI_OK),
            ("openai", OPENAI_OK),
            ("anthropic", CLAUDE_OK),
        ):
            result = driver(provider, FakeSession(FakeResponse(payload))).generate("hi")

            assert result.status == "complete", provider
            assert result.text == "hello", provider
            assert result.prompt_tokens == 10, provider
            assert result.completion_tokens == 3, provider

    def test_an_empty_answer_is_a_decline_not_a_crash(self):
        for provider, payload in (
            ("gemini", {"candidates": [], "promptFeedback": {"blockReason": "SAFETY"}}),
            ("openai", {"choices": [{"message": {"content": ""}}]}),
            ("anthropic", {"content": []}),
        ):
            result = driver(provider, FakeSession(FakeResponse(payload))).generate("hi")

            assert result.status == "declined", provider


class TestEachApiIsCalledItsOwnWay:
    def test_gemini_puts_the_key_in_the_query_string(self):
        session = FakeSession(FakeResponse(GEMINI_OK))
        driver("gemini", session).generate("hi")

        assert "key=secret-key" in session.calls[0]["url"]

    def test_openai_uses_a_bearer_header(self):
        session = FakeSession(FakeResponse(OPENAI_OK))
        driver("openai", session).generate("hi")

        assert session.calls[0]["headers"]["authorization"] == "Bearer secret-key"

    def test_anthropic_uses_its_own_header_and_needs_max_tokens(self):
        session = FakeSession(FakeResponse(CLAUDE_OK))
        driver("anthropic", session).generate("hi")

        assert session.calls[0]["headers"]["x-api-key"] == "secret-key"
        assert session.calls[0]["headers"]["anthropic-version"] == "2023-06-01"
        # Required by that API, unlike the other two.
        assert session.calls[0]["json"]["max_tokens"] > 0


class TestGroqSpeaksOpenAisDialect:
    """Groq exists to let the OpenAI-style flow be tested on a free key: same
    request and answer shape as OpenAI, different host."""

    def test_groq_calls_its_own_host_with_a_bearer_header(self):
        session = FakeSession(FakeResponse(OPENAI_OK))
        driver("groq", session).generate("hi")

        assert session.calls[0]["url"] == "https://api.groq.com/openai/v1/chat/completions"
        assert session.calls[0]["headers"]["authorization"] == "Bearer secret-key"

    def test_groq_answers_the_same_shape_as_the_others(self):
        result = driver("groq", FakeSession(FakeResponse(OPENAI_OK))).generate("hi")

        assert result.status == "complete"
        assert result.text == "hello"
        assert result.prompt_tokens == 10
        assert result.completion_tokens == 3


class TestReadingImages:
    """The USA posted prices arrive as a picture inside the report. Vision-
    capable providers transcribe it; one that cannot must say so rather than
    silently answer from nothing."""

    def test_gemini_sends_images_inline(self):
        session = FakeSession(FakeResponse(GEMINI_OK))
        driver("gemini", session).generate_with_images("read this", [("image/png", b"\x89PNG")])

        parts = session.calls[0]["json"]["contents"][0]["parts"]
        assert parts[0]["text"] == "read this"
        assert parts[1]["inline_data"]["mime_type"] == "image/png"
        assert parts[1]["inline_data"]["data"]  # base64 payload present

    def test_openai_sends_images_as_data_urls(self):
        session = FakeSession(FakeResponse(OPENAI_OK))
        driver("openai", session).generate_with_images("read this", [("image/png", b"\x89PNG")])

        content = session.calls[0]["json"]["messages"][0]["content"]
        assert content[0] == {"type": "text", "text": "read this"}
        assert content[1]["type"] == "image_url"
        assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")

    def test_anthropic_sends_images_as_base64_blocks(self):
        session = FakeSession(FakeResponse(CLAUDE_OK))
        driver("anthropic", session).generate_with_images("read this", [("image/png", b"\x89PNG")])

        content = session.calls[0]["json"]["messages"][0]["content"]
        assert content[0] == {"type": "text", "text": "read this"}
        assert content[1]["type"] == "image"
        assert content[1]["source"]["media_type"] == "image/png"

    def test_a_provider_without_vision_refuses_by_name(self):
        with pytest.raises(AiProviderError) as error:
            driver("groq", FakeSession()).generate_with_images("read", [("image/png", b"x")])

        assert "Groq" in str(error.value)

    def test_an_image_call_uses_the_longer_timeout(self):
        # A full-page scan transcription legitimately runs past the plain
        # text timeout (see IMAGE_TIMEOUT_SECONDS's own comment); the image
        # path must be given the room to finish honestly rather than time
        # out early.
        session = FakeSession(FakeResponse(OPENAI_OK))
        driver("openai", session).generate_with_images("read this", [("image/png", b"\x89PNG")])

        assert session.calls[0]["timeout"] == IMAGE_TIMEOUT_SECONDS

    def test_a_text_call_keeps_the_shorter_default_timeout(self):
        session = FakeSession(FakeResponse(OPENAI_OK))
        driver("openai", session).generate("hi")

        assert session.calls[0]["timeout"] == 120
        assert session.calls[0]["timeout"] != IMAGE_TIMEOUT_SECONDS

    def test_the_image_timeout_is_still_overridable(self):
        session = FakeSession(FakeResponse(OPENAI_OK))
        custom = create_driver(
            "openai", "secret-key", PROVIDERS["openai"]["models"][0],
            session=session, backoff_seconds=0, sleep=lambda _s: None,
            image_timeout_seconds=17,
        )
        custom.generate_with_images("read this", [("image/png", b"\x89PNG")])

        assert session.calls[0]["timeout"] == 17


class TestFailures:
    def test_a_quota_refusal_is_its_own_error_and_is_not_retried(self):
        # Retrying spends the very allowance that ran out.
        session = FakeSession(FakeResponse({"error": {"message": "quota"}}, 429))

        with pytest.raises(AiQuotaExhausted):
            driver("openai", session).generate("hi")

        assert len(session.calls) == 1

    def test_a_5xx_is_retried(self):
        session = FakeSession(FakeResponse(None, 503, "upstream"), FakeResponse(OPENAI_OK))

        assert driver("openai", session).generate("hi").status == "complete"
        assert len(session.calls) == 2

    def test_a_rejected_key_says_so_in_one_sentence(self):
        session = FakeSession(FakeResponse({"error": {"message": "bad"}}, 401))

        with pytest.raises(AiProviderError) as error:
            driver("anthropic", session).generate("hi")

        assert str(error.value) == "Claude rejected the API key."

    def test_the_key_never_appears_in_an_error(self):
        # Gemini puts it in the URL, so a transport error carries it.
        # One per attempt: a transport error is retried before it is raised.
        session = FakeSession(
            *[requests.ConnectionError("failed ...?key=secret-key") for _ in range(3)]
        )

        with pytest.raises(AiProviderError) as error:
            driver("gemini", session).generate("hi")

        assert "secret-key" not in str(error.value)
        assert "***" in str(error.value)

    def test_an_unknown_provider_is_refused_by_name(self):
        with pytest.raises(AiProviderError) as error:
            create_driver("mystery-ai", "k", "m")

        assert "mystery-ai" in str(error.value)


def test_the_catalogue_and_the_drivers_agree():
    # The screen offers what the catalogue lists; a name it offers that has no
    # driver would fail only when someone tried to use it.
    from app.ai.providers import DRIVERS

    assert set(PROVIDERS) == set(DRIVERS)

    for meta in PROVIDERS.values():
        assert meta["models"], meta["label"]


def test_a_quota_refusal_reads_as_one_sentence_for_every_provider():
    """It lands in a table on a screen, whichever provider produced it."""
    from app.ai.providers import AiQuotaExhausted

    gemini_body = {
        "error": {
            "message": "You exceeded your current quota...\n* Quota exceeded for metric",
            "details": [
                {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "31s"}
            ],
        }
    }

    with pytest.raises(AiQuotaExhausted) as error:
        driver("gemini", FakeSession(FakeResponse(gemini_body, 429))).generate("hi")

    assert str(error.value) == (
        "Gemini quota exceeded — the API key has hit its limit. Try again in about 31s."
    )

    with pytest.raises(AiQuotaExhausted) as error:
        driver("openai", FakeSession(FakeResponse({"error": {"message": "rate"}}, 429))).generate("hi")

    assert str(error.value) == "OpenAI quota exceeded — the API key has hit its limit."
