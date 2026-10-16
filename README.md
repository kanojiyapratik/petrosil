# Petrosil platform

One application for the whole estate: nine brand sites, one dashboard, one
database. The Python price module and its AI console stay exactly as they are —
this app re-implements the **site side** of the API they already speak, so the
module needs no change when a brand moves over.

Status: **backend, phase 1.** The compat API is built and proven; the brand
pages and the dashboard come later.

## What works today

| Endpoint | Who calls it |
|---|---|
| `GET /api/compat/{site}/locations` | module — what the brand tracks, with its latest published price |
| `GET /api/compat/{site}/price-batches` | console — the batch list, paginated |
| `POST /api/compat/{site}/price-batches/rows` | console — stage the rows an editor kept |
| `GET /api/compat/{site}/price-batches/{id}` | console — the batch with every staged row |
| `PUT /api/compat/{site}/price-batches/items/{id}` | console — edit one staged row |
| `POST /api/compat/{site}/price-batches/{id}/commit` | console — publish |
| `POST /api/compat/{site}/price-batches/{id}/rollback` | console — undo a published batch |
| `POST /api/compat/{site}/price-batches/{id}/discard` | console — throw away a draft |
| `POST /api/compat/{site}/price-summaries` | module — the AI note shown above the price table |
| `GET /api/compat/{site}/price-crawl/sources` | crawler — what to fetch, with last time's validators |
| `POST /api/compat/{site}/price-crawl/results` | crawler — one whole pass's findings |
| `GET`/`PUT /api/compat/{site}/price-crawl/urls` | console — read and replace the watch list |
| `GET /api/compat/{site}/price-crawl/activity` | console — what the pages have said lately |
| `POST /api/compat/{site}/price-crawl/activity/stage` | console — turn findings into a draft batch |
| `POST /api/compat/{site}/price-crawl/activity/clear` | console — forget the findings and the page hashes |
| `GET /api/health` | Railway |

Not yet built: spreadsheet upload (`/price-batches/upload`) and bulk edit
(`/price-batches/bulk`) — the two paths that take a file or a form rather than
JSON.

## The rules this code exists to protect

- **Published history is immutable.** An existing price on a past date is
  `locked`, never overwritten. Backfilling an *empty* past date is still allowed.
- **The lock is re-derived at commit time.** A row staged while its date was
  today is history once midnight passes, and is refused.
- **A price that moved after staging is a conflict, not an overwrite.** The live
  row is locked (`select … for update`) and re-compared inside the commit
  transaction.
- **A row that cannot be read does not fail the request.** It is staged as
  `invalid` / `unmatched` / `ambiguous` so an editor sees it.
- **The crawler never publishes.** A finding is a record of what a page said;
  it reaches a price only by being staged as an ordinary batch a human commits.
  A page that could not be read stores no content hash, or every later check
  would call it unchanged and skip it.
- **Names are matched exactly** (case folded, whitespace collapsed) and never
  fuzzily. A near miss publishes a wrong price; `unmatched` does not.
- **Every query is scoped by site.** A token is bound to one brand, and the slug
  in the URL must agree with it.

## Running it

```bash
npm install
npm run db:up        # Postgres on 5434 (5433 is the price module's — untouched)
npm run db:migrate
npm run db:seed      # nine brands, a superadmin, one API token each (printed once)
npm run dev          # http://127.0.0.1:3100
npm test             # 65 tests against the real database
```

`npm run db:seed` prints each brand's token once. Only a SHA-256 of it is
stored, so there is no way to read it back — mint a new one if it is lost.

## Proving the contract

`tests/compat-api.test.ts` asserts the exact JSON shapes, which were measured
against the live Laravel sites (baseoil and bitumart) on 2026-10-16 through the
module's own `SiteClient`.

`tools/roundtrip.py` goes further: it runs the module's unmodified `SiteClient`
against this app — locations, stage, edit, commit, note, list, rollback — and is
the acceptance gate from the build spec. With the dev server running:

```bash
docker cp tools/roundtrip.py petrosil-module:/tmp/roundtrip.py
docker exec petrosil-module python /tmp/roundtrip.py <baseoil-token>
```

## Layout

```
src/db/schema.ts        every table; site_id on everything that belongs to a brand
src/domain/price/       the rules above, independent of HTTP
src/lib/compat/         token auth, the JSON shapes, the shared route wrapper
src/app/api/compat/     the endpoints themselves, deliberately thin
tests/                  domain tests and contract tests, against real Postgres
```

Nothing here talks to the live estate. The module's own database (port 5433)
and the nine Railway sites are untouched by this app.
