"""A site can run its provider on a model of its own.

Before this the drafting, reading and price-note screens all used the
default provider whatever the "Which site uses which" table said; only the
crawl-now button asked for the site's. Now every console AI call for a site
asks for that site's provider, on the site's own model when one is set.
"""

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

import app.console.routes_ai as routes_ai
from app.console.routes_ai import create_ai_routes
from app.db.store import ProviderStore, StoredProvider

OPENAI = (7, "Main", "openai", "sk-main", "gpt-4.1", True, False)
DEFAULT = (1, "Default", "openai", "sk-default", "gpt-4o-mini", True, True)


class FakeConnection:
    def __init__(self, pool):
        self.pool = pool
        self.last = ""

    def execute(self, sql, params=None):
        self.last = " ".join(sql.split())
        self.pool.statements.append((self.last, params))

        return self

    def fetchone(self):
        if self.last.startswith("SELECT ai_provider_id, ai_model FROM console_sites"):
            return self.pool.site

        if "WHERE is_default" in self.last:
            return DEFAULT

        if "FROM console_ai_providers WHERE id" in self.last:
            return self.pool.provider

        return None

    def commit(self):
        pass


class FakePool:
    def __init__(self, site, provider=OPENAI):
        self.site = site
        self.provider = provider
        self.statements = []

    def connection(self):
        pool = self

        class Scope:
            def __enter__(self):
                return FakeConnection(pool)

            def __exit__(self, *args):
                return False

        return Scope()


class TestForSite:
    def test_the_sites_own_model_runs_on_its_provider(self):
        chosen = ProviderStore(FakePool(site=(7, "gpt-4.1-mini"))).for_site("bitumart")

        assert (chosen.id, chosen.api_key, chosen.model) == (7, "sk-main", "gpt-4.1-mini")

    def test_no_model_of_its_own_means_the_providers_model(self):
        chosen = ProviderStore(FakePool(site=(7, None))).for_site("bitumart")

        assert chosen.model == "gpt-4.1"

    def test_a_site_on_the_default_gets_the_default_as_it_is(self):
        chosen = ProviderStore(FakePool(site=(None, None))).for_site("bitumart")

        assert (chosen.id, chosen.model) == (1, "gpt-4o-mini")

    def test_a_turned_off_provider_falls_back_to_the_default_on_its_own_model(self):
        # The site's model belongs to the key it chose; the default is
        # another key that may not run it.
        chosen = ProviderStore(FakePool(site=(7, "gpt-4.1-mini"), provider=None)).for_site("x")

        assert (chosen.id, chosen.model) == (1, "gpt-4o-mini")


class TestAssignToSite:
    def test_the_model_is_stored_with_the_provider(self):
        pool = FakePool(site=None)
        ProviderStore(pool).assign_to_site("bitumart", 7, " gpt-4.1-mini ")

        sql, params = pool.statements[-1]
        assert "ai_model = %s" in sql
        assert params == (7, "gpt-4.1-mini", "bitumart")

    def test_the_default_carries_no_model(self):
        pool = FakePool(site=None)
        ProviderStore(pool).assign_to_site("bitumart", None, "gpt-4.1-mini")

        assert pool.statements[-1][1] == (None, None, "bitumart")


class FakeStore:
    def __init__(self):
        self.recorded = []

    def sites(self):
        return [type("S", (), {"slug": "bitumart", "name": "Bitumart", "enabled": True})()]

    def site_by_slug(self, slug):
        return self.sites()[0] if slug == "bitumart" else None

    def record(self, *args):
        self.recorded.append(args)


class FakeProviders:
    def __init__(self):
        self.assigned = None

    def all(self):
        return [StoredProvider(*OPENAI)]

    def get(self, provider_id):
        return StoredProvider(*OPENAI) if provider_id == 7 else None

    def assignments(self):
        return {"bitumart": 7}

    def site_models(self):
        return {"bitumart": "gpt-4.1-mini"}

    def assign_to_site(self, slug, provider_id, model=None):
        self.assigned = (slug, provider_id, model)


def admin(request=None):
    return type(
        "U", (), {"email": "a@local.test", "name": "A", "is_admin": True, "is_superadmin": True}
    )()


def client_for(providers, store=None):
    app = FastAPI()
    app.include_router(
        create_ai_routes(
            store=store or FakeStore(),
            providers=providers,
            templates=Jinja2Templates(directory="app/templates"),
            current_user=admin,
        )
    )

    return TestClient(app)


class TestTheSiteRow:
    def save(self, monkeypatch, data):
        monkeypatch.setattr(
            routes_ai, "available_models", lambda *a, **k: ["gpt-4.1", "gpt-4.1-mini"]
        )
        providers = FakeProviders()
        response = client_for(providers).post(
            "/console/settings/ai/site/bitumart", data=data, follow_redirects=False
        )

        return response, providers.assigned

    def test_a_model_of_the_sites_own_is_saved(self, monkeypatch):
        response, assigned = self.save(monkeypatch, {"provider_id": "7", "model": "gpt-4.1-mini"})

        assert response.status_code == 303
        assert "ok=" in response.headers["location"]
        assert assigned == ("bitumart", 7, "gpt-4.1-mini")

    def test_the_providers_own_model_is_stored_blank(self, monkeypatch):
        _, assigned = self.save(monkeypatch, {"provider_id": "7", "model": "gpt-4.1"})

        assert assigned == ("bitumart", 7, None)

    def test_a_model_the_key_cannot_run_is_refused(self, monkeypatch):
        response, assigned = self.save(monkeypatch, {"provider_id": "7", "model": "gpt-9"})

        assert "err=" in response.headers["location"]
        assert assigned is None

    def test_the_default_ignores_any_model_sent(self, monkeypatch):
        _, assigned = self.save(monkeypatch, {"provider_id": "", "model": "gpt-4.1-mini"})

        assert assigned == ("bitumart", None, None)

    def test_the_screen_shows_the_sites_model_selected(self, monkeypatch):
        monkeypatch.setattr(
            routes_ai, "available_models", lambda *a, **k: ["gpt-4.1", "gpt-4.1-mini"]
        )
        html = client_for(FakeProviders()).get("/console/settings/ai").text

        assert 'name="model"' in html
        assert 'value="gpt-4.1-mini" data-provider="7"\n                        selected' in html
