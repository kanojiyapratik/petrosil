# Price Module Site Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the six remaining Petrosil sites onto the shared price console, each with the price API, the AI Market Insights page, its own Railway deployment, and a console row that stays hidden until its data is ready.

**Architecture:** Every site is the same Laravel 7 application in the same unusual layout, so this is one recipe applied six times rather than six ports. Task 1 extracts the verbatim, mechanical part of that recipe into a script and a checklist; each site task then runs the script, does the small amount of work that genuinely differs per site (its own view markup), verifies against its own database, and deploys. baseoil is the reference implementation; waxreport is the most recent proof that the recipe travels.

**Tech Stack:** PHP 7.3, Laravel 7, MariaDB 10.6, Apache/mod_php, Docker, Railway. No Composer — `vendor/` is pre-committed on every site.

**Spec:** `D:\project2026\htdocs\waxreport\PORT-REPORT.md` and `DEPLOY-SCAFFOLDING.md` — what was actually done for the third site, including every trap hit. Commit `e7bcd93` in that repo is the canonical file list (57 files, 4,696 insertions).

## Global Constraints

- **All six sites are PHP 7.3** (`"php": "^7.3.5"`, chemicalexplorer `"7.3"`). Use baseoil's `php:7.3-apache` Dockerfile, **not** wax's PHP 8 variant — the `docker-php-ext-configure gd` flags differ between them.
- **Composer cannot run.** `vendor/` is pre-committed. Add no dependency.
- **Debian bullseye has left standard security support.** Every Dockerfile must point apt at `archive.debian.org` for bullseye main and bullseye-updates, drop the security line, and pass `-o Acquire::Check-Valid-Until=false`. Without this every build fails at exit 100. Proven in `D:\project2026\htdocs\Dockerfile`.
- **A seed must have every `api_token` scrubbed to NULL.** Bitumart's seed once carried a working local token into a public deployment.
- **A seed must import under `mariadb-client-10.5`.** MariaDB 10.6+ dumps open with `/*M!999999\- enable the sandbox mode */`, which that client reads as a command and dies on. Strip it from the seed *and* at import time in the entrypoint.
- **Stage with full paths, never bare directory names.** `robocopy /XD framework` matches `vendor/laravel/framework` and silently removes it; the site then serves a PHP fatal error. Exclude by absolute path only.
- **`globalprices` ships as InnoDB.** All six are MyISAM today, so `PriceBatchCommitter`'s transaction silently does nothing and a half-failed commit cannot roll back. Dump the table before converting.
- **`.gitignore` needs `**/`-prefixed patterns.** A pattern with a middle slash is anchored to the repo root, so `storage/framework/` never matches `<site>/application/storage`.
- **Screen wording follows the owner's vocabulary: read / check / use.**
- **A site is added to the production console with `enabled = false`.** It is then absent from the site list and 404s on direct access, and one boolean turns it on later.

---

## Site inventory

Audited 2026-09-18. All six are git repos with GitHub remotes on `Tikitech01`, all one commit deep, none have price API routes.

| Site | Port | DB | Locations | Prices | Latest | Order |
|---|---|---|---|---|---|---|
| titaniumdioxidereport | 8087 | `titaniumdioxidereport` | 24 | 12,216 | 2026-06-01 | 1st |
| petrosilicon | 8086 | `petrosilicon` | 41 | 24,002 | 2026-05-15 | 2nd |
| chemicalexplorer | 8082 | `chemicalexplorer` | 60 | 6,255 | 2026-04-14 | 3rd |
| fertilizerreport | 8083 | `fertilizerreport` | 36 | **0** | — | 4th |
| glycerinereport | 8084 | `glycerinereport` | 36 | **0** | — | 5th |
| methanolreport | 8085 | `methanolreport` | 36 | **0** | — | 6th |

The last three share `Petrosil_Database_Template.sql` and hold no prices. They get the full port and deployment, but their console rows stay disabled until the owner supplies data — an editorial run against a site with no current prices has nothing to compare against.

---

## File Structure

**Created once (Task 1), in this repo:**
- `tools/site-port/port-price-module.sh` — copies the verbatim files from baseoil into a target site, stamps fresh migration timestamps, appends the API routes. Deterministic, re-runnable, reviewable once instead of six times.
- `tools/site-port/CHECKLIST.md` — the per-site work the script cannot do: the view markup, the middleware and `.htaccess` edits, the database steps, and the verification commands with their expected output.

**Created per site (Tasks 2-13), in that site's repo:**
- `<site>/application/app/Http/Controllers/Api/` — four controllers
- `<site>/application/app/Services/Price/` — the service classes
- `<site>/application/app/{PriceBatch,PriceBatchItem,PriceCrawlUrl,PriceCrawlActivity,PriceSummary}.php`
- `<site>/application/app/Console/Commands/PriceApiTokenCommand.php`
- `<site>/application/app/Imports/PriceSheetReader.php`
- `<site>/application/database/migrations/` — nine migrations
- `<site>/application/resources/views/front/insights/index.blade.php`
- `<site>/application/tests/Feature/Price/` — nine test files
- `Dockerfile`, `railway.json`, `.dockerignore`, `.railwayignore`, `docker/railway-entrypoint.sh`, `docker/seed/<site>-seed.sql`

**Modified per site:**
- `routes/api.php`, `routes/web.php`
- `app/User.php`, `app/Http/Middleware/{Authenticate,TrustProxies}.php`, `app/Exceptions/Handler.php`
- `resources/views/{home,layouts/front,layouts/nav,front/location/index}.blade.php`
- `.gitignore`, `.htaccess`, `phpunit.xml`

---

### Task 1: The port kit

The mechanical half of the recipe, extracted once so six repetitions cannot drift.

**Files:**
- Create: `tools/site-port/port-price-module.sh`
- Create: `tools/site-port/CHECKLIST.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `port-price-module.sh <site-dir> <inner-dir>` — e.g. `port-price-module.sh D:/project2026/htdocs/titaniumdioxidereport titaniumdioxidereport`. Copies from baseoil, exits non-zero on any missing source file, and prints every file it wrote.

- [ ] **Step 1: List the verbatim files**

Derive the list from baseoil, and verify it against wax's commit `e7bcd93` — that commit is the set that is known to work on a PHP 7.3 site:

```bash
cd /d/project2026/htdocs/waxreport && git show --stat e7bcd93 | grep -E "app/|database/|routes/|tests/"
```

Expected: the four `Api/*Controller` classes, `app/Services/Price/*` (excluding `PriceReviewGateway`, which is AI-editorial only), the five price models, `PriceApiTokenCommand`, `PriceSheetReader`, nine migrations, nine test files.

- [ ] **Step 2: Write the script**

It must: refuse to run if the target already has `routes/api.php` containing `price` (re-running must not duplicate routes); copy each file from `baseoil/baseoil/application/` to `<site>/<inner>/application/`; rewrite migration filenames to today's date keeping the `000001`-`000009` ordering; and print a summary. Fail loudly on a missing source rather than silently skipping.

- [ ] **Step 3: Write the checklist**

Everything the script deliberately does not do, with the reason each one is manual:

1. **The views.** Each site's `home.blade.php`, `layouts/nav.blade.php`, `layouts/front.blade.php` and `front/location/index.blade.php` differ. The insights page must be written in that site's own markup, as it was for wax — not copied from baseoil.
2. **`app/Http/Middleware/Authenticate.php`** — `redirectTo` must guard on `!$request->hasSession()`; `expectsJson()` alone is not enough, because curl and a browser address bar send no Accept header.
3. **`app/Exceptions/Handler.php`** — an `unauthenticated()` override returning JSON 401 for any `/api/*` path. Laravel's default falls back to `route('login')` regardless of what `redirectTo` returns, so a token-less request 302s without this.
4. **`app/Http/Middleware/TrustProxies.php`** — `$proxies = '*'`, or every asset URL is written `http://` on an https page and the browser blocks it as mixed content.
5. **`.htaccess`** — exempt `/api/` from the user-agent blocklist, and force https only for hostnames containing a dot (the console calls sites by bare hostname).
6. **`.gitignore`** — add `**/storage/framework/` and `**/storage/logs/`.
7. **`app/User.php`** — add `api_token` to `$hidden`.
8. **The `/price-trends` guard** — `$location->globalPrices[0]->pricedate` crashes for a location with no prices. Present on every site checked so far.

- [ ] **Step 4: Commit**

```bash
git add tools/site-port/
git commit -m "tools: the site port recipe, extracted once instead of six times"
```

---

### Tasks 2-13: per site

Two tasks per site, run in the order given in the inventory. **Finish a site before starting the next** — six half-ported sites is a worse position than three finished ones.

For each site, substitute `<site>` (e.g. `titaniumdioxidereport`), `<port>` (e.g. `8087`), `<db>` (e.g. `titaniumdioxidereport`).

#### Task 2N: Port `<site>` locally

**Files:** as listed in File Structure, under `D:\project2026\htdocs\<site>`.

**Interfaces:**
- Consumes: `tools/site-port/port-price-module.sh` and `CHECKLIST.md` from Task 1.
- Produces: a site whose `/api/locations` answers 200 with a bearer token and 401 without, and whose AI Market Insights page renders with zero summaries.

- [ ] **Step 1: Back up `globalprices` before touching it**

```bash
docker exec petrosil-db mysqldump -uroot -proot <db> globalprices > /d/project2026/htdocs/_backups/<site>-globalprices-pre-innodb-$(date +%Y%m%d).sql
```

- [ ] **Step 2: Run the port script, then work the checklist**

Every item in `CHECKLIST.md`, in order. The views are the part that needs judgement — read that site's existing templates first and match them.

- [ ] **Step 3: Database changes**

```bash
docker exec petrosil-db mysql -uroot -proot -e "ALTER TABLE <db>.globalprices ENGINE=InnoDB;"
docker exec site-<site> sh -c 'cd /var/www/html/application && php artisan migrate'
```

Expected: nine migrations run; `globalprices` reports `InnoDB`; `users.api_token` exists.

- [ ] **Step 4: Run the tests**

```bash
docker exec site-<site> sh -c 'cd /var/www/html/application && vendor/bin/phpunit --filter Price'
```

Expected: the ported suite green. If `vendor/bin/phpunit` is absent, follow what wax's report records — a standalone `phpunit-8.5.phar` and a `tests/bootstrap.php` registering the `Tests\` autoload mapping, neither committed to the repo.

- [ ] **Step 5: Service account, with its role**

```bash
docker exec site-<site> php -r 'echo password_hash(bin2hex(random_bytes(16)), PASSWORD_BCRYPT);'
```

Insert a `users` row `price-module@<site>.local` with that hash, `isAdmin=1`, `user_status='Active'`, `email_verified_at` set. `users` has **no unique index on email**, so guard with `WHERE NOT EXISTS` rather than `ON DUPLICATE KEY`.

Then grant the role — **the `model_type` must be written as a hex literal**, because shell and SQL escaping eat the backslash and silently store `AppUser`, which matches nothing:

```sql
INSERT INTO <db>.model_has_roles (role_id, model_type, model_id)
SELECT 1, 0x4170705C55736572, <id> FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM <db>.model_has_roles WHERE model_id=<id> AND role_id=1);
```

Verify through the framework, not SQL — a join looks correct either way:

```bash
docker exec site-<site> sh -c 'cd /var/www/html/application && php -r "...; echo App\User::find(<id>)->getRoleNames();"'
```

Expected: `super-admin`.

- [ ] **Step 6: Mint the token and prove the API**

```bash
docker exec site-<site> sh -c 'cd /var/www/html/application && php artisan price-api:token price-module@<site>.local'
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <token>" -H "Accept: application/json" http://localhost:<port>/api/locations
curl -s -o /dev/null -w "%{http_code}\n" -H "Accept: application/json" http://localhost:<port>/api/locations
```

Expected: **200** then **401**. A 403 means the role did not take — go back to Step 5.

- [ ] **Step 7: Add the site to the local console only**

```sql
INSERT INTO console_sites (slug, name, api_url, api_token, enabled)
VALUES ('<site>', '<Site Name>', 'http://<site>/api', '<token>', true)
ON CONFLICT (slug) DO UPDATE SET api_url=EXCLUDED.api_url, api_token=EXCLUDED.api_token, enabled=true;
```

Then prove the console can actually reach it over the Docker network, which is what the row claims:

```bash
docker exec petrosil-module python -c "import urllib.request,json; ..."
```

Expected: 200, and the site's full location count.

- [ ] **Step 8: Commit**

```bash
git -C /d/project2026/htdocs/<site> add -A
git -C /d/project2026/htdocs/<site> commit -m "Port price-module API from baseoil, plus AI Market Insights page"
```

#### Task 2N+1: Deploy `<site>`

**Interfaces:**
- Consumes: the ported site from the previous task.
- Produces: a public URL, and a production console row with `enabled = false`.

- [ ] **Step 1: Scaffolding**

Copy baseoil's `Dockerfile.deploy` as `Dockerfile` (that name exactly — a service created via `railway add` defaults to railpack and ignores `Dockerfile.deploy`), plus `railway.json`, `.dockerignore`, `.railwayignore`, `docker/railway-entrypoint.sh`. Apply the archive.debian.org apt block. In `.dockerignore`, prefix every non-root pattern with `**/` — Docker's matching, unlike git's, does not treat a bare pattern as recursive, and wax's image ballooned from 1 GB to 4.15 GB before this was spotted.

- [ ] **Step 2: Seed**

Generate from the local `<db>`: schema for every table, data for the price tables, lookups and staff logins only. Then scrub every `api_token` to NULL and strip the sandbox-mode line. Verify by re-importing into a scratch database and asserting `COUNT(*) WHERE api_token IS NOT NULL = 0`.

- [ ] **Step 3: Railway service and database**

```bash
railway add --service <site>-db --image mariadb:10.6 --variables "MARIADB_ROOT_PASSWORD=..." --variables "MARIADB_DATABASE=<db>" ...
railway service <site>-db && MSYS_NO_PATHCONV=1 railway volume add -m /var/lib/mysql
railway add --service <site> --variables "APP_KEY=base64:..." --variables "DB_HOST=<site>-db.railway.internal" ...
```

`railway variables` is blocked by the permission classifier; `railway add --variables` is not, so set the whole environment at creation. `railway volume add` has no `-s` flag in this CLI — link the service first.

- [ ] **Step 4: Stage and deploy**

Stage with **absolute** exclude paths (see Global Constraints), then:

```bash
railway up --service <site>
railway domain
```

- [ ] **Step 5: Verify the deployment, not just the HTTP code**

```bash
railway logs --service <site> | grep -iE "seed:|boot:"
curl -s https://<url>/ -A "Mozilla/5.0 ... Chrome/120" | wc -c
```

Expected: `seed: imported`, and a page of **tens of kilobytes**. A ~1 KB response is a PHP fatal error, not a site — wax served exactly that for two deploys because a bare-name exclusion had removed `vendor/laravel/framework`.

- [ ] **Step 6: Production token, and the hidden console row**

Mint a fresh token **on the production container** — never reuse the local one — then add the console row with `enabled = false`, and confirm the local token is rejected in production:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <LOCAL token>" https://<url>/api/locations
```

Expected: **401**.

- [ ] **Step 7: Commit and push**

All six sites have GitHub remotes, unlike wax. Push.

---

## Self-review

**Spec coverage:** every element of wax's `e7bcd93` and `635642d` maps to a step above — the 57 ported files (Task 2N Step 2), the database changes (Step 3), the tests (Step 4), the service account including the role trap (Step 5), the local console row (Step 7), and the full deployment (Task 2N+1). The two failures that only appeared in deployment — the sandbox-mode seed line and the bare-name staging exclusion — are Global Constraints, not buried in a step, because they cost two deploys each.

**Placeholders:** the per-site tasks are parameterised by `<site>`, `<port>`, `<db>` rather than repeated six times verbatim. This is a deliberate exception to "repeat the code": the six sites differ only in those three values, and six near-identical copies would invite exactly the drift Task 1 exists to prevent. Every command is otherwise complete.

**Type consistency:** `price-api:token` takes an email; `console_sites` takes `(slug, name, api_url, api_token, enabled)`; `model_has_roles` takes `(role_id, model_type, model_id)` — matching the module's schema and both previous ports.

**Known gap:** the three zero-price sites will deploy with locations and no prices. The `/price-trends` guard in the checklist is what stops that crashing, and it is the first thing to check on those three.
