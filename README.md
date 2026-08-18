# Petrosil price module

Headless price-review service. A site uploads a sheet, sends the parsed rows **plus its own
current prices**, and gets back a diff, computed figures and an AI narration. The calling site
renders its own preview page and performs its own commit.

Node 22 / TypeScript / Hono. Port of the Laravel service in `../trade-ai`.

## Why it takes the old data in the request

The module never reaches into anyone's database and holds no site credentials. Everything
needed to judge an upload arrives in the one request, which is what lets a single deployment
serve any site:

| Field | Supplied by the site |
|---|---|
| `rows` | parsed out of the uploaded sheet |
| `current_prices` | what the site currently holds for that date |
| `valid_locations` | which locations the site still considers live |

It also never commits. It returns the rows and the site writes them — committing would mean
holding every site's database credentials.

## The endpoint

```
POST /api/price-reviews
Authorization: Bearer <PRICE_API_TOKEN>

{
  "price_date": "2026-09-01",
  "rows":            [{ "location": "Singapore", "price": 845 }],
  "current_prices":  [{ "location": "Singapore", "price": 812 }],
  "valid_locations": ["Singapore"]
}
```

Returns `201` with `rows`, `summary` and `analysis`. A model *decline* is still a 201 — the
request succeeded. Only a provider failure gives `502`, and even then `rows` and `summary` are
still returned, because the diff is this module's own work and stays valid.

`GET /health` needs no token.

### Row statuses

| Status | Meaning |
|---|---|
| `new` | no price held for that location and date |
| `changed` | differs from the held price, date not yet past |
| `unchanged` | matches the held price |
| `locked` | differs, but the date is past — published history is immutable |
| `unmatched` | the site did not list that location as live |
| `invalid` | negative, zero-width, or unreadable price |

Two of these are load-bearing rulings, not incidental:

- **Published history is immutable, but an *empty* past date can still be backfilled.** Prices
  are entered days after the date they apply to, so a blanket past-date ban would make the
  module useless.
- **Bad prices are rejected, never clamped to zero.** Clamping publishes a wrong price instead
  of surfacing the mistake.

## Numbers are computed, never asked for

`summariser.ts` calculates every figure — status counts, rose/fell, median change, largest
moves, and `suspected_errors`. The model receives only those finished numbers and narrates
them. It never sees the raw rows, because models miscount rows.

`suspected_errors` flags a move more than **3 population standard deviations** from the batch
mean **or** **≥50% in absolute terms**. Both halves matter: the absolute floor catches a lone
wild jump in a flat batch where the standard deviation is near zero, and the relative half
catches a 10% move where everything else moved 1%.

## Running it

```bash
npm install
npm test          # 37 tests
npm run dev       # tsx watch
npm run build && npm start
```

Env (see `.env.example`): `PRICE_API_TOKEN` and `GOOGLE_GENERATIVE_AI_API_KEY` are both
required — the server refuses to start without them. `AI_DEFAULT_MODEL` and `PORT` are optional.

## Deploying

Railway, via the `Dockerfile`: `railway up`. No database — nothing is persisted, so there is
nothing to provision. If analysis history is wanted later, that is a storage interface to add,
not a rewrite.

**A real analysis takes ~8-9 seconds.** That rules out synchronous serverless hosts with short
timeouts (Netlify functions cap at 10s) without moving to a two-phase job/poll API. On Railway
it runs as a normal long-lived server and this is a non-issue.

## Two traps in the Gemini driver

Both were found the hard way in the Laravel version and are covered by tests here:

1. **Gemini can answer HTTP 200 with no usable text** — an empty `candidates` array plus
   `promptFeedback.blockReason`. That shape is checked *before* `candidates[0]` is touched, and
   becomes a `declined` completion. A model decline must never surface as a crash.
2. **The API key travels in the URL query string**, so it appears in error text — including
   network-level failures that never produced a response. Every thrown message is redacted,
   because an unredacted one ends up stored and shown to admins.

---

# The price-URL crawler (Python)

A second process that ships **inside this module**: `scraper/`, Python 3.12,
no framework. The Node API answers requests; the crawler runs a loop. One
module, two processes, one repo.

It watches a list of price/news pages on behalf of a site, reads them with
Gemini, and reports what it found. **It never writes a price.** Findings land
on the site's price-update screen as *recent activity*, and an admin stages
and commits them like any other batch.

## Why it talks to the site over the API

The crawler holds **no database credentials and no site knowledge**. It asks
the site what to watch and posts back what it read; everything that needs
site data is decided on the site's side:

| Decided by the site | Why it cannot be decided here |
|---|---|
| which location names exist | they are the site's rows, and 38 of baseoil's 85 are retired |
| whether a price actually *moved* | only the site knows what the page said last time |
| what the site currently holds | that is the site's own price list |

That split is what lets **one deployed crawler serve every Petrosil site**:
point it at a different `SITE_API_URL` and token, no code change.

## The contract

```
GET  {SITE_API_URL}/price-crawl/sources
  -> { interval_minutes, locations: ["Europe SN 500 FOB Group I", …],
       urls: [{ id, url, label, etag, last_modified, content_hash }] }

POST {SITE_API_URL}/price-crawl/results
  <- { results: [{ url_id, status, content_hash?, etag?, last_modified?,
                   rows?: [{location, date, price}], error?, notes? }] }
```

Both use the site's existing bearer token (`users.api_token`) and the same
permissions as the batch API.

`status` is what the crawler observed, never what it concluded:

| status | meaning |
|---|---|
| `read` | the page was read; `rows` and `content_hash` are attached |
| `unchanged` | a 304, or the price region hashed the same — no model call |
| `no_rows` | read, but the model found nothing it could attribute |
| `disallowed` | robots.txt forbids it; the page was never fetched |
| `blocked` | 403/429/503 |
| `failed` | network error, timeout, or a provider failure |

The site turns `read` into `updated` / `no_change` / `no_rows` once it has
compared the rows against what it already knew.

## What makes 15 minutes affordable

96 checks a day per URL would be ruinous if each one cost an AI call. Three
gates stand in front of the model, in this order:

1. **robots.txt**, before the fetch. An unreadable robots.txt counts as a
   refusal — this runs unattended, and reading "their server is broken" as
   consent is how a crawler gets banned.
2. **A conditional request.** The site hands back the `etag`/`last-modified`
   from last time; a publisher who supports them answers `304` with no body.
3. **A hash of the price region** — not of the page. A whole-page hash flips
   on a rotating ad or a "posted 3 hours ago" stamp, so every check would
   look like a change.

Measured on the local stack: a first pass took **13.0s** and read 4 prices; an
unchanged pass took **0.6s** and called nothing.

A hash is **never** reported for a page that could not be read. Storing one
would mark the page "seen", and every later check would call it unchanged and
skip it — silently, for as long as nobody looked.

## Why the model, not a selector

These pages write prices as prose ("Group I SN500 held at $845/t in
Singapore") and get redesigned without notice. A selector breaks silently,
and a silent break on a 15-minute job means stale prices nobody questions.
The model is only ever asked to *read*: every number it returns goes through
the same numeric guard as an uploaded spreadsheet cell, and every location it
names must already exist on the site.

## Running it

```bash
pip install -r requirements-dev.txt
python -m pytest -q            # 85 tests, no network
python -m scraper.main --once  # one pass
python -m scraper.main         # the loop
```

Deploy as a second Railway service from this repo using `Dockerfile.scraper`.
Locally it is the `price-crawler` service in `htdocs/docker-compose.yml`.

Config: `SITE_API_URL`, `SITE_API_TOKEN`, `GOOGLE_GENERATIVE_AI_API_KEY` are
required; the crawler refuses to start without them. See `.env.example`.

## The one blocker in production

**baseoil's `.htaccess` firewall answers 403 to non-browser user-agents on
`/api/*`.** The client sends a browser-shaped UA so it gets through today,
but that is a workaround. The fix is an exemption for the module's egress IP
or a shared header. A 403 from the site is reported with both possible causes
named, because a blocked UA and a bad token look identical from the outside.
