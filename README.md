# Petrosil platform

One application for the whole estate: nine brand sites, one dashboard, one
database. The Python price module and its AI console stay exactly as they are —
this app re-implements the **site side** of the API they already speak, so the
module needs no change when a brand moves over.

Everything runs locally. There is no deployment and no remote.

Status: **backend.** The compat API is complete and proven against the module.
The brand sites' read API, accounts, billing and content are built and tested.
No UI yet.

---

## Running it

```bash
npm install
npm run db:up        # Postgres on 5434 (5433 is the price module's — untouched)
npm run db:migrate
npm run db:seed      # nine brands, a superadmin, one API token each (printed once)
npm run db:dev-data  # demo locations, prices, clients, plans, articles, pages
npm run dev          # http://127.0.0.1:3100
npm test             # 310 tests, against their own petrosil_test database
```

`npm run db:seed` prints each brand's token once. Only a SHA-256 is stored, so
there is no way to read it back — mint a new one if it is lost.

Tests use a separate `petrosil_test` database, created on first run. They
truncate between cases; sharing the development database once cost a session
its demo data.

Use `npm run dev`, not `npm start`, for local browser and curl work: `next
start` runs with `NODE_ENV=production`, which makes the session cookie `Secure`,
and it will not come back over plain http.

Demo accounts after `db:dev-data` (password `petrosil-dev`):

| Account | What they are |
|---|---|
| `rakesh@tikitech.in` | superadmin, the whole estate |
| `editor@petrosil.example` | staff, **baseoil only** — the account to test scoping with |
| `tanvi@ebo.example` | premium subscriber on two brands |

Other scripts:

```bash
npm run migrate:site -- --from <mysql db> --site <slug> [--fresh]   # a dump into the platform
npm run sweep:expiries                                             # end the terms that have run out
```

---

## What works today

### The compat API — what the price module already speaks

Token auth (`Authorization: Bearer`), one token per brand, slug and token must
agree.

| Endpoint | Who calls it |
|---|---|
| `GET /api/compat/{site}/locations` | module — what the brand tracks, with its latest published price |
| `GET/POST /api/compat/{site}/price-batches…` | console — list, stage, show, edit an item, commit, rollback, discard |
| `POST /api/compat/{site}/price-batches/upload` | console — a spreadsheet, relayed as the editor picked it |
| `POST /api/compat/{site}/price-batches/bulk` | console — set or adjust across a date range |
| `GET/PUT /api/compat/{site}/price-crawl/…` | crawler — sources, results, urls, activity, stage, clear |
| `POST /api/compat/{site}/price-summaries` | module — the published AI note |

### The brand sites — public

| Endpoint | Notes |
|---|---|
| `GET /api/public/sites` | the nine brands, for the umbrella home page. Carries no figures |
| `GET /api/public/{site}/price-trends` | names and movement for everyone, figures for subscribers |
| `GET /api/public/{site}/locations/{id}?weeks=` | one market and its series; withheld whole when locked |
| `GET /api/public/{site}/insights` | the AI market note and its archive. Open to everyone — see below |
| `GET /api/public/{site}/articles` | published only, never a body |
| `GET /api/public/{site}/articles/{slug}` | one piece; a premium piece keeps its body out of the reply |
| `GET /api/public/{site}/pages/{slug}` | the staff-edited content pages |
| `GET /api/public/{site}/announcements` | whatever strip is running now |
| `GET /api/public/{site}/plans` | what this brand sells, priced per term |
| `POST /api/public/{site}/coupon-check` | what a code would make it cost |
| `GET /api/public/{site}/search?q=` | markets and market notes |

### Accounts

`POST /api/auth/register`, `verify-email`, `forgot-password`, `reset-password`,
`login`, `logout`, `GET /api/auth/me`, and `GET|PATCH /api/account/profile`,
`POST /api/account/password`.

### Money

`POST /api/account/orders`, `POST /api/account/orders/{id}/confirm`,
`GET /api/account/orders`, `POST /api/account/trial`.

### The dashboard side

`overview`, `clients[/id]`, `clients/{id}/membership`, `locations[/id]`,
`batches[/id]`, `articles[/id]`, `trials[/id]`, `audit`, `logins`.

---

## The rules this code exists to protect

Each of these is ported from the Laravel estate with its reason, and each has a
test. They are the reason this is a rewrite rather than a port.

**Movement is public, figures are paid for.** A visitor sees that a price rose
and when it was last assessed, never what it rose to. The rule lives in exactly
one function (`domain/public/paywall.ts`) because the old sites decided it in
every template that showed a price, and it drifted — on two of them a free
reader could still reach the price-history link.

**A paid tier with no expiry is open-ended, not lapsed.** Some of the oldest
premium rows in the dumps have no expiry at all.

**The last day belongs to the reader.** A subscription, a coupon or an
announcement ending today is live today. The old sites compared against a
midnight datetime and cut the final day short.

**History is immutable.** A price for a date that already has one is `locked`,
and the lock is re-derived at commit time, not trusted from when the row was
staged.

**A conflict is never an overwrite.** Two editors committing the same date get
a conflict, not a silent last-write-wins (`select … for update`).

**The server prices the order.** The plan and the coupon decide the amount;
anything price-shaped in the request is ignored. The old checkout posted the
price it had been shown.

**A renewal extends, it does not replace.** Renewing early keeps the time
already paid for. Years are added in the calendar, so 29 February plus a year
is 28 February.

**Settling is idempotent**, and claimed in a `WHERE` clause rather than after an
`if`, so a retried callback cannot buy a second year.

**A draft is not reachable from the public side.** Published means status
`published` *and* a `published_at` that has passed. The old article route read
by id with no status check.

**A locked article keeps its body out of the reply**, not merely off the screen.
The old page rendered the whole thing and hid the overflow with CSS.

**Nothing reveals whether an address has an account.** Registering a known
address answers exactly as a new one does, and never touches the password. The
old estate had a `checkemail` endpoint that answered the question directly.

**Scoping never reads a slug off the request.** Every dashboard query goes
through `visibleSites()`; another brand's row answers **404, not 403**, because
a 403 confirms it exists.

**One log, not audit columns on forty tables.** Every write a human or a token
causes lands in `audit_log` with the brand it belonged to.

**The AI note is open to everyone** because the module builds its prompt from
movements only, so the prose contains nothing that was paid for. If that prompt
ever starts quoting figures, this decision has to be revisited.

---

## Things that are deliberately not finished

**Mail is queued, never sent.** The estate's Brevo/SendGrid/SMTP credentials
live in the old sites' settings table and are not ours to use. `mail_outbox`
holds what would go out; a sender drains it later. Read a token back in
development with:

```sql
select payload from mail_outbox order by id desc limit 1;
```

**Razorpay is real except for one call.** The signature check — HMAC-SHA256 of
`order_id|payment_id`, compared in constant time — is implemented and tested,
because it is the only thing between "the browser says it paid" and "it paid".
Creating the order *at* Razorpay mints a local reference of the same shape, so
the whole flow works offline; when the live keys arrive, one function body in
`lib/payments/razorpay.ts` changes.

**Old binary `.xls` is refused** with "save as .xlsx or .csv". There is no safe
maintained Node reader for it.

**The migration carries locations, prices and people only.** Articles, reports,
offers and the directory wait for their tables; reports, offers and the
directory are not built yet.

**Still open for the owner:** are the three conference sites and `trade-ai` in
scope; which phase gets impex/qty (630k rows), offers and the directory; and
what happens to the 756k click rows.

---

## Proving the contract

`tests/compat-api.test.ts` asserts the exact JSON shapes, measured against the
live Laravel sites (baseoil and bitumart) on 2026-10-16 through the module's own
`SiteClient`. **Never treat the local htdocs copies as the contract** — they are
behind production, and bitumart returns a `currency` field baseoil does not.

`tools/roundtrip.py` goes further: it runs the module's unmodified `SiteClient`
against this app — locations, stage, edit, commit, note, list, rollback, and the
crawl half — and is the acceptance gate from the build spec. With the dev server
running:

```bash
docker cp tools/roundtrip.py petrosil-module:/tmp/roundtrip.py
docker exec petrosil-module python /tmp/roundtrip.py <baseoil-token>
```

---

## Layout

```
src/db/schema.ts          every table; site_id on everything that belongs to a brand
src/domain/price/         staging, committing, the date lock, spreadsheets
src/domain/crawl/         what the crawler reports and what may be staged from it
src/domain/public/        the paywall, and what a brand site publishes
src/domain/accounts/      registering, one-shot links, profiles
src/domain/billing/       plans, coupons, orders, terms, trials, the sweep
src/domain/content/       articles, pages, announcements
src/domain/dashboard/     the team's own screens
src/domain/migrate/       the decisions a migration has to make
src/lib/compat/           token auth and the shapes the module expects
src/lib/public/           the brand-site route wrapper
src/lib/auth/             sessions, the dashboard guard, the account guard
src/lib/payments/         Razorpay signatures
src/lib/mail/             the outbox
src/app/api/              the endpoints, deliberately thin
tests/                    domain and contract tests, against real Postgres
```

Nothing here talks to the live estate. The module's own database (port 5433) and
the nine Railway sites are untouched by this app.
