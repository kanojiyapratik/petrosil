"""The Price rules screen says what it already knows about a location.

Both fields on that screen used to be blind. Picking a location that is
already calculated replaces its rule without warning, and typing a location
that other rules are calculated FROM moves all of them. The ⓘ in each list
is the flag; these tests hold the sentences behind it.
"""

import json
import re

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
        adjustment_pct=pct, enabled=enabled,
    )


class TestPickingTheLocationThatIsBeingCalculated:
    def test_a_location_that_already_has_a_rule_warns_that_saving_replaces_it(self):
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS
        )["Korea TOBS"]["derived"]

        assert note["tone"] == "warn"
        assert note["title"] == "This location already has a rule"
        assert "calculated from Singapore SN 150 -10%" in note["detail"]
        assert "Saving replaces that rule" in note["detail"]

    def test_a_rule_that_is_turned_off_says_it_stays_off(self):
        # rules.create() rewrites the formula and never touches `enabled`, so
        # saving over a disabled rule leaves it disabled -- which reads as
        # "my rule did nothing" unless the screen says so.
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10, enabled=False)], LOCATIONS
        )["Korea TOBS"]

        assert "turned off" in note["derived"]["title"]
        assert "stays off until you turn it on" in note["derived"]["detail"]
        assert note["summary"].endswith("(turned off)")

    def test_picking_a_benchmark_warns_that_a_rule_there_moves_everything_below_it(self):
        # The engine chains rules to a fixpoint, so a rule on Singapore moves
        # Korea too. That is the whole reason to show this.
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS
        )["Singapore SN 150"]["derived"]

        assert note["title"] == "1 rule is calculated from this location"
        assert "Korea TOBS -10%" in note["detail"]
        assert "changes what they all start from" in note["detail"]

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

        assert note["title"] == "Already the source for 2 rules"
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

        assert "itself calculated from Report: FOB Asia SN 150 -1%" in note["detail"]
        assert "follow on from that one" in note["detail"]

    def test_a_calculated_location_nothing_hangs_off_still_says_it_would_chain(self):
        note = build_rule_notes(
            [rule("Korea TOBS", "Singapore SN 150", -10)], LOCATIONS
        )["Korea TOBS"]["reference"]

        assert note["title"] == "This location is itself calculated"
        assert "follow on from that one" in note["detail"]

    def test_a_benchmark_that_is_not_a_site_location_still_gets_a_note(self):
        # "Report: FOB Asia SN 150" is typed, never picked, so it is not in
        # `locations` -- but the line under the field must still appear.
        note = build_rule_notes(
            [rule("Singapore SN 150", "Report: FOB Asia SN 150", -1)], LOCATIONS
        )["Report: FOB Asia SN 150"]["reference"]

        assert note["title"] == "Already the source for 1 rule"


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
                "U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True}
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
        assert "<select id=" not in page
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
            "1 rule is calculated from this location"
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
        assert note["reference"]["title"] == "No location and no report figure has this name"
        assert "none of them can run" in note["reference"]["detail"]

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
