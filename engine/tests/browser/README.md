# Browser checks

One screen in this console does most of its work in script rather than in
markup: `/console/sites/{slug}/rules`. A row opens an editor in place, that
editor's worked example and info note have to be its own, and the form at
the top has to be unaffected by both. Rendering the page and searching the
HTML — which is all the rest of the suite does — proves none of that.

The bug that put this here was exactly of that kind. The worked example
("Singapore SN 150 is 1,560 today, so Korea TOBS would be 1,404") and the
combo's info note were looked up by element id. With one form on the screen
that was fine. With an editor in every row, every form drove the same
example, and a row's Save could have posted the amount typed at the top.
Nothing in the HTML looks wrong; only clicking it shows it.

## How it fits together

- `../test_rules_screen_in_a_browser.py` owns the fixture. It renders the
  screen with real rules and real rounding steps on it, writes the HTML to a
  temporary file next to a `plan.json` naming what it put there, and runs the
  driver.
- `drive_rules.js` loads that HTML into jsdom with its scripts running,
  clicks through it, and prints one JSON object per check:
  `{"name": ..., "ok": true|false, "detail": ...}`. It exits non-zero if any
  check failed.
- The Python side asserts every check passed, and names the ones that did
  not — so a failure reads as "Cancel does not bring the display row back",
  not "the browser test failed".

The driver takes its expectations from the plan rather than hard-coding
them, so changing the fixture does not mean editing the javascript.

## Running it

The application image has no javascript runtime and should not grow one, so
the test skips when node or jsdom is missing — and says which. The test
image has both:

```sh
docker build -f ../../Dockerfile.test -t petrosil-module:test ../..
docker run --rm -v "$PWD/../..:/src" -w /src petrosil-module:test python -m pytest -q
```

That image installs jsdom at `/opt/browser-tests/node_modules` and points
`NODE_PATH` at it — outside the repo, because the repo is bind-mounted over
it at run time.

To run it against a node you already have, install jsdom here first:

```sh
npm install --prefix tests/browser
node tests/browser/drive_rules.js <plan.json>   # or just run pytest
```

`node_modules/` is already gitignored.
