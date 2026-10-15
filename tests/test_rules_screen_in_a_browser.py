"""The price-rules screen, driven in a real DOM.

Most of what this screen does is script. A row opens an editor in place;
that editor's worked example ("Singapore SN 150 is 1,560 today, so Korea
TOBS would be 1,404") and its info note must be its own; and the form at
the top must be untouched by both. Rendering the page and searching the
HTML -- all the rest of the suite can do -- proves none of it, and the one
bug that mattered here was exactly of that kind: the example and the note
were looked up by element id, so every form on the screen drove the same
one and a row's Save could have posted the amount typed at the top.

So this test renders the screen with real rules and real rounding steps on
it, writes it out next to a plan naming what it put there, and hands both
to tests/browser/drive_rules.js, which clicks through it under jsdom. The
assertions live in that script, one line of JSON per check; this file owns
the fixture and reports what came back.

Needs node and jsdom, which the application image has no business carrying,
so it skips when they are absent and says how to get them. To run it:

    docker build -f Dockerfile.test -t petrosil-module:test .
    docker run --rm -v "$PWD:/src" -w /src petrosil-module:test \
        python -m pytest -q tests/test_rules_screen_in_a_browser.py

See tests/browser/README.md.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

from app.console.routes_rules import create_rules_routes
from app.db.store import LocationRounding, StoredSite
from app.editorial.rules import PriceRule

HERE = Path(__file__).resolve().parent
DRIVER = HERE / "browser" / "drive_rules.js"

SITE = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://example.test/api", token="t", enabled=True, round_to_nearest=5.0,
)

# A priced reference, so the worked example names the rule rather than
# falling back to its generic "Example: 1,000 - 10% = 900"; and a currency on
# the step's location, so the row shows the sign in front of it.
LOCATIONS = [
    {"title": "Korea TOBS", "latest_price": 1404, "currency": "USD"},
    {"title": "Singapore SN 150", "latest_price": 1560, "currency": "USD"},
    {"title": "Saudi SN 500", "latest_price": 1200, "currency": "USD"},
    {"title": "Turkey Domestic EUR", "latest_price": 850, "currency": "EUR"},
    {"title": "Indonesia (Rack)", "latest_price": 896, "currency": "USD"},
]

RULES = [
    PriceRule(id=1, derived_location="Korea TOBS", reference_location="Singapore SN 150",
              adjustment_value=-10.0, adjustment_kind="percent"),
    PriceRule(id=2, derived_location="Saudi SN 500", reference_location="Singapore SN 150",
              adjustment_value=-25.0, adjustment_kind="usd"),
]

OVERRIDES = [
    LocationRounding(id=7, location="Turkey Domestic EUR", round_to_nearest=10.0, direction="up"),
    # The client's Indonesia: printed 896, and 896 it stays.
    LocationRounding(id=8, location="Indonesia (Rack)", round_to_nearest=0.0),
]


class FakeStore:
    def site_by_slug(self, slug):
        return SITE if slug == SITE.slug else None

    def record(self, *args, **kwargs):
        pass


class FakeRules:
    def for_site(self, slug):
        return RULES


class FakeRounding:
    def list_for_site(self, slug):
        return OVERRIDES


class FakeSiteClient:
    def locations(self):
        return {"data": LOCATIONS}


def render() -> str:
    app = FastAPI()
    app.include_router(
        create_rules_routes(
            store=FakeStore(),
            rules=FakeRules(),
            templates=Jinja2Templates(directory="app/templates"),
            current_user=lambda request: type(
                "U", (), {"email": "a@b.test", "name": "A", "is_admin": True,
                          "is_superadmin": True},
            )(),
            client_factory=lambda site: FakeSiteClient(),
            rounding=FakeRounding(),
        )
    )

    page = TestClient(app).get(f"/console/sites/{SITE.slug}/rules")
    assert page.status_code == 200

    return page.text


def node_or_skip() -> str:
    """The driver needs node, and node needs jsdom. Either missing is a skip
    with the command that fixes it, never a failure: the application image
    carries no javascript runtime and should not start now."""
    node = shutil.which("node")

    if node is None:
        pytest.skip(
            "node is not on PATH, so the browser checks cannot run. Build the test "
            "image: docker build -f Dockerfile.test -t petrosil-module:test ."
        )

    found = subprocess.run(
        [node, "-e", "require.resolve('jsdom')"],
        capture_output=True, text=True, cwd=HERE / "browser",
    )

    if found.returncode != 0:
        pytest.skip(
            "jsdom is not installed, so the browser checks cannot run: "
            "npm install --prefix tests/browser"
        )

    return node


@pytest.fixture(scope="module")
def checks(tmp_path_factory) -> list[dict]:
    """Drives the screen once and hands every check back, so a failure names
    the behaviour that broke rather than "the browser test failed"."""
    node = node_or_skip()
    work = tmp_path_factory.mktemp("rules-screen")
    page = work / "rules.html"
    page.write_text(render(), encoding="utf-8")

    plan = {
        "html": str(page),
        "rules": [
            {"id": rule.id, "derived": rule.derived_location,
             "reference": rule.reference_location}
            for rule in RULES
        ],
        "rounding": [
            {"id": step.id, "location": step.location, "direction": step.direction,
             "exact": not step.round_to_nearest,
             "step": f"{step.round_to_nearest:g}" if step.round_to_nearest else ""}
            for step in OVERRIDES
        ],
    }
    plan_file = work / "plan.json"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")

    # NODE_PATH lets the test image keep jsdom outside the mounted repo, so a
    # bind-mounted checkout does not need its own node_modules.
    env = dict(os.environ)
    run = subprocess.run(
        [node, str(DRIVER), str(plan_file)],
        capture_output=True, text=True, cwd=DRIVER.parent, env=env,
    )

    if not run.stdout.strip():
        pytest.fail(f"the driver printed nothing.\nstderr:\n{run.stderr}")

    return [json.loads(line) for line in run.stdout.splitlines() if line.strip()]


def test_the_driver_actually_checked_something(checks):
    # A driver that threw early would otherwise "pass" on an empty list.
    assert len(checks) >= 30, [line["name"] for line in checks]


def test_every_behaviour_the_screen_promises_holds(checks):
    failed = [
        f"{line['name']}" + (f" -> {line['detail']}" if line["detail"] else "")
        for line in checks
        if not line["ok"]
    ]

    assert not failed, "the rules screen misbehaved in the browser:\n  " + "\n  ".join(failed)
