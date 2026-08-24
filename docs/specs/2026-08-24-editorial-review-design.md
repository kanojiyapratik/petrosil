# AI Editorial Price Update — design (2026-08-24)

Approved by the owner in chat, 2026-08-24. Modelled on the sample sheet
`Base_Oil_FOB_Prices_AI_Editorial_Update.xlsx`: an editor uploads market
reports (Lube Report docx/pdf/txt), and gets back, per active price location,
a draft — current price, suggested range, confidence, basis, source reference
and a one-line rationale — to review and stage as a normal draft price batch.

## Rulings this design follows

- One module, deployed once, that any site calls. The module is headless and
  stateless: the site renders the preview and does its own commit.
- Everything AI lives in the Python module. baseoil (PHP 7.3, vendor
  pre-committed) gains no new dependencies — document parsing happens here.
- Code computes every number the editor acts on (midpoint, % change, outlier
  flags); the model only proposes ranges and narrates evidence, and every row
  it returns is validated before it is shown.

## Module: `POST /api/editorial-reviews`

Multipart, behind the same bearer `PRICE_API_TOKEN`:

- `payload` — JSON string: `{price_date, current_prices: [{location, price}],
  model?, title?}`. `current_prices` is the site's list of ACTIVE locations
  with their latest published price; the module never guesses which locations
  exist (site-agnostic, like /api/price-reviews).
- `documents` — 1–5 files, docx/pdf/txt, each ≤ 10 MB. docx is read with the
  standard library (zipfile + XML); pdf reuses `scraper.pdf.pdf_to_text`.

The prompt hands the model the extracted document text plus the exact list of
location names, and demands a strict JSON array keyed by those names:
`{location, suggested_min, suggested_max, confidence, basis, source,
rationale}`. Parsing is defensive: fenced JSON is unwrapped; a row naming an
unknown location is dropped and counted; a location with no row comes back as
`no_evidence`; a row with unusable numbers comes back as `invalid`.

Computed in code per suggested row: `suggested_price` (midpoint),
`change_pct` vs the current price, and `flag` = `check` when the midpoint
moves ≥ 50% or the range does not contain a plausible move (mirrors the
suspected-errors floor).

Responses: `201` rows + summary + model/token metadata; `422` bad payload;
`502` provider failure (unlike price-reviews there is nothing useful without
the model, so no partial result). A model decline is still `201` with
`status: declined` and no rows.

Provider selection mirrors `/api/price-reviews`: the console's default
provider when configured, else the boot Gemini driver.

## The console is the one screen (owner correction, 2026-08-24)

First built as a baseoil admin page; the owner corrected it the same day: the
module's console is the single place an editor manages every site's prices,
and the sites are reached only through their APIs. The baseoil UI was removed
and replaced by:

- **Console screen** `/console/sites/{slug}/editorial`
  (`app/console/routes_editorial.py`, template `editorial.html`): upload the
  reports, the console fetches the site's live locations and latest prices
  over the site API, runs the draft with the console-configured AI provider,
  renders the sample-sheet-shaped table (editable price defaulting to the
  midpoint, flagged/no-evidence rows called out), and stages the ticked rows
  back onto the site via `POST /api/price-batches/rows` with
  `source=editorial`. Commit happens on the console's existing batch screen.
- **baseoil API only**: `GET /api/locations` now carries `latest_price` +
  `latest_pricedate` per live location; `POST /api/price-batches/rows`
  accepts `source` (`api`|`editorial`); `PriceBatch::SOURCE_EDITORIAL` labels
  the batch "AI editorial update". No web routes, no views.
- `SiteClient.stage_rows()` is the console's staging call.

`POST /api/editorial-reviews` (above) remains the headless equivalent for any
caller that wants the draft as JSON.

## Out of scope (v1)

Fetching reports by URL (the crawler covers URLs), auto-publish without an
editor, per-site provider overrides beyond what the console already does.
