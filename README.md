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
npm test          # 35 tests
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
