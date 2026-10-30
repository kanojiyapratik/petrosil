"""Entry point: every brand's watched pages, every fifteen minutes.

scraper.main crawls the one site its environment names, which is how each
PHP site had its own crawler. In the Petrosil app every brand is one site
in the engine's own table (console_sites), so this loop walks them all, each
with the provider and model that brand chose, through the same pass the
"Check now" button runs (app.console.crawl_now.crawl_site_now).

A brand that fails -- its API down, no provider, a bad page -- is logged and
skipped; the others are still crawled, and it is tried again next pass.

    MODULE_PROCESS=estate-crawler   (the Dockerfile runs this module)
    DATABASE_URL                    the engine's database, as the API uses
    CRAWL_INTERVAL_SECONDS          default 900
    CRAWL_EXTRACTOR=rules           no model at all, as with scraper.main

Run one pass and exit with ``--once``.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
from typing import Callable, Iterable

logger = logging.getLogger("crawler.estate")

_stopping = False


def _handle_signal(signum, _frame) -> None:
    """Finish the brand in progress, then stop."""
    global _stopping
    _stopping = True
    logger.info("Signal %s received - stopping after this brand.", signum)


def run_estate_pass(sites: Iterable, crawl: Callable, stop: Callable[[], bool] = lambda: False) -> dict:
    """One pass over every enabled brand. Answers {slug: outcome count, or
    the error text} so a pass can be read back in one log line per brand."""
    report: dict = {}

    for site in sites:
        if not getattr(site, "enabled", True):
            continue

        if stop():
            break

        try:
            outcomes = crawl(site)
        except Exception as error:  # noqa: BLE001 - one brand never stops the rest
            logger.error("%s: %s", site.slug, error)
            report[site.slug] = f"failed: {error}"
            continue

        changed = sum(1 for o in outcomes if getattr(o, "status", "") == "read")
        logger.info("%s: %s page(s) checked, %s changed and read.", site.slug, len(outcomes), changed)
        report[site.slug] = len(outcomes)

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Every brand's watched pages, on a loop")
    parser.add_argument("--once", action="store_true", help="run a single pass and exit")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    database_url = os.environ.get("DATABASE_URL", "")

    if not database_url:
        logger.error("DATABASE_URL is not set: the brands are read from the engine's own table.")
        return 1

    # Imported here so `--help` and the tests need no database driver.
    from app.console.crawl_now import crawl_site_now
    from app.db.pool import create_pool
    from app.db.store import ProviderStore, Store

    pool = create_pool(database_url)
    store = Store(pool)
    providers = ProviderStore(pool)
    interval = int(os.environ.get("CRAWL_INTERVAL_SECONDS", "900"))

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    while True:
        # Read every pass: a brand added, switched off or given a new
        # provider on the AI settings screen is picked up without a restart.
        report = run_estate_pass(
            store.sites(),
            # CRAWL_EXTRACTOR is read by crawl_site_now itself.
            lambda site: crawl_site_now(site, providers=providers),
            stop=lambda: _stopping,
        )
        logger.info("Pass complete over %s brand(s).", len(report))

        if args.once or _stopping:
            return 0

        logger.info("Sleeping %ss until the next pass.", interval)
        slept = 0

        # Short steps, so a SIGTERM need not wait out a fifteen-minute nap.
        while slept < interval and not _stopping:
            time.sleep(min(5, interval - slept))
            slept += 5

        if _stopping:
            return 0


if __name__ == "__main__":
    sys.exit(main())
