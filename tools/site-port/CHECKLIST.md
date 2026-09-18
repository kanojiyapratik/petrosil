# Site-port checklist

`port-price-module.sh` copies the mechanical, verbatim part of the recipe:
controllers, services, models, the token command, the sheet importer, nine
migrations, ten tests, a `tests/bootstrap.php` (identical on every site, so
the script writes it instead of it being rebuilt by hand each time), and the
price routes appended to `routes/api.php`.

Everything below is what it deliberately leaves for a human, because none of
it can be copied byte-for-byte from baseoil without breaking the target site
or missing something baseoil itself doesn't need. Every item here caused a
real failure on at least one of the four completed sites (baseoil, bitumart,
waxreport, titaniumdioxidereport) — none of these are hypothetical.

Work through them in order. The verification commands at the end tell you
whether you actually got there, not just whether the code looks right.

---

## 1. Zero-date `users` rows block the migration

**Do this before running `php artisan migrate`.**

**Why it can't be skipped:** `add_api_token_to_users_table` runs a plain
`ALTER TABLE users ADD COLUMN api_token ...`. Under MySQL's
`STRICT_TRANS_TABLES`, adding a column rebuilds the table, and the rebuild
re-validates every existing row against the current column types — including
columns the migration never touches. Any row with a legacy zero date
(`'0000-00-00 00:00:00'`) in a datetime/timestamp column is rejected outright:
`SQLSTATE[22007]: Invalid datetime value: '0000-00-00 00:00:00'`. This has
stopped the port on both sites tried so far — titaniumdioxidereport (8 rows,
`created_at`) and waxreport (2 rows, `email_verified_at` — a *different*
column, same trap). Two for two is enough to expect it on every site, not
rediscover it.

**Detect it first, and read the count** — it will differ per site:

```bash
docker exec petrosil-db mysql -uroot -proot -N -e \
  "SELECT COUNT(*) FROM <db>.users WHERE created_at = '0000-00-00 00:00:00'
     OR updated_at = '0000-00-00 00:00:00'
     OR email_verified_at = '0000-00-00 00:00:00';"
```

Zero is a valid, clean answer — if you get it, skip straight to `php artisan
migrate`.

**The repair, if the count is non-zero.** Say plainly what this is: a real
data change to a real table, not a script tweak or a migration change. Point
the affected column at another real timestamp already on the same row —
`updated_at` was always populated on both sites so far, so it was the target
both times:

```sql
UPDATE <db>.users SET created_at = updated_at
  WHERE created_at = '0000-00-00 00:00:00';

-- repeat for any other column the detection query found affected, e.g.:
UPDATE <db>.users SET email_verified_at = updated_at
  WHERE email_verified_at = '0000-00-00 00:00:00';
```

**Count again after the repair**, and keep both numbers (before and after) in
whatever record you're keeping of this port — titaniumdioxidereport's was "8
rows, `created_at`, fixed; 0 after":

```bash
docker exec petrosil-db mysql -uroot -proot -N -e \
  "SELECT COUNT(*) FROM <db>.users WHERE created_at = '0000-00-00 00:00:00'
     OR updated_at = '0000-00-00 00:00:00'
     OR email_verified_at = '0000-00-00 00:00:00';"
```

Expected: 0. Only then run `php artisan migrate`.

---

## 2. The views

**Why it can't be scripted:** each site's `home.blade.php`,
`layouts/nav.blade.php`, `layouts/front.blade.php` and
`front/location/index.blade.php` have their own markup, their own CSS
classes, their own layout structure. Copying baseoil's HTML wholesale
produces a page that visibly does not belong on the site. On waxreport this
was done by reading the site's *existing* templates first, then writing the
insights page and the nav/home/price-trends links to match.

**What to do:**

1. Read the target site's current `resources/views/home.blade.php`,
   `resources/views/layouts/nav.blade.php`,
   `resources/views/layouts/front.blade.php` and
   `resources/views/front/location/index.blade.php` to learn its markup
   conventions (card components, class names, icon usage).
2. Write `resources/views/front/insights/index.blade.php` in that style. It
   renders the `PriceSummary` rows the console writes on commit (plain-English
   notes, no figures) — see baseoil's
   `app/Http/Controllers/HomeController.php` methods `locations()` /
   `aiMarketInsights()` and baseoil's own
   `resources/views/front/insights/index.blade.php` for the data shape, not
   the markup.
3. Add the route to `routes/web.php`:
   ```php
   Route::get('ai-market-insights', 'HomeController@aiMarketInsights')->name('aiMarketInsights');
   ```
4. Add an `aiMarketInsights()` method to `HomeController.php` that loads
   `PriceSummary` rows and returns the new view (mirror baseoil's method —
   the controller is otherwise site-specific and must not be overwritten).
5. Link the page from the homepage, `layouts/nav.blade.php`, and
   `front/location/index.blade.php`, matching how the site already links its
   other secondary pages.

**Wording constraint.** This is the one place in the whole port where an
executor writes new copy a site visitor actually reads, so it is the one
place the plan's screen-wording rule applies: **follow the owner's
vocabulary — read / check / use** for labels, links and headings on the
insights page and its nav/home links. Never write "extraction", "parsed",
"derived", "benchmark" or "rulebook" in anything a person reads (internal
code comments are fine — this is about visible copy only). If the site's
own existing pages already use different plain-English verbs for the same
action, match the site over this list; the point is owner-vocabulary,
plain-English wording, not this exact set of words.

**Verify:** visit `/ai-market-insights` on the target site. It should render
with the site's own header/footer/styling, and show "no notes yet" (or
equivalent) cleanly with zero summaries — this is every site's day-one state.

---

## 3. `app/Http/Middleware/Authenticate.php`

**Why it can't be scripted:** `expectsJson()` alone is not enough. Both curl
and a browser typing the API URL directly send **no `Accept` header**, so
`expectsJson()` returns false for both, and Laravel's `redirect()->guest()`
path tries to flash the intended URL onto the session — which throws
`Session store not set on request` for the stateless `api` middleware group,
turning an unauthenticated call into a 500 instead of a 401.
`!$request->hasSession()` is the guard that actually distinguishes "this is
an API-shaped request" from "this is a browser session."

**Exact change** (whole file):

```php
<?php

namespace App\Http\Middleware;

use Illuminate\Auth\Middleware\Authenticate as Middleware;

class Authenticate extends Middleware
{
    protected function redirectTo($request)
    {
        if ($request->expectsJson() || !$request->hasSession()) {
            return null;
        }

        return route('login');
    }
}
```

---

## 4. `app/Exceptions/Handler.php` — `unauthenticated()` override

**Why it can't be scripted:** Laravel's default `unauthenticated()` calls
`redirect()->guest($exception->redirectTo() ?? route('login'))` for any
request that doesn't `expectsJson()`, **regardless of what
`Authenticate::redirectTo()` returns**. Fixing `Authenticate.php` alone (item
3) is not sufficient — a token-less curl request to `/api/*` still gets a 302
to `/login` without this override.

**Add to `Handler.php`** (inside the `Handler` class):

```php
protected function unauthenticated($request, \Illuminate\Auth\AuthenticationException $exception)
{
    if ($request->expectsJson() || $request->is('api/*')) {
        return response()->json(['message' => $exception->getMessage()], 401);
    }

    return redirect()->guest($exception->redirectTo() ?? route('login'));
}
```

---

## 5. `app/Http/Middleware/TrustProxies.php`

**Why it can't be scripted:** whatever terminates TLS in front of the app
(Docker's port mapping locally, Railway's edge in production) forwards plain
HTTP with `X-Forwarded-Proto: https`. Left untrusted, Laravel thinks the
request is insecure and generates every asset/action URL as `http://` on a
page served over `https://` — the browser blocks those as mixed content.

**Exact change:**

```php
protected $proxies = '*';
```

(`'*'` is correct because the only way in is through a proxy. If a site is
ever exposed directly to the internet as well, narrow this to the proxy's
actual addresses.)

---

## 6. `.htaccess`

**Why it can't be scripted:** two independent problems live in the same
file, and both were hit for real:

- The user-agent blocklist rejects anything claiming to be `python`, `curl`,
  etc. — which is exactly what the price-console module's HTTP client says.
  Without an exemption, every API call gets blocked at the web server, before
  Laravel even sees it.
- The forced-https redirect fires for **any** hostname, including a bare
  Docker service name (`http://titaniumdioxidereport/...`) that has no TLS
  listener — the redirect sends the caller somewhere nothing answers.

**Exact changes:**

Exempt `/api/` from the user-agent blocklist by adding a condition
immediately before the final blocklist `RewriteRule`:

```apache
# ...but never for /api/, which the price module calls with a bearer token.
# THE_REQUEST rather than REQUEST_URI: these rules run a second time after
# the front controller rewrites the URI to index.php, and only THE_REQUEST
# still holds the address that was actually asked for.
RewriteCond %{THE_REQUEST} !\s/+api/ [NC]

RewriteRule ^(.*)$ - [F,L]
```

Force https only for hostnames containing a dot:

```apache
RewriteCond %{HTTP_HOST} \.
RewriteCond %{HTTP:X-Forwarded-Proto} !https
RewriteCond %{HTTPS} off
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
```

---

## 7. `.gitignore`

**Why it can't be scripted:** a pattern with a middle slash
(`storage/framework/`) is anchored to the **repo root** in git's
`.gitignore` syntax, so it never matches `<site>/application/storage` in
this layout, where the Laravel app lives one directory below the repo root.
This is not cosmetic — it committed 1,975 compiled Blade views and
laravel-excel temp files on bitumart before anyone noticed.

**Add:**

```
**/storage/framework/
**/storage/logs/
```

(`storage/framework/` / `storage/logs/` without a leading `**/` — even if
already present — do nothing useful in this layout; leave them or remove
them, but the `**/`-prefixed lines are the ones that matter.)

---

## 8. `app/User.php` — hide `api_token`

**Why it can't be scripted:** `api_token` is added to `$fillable` by the
ported migration, but nothing hides it from serialization. Any endpoint that
returns a `User` model as JSON — including ones unrelated to the price
module — would leak the bearer token in the response body.

**Exact change:**

```php
protected $hidden = [
    'password', 'remember_token', 'api_token',
];
```

---

## 9. The `/price-trends` guard

**Why it can't be scripted:** `resources/views/globalprice/locations.blade.php`
and (unfixed) `front/location/index.blade.php` reach directly into
`$location->globalPrices[0]->pricedate`. A location the desk has just added
— or, on fertilizerreport/glycerinereport/methanolreport, **every** location,
since those three sites currently hold zero prices — has no `globalPrices[0]`,
and the page throws instead of rendering. This has been present on every
site checked so far.

**Exact change**, in `resources/views/front/location/index.blade.php`
(inside the location loop, replacing the direct `globalPrices[0]` access):

```blade
{{-- A location the desk has just added has no price yet. Reaching
     straight into globalPrices[0] took the whole page down for any such
     location. --}}
@php $latestPrice = $location->globalPrices->first(); @endphp
...
@if ($latestPrice)
    ... {{ $latestPrice->price }} price on {{ date("d-M-y", strtotime($latestPrice->pricedate)) }}
@else
    no price published yet
@endif
```

Apply the same `isset($location->globalPrices[0])` guard pattern anywhere
else in the site's views that indexes into `globalPrices[0]` directly
(`resources/views/globalprice/locations.blade.php` is the other place this
was found on both baseoil and waxreport).

**This item is the first thing to check on fertilizerreport, glycerinereport
and methanolreport** — they deploy with locations and no prices at all.

---

## Additional note: test fixtures name a real location

Not one of the nine items above, but it will block "run the tests" if
skipped: five of the ten ported test files (`tests/Feature/Price/*.php`) hardcode
`'India Paraffin Wax Full Refined CFR'` — wax's own always-priced location —
as `KNOWN_LOCATION` / `PRICED_LOCATION` / `LIVE_LOCATION` in
`LocationResolverTest.php`, `LocationsApiTest.php`, `PriceBatchApiTest.php`,
`PriceBatchCommitTest.php`, `PriceCrawlApiTest.php` and (as a literal string)
`PriceTrendsPageTest.php`. Before running the suite on a new site, change
that constant/string in each file to a location that actually exists **and
carries a price** on that site. On fertilizerreport/glycerinereport/
methanolreport (currently zero prices), use `PriceApiTestCase::makeLocation()`
and manually insert a `globalprices` row for it in the test's `setUp()`
instead — there is no real priced location to point at yet.

**Retargeting the constants alone is incomplete — check for every occurrence,
not just one substitution.** `LocationResolverTest::testItIgnoresCaseAndUntidySpacing`
hardcodes a *second*, independent copy of the same location name, typed by
hand rather than built from the constant: `'  india   paraffin wax full refined cfr '` — deliberately
lowercased and re-spaced, because the test exists to prove the resolver
tolerates exactly that kind of untidiness. A find-and-replace on the tidy
`KNOWN_LOCATION`/`PRICED_LOCATION`/`LIVE_LOCATION` string leaves this one
behind, and titaniumdioxidereport's port hit it for real: the suite fails
with `'unmatched'` where it expects `'matched'` (or vice versa) — a real,
confusing diff that looks like a resolver bug, not a leftover fixture. Recognise
that failure mode: if a resolver test fails on `MATCHED`/`AMBIGUOUS`/`UNMATCHED`
status *after* the constants have already been retargeted, this is almost
certainly it.

Don't rely on the constant names to find every copy. Run this across the
whole test directory instead — it matches the tidy name and any hand-mangled
casing/spacing of it in one pass, so nothing is left behind:

```bash
grep -rniE "india\s+paraffin\s+wax\s+full\s+refined\s+cfr" tests/Feature/Price/
```

Every line it returns must be changed to the target site's own location
before the suite is trusted green — including the untidy-spacing literal
above, once it's rewritten to match a location that actually exists on this
site (untidied the same way: different case, extra/odd spacing) so the test
still proves what it's meant to prove.

---

## Test infrastructure: `vendor/bin/phpunit` doesn't exist

Not one of the nine items above either, but every site checked so far —
baseoil, bitumart, waxreport, titaniumdioxidereport — ships `vendor/`
pre-committed **without** dev dependencies, and none of these containers has
Composer to fix it. That means `vendor/bin/phpunit` is absent and the
`Tests\` → `tests/` autoload mapping `composer.json`'s `autoload-dev` declares
was never generated — not even the site's own stock `tests/Feature/ExampleTest.php`
runs without it. Waxreport and titaniumdioxidereport each rebuilt the same
four things by hand; this section is that procedure, folded into the kit so
the third site doesn't rebuild it a third time.

1. **The `Tests\` autoload mapping.** `port-price-module.sh` now writes
   `tests/bootstrap.php` for you (from `tools/site-port/templates/tests-bootstrap.php`
   — see "wrote: .../tests/bootstrap.php" in the script's own output). Nothing
   to do here unless that line is missing from the run, in which case treat
   it as a broken port, not a skippable step.

2. **A standalone phpunit**, fetched straight into the container and kept out
   of the repo, the same way both earlier sites did it:
   ```bash
   docker exec site-<site> sh -c 'curl -sL -o /tmp/phpunit-8.5.phar https://phar.phpunit.de/phpunit-8.5.phar'
   ```
   (8.5 is the line already pinned in these sites' `composer.lock`; it has run
   clean on both PHP 7.3 and PHP 8 containers so far.)

3. **`phpunit.xml`**: confirm `bootstrap="tests/bootstrap.php"` (the stock
   file already points there — check, don't assume it wasn't changed), and
   repoint the `<php>` block's `DB_*` server vars at a real MySQL test
   database instead of the stock sqlite `:memory:`:
   ```xml
   <server name="DB_CONNECTION" value="mysql"/>
   <server name="DB_HOST" value="db"/>
   <server name="DB_PORT" value="3306"/>
   <server name="DB_DATABASE" value="<db>_test"/>
   <server name="DB_USERNAME" value="root"/>
   <server name="DB_PASSWORD" value="root"/>
   ```
   Use the site's **actual** database name for `<db>` — check with
   `SHOW DATABASES;` rather than assuming it matches the folder name.
   Waxreport's folder is `waxreport` but its database is `waxreports`
   (plural); pointing at the wrong one produces a test database that imports
   cleanly and is simply empty.

4. **The test database itself** — a real copy of the live schema and data,
   not an empty one, because the price code this suite covers depends on
   actual tables and real MySQL behaviour:
   ```bash
   docker exec petrosil-db sh -c 'mysqldump -uroot -proot <db> | mysql -uroot -proot <db>_test'
   ```
   Rebuild it the same way after any schema change (a fresh `php artisan
   migrate` on the live `<db>` included).

Run with:
```bash
docker exec site-<site> sh -c 'cd /var/www/html/application && php /tmp/phpunit-8.5.phar --filter Price'
```
Expected: green, once the fixture retargeting above (including the
untidy-spacing literal) is done.

---

## Verification commands

Run these after the checklist above and the database steps in the plan
(`php artisan migrate`, the service-account role grant). They tell success
from a plausible-looking failure — a **403** below means the role did not
take (go back and re-check the `model_has_roles` insert), not that the API
is broken.

**The role, through the framework — not SQL.** A SQL join against
`model_has_roles` looks correct even when `model_type` was stored as the
literal string `AppUser` (backslash eaten by shell/SQL escaping) instead of
`App\User`, which then matches nothing Eloquent asks for:

```bash
docker exec site-<site> sh -c 'cd /var/www/html/application && php -r "
require \"vendor/autoload.php\";
\$app = require \"bootstrap/app.php\";
\$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
echo App\User::find(<id>)->getRoleNames();
"'
```
Expected output: `super-admin`

**The API, with and without a token:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <token>" -H "Accept: application/json" \
  http://localhost:<port>/api/locations
# Expected: 200

curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Accept: application/json" \
  http://localhost:<port>/api/locations
# Expected: 401

curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:<port>/api/locations
# Expected: 401 (no Accept header at all -- the curl/browser-address-bar case
# that items 3 and 4 above exist to fix; a 302 here means Handler.php's
# override is missing, a 500 means Authenticate.php's hasSession() guard is
# missing)
```

**The permissions migration took effect** (belt-and-braces alongside the
role check above):

```bash
docker exec petrosil-db mysql -uroot -proot -e \
  "SELECT name FROM <db>.permissions WHERE name LIKE 'price-batch-%';"
```
Expected: 4 rows (`price-batch-view`, `price-batch-create`,
`price-batch-commit`, `price-batch-rollback`)

**Tests:**

```bash
docker exec site-<site> sh -c 'cd /var/www/html/application && vendor/bin/phpunit --filter Price'
```
Expected: green, after the location-fixture edit above. `vendor/bin/phpunit`
has not existed on any site ported so far — see "Test infrastructure" above
for the procedure (a standalone phar in place of this exact command), folded
into the kit rather than left as a pointer to another site's report.

**No mixed content / correct scheme on assets** (TrustProxies, item 5):

```bash
curl -s http://localhost:<port>/ | grep -o 'src="http://[^"]*"' | head -5
```
Expected: no output (no asset is written as a bare `http://` URL while the
proxy forwards `X-Forwarded-Proto: https`).

**`/price-trends` doesn't crash on an unpriced location** (item 9) —
required for fertilizerreport/glycerinereport/methanolreport before anything
else is checked:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<port>/price-trends
```
Expected: 200, not 500.
