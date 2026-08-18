"""Entry point: check the site's watched URLs, sleep, repeat.

A plain loop rather than cron or a scheduler library. The work is one pass
over a handful of URLs; a loop is easy to reason about, keeps the HTTP
session (and its connection pool and robots.txt cache) warm between passes,
and makes the container's own restart policy the only supervisor involved.

Run a single pass and exit with ``--once``, which is what a manual re-check
and the smoke test use.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time

from . import config as config_module
from .ai import GeminiExtractor
from .fetcher import Fetcher
from .runner import run_once
from .site import SiteClient, SiteError

logger = logging.getLogger("crawler")

_stopping = False


def _handle_signal(signum, _frame) -> None:
    """Finish the pass in progress, then stop. Dying mid-pass would leave the
    site holding results for some URLs and nothing for the rest."""
    global _stopping
    _stopping = True
    logger.info("Signal %s received - stopping after this pass.", signum)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Petrosil price URL crawler")
    parser.add_argument("--once", action="store_true", help="run a single pass and exit")
    parser.add_argument("--log-level", default="INFO", help="DEBUG, INFO, WARNING, ERROR")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        config = config_module.load()
    except config_module.ConfigError as error:
        logger.error("%s", error)
        return 1

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    client = SiteClient(
        base_url=config.site_api_url,
        token=config.site_api_token,
        timeout_seconds=config.site_timeout_seconds,
    )
    fetcher = Fetcher(user_agent=config.user_agent, timeout_seconds=config.timeout_seconds)
    extractor = GeminiExtractor(api_key=config.api_key, model=config.model)

    while True:
        _pass(client, fetcher, extractor, config)

        if args.once or _stopping:
            return 0

        logger.info("Sleeping %ss until the next pass.", config.interval_seconds)

        # Slept in short steps so a SIGTERM does not have to wait out a
        # fifteen-minute nap before the container can stop.
        slept = 0

        while slept < config.interval_seconds and not _stopping:
            time.sleep(min(5, config.interval_seconds - slept))
            slept += 5

        if _stopping:
            return 0


def _pass(client, fetcher, extractor, config) -> None:
    """One pass. A site that is down must not kill the loop -- the next pass
    is fifteen minutes away and the site will probably be back."""
    try:
        outcomes = run_once(client, fetcher, extractor, config)
    except SiteError as error:
        logger.error("%s", error)
        return

    if not outcomes:
        logger.info("The site has no URLs enabled - nothing to check.")
        return

    for outcome in outcomes:
        logger.info(
            "%s -> %s (rows=%s ai=%s)%s",
            outcome.url,
            outcome.status,
            outcome.row_count,
            "yes" if outcome.used_ai else "no",
            f" error={outcome.error}" if outcome.error else "",
        )

    logger.info(
        "Pass complete: %s URLs, %s used the model.",
        len(outcomes),
        sum(1 for outcome in outcomes if outcome.used_ai),
    )


if __name__ == "__main__":
    sys.exit(main())
