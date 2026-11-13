"""Monthly trade quantities from government statistics.

The site says which sheets it fills from where (its trade feeds) and which
months each is missing; this package reads those months from the sources
and reports one result per feed and month. It never writes figures itself:
the site stages them for review, as it does crawled prices.
"""

from __future__ import annotations

import logging
import time
from decimal import ROUND_HALF_UP, Decimal
from typing import Callable

import requests

from . import comtrade, india, japan, korea, singapore, thailand
from .base import Figure, MonthResult, NoData, SourceError, sheet_unit

logger = logging.getLogger("crawler.trade")

SOURCES: dict[str, Callable[..., MonthResult]] = {
    "thailand": thailand.fetch,
    "japan": japan.fetch,
    "india": india.fetch,
    "singapore": singapore.fetch,
    "korea": korea.fetch,
    "comtrade": comtrade.fetch,
}

_THOUSANDS = {"MT", "TON", "TONNE", "TONNES", "TNE", "KL", "KLT"}


def _in_thousands(figure: Figure) -> Decimal:
    unit = figure.unit.strip().upper()

    if unit in _THOUSANDS:
        return figure.quantity

    if unit in {"KG", "KGS", "KGM", "LTR", "L", "LITRE", "LITRES"}:
        return figure.quantity / 1000

    raise SourceError(f"The source gave a quantity in {figure.unit!r}, which we do not know how to convert.")


def fetch_month(
    source: str,
    codes: list[str],
    year: int,
    month: int,
    flow: str,
    reporter_iso2: str | None = None,
    session: requests.Session | None = None,
) -> dict:
    """Every code's figures for the month, summed per partner and put in the
    sheets' terms: thousands of the source's unit, rounded half up at the
    end (rounding each code first would drift from the hand-entered sums).

    Raises NoData when no code has figures, SourceError when a source fails.
    """
    fetcher = SOURCES.get(source)

    if fetcher is None:
        raise SourceError(f"No trade source called {source!r}.")

    session = session or requests.Session()
    totals: dict[str, Decimal] = {}
    codes_of: dict[str, str | None] = {}
    units: set[str] = set()
    urls: list[str] = []
    found = False

    for code in codes:
        kwargs = {"code": code, "year": year, "month": month, "flow": flow}

        if source == "comtrade":
            kwargs["reporter"] = reporter_iso2 or ""

        try:
            result = fetcher(session, **kwargs)
        except NoData:
            continue

        found = True

        if result.source_url:
            urls.append(result.source_url)

        for figure in result.figures:
            key = figure.iso2.upper() if figure.iso2 else figure.partner.strip().lower()
            totals[key] = totals.get(key, Decimal(0)) + _in_thousands(figure)
            codes_of.setdefault(key, figure.iso2.upper() if figure.iso2 else None)
            units.add(sheet_unit(figure.unit))
            codes_of[f"name:{key}"] = figure.partner

    if not found:
        raise NoData("No figures for that month yet.")

    partners = []

    for key, total in totals.items():
        qty = total.quantize(Decimal("1"), rounding=ROUND_HALF_UP)

        # A partner under half a unit rounds to nothing; the sheets never
        # held zeros, so it is left out as the team left it out.
        if qty <= 0:
            continue

        partners.append({"partner": codes_of[f"name:{key}"], "iso2": codes_of.get(key), "qty": str(qty)})

    partners.sort(key=lambda row: -Decimal(row["qty"]))

    return {
        "partners": partners,
        "unit": "LTR" if units == {"LTR"} else "KGS",
        "source_url": urls[0] if urls else None,
    }


def run_trade_pass(client, session: requests.Session | None = None, pause: float = 1.0) -> list[dict]:
    """One pass over the site's feeds: fetch each missing month, oldest
    first, and stop a feed at its first month the source has not published
    (the later ones cannot be out either). Reports the pass in one call."""
    session = session or requests.Session()
    payload = client.trade_feeds()
    results: list[dict] = []

    for feed in payload.get("feeds", []):
        for period in feed.get("months", []):
            year, month = (int(part) for part in period.split("-")[:2])
            entry = {"feed_id": feed["id"], "month": f"{year:04d}-{month:02d}"}

            try:
                found = fetch_month(feed["source"], list(feed["hs_codes"]), year, month, feed["kind"],
                                    feed.get("reporter_iso2"), session)
                entry.update(status="read", **found)
            except NoData as reason:
                entry.update(status="no_data", error=str(reason))
                results.append(entry)
                break
            except SourceError as error:
                entry.update(status="failed", error=str(error))
                results.append(entry)
                break
            except Exception as error:  # noqa: BLE001 - one feed never stops the rest
                logger.exception("trade feed %s failed", feed.get("id"))
                entry.update(status="failed", error=f"Unexpected error: {error}")
                results.append(entry)
                break

            results.append(entry)
            time.sleep(pause)

    if results:
        return client.report_trade(results)

    return []


__all__ = ["SOURCES", "fetch_month", "run_trade_pass", "NoData", "SourceError"]
