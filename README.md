# Petrosil platform

One application for the whole estate: nine brand sites, one dashboard, one
database. The Python price module and its AI console stay exactly as they are —
this app re-implements the **site side** of the API they already speak, so the
module needs no change when a brand moves over.

Everything runs locally. There is no deployment and no remote.

Status: **admin complete, all nine brands loaded.** The compat API is complete
and proven against the module. The brand sites' read API, accounts, billing and
content are built and tested. The admin is all 31 screens the nine PHP admins
had, over one database holding every brand's real data.

---

## Running it

```bash
npm install
npm run db:up        # Postgres on 5434 (5433 is the price module's — untouched)
npm run db:migrate
npm run db:seed      # nine brands, a superadmin, one API token each (printed once)
npm run db:dev-data  # demo locations, prices, clients, plans, articles, pages
npm run dev          # http://127.0.0.1:3100 — and on this machine's LAN IP
npm test             # against its own petrosil_test database
```

`npm run db:seed` prints each brand's token once. Only a SHA-256 is stored, so
there is no way to read it back — mint a new one if it is lost.

Tests use a separate `petrosil_test` database, created on first run. They
truncate between cases; sharing the development database once cost a session
its demo data.

Use `npm run dev`, not `npm start`, for local browser and curl work: `next
start` runs with `NODE_ENV=production`, which makes the session cookie `Secure`,
and it will not come back over plain http. That applies over the LAN too —
`npm start` on an `http://192.168.x.x` address will take a password and then
refuse to stay signed in.

### Reaching it from another machine

The server binds `0.0.0.0`, so it answers on this machine's LAN address as
well as localhost. Two things stand between that and a colleague's browser:

```powershell
# in an elevated PowerShell, once
Set-NetConnectionProfile -InterfaceAlias WiFi -NetworkCategory Private
New-NetFirewallRule -DisplayName "Petrosil admin (dev) 3100" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3100 `
  -Profile Private -RemoteAddress LocalSubnet
```

`-RemoteAddress LocalSubnet` is the part that matters: it keeps the rule to
the network you are on rather than opening the port wherever this laptop next
connects.

Next refuses cross-origin dev requests unless the origin is allowed, so
`next.config.ts` permits the private ranges. Set `DEV_ORIGINS` to a
comma-separated list to narrow it to named machines.

**This is a development server with no TLS, and the admin holds every
subscriber's name, email and company.** Fine on a network you control, not
something to leave reachable from a café.

The sign-in page offers these accounts as buttons, so you do not type the
password forty times a day. They go through the same `signIn` as the form, so
the throttle still applies and the attempt still lands in the login log.

The panel is gated on `NODE_ENV`: never in production, and refused when
`NODE_ENV` is unset rather than assumed safe — `quickSignInAllowed` returns
before it reads anything else, so no flag can turn it back on there. It also
only offers accounts whose password really is the development one, verified
against the hash, because a button that fails is worse than no button. Set
`DEV_QUICK_SIGN_IN=off` to hide it here too and test the real sign-in path.

Demo accounts after `db:dev-data` (password `petrosil-dev`):

| Account | What they are |
|---|---|
| `rakesh@tikitech.in` | superadmin, the whole estate |
| `editor@petrosil.example` | staff, **baseoil only** — the account to test scoping with |
| `tanvi@ebo.example` | premium subscriber on two brands |

Other scripts:

```bash
npm run migrate:site    -- --from <mysql db> --site <slug> [--fresh]  # locations, prices, people
npm run migrate:content -- --from <mysql db> --site <slug> [--fresh]  # everything else the admin shows
npm run sweep:expiries                                                # end the terms that have run out
npm run jobs                                                          # run due background jobs once
npm run jobs -- mail.deliver                                          # run one job now, due or not
npm run jobs -- --status                                              # when each job last ran, and how
npm run import:files -- --site <slug> --from <old file_manager dir>   # carry a brand's files into the store
```

### The AI engine

Deploying it: see [docs/deploying-the-ai-engine.md](docs/deploying-the-ai-engine.md).

`engine/` is the Python price module — report reading, drafting, rules,
rounding, currency conversion, the crawler — brought in with its history
(`git subtree`). It stays Python and does not draw the admin's screens; the
brand's AI tools tab will call it. It keeps its tables in the `engine` schema
of this same database and reaches each brand through this app's compat API,
exactly as it reached the old PHP sites.

```bash
cp <the standalone module's .env> .env.engine   # PRICE_API_TOKEN, CONSOLE_SECRET, provider key; then:
# DATABASE_URL=postgresql://petrosil:petrosil@platform-db:5432/petrosil?sslmode=disable&options=-csearch_path%3Dengine
docker compose up -d --build engine   # http://127.0.0.1:8097, needs `npm run dev` running for the brands
npm run engine:link                   # a token per brand, written straight into engine.console_sites
```

`engine:link` mints each brand a token named "engine" (revoking the previous
one) and points the engine's site entry at `ENGINE_SITE_API_BASE` (default
`http://host.docker.internal:3100/api/compat`). Its other settings — model,
instructions, rules, rounding — are left alone. Re-run it whenever a brand is
added.

The crawler is the same image run as a second process,
`MODULE_PROCESS=estate-crawler` (`scraper/estate.py`): every fifteen minutes it
reads every brand's watched pages, each brand on its own AI provider, through
the same pass as the Watched pages screen's "Check now". Locally it is the
`engine-crawler` compose service:

```bash
docker compose up -d engine-crawler                                   # the loop
docker compose run --rm engine-crawler python -m scraper.estate --once # one pass now
```

A brand's watch list and crawler instructions come across from its old site
with `npm run migrate:content -- --from <mysql db> --site <slug> --only crawl-watch`
(safe to run again: pages are matched by address).

`Dockerfile.local` builds on an image that already has the dependencies
installed, so a code change does not wait on PyPI; `ENGINE_DOCKERFILE=Dockerfile`
builds exactly as production will. The engine's own tests run where they
always did:

```bash
docker run --rm -v "$PWD/engine:/src" -w /src petrosil-module:test python -m pytest tests -q
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

### The dashboard API

`overview`, `clients[/id]`, `clients/{id}/membership`, `locations[/id]`,
`batches[/id]`, `articles[/id]`, `trials[/id]`, `audit`, `logins`.

### The admin — 31 screens

The menu is lifted from `htdocs/baseoil/.../layouts/app.blade.php`: the same
groups in the same order the team has opened every working day since 2015. The
purchased theme's demo pages — chat, calendar, gallery, invoice, lock-screen
and some seventy more, about 45% of the old route table — are not carried,
because not one of them is a feature.

| Group | Screens |
|---|---|
| Dashboard | Estate overview |
| Prices | Locations · Price update · Watched URLs · Manage qty trend · Trade analysis |
| Content | Articles · Pages · Announcements · Reports · Offers · Impex data |
| Clients | Directory · Free trials · Login log |
| Subscription | Plans · Transactions · Coupons |
| Masters | Currencies · Categories · File manager |
| Newsletter | Templates · Newsletters |
| Ads | Ad locations · Ads |
| Users | Staff · Roles · Audit trail |
| Settings | General · Directory fields · Offer fields |

Every screen reads its domain function directly rather than calling this app's
own HTTP API: the same scoping (`visibleSites`), one less round trip, and the
type survives. Every list is a GET form, so every view is a URL you can paste
to a colleague.

Four of them answer a question the old admin could not:

- **Locations** and **Price update** link each published figure to the batch
  that set it, which is how a wrong price is traced without opening the
  database.
- **Coupons** says *why* a code is not working — off, expired, spent, not yet
  started — where the old screen showed the enabled flag alone.
- **Ads** and **Announcements** judge "running" against today's date, not the
  publish flag, so a slot full of ads that ended in 2021 reads as empty.
- **Settings → Directory fields** and **Offer fields** state the paywall once:
  one row per field with "a free reader sees" and "a subscriber sees" side by
  side, rebuilt from 44 loose `city_free` / `offer_phone_premium` settings
  rows per site.

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

**Mail goes out once a Brevo key is set, and not before.** Everything is
queued in `mail_outbox`; the `mail.deliver` job (`lib/mail/deliver.ts`)
drains it every minute through Brevo's API — sent once even with two
instances running, retried after 5 min / 15 min / 1 h / 4 h, given up after
five tries with the reason kept on the row. Until `BREVO_API_KEY` and
`MAIL_FROM` are set the job claims nothing, so nothing is lost. Only three
templates exist (verify, reset, account exists); the old sites' twelve
system mails are not ported yet. Read a token back in development with:

```sql
select payload from mail_outbox order by id desc limit 1;
```

**Background jobs run inside the server.** `src/instrumentation.ts` starts a
one-minute loop in production (`JOBS=off` stops it; `JOBS=on` starts it on a
laptop). Each job's row in `scheduled_jobs` is its lock, so any number of
instances can run the loop. Jobs: `mail.deliver` every minute,
`memberships.sweep` daily at 11:00 India time. The old trial and renewal
reminder crons are not ported yet — they need the mail templates.

**Razorpay is real except for one call.** The signature check — HMAC-SHA256 of
`order_id|payment_id`, compared in constant time — is implemented and tested,
because it is the only thing between "the browser says it paid" and "it paid".
Creating the order *at* Razorpay mints a local reference of the same shape, so
the whole flow works offline; when the live keys arrive, one function body in
`lib/payments/razorpay.ts` changes.

**Old binary `.xls` is refused** with "save as .xlsx or .csv". There is no safe
maintained Node reader for it.

**No editors yet.** Every admin screen reads, and the mutations that exist are
the ones the team does daily: hold or publish a location, change a
subscription, decide a trial, save a setting, move a paywalled field. Creating
and editing articles, reports and offers goes through the API, which is built
and tested, but has no form over it.

**Authorship is not carried.** The old `authored_by` is a legacy user id and
nothing here carries legacy ids, so 93,000 migrated articles have no author
rather than the wrong one. Transactions *are* attributed, by matching the
email on the old row to the person already on the platform; the handful whose
buyer no longer exists are counted and skipped rather than orphaned.

**A payment nobody recorded arrives pending, not paid.** 255 of baseoil's 635
subscription rows have a null `payment_status`, and "Paid" and "success" are
both spellings in use. Only the two spellings of success become `paid`.

**Newsletters arrive as drafts.** 2,136 issues came across; the old
`sent_emails` table held six rows between nine sites, so nothing is recorded
as sent, because nothing can be.

**`importlocations` and `exportlocations` are not carried.** All three of the
old quantity tables reference `qtylocations` on both ends — checked against
the id ranges, not assumed. Those two four-row tables duplicate the first qty
locations by name and nothing points at them.

**Files live in a store, by the old folders.** `lib/files/store.ts` is a
directory (`FILES_DIR`) or an S3-compatible bucket (`FILES_S3_*`); production
wants the bucket, since the estate's files come to about 14 GB. Keys are
`<brand>/<area>/<folder>/<name>`, the old `file_manager` layout, so a carried
report's bare "584.pdf" still finds its file. `npm run import:files -- --site
<slug> --from <old file_manager>` carries a brand's files (baseoil: 5,292 files,
1.7 GB, about a minute to disk) and lists content that names a missing file.
Public folders (article and ad images, thumbnails) are served at
`/api/public/{site}/files/...`; report PDFs, trade sheets and attachments only
to staff, at `/api/dashboard/files/{id}`, until a paywalled download exists.
Staff upload on the Files screen (50 MB, a fixed list of types, a new name per
upload). The S3 store is tested against Adobe's S3Mock when
`S3_TEST_ENDPOINT` is set; MinIO's images are no longer published.

**Still open for the owner:** are the three conference sites and `trade-ai` in
scope; what happens to the 756k click rows; and who among the 34 accounts that
held a role on the old sites should be granted access here (the migration
granted nobody, deliberately).

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
src/domain/dashboard/     the team's own screens, one module per group
src/app/(admin)/          the 31 admin screens, the rail, the shared pieces
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
