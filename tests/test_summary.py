"""The plain-English note that goes above the site's price trends table.

The page it lands on is public and shows `xxx` where a price would be, so the
one rule that matters here is structural rather than editorial: the prompt is
built from directions and percentages only. A model cannot leak a price it was
never given.
"""

from app.ai.providers import AiCompletion, AiProviderError, declined
from app.editorial.summary import build_summary_prompt, write_summary

ITEMS = [
    {
        "location": "Singapore N 150 FOB Group II",
        "old_price": 905.0,
        "new_price": 880.0,
        "delta_pct": -2.7624,
        "is_included": True,
        "status": "ok",
    },
    {
        "location": "Europe Domestic SN 150 FOB Group I",
        "old_price": 1120.0,
        "new_price": 1120.0,
        "delta_pct": 0.0,
        "is_included": True,
        "status": "ok",
    },
    {
        "location": "Korea N 150 FOB Group II/ II+",
        "old_price": None,
        "new_price": 963.0,
        "delta_pct": None,
        "is_included": True,
        "status": "ok",
    },
    {
        "location": "A row the admin unticked",
        "old_price": 100.0,
        "new_price": 200.0,
        "delta_pct": 100.0,
        "is_included": False,
        "status": "ok",
    },
]


class StubDriver:
    def __init__(self, completion=None, raises=None):
        self._completion = completion or AiCompletion(
            status="complete",
            text="  Group II grades in Singapore eased while Europe held flat.  ",
            prompt_tokens=300,
            completion_tokens=40,
            error=None,
        )
        self._raises = raises
        self.calls = []

    def generate(self, model, prompt):
        self.calls.append({"model": model, "prompt": prompt})

        if self._raises:
            raise self._raises

        return self._completion


class TestThePromptCannotLeakAPrice:
    def test_no_absolute_price_reaches_the_model(self):
        prompt = build_summary_prompt(ITEMS, source="editorial")

        for figure in ("905", "880", "1120", "963"):
            assert figure not in prompt

    def test_a_row_the_admin_unticked_is_not_described(self):
        prompt = build_summary_prompt(ITEMS, source="editorial")

        assert "A row the admin unticked" not in prompt


class TestThePromptDescribesWhatMoved:
    def test_it_names_a_location_and_which_way_it_went(self):
        prompt = build_summary_prompt(ITEMS, source="editorial")

        assert "Singapore N 150 FOB Group II" in prompt
        assert "down 2.8%" in prompt

    def test_a_price_that_did_not_move_is_called_unchanged(self):
        prompt = build_summary_prompt(ITEMS, source="editorial")

        assert "Europe Domestic SN 150 FOB Group I: unchanged" in prompt

    def test_a_location_priced_for_the_first_time_says_so(self):
        prompt = build_summary_prompt(ITEMS, source="editorial")

        assert "Korea N 150 FOB Group II/ II+: priced for the first time" in prompt

    def test_it_says_where_the_update_came_from(self):
        assert "crawl" in build_summary_prompt(ITEMS, source="crawl")


class TestWritingTheNote:
    def test_it_hands_back_the_models_answer_without_the_whitespace(self):
        driver = StubDriver()

        note = write_summary(driver, "gpt-4o-mini", ITEMS, source="editorial")

        assert note == "Group II grades in Singapore eased while Europe held flat."

    def test_a_provider_failure_is_no_note_rather_than_an_exception(self):
        driver = StubDriver(raises=AiProviderError("the key is wrong"))

        assert write_summary(driver, "gpt-4o-mini", ITEMS, source="editorial") is None

    def test_a_decline_is_no_note(self):
        driver = StubDriver(completion=declined("blocked"))

        assert write_summary(driver, "gpt-4o-mini", ITEMS, source="editorial") is None

    def test_an_update_that_changed_nothing_is_not_worth_a_note(self):
        driver = StubDriver()

        note = write_summary(driver, "gpt-4o-mini", [], source="editorial")

        assert note is None
        assert driver.calls == []
