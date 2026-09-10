"""What the console offers as a model, and where the list comes from.

The list used to be hardcoded. It was written in August and by September the
screen still offered gpt-4o-mini as the biggest OpenAI model on a paid key
that could reach the whole gpt-5 line -- so the list is now asked of the key
itself, and the hardcoded one is only a fallback.
"""

from app.ai.providers import PROVIDERS, _is_text_model, _newest_first, available_models


class FakeResponse:
    def __init__(self, payload, ok=True):
        self._payload = payload
        self.ok = ok

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, response=None, raises=None):
        self._response = response
        self._raises = raises
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))

        if self._raises:
            raise self._raises

        return self._response


def openai_listing(*ids):
    return FakeResponse({"data": [{"id": name} for name in ids]})


class TestAskingTheKeyWhatItCanRun:
    def test_the_models_a_key_lists_are_what_is_offered(self):
        session = FakeSession(openai_listing("gpt-5.5", "gpt-4o", "gpt-5-mini"))

        assert available_models("openai", "sk-x", session=session) == [
            "gpt-5.5", "gpt-5-mini", "gpt-4o",
        ]

    def test_the_key_travels_as_a_header_not_in_the_address(self):
        # The Gemini key rides in a query string and every message has to be
        # redacted because of it. An OpenAI key must not repeat that.
        session = FakeSession(openai_listing("gpt-5"))

        available_models("openai", "sk-secret", session=session)
        url, kwargs = session.calls[0]

        assert "sk-secret" not in url
        assert kwargs["headers"]["authorization"] == "Bearer sk-secret"

    def test_a_gemini_key_is_asked_only_for_models_that_can_answer_a_prompt(self):
        session = FakeSession(
            FakeResponse(
                {
                    "models": [
                        {"name": "models/gemini-3.5-flash",
                         "supportedGenerationMethods": ["generateContent"]},
                        {"name": "models/text-embedding-004",
                         "supportedGenerationMethods": ["embedContent"]},
                    ]
                }
            )
        )

        assert available_models("gemini", "k", session=session) == ["gemini-3.5-flash"]

    def test_an_anthropic_key_is_asked_with_its_own_header(self):
        session = FakeSession(openai_listing("claude-sonnet-4-5"))

        available_models("anthropic", "sk-ant-x", session=session)

        assert session.calls[0][1]["headers"]["x-api-key"] == "sk-ant-x"

    def test_a_refused_key_offers_nothing_rather_than_failing(self):
        session = FakeSession(FakeResponse({"error": "bad key"}, ok=False))

        assert available_models("openai", "sk-wrong", session=session) == []

    def test_no_network_offers_nothing_rather_than_failing(self):
        # This runs while a settings page is rendering. It may never raise.
        session = FakeSession(raises=OSError("no route to host"))

        assert available_models("openai", "sk-x", session=session) == []


class TestWhatCountsAsAModelToOffer:
    def test_pictures_sound_and_embeddings_are_not_offered(self):
        for name in (
            "gpt-4o-mini-tts", "text-embedding-3-large", "whisper-1", "dall-e-3",
            "gpt-image-1", "gpt-realtime", "omni-moderation-latest", "sora-2",
            "gemini-robotics-er-2-preview",
        ):
            assert not _is_text_model(name), name

    def test_the_current_text_models_are_offered(self):
        for name in ("gpt-5.5", "gpt-5-pro", "gpt-4.1", "o3", "o4-mini", "claude-opus-4-5"):
            assert _is_text_model(name), name

    def test_a_dated_snapshot_of_a_model_already_listed_is_dropped(self):
        # The same model twice under two names is noise in a dropdown.
        assert not _is_text_model("gpt-4o-2024-08-06")
        assert _is_text_model("gpt-4o")

    def test_versions_are_compared_as_numbers_not_as_text(self):
        assert _newest_first(["gpt-5.4", "gpt-5.10", "gpt-5.2"]) == [
            "gpt-5.10", "gpt-5.4", "gpt-5.2",
        ]

    def test_the_o_series_sorts_under_the_main_line_not_above_it(self):
        assert _newest_first(["o3", "gpt-4o"]) == ["gpt-4o", "o3"]


class TestTheFallbackList:
    def test_every_provider_still_has_one_for_when_the_key_cannot_be_asked(self):
        for name, meta in PROVIDERS.items():
            assert meta["models"], name
