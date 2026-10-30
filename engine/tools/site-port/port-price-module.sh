#!/bin/sh
# port-price-module.sh -- copy the price-console API port from baseoil into
# another Petrosil site.
#
# This is the *mechanical* half of the recipe proven on waxreport (commit
# e7bcd93 in that repo). It copies the verbatim files: the four Api
# controllers, the Price service classes (minus PriceReviewGateway, which is
# AI-editorial only and never leaves baseoil), the five price models, the
# token-mint command, the sheet importer, nine migrations stamped with
# today's date, ten feature tests, and a tests/bootstrap.php that registers
# the Tests\ autoload mapping every site is missing (see CHECKLIST.md's test
# infrastructure section for why), then it appends the price routes block to
# routes/api.php. 43 files written per run.
#
# It deliberately does NOT touch: views, Authenticate/TrustProxies/Handler,
# .htaccess, .gitignore, User.php's $hidden, the price-trends null guard, or
# phpunit.xml (its DB_DATABASE value is site-specific -- see CHECKLIST.md).
# Those differ per site or need judgement -- see CHECKLIST.md next to this
# script.
#
# Usage:
#   port-price-module.sh <site-dir> <inner-dir>
#
# Example:
#   tools/site-port/port-price-module.sh /d/project2026/htdocs/titaniumdioxidereport titaniumdioxidereport
#
# Plain sh, coreutils + git only. Run from Git Bash on Windows.

set -eu

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

if [ $# -ne 2 ]; then
    echo "usage: $0 <site-dir> <inner-dir>" >&2
    echo "  e.g.: $0 /d/project2026/htdocs/titaniumdioxidereport titaniumdioxidereport" >&2
    exit 1
fi

SITE_DIR=$1
INNER_DIR=$2

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TEMPLATES_DIR="$SCRIPT_DIR/templates"

# baseoil is the reference implementation. Its application/ is the source of
# truth for every verbatim file this script copies.
BASEOIL_APP="/d/project2026/htdocs/baseoil/baseoil/application"

TARGET_APP="$SITE_DIR/$INNER_DIR/application"

if [ ! -d "$BASEOIL_APP" ]; then
    echo "ERROR: baseoil reference tree not found at $BASEOIL_APP" >&2
    exit 1
fi

if [ ! -d "$TARGET_APP" ]; then
    echo "ERROR: target application directory not found: $TARGET_APP" >&2
    echo "       (expected <site-dir>/<inner-dir>/application)" >&2
    exit 1
fi

TARGET_API_ROUTES="$TARGET_APP/routes/api.php"

if [ ! -f "$TARGET_API_ROUTES" ]; then
    echo "ERROR: $TARGET_API_ROUTES does not exist -- wrong site-dir/inner-dir?" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Re-run guard: never duplicate routes
# ---------------------------------------------------------------------------

if grep -qi "price" "$TARGET_API_ROUTES"; then
    echo "ERROR: $TARGET_API_ROUTES already mentions 'price' -- this site looks" >&2
    echo "       already ported. Refusing to run again to avoid duplicating routes." >&2
    echo "       If this is wrong, remove the price routes block by hand first." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# The verbatim file list
# ---------------------------------------------------------------------------
# Derived from waxreport commit e7bcd93 (the proven-working set on a PHP 7.3
# site) and cross-checked against baseoil's working tree. Two disagreements
# were found and resolved in favour of the *proven* set rather than baseoil's
# tree as-is -- see task-1-report.md for the full reasoning:
#
#   1. Migrations: baseoil implements the four price-batch permissions via a
#      seeder (database/seeds/PermissionSeeder.php), not a migration. A
#      seeder never runs from `php artisan migrate` (the only DB step in the
#      per-site rollout task), so every ported site would 403 the moment a
#      super-admin hit a price endpoint. wax converted this into a ninth
#      migration, safe to run twice, and that migration is what this script
#      installs (from tools/site-port/templates/, not from baseoil).
#
#   2. Tests: baseoil's own tests/Feature/Price/ are unit tests against the
#      service classes in isolation (BulkEditBatchBuilderTest,
#      PriceBatchCommitterTest, etc.) -- superseded on bitumart and again on
#      wax by API-level Feature tests that exercise the actual ported
#      endpoints and auth. wax's PORT-REPORT.md records this as a deliberate
#      departure from baseoil's tree, not an oversight. This script installs
#      wax's 10 feature tests (from templates/), not baseoil's 8 unit tests.
#
# Everything else below is copied verbatim from baseoil's live working tree,
# so a baseoil fix made after this script was written is picked up
# automatically the next time it runs.

# --- Controllers -----------------------------------------------------------
API_CONTROLLERS="
app/Http/Controllers/Api/PriceBatchApiController.php
app/Http/Controllers/Api/PriceCrawlAdminApiController.php
app/Http/Controllers/Api/PriceCrawlApiController.php
app/Http/Controllers/Api/PriceSummaryApiController.php
"

# --- Services/Price, excluding PriceReviewGateway.php (AI-editorial only) --
PRICE_SERVICES="
app/Services/Price/ApiRowsBatchBuilder.php
app/Services/Price/BulkEditBatchBuilder.php
app/Services/Price/LocationMatch.php
app/Services/Price/LocationResolver.php
app/Services/Price/PriceBatchCommitter.php
app/Services/Price/PriceBatchRoller.php
app/Services/Price/PriceBatchSummariser.php
app/Services/Price/PriceCrawlRecorder.php
app/Services/Price/PriceDateParser.php
app/Services/Price/PriceDiffer.php
app/Services/Price/UploadBatchBuilder.php
"

# --- Models ------------------------------------------------------------------
PRICE_MODELS="
app/PriceBatch.php
app/PriceBatchItem.php
app/PriceCrawlActivity.php
app/PriceCrawlUrl.php
app/PriceSummary.php
"

# --- Command + importer ------------------------------------------------------
MISC_FILES="
app/Console/Commands/PriceApiTokenCommand.php
app/Imports/PriceSheetReader.php
"

ALL_BASEOIL_FILES="$API_CONTROLLERS $PRICE_SERVICES $PRICE_MODELS $MISC_FILES"

# --- Migrations --------------------------------------------------------------
# name:source
#   source "baseoil:<path under baseoil application/database/migrations>"
#   source "template:<path under tools/site-port/templates>"
# Order matches wax's e7bcd93 numbering (000001-000009), which is the proven
# dependency-safe order (e.g. analysis columns after price_batches exists).
MIGRATIONS="
add_api_token_to_users_table|baseoil:2026_08_11_000001_add_api_token_to_users_table.php
create_price_batches_table|baseoil:2026_08_10_000001_create_price_batches_table.php
create_price_batch_items_table|baseoil:2026_08_10_000002_create_price_batch_items_table.php
add_index_to_globalprices_table|baseoil:2026_08_10_000003_add_index_to_globalprices_table.php
add_analysis_columns_to_price_batches_table|baseoil:2026_08_12_000001_add_analysis_columns_to_price_batches_table.php
add_price_batch_permissions|template:migration-000006-add_price_batch_permissions.php
create_price_crawl_urls_table|baseoil:2026_08_18_000001_create_price_crawl_urls_table.php
create_price_crawl_activities_table|baseoil:2026_08_18_000002_create_price_crawl_activities_table.php
create_price_summaries_table|baseoil:2026_09_03_000001_create_price_summaries_table.php
"

# --- Feature tests (from templates/, sourced from wax e7bcd93 -- see note above) ---
# Ten files, not nine: PriceApiTokenCommandTest.php was present in e7bcd93's
# diffstat (46 insertions) but missed on the first pass of this script --
# it is the only test that exercises `php artisan price-api:token` itself,
# the command PriceApiTokenCommand.php ports, so it stays in.
TEST_FILES="
HttpsBehindProxyTest.php
LocationResolverTest.php
LocationsApiTest.php
PriceApiTestCase.php
PriceApiTokenCommandTest.php
PriceBatchApiTest.php
PriceBatchCommitTest.php
PriceCrawlApiTest.php
PriceSummaryTest.php
PriceTrendsPageTest.php
"

# --- Test bootstrap (from templates/) ---------------------------------------
# Every site checked so far (baseoil, bitumart, waxreport, titaniumdioxide-
# report) ships vendor/ without dev dependencies and has no Composer in its
# container, so the "Tests\" => "tests/" autoload mapping composer.json's
# autoload-dev declares was never generated. Without it, no test in the
# suite runs -- not even the stock ExampleTest.php the site shipped with.
# The file is identical on every site (it registers the mapping by hand, and
# names nothing site-specific), so it is written here instead of being
# hand-rebuilt per site. It does NOT make vendor/bin/phpunit exist -- see
# CHECKLIST.md's test infrastructure section for the phar + test-database
# steps that are still per-site and still manual.
TEST_BOOTSTRAP="tests-bootstrap.php"

# ---------------------------------------------------------------------------
# Pre-flight: verify every source file exists BEFORE writing anything.
# A partial port that looks successful is the worst outcome here.
# ---------------------------------------------------------------------------

MISSING=""

for rel in $ALL_BASEOIL_FILES; do
    [ -n "$rel" ] || continue
    if [ ! -f "$BASEOIL_APP/$rel" ]; then
        MISSING="$MISSING\n  baseoil:$rel"
    fi
done

for entry in $MIGRATIONS; do
    [ -n "$entry" ] || continue
    src=${entry#*|}
    case "$src" in
        baseoil:*)
            f=${src#baseoil:}
            [ -f "$BASEOIL_APP/database/migrations/$f" ] || MISSING="$MISSING\n  baseoil migration:$f"
            ;;
        template:*)
            f=${src#template:}
            [ -f "$TEMPLATES_DIR/$f" ] || MISSING="$MISSING\n  template migration:$f"
            ;;
    esac
done

for f in $TEST_FILES; do
    [ -n "$f" ] || continue
    [ -f "$TEMPLATES_DIR/tests-Feature-Price/$f" ] || MISSING="$MISSING\n  template test:$f"
done

[ -f "$TEMPLATES_DIR/$TEST_BOOTSTRAP" ] || MISSING="$MISSING\n  template:$TEST_BOOTSTRAP"

# The routes/api.php block is extracted here, in pre-flight, not during the
# write phase. Extracting it last (after 42 other files are already
# written) means a reworded marker line in baseoil -- which has already
# happened once, see task-1-report.md -- kills the run on the last step with
# every other file already in place: a partial port that looks like it
# almost finished. Failing here means nothing has been written yet.
ROUTES_BLOCK=$(sed -n '/^\/\/ Price-batch API:/,$p' "$BASEOIL_APP/routes/api.php")

if [ -z "$ROUTES_BLOCK" ]; then
    MISSING="$MISSING\n  baseoil routes/api.php: no line starting '// Price-batch API:' found (has the comment been reworded?)"
fi

if [ -n "$MISSING" ]; then
    echo "ERROR: missing source file(s), refusing to write a partial port:" >&2
    printf "%b\n" "$MISSING" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Copy
# ---------------------------------------------------------------------------

WRITTEN=0

copy_verbatim() {
    # $1 = path relative to application/, same on both sides
    rel=$1
    src="$BASEOIL_APP/$rel"
    dest="$TARGET_APP/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "wrote: $INNER_DIR/application/$rel"
    WRITTEN=$((WRITTEN + 1))
}

for rel in $ALL_BASEOIL_FILES; do
    [ -n "$rel" ] || continue
    copy_verbatim "$rel"
done

# --- Migrations, stamped with today's date ----------------------------------

TODAY=$(date +%Y_%m_%d)
MIGRATIONS_DIR="$TARGET_APP/database/migrations"
mkdir -p "$MIGRATIONS_DIR"

SUFFIX=1
for entry in $MIGRATIONS; do
    [ -n "$entry" ] || continue
    name=${entry%%|*}
    src=${entry#*|}
    padded=$(printf "%06d" "$SUFFIX")
    dest="$MIGRATIONS_DIR/${TODAY}_${padded}_${name}.php"

    case "$src" in
        baseoil:*)
            f=${src#baseoil:}
            cp "$BASEOIL_APP/database/migrations/$f" "$dest"
            ;;
        template:*)
            f=${src#template:}
            cp "$TEMPLATES_DIR/$f" "$dest"
            ;;
    esac

    echo "wrote: $INNER_DIR/application/database/migrations/${TODAY}_${padded}_${name}.php"
    WRITTEN=$((WRITTEN + 1))
    SUFFIX=$((SUFFIX + 1))
done

# --- Feature tests -----------------------------------------------------------

TESTS_DIR="$TARGET_APP/tests/Feature/Price"
mkdir -p "$TESTS_DIR"

for f in $TEST_FILES; do
    [ -n "$f" ] || continue
    cp "$TEMPLATES_DIR/tests-Feature-Price/$f" "$TESTS_DIR/$f"
    echo "wrote: $INNER_DIR/application/tests/Feature/Price/$f"
    WRITTEN=$((WRITTEN + 1))
done

# --- Test bootstrap (Tests\ autoload mapping) --------------------------------
# Same file on every site -- see the TEST_BOOTSTRAP comment above.

cp "$TEMPLATES_DIR/$TEST_BOOTSTRAP" "$TARGET_APP/tests/bootstrap.php"
echo "wrote: $INNER_DIR/application/tests/bootstrap.php"
WRITTEN=$((WRITTEN + 1))

# --- Append the price routes block to routes/api.php ------------------------
# $ROUTES_BLOCK was extracted and validated in the pre-flight pass above, so
# a reworded marker line in baseoil fails before anything is written, not
# after 42 other files already are.

{
    printf '\n'
    printf '%s\n' "$ROUTES_BLOCK"
} >> "$TARGET_API_ROUTES"

echo "wrote: $INNER_DIR/application/routes/api.php (appended price routes)"
WRITTEN=$((WRITTEN + 1))

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "Port complete: $WRITTEN files written to $INNER_DIR/application/"
echo ""
echo "Not done by this script -- work tools/site-port/CHECKLIST.md next, IN ORDER:"
echo "  - the users zero-date trap, BEFORE 'php artisan migrate' (checklist item 1)"
echo "  - the AI Market Insights view + nav/home/price-trends links (site-specific markup)"
echo "  - Authenticate::redirectTo, Handler::unauthenticated(), TrustProxies::\$proxies"
echo "  - .htaccess (/api/ exemption, dotted-hostname https redirect)"
echo "  - .gitignore (**/storage/framework/, **/storage/logs/)"
echo "  - app/User.php: add api_token to \$hidden"
echo "  - the /price-trends globalPrices[0] guard"
echo "  - phpunit.xml: point DB_DATABASE at a real <db>_test database (checklist:"
echo "    test infrastructure) -- tests/bootstrap.php was already written above"
echo ""
echo "NOTE: the ported tests hardcode a real, always-priced location name"
echo "      ('India Paraffin Wax Full Refined CFR', wax's own fixture)."
echo "      Update the KNOWN_LOCATION / PRICED_LOCATION / LIVE_LOCATION"
echo "      constants in tests/Feature/Price/*.php to a location that exists"
echo "      and carries a price on THIS site before expecting the suite green."
echo "      LocationResolverTest::testItIgnoresCaseAndUntidySpacing ALSO hardcodes"
echo "      a second, hand-mangled copy of that same location name -- a plain"
echo "      constant find-and-replace misses it. See CHECKLIST.md's 'Additional"
echo "      note' section for the exact search command."
