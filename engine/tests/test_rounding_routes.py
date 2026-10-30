"""The Price rules screen's rounding settings: a site-wide default step
("round off closest multiple of 5") and the handful of locations that
override it (Turkey's own-currency price rounds to 10). See
app/editorial/rounding.py for where these are applied.
"""

import dataclasses
import re
from urllib.parse import unquote

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

    def set_round_to_nearest(self, slug, step, direction="nearest"):
        self.site = StoredSite(
            db_id=self.site.db_id, slug=self.site.slug, name=self.site.name,
            api_url=self.site.api_url, token=self.site.token, enabled=self.site.enabled,
            editorial_instructions=self.site.editorial_instructions, round_to_nearest=step,
            round_direction=direction,
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
        return {row.location: (row.round_to_nearest, row.direction) for row in self._overrides}

    def list_for_site(self, slug):
        return self._overrides

    def set_override(self, slug, location, step, direction="nearest", as_printed=False):
        self.set_calls.append((slug, location, step, direction, as_printed))
        self._overrides = [row for row in self._overrides if row.location != location]
        self._overrides.append(
            LocationRounding(
                id=len(self._overrides) + 1, location=location, round_to_nearest=step,
                direction=direction, as_printed=as_printed,
            )
        )

    def as_printed_for_site(self, slug):
        return {row.location for row in self._overrides if row.as_printed}

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

    def test_an_exempt_location_says_so_instead_of_showing_a_zero(self):
        overrides = [LocationRounding(id=9, location="Indonesia (Rack)", round_to_nearest=0.0)]
        client, _, _ = build(rounding=FakeRounding(overrides))

        page = client.get("/console/sites/baseoil/rules").text

        assert "Never rounded — used exactly as it is" in page
        # Edit opens on the checkbox, not on a step of "0": the box is
        # ticked and the step field is greyed out.
        editor = page.split('data-rounding-edit="9"')[1]

        assert "data-row-exact" in editor
        assert re.search(r'data-row-exact[\s\S]{0,60}checked', editor)
        assert re.search(r'name="round_to_nearest"[\s\S]{0,160}disabled', editor)


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

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 10.0, "nearest", False)]
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

    def test_use_exactly_as_it_is_saves_a_step_of_zero(self):
        client, _, rounding = build()

        response = client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "exact": "1"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 0.0, "nearest", False)]
        assert "ok=" in response.headers["location"]
        assert "exactly as it is" in unquote(response.headers["location"])

    def test_the_exact_choice_wins_over_a_typed_step(self):
        # Ticking the box while a number sits in the (disabled) field must
        # not round after all -- the tick is the editor's last word.
        client, _, rounding = build()

        client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "round_to_nearest": "10", "exact": "1"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 0.0, "nearest", False)]

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


class CurrencyClient:
    def locations(self):
        return {"data": [
            {"title": "BPCL BITUMEN - VG 10 (bulk)", "latest_price": None, "currency": "INR"},
            {"title": "Turkey Domestic EUR", "latest_price": 850, "currency": "EUR"},
            {"title": "Japan FOB", "latest_price": 600, "currency": "USD"},
        ]}


def build_with_currencies(rounding=None, site=SITE):
    rounding = rounding if rounding is not None else FakeRounding()
    store = FakeStore(site)
    app = FastAPI()
    app.include_router(
        create_rules_routes(
            store=store,
            rules=FakeRules(),
            templates=Jinja2Templates(directory="app/templates"),
            current_user=lambda request: type(
                "U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True, "is_superadmin": True}
            )(),
            client_factory=lambda site: CurrencyClient(),
            rounding=rounding,
        )
    )

    return TestClient(app), store, rounding


class TestAStepIsWrittenTheWayAPersonWritesIt:
    """"1.0" beside a rupee price means nothing to an editor. The step is
    in the price's own currency, so it says so: Rs 1, EUR 10, $5."""

    def test_an_override_shows_its_currency_and_no_trailing_zero(self):
        overrides = [
            LocationRounding(id=1, location="BPCL BITUMEN - VG 10 (bulk)", round_to_nearest=1.0),
            LocationRounding(id=2, location="Turkey Domestic EUR", round_to_nearest=10.0),
            LocationRounding(id=3, location="Japan FOB", round_to_nearest=5.0),
        ]
        client, _, _ = build_with_currencies(FakeRounding(overrides))

        page = client.get("/console/sites/baseoil/rules").text

        assert "to the nearest ₹1" in page
        assert "to the nearest €10" in page
        assert "to the nearest $5" in page
        assert ">1.0<" not in page

    def test_the_site_default_field_has_no_trailing_zero(self):
        # The database hands back 5.0, which the field showed as "5.0".
        client, _, _ = build_with_currencies(site=dataclasses.replace(SITE, round_to_nearest=5.0))

        page = client.get("/console/sites/baseoil/rules").text

        assert default_field_value(page) == "5"

    def test_saving_an_override_says_the_currency(self):
        client, _, _ = build_with_currencies()

        response = client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "BPCL BITUMEN - VG 10 (bulk)", "round_to_nearest": "1"},
            follow_redirects=False,
        )

        assert "₹1" in unquote(response.headers["location"])
        assert "1.0" not in unquote(response.headers["location"])

    def test_a_location_with_no_currency_shows_the_plain_number(self):
        overrides = [LocationRounding(id=9, location="Korea TOBS", round_to_nearest=10.0)]
        client, _, _ = build(rounding=FakeRounding(overrides))

        page = client.get("/console/sites/baseoil/rules").text

        assert "to the nearest 10" in page


class TestEveryRowIsEditedInPlace:
    """The list sits at the bottom of a long screen, so Edit opens a form in
    the row itself rather than scrolling the editor back up to the one at
    the top and taking the line they are changing off the screen."""

    def test_each_rounding_step_has_its_own_editor_carrying_its_values(self):
        overrides = [
            LocationRounding(id=1, location="BPCL BITUMEN - VG 10 (bulk)", round_to_nearest=1.0),
            LocationRounding(
                id=2, location="Turkey Domestic EUR", round_to_nearest=10.0, direction="up"
            ),
        ]
        client, _, _ = build_with_currencies(FakeRounding(overrides))

        page = client.get("/console/sites/baseoil/rules").text

        assert page.count('type="button" data-edit-rounding') == 2
        assert 'data-rounding-edit="1"' in page
        assert 'data-rounding-edit="2"' in page
        # Each editor posts the row's own location, so nothing depends on the
        # dropdown above still listing a title the site has since renamed.
        assert '<input type="hidden" name="location" value="BPCL BITUMEN - VG 10 (bulk)">' in page
        assert 'value="1"' in page
        assert 'value="10"' in page

    def test_an_editor_opens_on_the_direction_the_row_already_has(self):
        overrides = [
            LocationRounding(
                id=2, location="Turkey Domestic EUR", round_to_nearest=10.0, direction="up"
            ),
        ]
        client, _, _ = build_with_currencies(FakeRounding(overrides))

        page = client.get("/console/sites/baseoil/rules").text
        editor = page.split('data-rounding-edit="2"')[1]

        assert re.search(r'value="up"[\s\S]{0,60}checked', editor)
        assert "up to the next €10" in page


class TestSavingWhichWayAPriceRounds:
    """"Nearest" stays the default everywhere, so a form that does not name
    a direction -- an old bookmark, a script -- keeps today's behaviour."""

    def test_the_site_default_remembers_the_direction(self):
        client, store, _ = build()

        client.post(
            "/console/sites/baseoil/rounding",
            data={"round_to_nearest": "5", "direction": "up"},
            follow_redirects=False,
        )

        assert store.site.round_to_nearest == 5.0
        assert store.site.round_direction == "up"

    def test_the_site_default_says_which_way_it_now_rounds(self):
        client, _, _ = build()

        response = client.post(
            "/console/sites/baseoil/rounding",
            data={"round_to_nearest": "5", "direction": "down"},
            follow_redirects=False,
        )

        assert "down to the previous 5" in unquote(response.headers["location"])

    def test_a_missing_direction_means_nearest(self):
        client, store, _ = build()

        client.post(
            "/console/sites/baseoil/rounding", data={"round_to_nearest": "5"},
            follow_redirects=False,
        )

        assert store.site.round_direction == "nearest"

    def test_an_override_remembers_its_direction(self):
        client, _, rounding = build()

        client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "round_to_nearest": "10", "direction": "down"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 10.0, "down", False)]

    def test_an_override_says_which_way_it_now_rounds(self):
        client, _, _ = build_with_currencies()

        response = client.post(
            "/console/sites/baseoil/rounding/override",
            data={
                "location": "BPCL BITUMEN - VG 10 (bulk)", "round_to_nearest": "1",
                "direction": "up",
            },
            follow_redirects=False,
        )

        assert "up to the next ₹1" in unquote(response.headers["location"])

    def test_a_junk_direction_falls_back_to_nearest_rather_than_being_stored(self):
        client, _, rounding = build()

        client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "round_to_nearest": "10", "direction": "sideways"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 10.0, "nearest", False)]

    def test_never_rounded_keeps_a_direction_that_means_nothing_out_of_the_way(self):
        # A step of 0 is "use it exactly as it is": there is no direction to
        # choose, so one is never stored against it.
        client, _, rounding = build()

        client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "exact": "1", "direction": "up"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 0.0, "nearest", False)]

    def test_the_screen_offers_all_three_ways_on_both_forms(self):
        client, _, _ = build()

        page = client.get("/console/sites/baseoil/rules").text

        assert page.count('name="direction" value="up"') >= 2
        assert page.count('name="direction" value="down"') >= 2
        assert page.count('name="direction" value="nearest"') >= 2


class TestTakingAFigureAsPrinted:
    """UK South: Argus marks that row £/t and the client's published euro
    price is that same number unconverted. The model reads the report
    correctly when it says GBP, so the exception is the editor's to declare
    -- a tick against the location, honoured by app/editorial/fx.py, after
    two runs of instructions worded "with currency EUR" came back converted
    anyway.
    """

    def test_the_form_offers_it(self):
        client, _, _ = build()

        page = client.get("/console/sites/baseoil/rules").text

        assert 'name="as_printed"' in page
        assert "never convert it" in page

    def test_ticking_it_saves_it_against_the_location(self):
        client, _, rounding = build()

        response = client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "round_to_nearest": "5", "as_printed": "1"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 5.0, "nearest", True)]
        assert "as printed" in unquote(response.headers["location"])

    def test_it_can_be_had_with_no_rounding_at_all(self):
        # The two are independent: Indonesia is "never rounded" and does
        # convert; UK South rounds to 5 and does not convert.
        client, _, rounding = build()

        client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "exact": "1", "as_printed": "1"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 0.0, "nearest", True)]

    def test_leaving_it_unticked_turns_it_off_again(self):
        client, _, rounding = build(rounding=FakeRounding([
            LocationRounding(id=1, location="Korea TOBS", round_to_nearest=5.0,
                             as_printed=True),
        ]))

        client.post(
            "/console/sites/baseoil/rounding/override",
            data={"location": "Korea TOBS", "round_to_nearest": "5"},
            follow_redirects=False,
        )

        assert rounding.set_calls == [("baseoil", "Korea TOBS", 5.0, "nearest", False)]
        assert rounding.as_printed_for_site("baseoil") == set()

    def test_a_location_already_set_opens_with_the_box_ticked(self):
        client, _, _ = build(rounding=FakeRounding([
            LocationRounding(id=1, location="Korea TOBS", round_to_nearest=5.0,
                             as_printed=True),
        ]))

        page = client.get("/console/sites/baseoil/rules").text
        editor = page.split('data-rounding-edit="1"')[1]

        assert re.search(r"data-row-as-printed\s+checked", editor), (
            "the row's editor opens with the box clear, so saving any other "
            "change on that row would quietly turn the setting off"
        )

    def test_the_list_says_which_locations_are_set(self):
        client, _, _ = build(rounding=FakeRounding([
            LocationRounding(id=1, location="Korea TOBS", round_to_nearest=5.0,
                             as_printed=True),
        ]))

        page = client.get("/console/sites/baseoil/rules").text

        assert "taken as printed, never converted" in page
