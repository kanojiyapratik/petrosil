# Site-port checklist

`port-price-module.sh` copies the mechanical, verbatim part of the recipe:
controllers, services, models, the token command, the sheet importer, nine
migrations, ten tests, and the price routes appended to `routes/api.php`.

Everything below is what it deliberately leaves for a human, because none of
it can be copied byte-for-byte from baseoil without breaking the target site
or missing something baseoil itself doesn't need. Every item here caused a
real failure on at least one of the three completed sites (baseoil,
bitumart, waxreport) — none of these are hypothetical.

Work through them in order. The verification commands at the end tell you
whether you actually got there, not just whether the code looks right.

---

## 1. The views

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

## 2. `app/Http/Middleware/Authenticate.php`

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

## 3. `app/Exceptions/Handler.php` — `unauthenticated()` override

**Why it can't be scripted:** Laravel's default `unauthenticated()` calls
`redirect()->guest($exception->redirectTo() ?? route('login'))` for any
request that doesn't `expectsJson()`, **regardless of what
`Authenticate::redirectTo()` returns**. Fixing `Authenticate.php` alone (item
2) is not sufficient — a token-less curl request to `/api/*` still gets a 302
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

## 4. `app/Http/Middleware/TrustProxies.php`

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

## 5. `.htaccess`

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

## 6. `.gitignore`

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

## 7. `app/User.php` — hide `api_token`

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

## 8. The `/price-trends` guard

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

Not one of the eight items above, but it will block "run the tests" if
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
# that items 2 and 3 above exist to fix; a 302 here means Handler.php's
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
Expected: green, after the location-fixture edit above. If
`vendor/bin/phpunit` doesn't exist, see wax's `PORT-REPORT.md` for the
`phpunit-8.5.phar` + `tests/bootstrap.php` workaround.

**No mixed content / correct scheme on assets** (TrustProxies, item 4):

```bash
curl -s http://localhost:<port>/ | grep -o 'src="http://[^"]*"' | head -5
```
Expected: no output (no asset is written as a bare `http://` URL while the
proxy forwards `X-Forwarded-Proto: https`).

**`/price-trends` doesn't crash on an unpriced location** (item 8) —
required for fertilizerreport/glycerinereport/methanolreport before anything
else is checked:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<port>/price-trends
```
Expected: 200, not 500.
