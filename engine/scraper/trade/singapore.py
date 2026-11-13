"""Singapore: SingStat Table Builder, table T010002 (Enterprise Singapore's
merchandise trade volume by HS8 commodity and market).

`search` is a substring match over the commodity label, so asking for
"27101941" returns that code (and any code it prefixes); the trade type is
filtered here. The unit is written in each label: "(TNE)" or "(KGM)".

Trap: python-requests' default user-agent is answered with an HTML page,
not JSON. A browser user-agent gets the API.
"""

from __future__ import annotations

import re
from decimal import Decimal

import requests

from .base import Figure, MonthResult, NoData, SourceError, parse_number

URL = "https://tablebuilder.singstat.gov.sg/api/table/tabledata/T010002"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Regional and group totals the table lists beside the countries.
AGGREGATES = {
    "WORLD", "APEC", "ASEAN", "EU", "EUROPEAN UNION", "GCC", "AFRICA", "AMERICA", "ASIA",
    "EUROPE", "OCEANIA", "MIDDLE EAST", "NORTH EAST ASIA", "SOUTH ASIA", "OTHERS",
    "OTHER ASIA", "LATIN AMERICA", "NORTH AMERICA", "CARIBBEAN", "CENTRAL AMERICA",
    "SOUTH AMERICA", "EASTERN EUROPE", "WESTERN EUROPE", "EU-27", "EU 27", "EUROPEAN UNION (EU)",
    "CARRIBBEAN", "CENTRAL ASIA", "CLMV", "EAST ASIA + TAIWAN", "NAFTA",
}

_LABEL = re.compile(r"^(\d{8})\s*-.*\(([A-Z]+)\)\s*$")

_NAMES = {"MAINLAND CHINA": "China", "REPUBLIC OF KOREA": "South Korea", "KOREA, REPUBLIC OF": "South Korea"}


def parse(rows: list[dict], code: str, flow: str) -> list[Figure]:
    trade_type = "IMPORTS" if flow == "import" else "EXPORTS"
    figures: list[Figure] = []

    for row in rows:
        label = _LABEL.match(str(row.get("hs8Products", "")).strip())
        market = str(row.get("market", "")).strip().upper()

        if not label or not label.group(1).startswith(code) or row.get("tradeType") != trade_type:
            continue

        if market in AGGREGATES or "+" in market or market.startswith("ASEAN") or market.startswith("EUROPEAN"):
            continue

        quantity = parse_number(str(row.get("quantity", "")))

        if quantity is None or quantity <= 0:
            continue

        figures.append(Figure(partner=_NAMES.get(market, market.title()), quantity=quantity, unit=label.group(2)))

    return figures


def fetch(session: requests.Session, *, code: str, year: int, month: int, flow: str, timeout: int = 60) -> MonthResult:
    params = {"timeFilter": f"{year} {MONTHS[month - 1]}", "search": code, "limit": "5000"}
    rows: list[dict] = []
    url = URL

    for _ in range(20):  # paging backstop
        try:
            response = session.get(url, params=params, timeout=timeout, headers={"user-agent": "Mozilla/5.0", "accept": "application/json"})
            body = response.json()
        except (requests.RequestException, ValueError) as error:
            raise SourceError(f"SingStat could not be read: {error}") from error

        data = body.get("Data") or {}
        rows.extend(data.get("rows") or [])

        if not data.get("isMore") or not data.get("nextCursor"):
            break

        params = {**params, "cursor": data["nextCursor"]}

    figures = parse(rows, code, flow)

    if not figures:
        raise NoData("SingStat has no figures for that month yet.")

    return MonthResult(figures=figures, source_url=f"{URL}?timeFilter={params['timeFilter']}&search={code}")


__all__ = ["fetch", "parse", "Decimal"]
