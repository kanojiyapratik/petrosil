# Crawler feasibility probes — 2026-08-14

Evidence behind the decision to build the daily price crawler in **Node, not Python**.
Nothing here is module code; it is throwaway research kept so the finding can be re-checked.

## Run them

```bash
node crawl-probe.mjs      # no deps
node extract-probe.mjs    # no deps
node pw-probe.mjs         # needs: npm i playwright && npx playwright install chromium
```

## What they showed

| Probe | Target | Result |
|---|---|---|
| `crawl-probe.mjs` | eia.gov | 200, prices in static HTML, 400ms, zero deps |
| `crawl-probe.mjs` | oilprice.com | 200 but **no prices** — JS-rendered |
| `crawl-probe.mjs` | opec.org | **403** — Cloudflare bot block |
| `extract-probe.mjs` | eia.gov | robots.txt + SHA-256 change-hash + a real regional price table |
| `pw-probe.mjs` | oilprice.com | **prices recovered** (81.77 / 87.22 / 88.55) in 5.7s |
| `pw-probe.mjs` | opec.org | **403 → 200**, block cleared in 8.1s |

Both `fetch` failures are language-independent: Python's `requests` hits the identical 403 and
the identical price-free HTML. The fix in both cases is a real browser, and Playwright is a Node
project first. Scrapy's advantage only appears at thousands of pages; this job is ~5 URLs/day.

Caveat: the OPEC URL now renders a generic press page rather than the basket table — the page
moved. A URL problem, not a crawler problem.

Only remaining argument for Python would be heavy PDF table extraction (`pdfplumber`).
