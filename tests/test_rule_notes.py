"""The Price rules screen says what it already knows about a location.

Both fields on that screen used to be blind. Picking a location that is
already calculated replaces its rule without warning, and typing a location
that other rules are calculated FROM moves all of them. The ⓘ in each list
is the flag; these tests hold the sentences behind it.
"""

import json
import re
from urllib.parse import unquote

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

from app.console.routes_rules import build_rule_notes, create_rules_routes
from app.db.store import StoredSite
from app.editorial.rules import PriceRule

SITE = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://example.test/api", token="t", enabled=True,
)

LOCATIONS = [
    {"title": "Korea TOBS", "latest_price": 1404},
    {"title": "Singapore SN 150", "latest_price": 1560},
    {"title": "Saudi SN 500", "latest_price": 1200},
    {"title": "Europe FOB SN 150", "latest_price": 1100},
]


def rule(derived, reference, pct, enabled=True, rule_id=1):
    return PriceRule(
        id=rule_id, derived_location=derived, reference_location=reference,
        adjustment_value=pct, enabled=enabled,
    )


class TestPickingTheLocationThatIsBeingCalculated:
    def test_a_location_that_already_has_a_rule_warns_that_saving_replaces_it(self):
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS
        )["Korea TOBS"]["derived"]

        assert note["tone"] == "warn"
        assert note["title"] == "This price already has a rule"
        assert "Singapore SN 150 -10%" in note["detail"]
        assert "If you save, that is replaced" in note["detail"]

    def test_a_rule_that_is_turned_off_says_it_stays_off(self):
        # rules.create() rewrites the formula and never touches `enabled`, so
        # saving over a disabled rule leaves it disabled -- which reads as
        # "my rule did nothing" unless the screen says so.
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10, enabled=False)], LOCATIONS
        )["Korea TOBS"]

        assert "switched off" in note["derived"]["title"]
        assert "stays switched off until you turn it on" in note["derived"]["detail"]
        assert note["summary"].endswith("(switched off)")

    def test_picking_a_benchmark_warns_that_a_rule_there_moves_everything_below_it(self):
        # The engine chains rules to a fixpoint, so a rule on Singapore moves
        # Korea too. That is the whole reason to show this.
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS
        )["Singapore SN 150"]["derived"]

        assert note["title"] == "Other prices are worked out from this one"
        assert "Korea TOBS -10%" in note["detail"]
        assert "those prices change too" in note["detail"]

    def test_a_location_no_rule_touches_says_this_would_be_its_first(self):
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS
        )["Europe FOB SN 150"]["derived"]

        assert note["tone"] == "mute"
        assert note["title"] == "No rule yet"
        assert "first rule" in note["detail"]


class TestPickingWhatItIsCalculatedFrom:
    def test_a_source_says_how_many_rules_hang_off_it_and_which(self):
        note = build_rule_notes(
            [
                rule("Korea TOBS", "Singapore SN 150", -10, rule_id=1),
                rule("Saudi SN 500", "Singapore SN 150", 3, rule_id=2),
            ],
            LOCATIONS,
        )["Singapore SN 150"]["reference"]

        assert note["title"] == "2 rules already come from this price"
        assert "Korea TOBS -10%" in note["detail"]
        assert "Saudi SN 500 +3%" in note["detail"]

    def test_a_long_list_of_dependents_is_counted_rather_than_recited(self):
        rules = [
            rule(f"Location {n}", "Singapore SN 150", -n, rule_id=n) for n in range(1, 7)
        ]
        note = build_rule_notes(rules, LOCATIONS)["Singapore SN 150"]["reference"]

        assert "and 3 more" in note["detail"]

    def test_a_source_that_is_itself_calculated_says_the_rule_would_chain(self):
        note = build_rule_notes(
            [
                rule("Singapore SN 150", "Report: FOB Asia SN 150", -1, rule_id=1),
                rule("Korea TOBS", "Singapore SN 150", -10, rule_id=2),
            ],
            LOCATIONS,
        )["Singapore SN 150"]["reference"]

        assert "itself worked out from Report: FOB Asia SN 150 -1%" in note["detail"]
        assert "follows on from that" in note["detail"]

    def test_a_calculated_location_nothing_hangs_off_still_says_it_would_chain(self):
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS
        )["Korea TOBS"]["reference"]

        assert note["title"] == "This price is itself worked out from another"
        assert "follows on from that" in note["detail"]

    def test_a_benchmark_that_is_not_a_site_location_still_gets_a_note(self):
        # "Report: FOB Asia SN 150" is typed, never picked, so it is not in
        # `locations` -- but the line under the field must still appear.
        note = build_rule_notes(
            [rule("Singapore SN 150", "Report: FOB Asia SN 150", -1)], LOCATIONS
        )["Report: FOB Asia SN 150"]["reference"]

        assert note["title"] == "1 rule already comes from this price"


class TestTheMarkInTheDropdown:
    def test_the_summary_line_carries_the_formula(self):
        notes = build_rule_notes([rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS)

        assert notes["Korea TOBS"]["summary"] == "calculated from Singapore SN 150 -10%"
        assert notes["Korea TOBS"]["flag"] == "rule"

    def test_a_location_that_is_both_calculated_and_a_source_says_both(self):
        notes = build_rule_notes(
            [
                rule("Singapore SN 150", "Report: FOB Asia SN 150", -1, rule_id=1),
                rule("Korea TOBS", "Singapore SN 150", -10, rule_id=2),
            ],
            LOCATIONS,
        )

        assert notes["Singapore SN 150"]["flag"] == "both"
        assert notes["Singapore SN 150"]["summary"] == (
            "calculated from Report: FOB Asia SN 150 -1% · source for 1 rule"
        )

    def test_an_untouched_location_is_left_unflagged_so_the_marks_stand_out(self):
        notes = build_rule_notes([rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS)

        assert notes["Europe FOB SN 150"]["flag"] == ""
        assert notes["Europe FOB SN 150"]["summary"] == ""


class FakeStore:
    def site_by_slug(self, slug):
        return SITE if slug == SITE.slug else None

    def record(self, *args, **kwargs):
        pass


class FakeRules:
    def __init__(self, rules):
        self._rules = rules

    def for_site(self, slug):
        return self._rules


class FakeSiteClient:
    def locations(self):
        return {"data": LOCATIONS}


def screen(rules):
    app = FastAPI()
    app.include_router(
        create_rules_routes(
            store=FakeStore(),
            rules=FakeRules(rules),
            templates=Jinja2Templates(directory="app/templates"),
            current_user=lambda request: type(
                "U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True, "is_superadmin": True}
            )(),
            client_factory=lambda site: FakeSiteClient(),
        )
    )

    return TestClient(app).get("/console/sites/baseoil/rules")


def payload(page, name):
    """The JSON the page hands its dropdowns."""
    found = re.search(r"var " + name + r" = (.+);\n", page)

    return json.loads(found.group(1))


class TestTheScreenItself:
    def test_both_fields_are_the_same_control(self):
        page = screen([rule("Korea TOBS", "Singapore SN 150", -10)]).text

        assert page.count('class="combo-field"') == 2
        assert 'data-combo="derived"' in page
        assert 'data-combo="reference"' in page
        # The old mismatched pair: a dropdown on the left, a text box on the right.
        assert "<select id=\"derived" not in page
        assert "<datalist id=" not in page

    def test_the_form_still_posts_the_two_names_the_route_reads(self):
        page = screen([rule("Korea TOBS", "Singapore SN 150", -10)]).text

        assert 'name="derived_location"' in page
        assert 'name="reference_location"' in page

    def test_every_note_reaches_the_page(self):
        page = screen([rule("Korea TOBS", "Singapore SN 150", -10)]).text
        notes = payload(page, "NOTES")

        assert notes["Korea TOBS"]["summary"] == "calculated from Singapore SN 150 -10%"
        assert notes["Singapore SN 150"]["derived"]["title"] == (
            "Other prices are worked out from this one"
        )

    def test_the_report_figures_already_in_use_are_offered_back(self):
        page = screen([rule("Singapore SN 150", "Report: FOB Asia SN 150", -1)]).text

        assert payload(page, "BENCHMARKS") == ["Report: FOB Asia SN 150"]
        assert "Korea TOBS" in payload(page, "LOCATIONS")

    def test_the_screen_still_renders_when_the_site_has_no_rules_at_all(self):
        page = screen([])

        assert page.status_code == 200
        assert payload(page.text, "BENCHMARKS") == []
        assert all(note["flag"] == "" for note in payload(page.text, "NOTES").values())


class TestAReferenceThatMatchesNothing:
    """A reference is resolved by exact name, so a name that is neither a live
    location nor a "Report:" figure quietly stops every rule under it. Three
    baseoil Bright Stock rules had been dead this way; the screen now says so.
    """

    def test_a_reference_that_is_neither_a_location_nor_a_report_figure_is_flagged(self):
        note = build_rule_notes(
            [
                rule("Europe Bright Stock", "Europe Domestic Bright Stock FOB", -8, rule_id=1),
                rule("China Bright Stock", "Europe Domestic Bright Stock FOB", -15, rule_id=2),
            ],
            LOCATIONS,
        )["Europe Domestic Bright Stock FOB"]

        assert note["orphan"] is True
        assert note["reference"]["tone"] == "warn"
        assert note["reference"]["title"] == "No price has this name"
        assert "none of them work" in note["reference"]["detail"]

    def test_a_report_figure_is_not_flagged(self):
        note = build_rule_notes(
            [rule("Singapore SN 150", "Report: FOB Asia SN 150", -1)], LOCATIONS
        )["Report: FOB Asia SN 150"]

        assert note["orphan"] is False
        assert note["reference"]["tone"] == "info"

    def test_a_live_location_is_not_flagged(self):
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS
        )["Singapore SN 150"]

        assert note["orphan"] is False

    def test_a_name_nothing_is_calculated_from_is_not_flagged(self):
        # An unused name is not broken, it is just unused.
        note = build_rule_notes([], LOCATIONS)["Korea TOBS"]

        assert note["orphan"] is False


class RecordingRules(FakeRules):
    def __init__(self):
        super().__init__([])
        self.created = []

    def create(self, slug, derived, reference, value, kind="percent"):
        self.created.append((derived, reference, value, kind))


class CurrencySiteClient:
    """A site whose location list says which currency each is priced in."""

    def __init__(self, locations):
        self._locations = locations

    def locations(self):
        return {"data": self._locations}


def save(locations=None, **fields):
    store = RecordingRules()
    app = FastAPI()
    app.include_router(
        create_rules_routes(
            store=FakeStore(),
            rules=store,
            templates=Jinja2Templates(directory="app/templates"),
            current_user=lambda request: type(
                "U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True, "is_superadmin": True}
            )(),
            client_factory=lambda site: (
                CurrencySiteClient(locations) if locations is not None else FakeSiteClient()
            ),
        )
    )
    form = {
        "derived_location": "Korea TOBS",
        "reference_location": "Singapore SN 150",
        "adjustment_value": "-10",
    }
    form.update(fields)
    response = TestClient(app).post(
        "/console/sites/baseoil/rules", data=form, follow_redirects=False
    )

    return store, response


class TestSavingARuleInDollarsOrPercent:
    def test_percent_is_what_a_rule_is_unless_dollars_are_chosen(self):
        store, response = save()

        assert store.created == [("Korea TOBS", "Singapore SN 150", -10.0, "percent")]
        assert "ok=" in response.headers["location"]

    def test_a_dollar_rule_is_stored_as_one(self):
        store, response = save(adjustment_value="-25", adjustment_kind="usd")

        assert store.created == [("Korea TOBS", "Singapore SN 150", -25.0, "usd")]
        assert "-25%20USD" in response.headers["location"]

    def test_the_percent_bound_does_not_apply_to_dollars(self):
        # -250 is a nonsense percentage and an ordinary dollar difference.
        store, _ = save(adjustment_value="-250", adjustment_kind="usd")

        assert store.created == [("Korea TOBS", "Singapore SN 150", -250.0, "usd")]

    def test_a_percentage_past_the_bound_is_still_refused(self):
        store, response = save(adjustment_value="-250")

        assert store.created == []
        assert "err=" in response.headers["location"]

    def test_a_conversion_at_a_fixed_rate_is_accepted(self):
        # The client's Turkey rule: the lira price divided by 29, which is
        # -96.5517%. The old -95 floor refused it outright.
        store, response = save(adjustment_value="-96.5517")

        assert store.created == [("Korea TOBS", "Singapore SN 150", -96.5517, "percent")]
        assert "ok=" in response.headers["location"]

    def test_minus_one_hundred_percent_is_refused(self):
        # At -100 the price is nothing, which is not a price.
        store, response = save(adjustment_value="-100")

        assert store.created == []
        assert "err=" in response.headers["location"]

    def test_a_slipped_decimal_point_in_dollars_is_refused(self):
        store, response = save(adjustment_value="-250000", adjustment_kind="usd")

        assert store.created == []
        assert "err=" in response.headers["location"]

    def test_a_euro_rule_is_stored_as_one(self):
        store, response = save(adjustment_value="5", adjustment_kind="eur")

        assert store.created == [("Korea TOBS", "Singapore SN 150", 5.0, "eur")]
        assert "ok=" in response.headers["location"]

    def test_a_rupee_rule_is_stored_as_one(self):
        # Packed over bulk runs to five figures in rupees -- 86,900 against
        # 75,100 -- which the dollar typo-catch would refuse.
        store, response = save(adjustment_value="11800", adjustment_kind="inr")

        assert store.created == [("Korea TOBS", "Singapore SN 150", 11800.0, "inr")]

    def test_a_slipped_decimal_point_in_rupees_is_still_refused(self):
        store, response = save(adjustment_value="1180000", adjustment_kind="inr")

        assert store.created == []
        assert "err=" in response.headers["location"]

    def test_a_fixed_amount_must_be_in_the_prices_own_currency(self):
        # Brussels is priced in euros; "+5 US dollars" on it would be staged
        # as five euros. The screen says so rather than storing it.
        store, response = save(
            locations=[
                {"title": "Korea TOBS", "latest_price": 525, "currency": "EUR"},
                {"title": "Singapore SN 150", "latest_price": 520, "currency": "EUR"},
            ],
            adjustment_value="5", adjustment_kind="usd",
        )

        assert store.created == []
        assert "err=" in response.headers["location"]
        assert "EUR" in unquote(response.headers["location"])

    def test_the_matching_currency_is_accepted(self):
        store, _ = save(
            locations=[
                {"title": "Korea TOBS", "latest_price": 525, "currency": "EUR"},
                {"title": "Singapore SN 150", "latest_price": 520, "currency": "EUR"},
            ],
            adjustment_value="5", adjustment_kind="eur",
        )

        assert store.created == [("Korea TOBS", "Singapore SN 150", 5.0, "eur")]

    def test_a_site_that_names_no_currency_accepts_dollars_as_before(self):
        store, _ = save(adjustment_value="-25", adjustment_kind="usd")

        assert store.created == [("Korea TOBS", "Singapore SN 150", -25.0, "usd")]

    def test_an_unknown_unit_is_treated_as_a_percentage_not_as_dollars(self):
        # The safe reading: percentages are what every stored rule is.
        store, _ = save(adjustment_kind="bananas")

        assert store.created[0][3] == "percent"


class TestTheWorkedExample:
    """The screen does the sum in front of the person rather than explaining
    what a percentage or a dollar difference is. That needs today's prices.
    """

    def test_the_latest_price_of_every_location_reaches_the_page(self):
        page = screen([rule("Korea TOBS", "Singapore SN 150", -10)]).text

        assert payload(page, "PRICES")["Singapore SN 150"] == 1560

    def test_the_unit_can_be_euros_or_rupees_as_well_as_dollars(self):
        page = screen([]).text

        for value in ("percent", "usd", "eur", "inr"):
            assert f'<option value="{value}"' in page

    def test_each_locations_currency_reaches_the_page(self):
        class Priced(FakeSiteClient):
            def locations(self):
                return {"data": [
                    {"title": "Brussels Domestic", "latest_price": 525, "currency": "EUR"},
                    {"title": "BPCL BITUMEN - VG 10 (bulk)", "latest_price": None,
                     "currency": "INR"},
                ]}

        app = FastAPI()
        app.include_router(
            create_rules_routes(
                store=FakeStore(),
                rules=FakeRules([]),
                templates=Jinja2Templates(directory="app/templates"),
                current_user=lambda request: type(
                    "U", (), {"email": "a@b.test", "name": "A", "is_admin": True, "is_superadmin": True}
                )(),
                client_factory=lambda site: Priced(),
            )
        )
        page = TestClient(app).get("/console/sites/baseoil/rules").text

        assert payload(page, "CURRENCIES") == {
            "Brussels Domestic": "EUR", "BPCL BITUMEN - VG 10 (bulk)": "INR",
        }

    def test_a_location_with_no_price_yet_is_simply_absent(self):
        # A newly imported location has none, and "undefined" arithmetic would
        # put "NaN" on the screen.
        class Unpriced(FakeSiteClient):
            def locations(self):
                return {"data": [{"title": "New Place", "latest_price": None}]}

        app = FastAPI()
        app.include_router(
            create_rules_routes(
                store=FakeStore(),
                rules=FakeRules([]),
                templates=Jinja2Templates(directory="app/templates"),
                current_user=lambda request: type(
                    "U", (), {"email": "a@b.test", "name": "A", "is_admin": True, "is_superadmin": True}
                )(),
                client_factory=lambda site: Unpriced(),
            )
        )
        page = TestClient(app).get("/console/sites/baseoil/rules").text

        assert payload(page, "PRICES") == {}
        assert "New Place" in payload(page, "LOCATIONS")


class TestEveryRuleHasAnEditButton:
    def test_each_rule_offers_edit_with_its_values(self):
        stored = [
            PriceRule(id=1, derived_location="Korea TOBS", reference_location="Singapore SN 150",
                      adjustment_value=-96.5517, adjustment_kind="percent"),
            PriceRule(id=2, derived_location="Saudi SN 500", reference_location="Europe FOB SN 150",
                      adjustment_value=5.0, adjustment_kind="eur"),
        ]

        page = screen(stored).text

        assert page.count("type=\"button\" data-edit-rule") == 2
        assert 'data-derived="Korea TOBS"' in page
        assert 'data-reference="Singapore SN 150"' in page
        assert 'data-value="-96.5517"' in page
        assert 'data-value="5"' in page
        assert 'data-kind="eur"' in page
