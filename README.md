# Petrosil price module

One module, one language. It does three things for every Petrosil site:

| | |
|---|---|
| **Admin console** | `/console` — sign in, pick a site, update prices, run the crawler |
| **JSON API** | `/api/price-reviews` — a site posts an uploaded sheet and gets back a diff, computed figures and an AI narration |
| **Crawler** | a second process that watches price pages and reports what moved |

Python 3.12, FastAPI, Jinja2, Postgres. One image; the crawler is the same
image run with a different command.

## What lives where

The module holds **no price data and no site database credentials**. Prices
stay on the sites and are reached over their APIs with each site's own token.
The module's own database holds only who may sign in, which sites exist, and
an audit trail of what was done.

That split is what lets one deployment serve every site: add a site in
Settings, and it appears.

```
app/
  api.py            the JSON API
  price_review/     differ, summariser  — the figures, computed not asked for
  ai/               Gemini driver, prompt
  console/          auth, routes, the shared site client
  db/               pool, migrations, store
  templates/        the screens
scraper/            the crawler (imports app.console.site_client)
tests/              pytest
```

## Running it

```bash
pip install -r requirements-dev.txt
python -m pytest -q                          # 134 tests, no network
uvicorn app.main:app --reload --port 8094    # API + console
python -m scraper.main --once                # one crawl pass
```

Config is in `.env.example`. `PRICE_API_TOKEN` and
`GOOGLE_GENERATIVE_AI_API_KEY` are required. Setting `DATABASE_URL` **and**
`CONSOLE_SECRET` switches the console on; leave both unset and the deployment
serves the API only and publishes no login page.

Migrations run at boot, because the production database is Railway's and
reachable only from inside their network — a deploy is the only thing that can
migrate it, so the deploy does.

## Why it takes the old data in the request

`/api/price-reviews` never reaches into anyone's database. Everything needed
to judge an upload arrives in the one request:

| Field | Supplied by the site |
|---|---|
| `rows` | parsed out of the uploaded sheet |
| `current_prices` | what the site currently holds for that date |
| `valid_locations` | which locations the site still considers live |

It also never commits. It returns the rows and the site writes them.

### Row statuses

| Status | Meaning |
|---|---|
| `new` | no price held for that location and date |
| `changed` | differs from the held price, date not yet past |
| `unchanged` | matches the held price |
| `locked` | differs, but the date is past — published history is immutable |
| `unmatched` | the site did not list that location as live |
| `invalid` | negative or unreadable price |

Two of these are load-bearing rulings, not incidental:

- **Published history is immutable, but an *empty* past date can still be
  backfilled.** Prices are entered days after the date they apply to, so a
  blanket past-date ban would make the module useless.
- **Bad prices are rejected, never clamped to zero.** Clamping publishes a
  wrong price instead of surfacing a mistake.

## Numbers are computed, never asked for

The model is handed the figures this module worked out and told to narrate
them. It never sees the raw rows, because models miscount. `suspected_errors`
needs both halves of its rule — more than 3 population standard deviations
from the batch mean, **or** a 50% absolute move — because the floor catches a
lone wild jump in a flat batch and the relative half catches a 10% move where
everything else moved 1%.

## The crawler

Watches a site's price pages, reads them with Gemini, and reports what moved.
Findings land on the site as ordinary batch material; a human still commits.

Three gates stand in front of the model, because 96 checks a day per URL would
otherwise be ruinous:

1. **robots.txt**, before the fetch. An unreadable one counts as a refusal —
   this runs unattended, and reading "their server is broken" as consent is how
   a crawler gets banned.
2. **A conditional request** — most checks come back `304` with no body.
3. **A hash of the price region**, not of the page. A whole-page hash flips on
   a rotating ad, so every check would look like a change.

A hash is never reported for a page that could not be read: storing one would
mark the page "seen" and it would be skipped silently for as long as nobody
looked.

## Traps encoded as tests

Don't let a refactor lose these:

- **`bool` is a subclass of `int`** in Python, so `True` would otherwise be a
  price of 1.0. (The TypeScript version guarded the mirror image: `Number('')`
  is `0` there.)
- **Gemini answers HTTP 200 with an empty `candidates` list** and a
  `promptFeedback.blockReason`. Check that before indexing `candidates[0]`, or
  a decline becomes a crash.
- **The Gemini key travels in the query string**, so every raised message is
  redacted — including transport failures that never produced a response.
- **`round()` is banker's rounding** in Python. The figures here round half
  away from zero, matching what the previous implementation's tests pinned.
- **Whole-number prices need a currency symbol to count** as prices when the
  crawler picks a page region: a bare `205` is indistinguishable from a year.

## The one blocker in production

baseoil's `.htaccess` firewall answers 403 to non-browser user-agents on
`/api/*`. The client sends a browser-shaped UA so it gets through today, but
that is a workaround; the fix is an exemption for this module's egress IP or a
shared header. A 403 is reported with both possible causes named, because a
blocked UA and a bad token look identical from the outside.
