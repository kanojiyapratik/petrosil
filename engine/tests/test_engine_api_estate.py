"""The engine's JSON face for crawling now, crawl match proposals, and the
estate-wide AI providers and usage (app/console/engine_api.py).

The rules behind each are the console's (test_ai_settings, test_crawl_now,
the crawler screen's tests); pinned here: the same refusals and words, a
key never leaving the engine, and the actor named in the audit trail.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.providers import AiCompletion, AiProviderError
from app.console.engine_api import create_engine_api
from scraper.runner import Outcome
from test_engine_api import ACTOR, HEADERS, TOKEN, Drafts
from test_engine_api_rules import GEMINI, OPENAI, Providers as SiteProviders
from test_reading_routes import FakeExtractions
from test_rounding_routes import FakeRounding, FakeStore


class Providers(SiteProviders):
    """The site-level fake, plus what the settings screen changes."""

    def __init__(self, rows=None):
        super().__init__()
        self.rows = list(rows if rows is not None else [OPENAI, GEMINI])
        self.created, self.updated, self.deleted, self.defaulted = [], [], [], []

    def all(self):
        return self.rows

    def get(self, provider_id):
        return next((row for row in self.rows if row.id == provider_id), None)

    def create(self, **row):
        self.created.append(row)
        return type("P", (), {"name": row["name"]})()

    def update(self, provider_id, **changes):
        self.updated.append((provider_id, changes))

    def make_default(self, provider_id):
        self.defaulted.append(provider_id)

    def delete(self, provider_id):
        self.deleted.append(provider_id)


class Usage:
    def __init__(self):
        self.recorded = []

    def record(self, **fields):
        self.recorded.append(fields)

    def by_day(self, days):
        return [{"day": "2026-10-30", "provider": "openai", "model": "gpt-4.1", "calls": 5, "prompt_tokens": 900, "completion_tokens": 300}]

    def by_site(self, days):
        return [{"site": "baseoil", "kind": "editorial", "calls": 5, "failed": 0, "prompt_tokens": 900, "completion_tokens": 300}]


class Locations:
    def locations(self):
        return {"data": [{"title": "Korea TOBS"}, {"title": "Singapore SN 150"}]}


class MatchDriver:
    provider_key = "openai"
    model = "gpt-4.1"

    def __init__(self):
        self.prompts = []

    def generate(self, prompt):
        self.prompts.append(prompt)

        return AiCompletion(
            status="complete",
            text=json.dumps([{"id": 7, "match": "Korea TOBS", "caution": "per litre"}, {"id": 8, "match": "Atlantis"}]),
            prompt_tokens=10, completion_tokens=5, error=None,
        )


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr(
        "app.console.routes_ai.available_models",
        lambda provider, key, timeout_seconds=None: ["gpt-4.1", "gpt-4.1-mini"] if key.startswith("sk-") else [],
    )


def build(providers=None, usage=None, driver=None, store=None):
    store = store or FakeStore()
    driver = driver or MatchDriver()
    app = FastAPI()
    app.include_router(
        create_engine_api(
            api_token=TOKEN, store=store, extractions=FakeExtractions(), drafts=Drafts(),
            driver=driver, default_model="gpt-4.1", driver_for=lambda slug: driver,
            usage=usage if usage is not None else Usage(),
            rounding=FakeRounding(), providers=providers if providers is not None else Providers(),
            client_factory=lambda site: Locations(),
        )
    )

    return TestClient(app), store


class TestProviders:
    def test_the_list_masks_every_key(self):
        api, _ = build()

        response = api.get("/api/engine/providers", headers=HEADERS)

        assert response.status_code == 200
        assert "SECRET" not in response.text
        assert response.json()["providers"][0]["masked_key"] == OPENAI.masked_key
        assert "openai" in response.json()["catalogue"]

    def test_the_door_is_the_same(self):
        api, _ = build()

        assert api.get("/api/engine/providers").status_code == 401
        assert api.get("/api/engine/usage", headers={"authorization": f"Bearer {TOKEN}"}).status_code == 400

    def test_a_key_being_typed_is_checked_and_never_echoed(self):
        api, _ = build()

        good = api.post("/api/engine/providers/check-key", headers=HEADERS, json={"provider": "openai", "api_key": "sk-new key\n"})
        bad = api.post("/api/engine/providers/check-key", headers=HEADERS, json={"provider": "openai", "api_key": "nope"})

        assert good.json() == {"models": ["gpt-4.1", "gpt-4.1-mini"]}
        assert (bad.status_code, bad.json()) == (422, {"error": "That key was not accepted."})
        assert "nope" not in bad.text

    def test_adding_one_records_it_without_the_key(self):
        providers = Providers()
        api, store = build(providers=providers)

        response = api.post(
            "/api/engine/providers", headers=HEADERS,
            json={"provider": "openai", "api_key": " sk-abc 123 ", "name": "Second key"},
        )

        assert (response.status_code, response.json()) == (201, {"message": "Second key added."})
        assert providers.created[0]["api_key"] == "sk-abc123"
        assert store.recorded[-1][:2] == (ACTOR, "added an AI provider")
        assert "sk-abc" not in str(store.recorded)

    def test_the_default_cannot_be_removed(self):
        api, _ = build()

        response = api.delete("/api/engine/providers/1", headers=HEADERS)

        assert (response.status_code, response.json()["error"]) == (409, "That is the default — make another one the default first.")

    def test_making_another_the_default_then_removing_the_first(self):
        providers = Providers()
        api, _ = build(providers=providers)

        assert api.post("/api/engine/providers/2/default", headers=HEADERS).json() == {"message": "Gemini is now the default."}
        assert providers.defaulted == [2]
        # The fake does not move the flag, so AI1 is still the default here.
        assert api.delete("/api/engine/providers/1", headers=HEADERS).status_code == 409
        assert api.delete("/api/engine/providers/2", headers=HEADERS).json() == {
            "message": "Gemini removed. Sites using it fall back to the default."
        }
        assert providers.deleted == [2]

    def test_a_blank_key_on_update_keeps_the_stored_one(self):
        providers = Providers()
        api, _ = build(providers=providers)

        response = api.patch("/api/engine/providers/1", headers=HEADERS, json={"model": "gpt-4.1-mini", "api_key": "", "enabled": True})

        assert response.json() == {"message": "AI1 saved."}
        assert providers.updated[0][1]["api_key"] == ""
        assert providers.updated[0][1]["model"] == "gpt-4.1-mini"

    def test_testing_a_provider_reports_what_came_back(self, monkeypatch):
        class Works:
            def generate(self, prompt):
                return AiCompletion(status="complete", text="ready", prompt_tokens=1, completion_tokens=1, error=None)

        class Broken:
            def generate(self, prompt):
                raise AiProviderError("Incorrect API key provided.")

        usage = Usage()
        api, _ = build(usage=usage)

        monkeypatch.setattr("app.console.routes_ai.create_driver", lambda *args: Works())
        works = api.post("/api/engine/providers/1/test", headers=HEADERS)
        monkeypatch.setattr("app.console.routes_ai.create_driver", lambda *args: Broken())
        broken = api.post("/api/engine/providers/1/test", headers=HEADERS)

        assert works.json() == {"message": 'AI1 works — gpt-4.1 replied "ready".'}
        assert (broken.status_code, broken.json()) == (502, {"error": "AI1: Incorrect API key provided."})
        assert [row["status"] for row in usage.recorded] == ["complete", "failed"]


class TestUsage:
    def test_it_comes_per_day_and_per_site(self):
        api, _ = build()

        body = api.get("/api/engine/usage?days=9999", headers=HEADERS).json()

        assert body["days"] == 365
        assert body["by_site"][0]["site"] == "baseoil"
        assert body["by_day"][0]["calls"] == 5


class TestCrawling:
    def test_crawl_now_says_what_happened_in_the_actors_name(self, monkeypatch):
        monkeypatch.setattr(
            "app.console.engine_api.crawl_site_now",
            lambda site, providers=None: [Outcome(url_id=1, url="https://example.test/a", status="unchanged")],
        )
        api, store = build()

        response = api.post("/api/engine/sites/baseoil/crawl", headers=HEADERS)

        assert response.status_code == 200
        assert response.json()["outcomes"] == [{"url": "https://example.test/a", "status": "unchanged", "rows": 0, "used_ai": False}]
        assert "Checked 1 URL(s)." in response.json()["message"]
        assert store.recorded[-1][:2] == (ACTOR, "ran a crawl by hand")

    def test_a_crawl_that_cannot_run_says_why(self, monkeypatch):
        def no_provider(site, providers=None):
            raise RuntimeError("No AI provider is configured, so pages cannot be read.")

        monkeypatch.setattr("app.console.engine_api.crawl_site_now", no_provider)
        api, _ = build()

        response = api.post("/api/engine/sites/baseoil/crawl", headers=HEADERS)

        assert (response.status_code, response.json()["error"]) == (502, "No AI provider is configured, so pages cannot be read.")

    def test_matches_are_proposed_only_among_the_sites_own_locations(self):
        usage = Usage()
        api, _ = build(usage=usage)

        response = api.post(
            "/api/engine/sites/baseoil/crawl/matches", headers=HEADERS,
            json={"findings": [{"id": 7, "location": "Korea N150 (per litre)", "price": 1.1}, {"id": 8, "location": "Mystery", "price": 9}]},
        )

        proposals = response.json()["proposals"]
        assert proposals["7"] == {"match": "Korea TOBS", "caution": "per litre"}
        assert proposals["8"]["match"] is None
        assert usage.recorded[-1]["kind"] == "crawler_match"
