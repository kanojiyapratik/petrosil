"""Report figures printed in another currency, turned into USD by code.

The client's Russia rule (2026-08-27): the Lube Report prints Tupras' Turkey
prices in lira, excluding VAT. Those are the reference for Russia Domestic
(-10%), which in turn gives Russia FOB (-10%). So the lira figure must
become USD first -- at the exchange rate for the same date as the price,
never a guessed one -- and the rate must be written down, because "how did
Russia get this number" has to be answerable afterwards.

The model reports the figure as printed with its currency and date; this
module does the division. No rate for that date means the figure stays
untouched and the row is marked for a person, so nothing downstream moves.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import requests

from ..price_review.differ import js_number
from ..price_review.summariser import _round2
from .review import FLAG_PCT

# A price dated on a weekend or holiday takes the last working day's rate.
# Anything older than this is a different market and is refused.
MAX_RATE_AGE_DAYS = 3

FRANKFURTER_URL = "https://api.frankfurter.app"


@dataclass(frozen=True)
class FxRate:
    currency: str
    rate: float  # units of `currency` per one USD
    rate_date: str  # ISO date the rate was published for
    source: str


class FrankfurterRates:
    """ECB reference rates via Frankfurter -- free, keyless, date-addressable.

    Asking for a date returns the latest rate published on or before it,
    with the date it was really published, which is what lets convert_rows
    refuse a stale one.
    """

    def __init__(self, session: requests.Session | None = None, timeout: float = 10.0) -> None:
        self._session = session or requests.Session()
        self._timeout = timeout

    def get(self, currency: str, on_date: str) -> FxRate | None:
        try:
            response = self._session.get(
                f"{FRANKFURTER_URL}/{on_date}?from=USD&to={currency}", timeout=self._timeout
            )
        except requests.RequestException:
            return None

        if response.status_code != 200:
            return None

        try:
            body = response.json()
            rate = float(body["rates"][currency])
            published = str(body["date"])
        except (ValueError, KeyError, TypeError):
            return None

        if rate <= 0:
            return None

        return FxRate(currency=currency, rate=rate, rate_date=published, source="ECB")


class CachedRates:
    """Rates looked up once and kept: a draft redone next month must cite the
    same rate it used, and the audit line must be reproducible offline.

    `store.get(currency, date)` / `store.put(date, FxRate)`; a miss from the
    fetcher is never stored, so a rate published later is still picked up.
    """

    def __init__(self, fetcher, store) -> None:
        self._fetcher = fetcher
        self._store = store

    def get(self, currency: str, on_date: str) -> FxRate | None:
        try:
            kept = self._store.get(currency, on_date)
        except Exception:  # noqa: BLE001 - the cache must never cost the draft
            kept = None

        if kept is not None:
            return kept

        rate = self._fetcher.get(currency, on_date)

        if rate is not None:
            try:
                self._store.put(on_date, rate)
            except Exception:  # noqa: BLE001
                pass

        return rate


def convert_rows(
    rows: list[dict], rates, pricedate: str, home: dict[str, str] | None = None
) -> list[dict]:
    """Turns every `foreign` row -- and a dollar figure for a location priced
    in another currency -- into a price in its location's own currency.

    `rates.get(currency, iso_date)` returns an FxRate or None. The price date
    comes from the report when it says one, otherwise the draft's own date.

    `home` maps a site location to the currency it is priced in, as the site
    reports it. The site stores whatever number it is given in that
    location's currency, so a figure must arrive in it: a rupee circular for
    a rupee location is already a price and is left exactly as printed, and
    lira for a euro location becomes euros, not dollars. A location with no
    home -- a dollar site, or a report benchmark, which is not a location at
    all -- becomes USD as it always has.
    """
    home = {name: code.strip().upper() for name, code in (home or {}).items() if code}

    for row in rows:
        target = home.get(row["location"], "USD")

        if row.get("status") == "foreign":
            currency = row["currency"]
        elif row.get("status") == "suggested" and not row.get("currency") and target != "USD":
            # A figure with no currency is a dollar figure (the prompt says
            # so). On a euro or rupee location it is not a price yet: saved
            # as it stands, Argus's $595/t Brussels line became EUR 595
            # against the euro column's EUR 520.
            currency = "USD"
        else:
            continue

        if currency == target:
            # Printed in the currency the location is priced in: nothing to
            # convert, and the change already computed against the current
            # price compares like with like.
            row.update({"status": "suggested", "currency": None})

            continue

        wanted = row.get("price_date") or pricedate
        # The rates are dollars' worth of each currency, so a dollar figure
        # needs no rate of its own.
        rate = (
            FxRate(currency="USD", rate=1.0, rate_date=wanted, source="ECB")
            if currency == "USD"
            else rates.get(currency, wanted)
        )
        # Rates are published per US dollar, so any other destination goes
        # through the dollar: its own rate for the same date is needed too.
        target_rate = None if target == "USD" else rates.get(target, wanted)

        missing = (
            currency if rate is None or not _applicable(rate.rate_date, wanted)
            else target if target != "USD" and (
                target_rate is None or not _applicable(target_rate.rate_date, wanted)
            )
            else None
        )

        if missing is not None:
            row["status"] = "needs_rate"
            row["rationale"] = (
                f"Needs manual review: no {missing}/USD exchange rate for "
                f"{_ddmmyy(wanted)}, so this figure was not converted to {target}. "
                + (row.get("rationale") or "")
            ).strip()

            continue

        def into_target(amount: float) -> float:
            dollars = amount / rate.rate

            return _round2(dollars if target == "USD" else dollars * target_rate.rate)

        printed = row["suggested_price"]
        low = into_target(row["suggested_min"])
        high = into_target(row["suggested_max"])
        price = into_target(printed)
        current = row.get("current_price")
        change = _round2(((price - current) / current) * 100) if current else None
        conversion = (
            f"USD {printed:,.0f} × {target_rate.rate:.4f} {target}/USD "
            f"({target_rate.source} rate of {_ddmmyy(target_rate.rate_date)}) "
            f"= {target} {price:,.2f}"
            if currency == "USD"
            else f"{currency} {printed:,.0f} ÷ {rate.rate:.4f} {currency}/USD "
            f"({rate.source} rate of {_ddmmyy(rate.rate_date)}) = USD {price:,.2f}"
            if target == "USD"
            else f"{currency} {printed:,.0f} ÷ {rate.rate:.4f} {currency}/USD "
            f"× {target_rate.rate:.4f} {target}/USD "
            f"({rate.source} rates of {_ddmmyy(rate.rate_date)}) = {target} {price:,.2f}"
        )

        row.update(
            {
                "status": "suggested",
                "currency": None,
                "suggested_min": js_number(low),
                "suggested_max": js_number(high),
                "suggested_price": js_number(price),
                "change_pct": js_number(change) if change is not None else None,
                "flag": "check" if change is not None and abs(change) >= FLAG_PCT else None,
                "conversion": conversion,
                "fx_rate": target_rate.rate if currency == "USD" else rate.rate,
                "fx_date": target_rate.rate_date if currency == "USD" else rate.rate_date,
                "rationale": (conversion + ". " + (row.get("rationale") or "")).strip(),
            }
        )

    return rows


def _applicable(rate_date: str, price_date: str) -> bool:
    try:
        published = date.fromisoformat(rate_date)
        wanted = date.fromisoformat(price_date)
    except ValueError:
        return False

    age = (wanted - published).days

    return 0 <= age <= MAX_RATE_AGE_DAYS


def _ddmmyy(iso: str) -> str:
    return f"{iso[8:10]}-{iso[5:7]}-{iso[2:4]}" if len(iso) >= 10 else iso
