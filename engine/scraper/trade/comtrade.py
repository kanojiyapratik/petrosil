"""UN Comtrade, for any reporter at six-digit HS, monthly, net weight in kg.

The fallback for a country whose own statistics we cannot read (South
Korea until its key is set). Months arrive later than at the national
source -- two to eleven months depending on the reporter -- and six digits
cannot single out base oil within 2710.19.

With COMTRADE_API_KEY set the subscription endpoint is used; without one,
the public preview (one period per call, which is all we ask for).
"""

from __future__ import annotations

import os
from decimal import Decimal

import requests

from .base import Figure, MonthResult, NoData, SourceError

PREVIEW = "https://comtradeapi.un.org/public/v1/preview/C/M/HS"
KEYED = "https://comtradeapi.un.org/data/v1/get/C/M/HS"

# Comtrade's numeric reporter codes for the countries the brands report.
REPORTERS = {"SG": 702, "TH": 764, "KR": 410, "IN": 699, "JP": 392}


def parse(rows: list[dict]) -> list[Figure]:
    figures: list[Figure] = []

    for row in rows:
        partner = str(row.get("partnerDesc") or "").strip()

        if not partner or partner.lower() == "world" or row.get("partnerCode") in (0, "0"):
            continue

        weight = row.get("netWgt") or row.get("qty")

        if weight in (None, "", 0):
            continue

        figures.append(Figure(partner=partner, quantity=Decimal(str(weight)), unit="KG", iso2=row.get("partnerISO") or None))

    return figures


def fetch(session: requests.Session, *, code: str, year: int, month: int, flow: str, reporter: str, timeout: int = 60) -> MonthResult:
    reporter_code = REPORTERS.get(reporter.upper())

    if reporter_code is None:
        raise SourceError(f"Comtrade is not set up for reporter {reporter}.")

    key = os.environ.get("COMTRADE_API_KEY", "")
    params = {"reporterCode": str(reporter_code), "period": f"{year}{month:02d}", "cmdCode": code[:6],
              "flowCode": "M" if flow == "import" else "X", "includeDesc": "true"}

    try:
        response = session.get(KEYED if key else PREVIEW, params=params, timeout=timeout,
                               headers={"Ocp-Apim-Subscription-Key": key} if key else {})
        body = response.json()
    except (requests.RequestException, ValueError) as error:
        raise SourceError(f"UN Comtrade could not be read: {error}") from error

    if not response.ok:
        raise SourceError(f"UN Comtrade answered HTTP {response.status_code}: {str(body)[:200]}")

    # The preview names partners but not always their ISO codes; aggregate
    # rows (motCode / customsCode splits) are not asked for.
    figures = parse(body.get("data") or [])

    if not figures:
        raise NoData("UN Comtrade has no figures for that month yet.")

    return MonthResult(figures=figures, source_url=response.url)
