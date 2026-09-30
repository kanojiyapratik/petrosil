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
    return type("U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True, "is_superadmin": True})()


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


class TestAddingAProviderWithoutPickingAModel:
    """The add form asks no model; it is changed on the provider's row."""

    def added(self, monkeypatch, live):
        monkeypatch.setattr(routes_ai, "available_models", lambda *a, **k: live)
        saved = {}
        providers = FakeProviders()

        def create(**kwargs):
            saved.update(kwargs)

            return type("P", (), {"name": kwargs["name"]})()

        providers.create = create
        response = build(providers=providers).post(
            "/console/settings/ai",
            data={"name": "Main", "provider": "openai", "api_key": "sk-new"},
            follow_redirects=False,
        )

        return response, saved

    def test_the_form_has_no_model_field_and_starts_closed(self):
        html = build().get("/console/settings/ai").text

        assert 'id="model"' not in html
        assert 'id="add-provider" hidden' in html
        assert 'id="add-provider-open"' in html

    def test_it_starts_on_the_providers_usual_model(self, monkeypatch):
        usual = PROVIDERS["openai"]["models"][0]
        response, saved = self.added(monkeypatch, ["gpt-5.5", usual])

        assert response.status_code == 303
        assert saved["model"] == usual

    def test_a_key_that_cannot_run_the_usual_model_starts_on_its_first(self, monkeypatch):
        _, saved = self.added(monkeypatch, ["gpt-5.5", "gpt-5-mini"])

        assert saved["model"] == "gpt-5.5"

    def test_with_no_answer_from_the_provider_it_uses_the_catalogue(self, monkeypatch):
        _, saved = self.added(monkeypatch, [])

        assert saved["model"] == PROVIDERS["openai"]["models"][0]


class TestAKeyPastedOutOfAChatMessage:
    """A long key wrapped by the app it was copied from arrives broken.

    .strip() only trims the ends, so a newline in the middle saved cleanly,
    masked identically on screen (four characters at each end) and was
    rejected by the provider with nothing on screen to explain it. This cost
    a real afternoon on the production console.
    """

    def test_a_newline_in_the_middle_is_taken_out(self):
        from app.console.routes_ai import clean_key

        assert clean_key("sk-proj-abc\ndef") == "sk-proj-abcdef"

    def test_spaces_anywhere_are_taken_out(self):
        from app.console.routes_ai import clean_key

        assert clean_key("  sk-proj abc \r\n def  ") == "sk-projabcdef"

    def test_a_clean_key_is_left_exactly_as_it_is(self):
        from app.console.routes_ai import clean_key

        assert clean_key("sk-proj-Abc_123-xyz") == "sk-proj-Abc_123-xyz"

    def test_nothing_at_all_is_an_empty_key_not_a_crash(self):
        from app.console.routes_ai import clean_key

        assert clean_key(None) == ""




class FakeProvidersWithRow(FakeProviders):
    def __init__(self, row):
        super().__init__([row])
        self._row = row

    def get(self, provider_id):
        return self._row if provider_id == self._row.id else None


def a_provider():
    return type(
        "P", (), {
            "id": 1, "name": "AI1", "provider": "openai", "api_key": "sk-proj-REAL-KEY-VALUE",
            "model": "gpt-4.1", "enabled": True, "is_default": True,
            "masked_key": "sk-p••••ALUE",
        },
    )()


def plain_user(request=None):
    return type("U", (), {"email": "ed@local.test", "name": "Ed", "is_admin": False, "is_superadmin": False})()


class TestSeeingAStoredKey:
    """A mask shows four characters at each end, which every key of a provider
    shares -- so "is this the same key that works elsewhere?" was unanswerable,
    and a production key differing only in the middle cost a real afternoon."""

    def test_an_administrator_can_ask_for_the_whole_key(self):
        client = build(providers=FakeProvidersWithRow(a_provider()))

        answer = client.post("/console/settings/ai/1/reveal").json()

        assert answer["ok"] is True
        assert answer["api_key"] == "sk-proj-REAL-KEY-VALUE"

    def test_looking_at_a_key_is_written_to_the_audit_trail(self):
        store = FakeStore()
        client = build(providers=FakeProvidersWithRow(a_provider()), store=store)

        client.post("/console/settings/ai/1/reveal")

        assert any("revealed an AI provider key" in str(entry) for entry in store.recorded)

    def test_someone_who_is_not_an_administrator_is_refused(self):
        client = build(current_user=plain_user, providers=FakeProvidersWithRow(a_provider()))

        assert client.post("/console/settings/ai/1/reveal").status_code == 403

    def test_an_unknown_provider_is_a_clean_404(self):
        client = build(providers=FakeProvidersWithRow(a_provider()))

        assert client.post("/console/settings/ai/999/reveal").status_code == 404
