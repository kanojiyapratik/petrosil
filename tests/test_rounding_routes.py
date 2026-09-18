"""The Price rules screen's rounding settings: a site-wide default step
("round off closest multiple of 5") and the handful of locations that
override it (Turkey's own-currency price rounds to 10). See
app/editorial/rounding.py for where these are applied.
"""

import re

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

from app.console.routes_rules import create_rules_routes
from app.db.store import LocationRounding, StoredSite

SITE = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://example.test/api", token="t", enabled=True,
    round_to_nearest=5,
)

LOCATIONS = [
    {"title": "Korea TOBS", "latest_price": 1404},
    {"title": "Singapore SN 150", "latest_price": 1560},
]


class FakeStore:
    def __init__(self, site=SITE):
        self.site = site
        self.recorded = []

    def site_by_slug(self, slug):
        return self.site if slug == self.site.slug else None

    def record(self, *args, **kwargs):
        self.recorded.append(args)

    def set_round_to_nearest(self, slug, step):
        self.site = StoredSite(
            db_id=self.site.db_id, slug=self.site.slug, name=self.site.name,
            api_url=self.site.api_url, token=self.site.token, enabled=self.site.enabled,
            editorial_instructions=self.site.editorial_instructions, round_to_nearest=step,
        )


class FakeRules:
    def for_site(self, slug):
        return []


class FakeSiteClient:
    def locations(self):
        return {"data": LOCATIONS}


class FakeRounding:
    def __init__(self, overrides=None):
        self._overrides = list(overrides or [])
        self.set_calls = []
        self.deleted = []

    def for_site(self, slug):
        return {row.location: row.round_to_nearest for row in self._overrides}

    def list_for_site(self, slug):
        return self._overrides

    def set_override(self, slug, location, step):
        self.set_calls.append((slug, location, step))
        self._overrides = [row for row in self._overrides if row.location != location]
        self._overrides.append(
            LocationRounding(id=len(self._overrides) + 1, location=location, round_to_nearest=step)
        )

    def delete(self, site_slug, override_id):
        # Scoped by site now: an override id on its own is not enough, or one
        # site's screen could remove another site's rounding step.
        self.deleted.append(override_id)
        self._overrides = [row for row in self._overrides if row.id != override_id]

        return True


def default_field_value(page: str) -> str:
    """What the site-default rounding input is prefilled with."""
    found = re.search(r'id="round_to_nearest"[\s\S]*?value="([^"]*)"', page)

    return found.group(1) if found else "<missing>"


def build(store=None, rounding=None):
    store = store or FakeStore()
    rounding = rounding if rounding is not None else FakeRounding()
    app = FastAPI()
    app.include_router(
        create_rules_routes(
            store=store,
            rules=FakeRules(),
            templates=Jinja2Templates(directory="app/templates"),
            current_user=lambda request: type(
                "U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True, "is_superadmin": True}
            )(),
            client_factory=lambda site: FakeSiteClient(),
            rounding=rounding,
        )
    )

    return TestClient(app), store, rounding


class TestTheScreenShowsTheCurrentSettings:
    def test_the_site_default_prefills_the_form(self):
        client, _, _ = build()

        page = client.get("/console/sites/baseoil/rules").text

        assert default_field_value(page) in ("5.0", "5")

    def test_a_site_with_no_default_leaves_the_field_blank(self):
        client, _, _ = build(store=FakeStore(site=StoredSite(
            db_id=1, slug="baseoil", name="Base Oil Report",
            api_url="https://example.test/api", token="t", enabled=True,
        )))

        page = client.get("/console/sites/baseoil/rules").text

        assert default_field_value(page) == ""

    def test_existing_overrides_are_listed(self):
        overrides = [LocationRounding(id=9, location="Turkey Domestic", round_to_nearest=10)]
        client, _, _ = build(rounding=FakeRounding(overrides))

        page = client.get("/console/sites/baseoil/rules").text

        assert "Turkey Domestic" in page
        assert "/rounding/override/9/delete" in page


class TestSavingTheSiteDefault:
    def test_saves_the_typed_step(self):
        client, store, _ = build()

        response = client.post(
            "/console/sites/baseoil/rounding",
            data={"round_to_nearest": "5"},
            follow_redirects=False,
        )

        assert store.site.round_to_nearest == 5.0
        assert "ok=" in response.headers["location"]

    def test_a_blank_step_clears_rounding(self):
        client, store, _ = build()

        client.post(
            "/console/sites/baseoil/rounding", data={"round_to_nearest": ""},
            follow_redirects=False,
        )

        assert store.site.round_to_nearest is None

    def test_a_non_numeric_step_is_refused(self):
        client, store, _ = build()

        response = client.post(
            "/console/sites/baseoil/rounding", data={"round_to_nearest": "banana"},
            follow_redirects=False,
        )

        assert store.site.round_to_nearest == 5  # unchanged
        assert "err=" in response.headers["location"]

    def test_a_zero_or_negative_step_is_refused(self):
        client, store, _ = build()

        response = client.post(
            "/console/sites/baseoil/rounding", data={"round_to_nearest": "0"},
            follow_redirects=False,
        )

        assert store.site.round_to_nearest == 5
        assert "err=" in response.headers["location"]


class TestSavingALocationOverride:
    def test_saves_the_override(self):
        client, _, rounding = build()

        response = client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "round_to_nearest": "10"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 10.0)]
        assert "ok=" in response.headers["location"]

    def test_a_missing_location_is_refused(self):
        client, _, rounding = build()

        response = client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "", "round_to_nearest": "10"},
            follow_redirects=False,
        )

        assert rounding.set_calls == []
        assert "err=" in response.headers["location"]

    def test_a_blank_step_is_refused_rather_than_silently_doing_nothing(self):
        client, _, rounding = build()

        response = client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "round_to_nearest": ""},
            follow_redirects=False,
        )

        assert rounding.set_calls == []
        assert "err=" in response.headers["location"]


class TestRemovingALocationOverride:
    def test_deletes_the_override(self):
        overrides = [LocationRounding(id=9, location="Turkey Domestic", round_to_nearest=10)]
        client, _, rounding = build(rounding=FakeRounding(overrides))

        response = client.post(
            "/console/sites/baseoil/rounding/override/9/delete", follow_redirects=False
        )

        assert rounding.deleted == [9]
        assert "ok=" in response.headers["location"]
