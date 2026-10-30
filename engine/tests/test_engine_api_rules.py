"""The engine's JSON face for the rulebook, rounding and a site's AI choice.

The checks themselves are the console's (test_rule_notes, test_rounding_routes,
test_ai_settings); what is pinned here is that the app's tab gets the same
words, the same refusals, the same preview -- and never a provider's key.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.console.engine_api import create_engine_api
from app.db.store import StoredProvider
from app.editorial.rules import PriceRule
from test_engine_api import ACTOR, HEADERS, TOKEN, Drafts
from test_reading_routes import FakeExtractions
from test_rounding_routes import SITE, FakeRounding, FakeStore

LOCATIONS = [
    {"title": "Korea TOBS", "latest_price": 1404, "currency": "USD"},
    {"title": "Singapore SN 150", "latest_price": 1560, "currency": "USD"},
    {"title": "Brussels Domestic", "latest_price": 520, "currency": "EUR"},
]


class Client:
    def locations(self):
        return {"data": LOCATIONS}


class Rules:
    def __init__(self, rules=None, owner="baseoil"):
        self._rules = list(rules or [])
        self._owner = owner
        self.created = []

    def for_site(self, slug):
        return self._rules if slug == self._owner else []

    def create(self, slug, derived, reference, value, kind="percent"):
        self.created.append((derived, reference, value, kind))

    def set_enabled(self, slug, rule_id, enabled):
        return slug == self._owner and any(rule.id == rule_id for rule in self._rules)

    def delete(self, slug, rule_id):
        return self.set_enabled(slug, rule_id, False)


OPENAI = StoredProvider(id=1, name="AI1", provider="openai", api_key="sk-live-SECRET-KEY-1234", model="gpt-4.1", enabled=True, is_default=True)
GEMINI = StoredProvider(id=2, name="Gemini", provider="gemini", api_key="AIza-SECRET-5678", model="gemini-2.5-flash", enabled=True, is_default=False)


class Providers:
    def __init__(self):
        self.assigned = {}

    def all(self):
        return [OPENAI, GEMINI]

    def get(self, provider_id):
        return {1: OPENAI, 2: GEMINI}.get(provider_id)

    def assignments(self):
        return {slug: pid for slug, (pid, _) in self.assigned.items() if pid}

    def site_models(self):
        return {slug: model for slug, (_, model) in self.assigned.items() if model}

    def assign_to_site(self, slug, provider_id, model=None):
        self.assigned[slug] = (provider_id, model)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Asking a provider which models a key can run is a network call."""
    monkeypatch.setattr(
        "app.console.routes_ai.available_models",
        lambda provider, key: {"openai": ["gpt-4.1", "gpt-4.1-mini"], "gemini": ["gemini-2.5-flash"]}[provider],
    )


def build(rules=None, rounding=None, providers=None, store=None):
    store = store or FakeStore()
    app = FastAPI()
    app.include_router(
        create_engine_api(
            api_token=TOKEN, store=store, extractions=FakeExtractions(), drafts=Drafts(),
            driver=None, default_model="gpt-4.1",
            rules=rules if rules is not None else Rules(),
            rounding=rounding if rounding is not None else FakeRounding(),
            providers=providers if providers is not None else Providers(),
            client_factory=lambda site: Client(),
        )
    )

    return TestClient(app), store


KOREA = PriceRule(id=9, derived_location="Korea TOBS", reference_location="Singapore SN 150", adjustment_value=-10.0)


class TestTheRulebook:
    def test_it_comes_with_labels_prices_and_rounding(self):
        api, _ = build(rules=Rules([KOREA]))

        body = api.get("/api/engine/sites/baseoil/rules", headers=HEADERS).json()

        assert body["rules"][0]["label"] == "-10%"
        assert body["rules"][0]["derived_location"] == "Korea TOBS"
        assert body["prices"]["Singapore SN 150"] == 1560
        assert body["currencies"]["Brussels Domestic"] == "EUR"
        assert body["round_to_nearest"] == 5

    def test_saving_a_rule_says_what_it_would_do_today_in_the_actors_name(self):
        rules = Rules()
        api, store = build(rules=rules)

        response = api.post(
            "/api/engine/sites/baseoil/rules", headers=HEADERS,
            json={"derived": "Korea TOBS", "reference": "Singapore SN 150", "value": -10, "kind": "percent"},
        )

        assert response.status_code == 201
        assert "With today's prices: Singapore SN 150 is 1560, so Korea TOBS would be 1404." in response.json()["message"]
        assert rules.created == [("Korea TOBS", "Singapore SN 150", -10.0, "percent")]
        assert store.recorded[-1][:2] == (ACTOR, "set a price rule")

    def test_the_consoles_refusals_come_back_in_its_words(self):
        api, _ = build()
        post = lambda **body: api.post("/api/engine/sites/baseoil/rules", headers=HEADERS, json=body)

        itself = post(derived="Korea TOBS", reference="Korea TOBS", value=1, kind="percent")
        wrong_money = post(derived="Brussels Domestic", reference="Korea TOBS", value=5, kind="usd")
        floor = post(derived="Korea TOBS", reference="Singapore SN 150", value=-100, kind="percent")

        assert (itself.status_code, itself.json()) == (422, {"error": "A price cannot be calculated from itself."})
        assert wrong_money.json()["error"].startswith("Brussels Domestic is priced in EUR")
        assert floor.json()["error"].startswith("A percentage must be more than -100")

    def test_another_sites_rule_cannot_be_switched_or_removed(self):
        api, _ = build(rules=Rules([KOREA], owner="bitumart"))

        off = api.patch("/api/engine/sites/baseoil/rules/9", headers=HEADERS, json={"enabled": False})
        gone = api.delete("/api/engine/sites/baseoil/rules/9", headers=HEADERS)

        assert (off.status_code, off.json()) == (404, {"error": "No such rule."})
        assert gone.status_code == 404

    def test_switching_a_rule_off(self):
        api, _ = build(rules=Rules([KOREA]))

        response = api.patch("/api/engine/sites/baseoil/rules/9", headers=HEADERS, json={"enabled": False})

        assert response.json() == {"message": "Rule turned off."}


class TestRounding:
    def test_the_site_step_is_checked_and_set(self):
        api, store = build()

        bad = api.put("/api/engine/sites/baseoil/rounding", headers=HEADERS, json={"step": "five", "direction": "up"})
        good = api.put("/api/engine/sites/baseoil/rounding", headers=HEADERS, json={"step": 10, "direction": "up"})
        off = api.put("/api/engine/sites/baseoil/rounding", headers=HEADERS, json={"step": None})

        assert bad.status_code == 422
        assert good.json()["message"].startswith("Prices now round up")
        assert off.json()["message"].startswith("Rounding turned off")
        assert store.site.round_to_nearest is None

    def test_a_location_can_be_left_exactly_as_printed(self):
        rounding = FakeRounding()
        api, _ = build(rounding=rounding)

        response = api.post(
            "/api/engine/sites/baseoil/rounding/locations", headers=HEADERS,
            json={"location": "Korea TOBS", "exact": True, "as_printed": True},
        )

        assert response.status_code == 201
        assert "never rounded" in response.json()["message"]
        assert rounding.set_calls == [("baseoil", "Korea TOBS", 0.0, "nearest", True)]

    def test_a_location_step_needs_a_number(self):
        api, _ = build()

        response = api.post("/api/engine/sites/baseoil/rounding/locations", headers=HEADERS, json={"location": "Korea TOBS"})

        assert response.status_code == 422


class TestTheSitesModel:
    def test_the_choice_never_carries_a_key(self):
        api, _ = build()

        response = api.get("/api/engine/sites/baseoil/ai-settings", headers=HEADERS)
        text = response.text

        assert response.status_code == 200
        assert "SECRET" not in text and "api_key" not in text
        assert [p["name"] for p in response.json()["providers"]] == ["AI1", "Gemini"]
        assert response.json()["providers"][0]["models"] == ["gpt-4.1", "gpt-4.1-mini"]
        assert response.json()["instructions"] == SITE.editorial_instructions

    def test_a_model_the_key_cannot_run_is_refused(self):
        providers = Providers()
        api, _ = build(providers=providers)

        response = api.put("/api/engine/sites/baseoil/ai-settings", headers=HEADERS, json={"provider_id": 1, "model": "gpt-9"})

        assert (response.status_code, response.json()) == (422, {"error": "AI1 cannot run gpt-9."})
        assert providers.assigned == {}

    def test_choosing_a_model_and_going_back_to_the_default(self):
        providers = Providers()
        api, store = build(providers=providers)

        chosen = api.put("/api/engine/sites/baseoil/ai-settings", headers=HEADERS, json={"provider_id": 1, "model": "gpt-4.1-mini"})
        default = api.put("/api/engine/sites/baseoil/ai-settings", headers=HEADERS, json={"provider_id": ""})

        assert chosen.json() == {"message": "Base Oil Report now uses AI1 (gpt-4.1-mini)."}
        assert default.json() == {"message": "Base Oil Report now uses the default."}
        assert providers.assigned["baseoil"] == (None, None)
        assert store.recorded[-1][:2] == (ACTOR, "chose an AI provider for a site")
