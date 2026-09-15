"""The add-a-key form asking a typed-but-unsaved key what it can run.

Before this, the model list on the add-a-key form was the hardcoded
catalogue and stayed that way until the key was saved -- the live list, asked
of the provider, was only reachable for a row already in the database. The
check-key route closes that gap by letting the form ask the typed key
directly, without ever saving, logging or echoing it back.
"""

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

import app.console.routes_ai as routes_ai
from app.ai.providers import PROVIDERS
from app.console.routes_ai import create_ai_routes


class FakeStore:
    def __init__(self):
        self.recorded = []

    def sites(self):
        return []

    def record(self, *args, **kwargs):
        self.recorded.append(args)


class FakeProviders:
    def __init__(self, rows=None):
        self._rows = rows or []

    def all(self):
        return list(self._rows)

    def assignments(self):
        return {}


def admin_user(request=None):
    return type("U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True})()


def build(current_user=admin_user, providers=None, store=None):
    app = FastAPI()
    app.include_router(
        create_ai_routes(
            store=store or FakeStore(),
            providers=providers or FakeProviders(),
            templates=Jinja2Templates(directory="app/templates"),
            current_user=current_user,
        )
    )

    return TestClient(app)


def check(client, provider="openai", api_key="sk-typed-key"):
    return client.post(
        "/console/settings/ai/check-key",
        data={"provider": provider, "api_key": api_key},
        follow_redirects=False,
    )


class TestTheKeyIsAskedDirectly:
    def test_a_good_key_gets_back_the_live_list(self, monkeypatch):
        seen = {}

        def fake_available_models(provider, api_key, timeout_seconds=10):
            seen["provider"] = provider
            seen["api_key"] = api_key
            seen["timeout_seconds"] = timeout_seconds

            return ["gpt-5.5", "gpt-5-mini"]

        monkeypatch.setattr(routes_ai, "available_models", fake_available_models)

        response = check(build(), provider="openai", api_key="sk-live-one")

        assert response.status_code == 200
        assert response.json() == {"ok": True, "models": ["gpt-5.5", "gpt-5-mini"]}
        assert seen["provider"] == "openai"
        assert seen["api_key"] == "sk-live-one"
        # A person is waiting on this form -- the check must not sit as long
        # as an ordinary call is allowed to.
        assert seen["timeout_seconds"] <= 10

    def test_a_rejected_key_gives_a_clean_failure_with_no_provider_text_or_key_fragment(
        self, monkeypatch
    ):
        # available_models never raises -- a refused key or a dead network
        # both come back as an empty list, exactly like the settings screen's
        # existing live lookup.
        monkeypatch.setattr(routes_ai, "available_models", lambda *a, **k: [])

        response = check(build(), provider="anthropic", api_key="sk-ant-super-secret")

        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is False

        raw = response.text
        assert "sk-ant-super-secret" not in raw
        assert "Anthropic" not in raw
        assert "Claude" not in raw
        assert body["error"] == "That key was not accepted."

    def test_the_key_is_never_persisted(self, monkeypatch):
        monkeypatch.setattr(routes_ai, "available_models", lambda *a, **k: ["m1"])
        providers = FakeProviders()
        providers.create = lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("check-key must never save a row")
        )
        store = FakeStore()

        response = check(build(providers=providers, store=store), provider="openai", api_key="sk-do-not-save")

        assert response.status_code == 200
        assert response.json() == {"ok": True, "models": ["m1"]}
        # Nothing about this call was written down anywhere.
        assert store.recorded == []

    def test_an_unauthenticated_caller_is_refused(self):
        response = check(build(current_user=lambda request: None))

        assert response.status_code == 303
        assert response.headers["location"].endswith("/console/login")
        assert "models" not in response.text

    def test_an_unknown_provider_is_a_clean_failure_not_a_crash(self):
        response = check(build(), provider="not-a-real-provider", api_key="x")

        assert response.status_code == 200
        assert response.json()["ok"] is False

    def test_a_blank_key_is_a_clean_failure(self):
        response = check(build(), provider="openai", api_key="")

        assert response.status_code == 200
        assert response.json()["ok"] is False


class TestTheFormStillRendersTheFallback:
    def test_the_hardcoded_catalogue_is_offered_before_anything_is_checked(self):
        client = build()

        response = client.get("/console/settings/ai")

        assert response.status_code == 200
        html = response.text

        # Every provider's hardcoded models are still on the page, ready to
        # work with no fetch, no key typed, and no JavaScript at all.
        for key, meta in PROVIDERS.items():
            for model in meta["models"]:
                assert f'data-provider="{key}"' in html
                assert f'value="{model}"' in html and f'data-fallback="1"' in html

        assert "check-key" in html
