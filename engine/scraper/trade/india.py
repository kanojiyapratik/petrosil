"""India: DGCI&S monthly trade, as the Department of Commerce's TradeStat
serves it (tradestat.commerce.gov.in/meidb, "Commodity-wise all Countries").

A Laravel form: GET the page for a session cookie and a CSRF token, POST
the form once. Each token is good for one POST (a second answers HTTP 419),
so every month is a fresh GET and POST.

The table: S.No, Country, the same month last year, this month, growth,
then the two years to date. The unit is printed above it, per eight-digit
code ("Commodity: 27101971 BASE OIL Unit: KGS"). Codes were reallocated in
April 2026; base oil is 27101971 now (27101960, in TON, before).
"""

from __future__ import annotations

import html
import re

import requests

from .base import Figure, MonthResult, NoData, SourceError, parse_number

BASE = "https://tradestat.commerce.gov.in/meidb"
PAGES = {"import": ("commodity_wise_all_countries_import", "cwacim"),
         "export": ("commodity_wise_all_countries_export", "cwacex")}

_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")
_TOKEN = re.compile(r'name="_token"\s+value="([^"]+)"|value="([^"]+)"\s+name="_token"')


def _cells(row_html: str) -> list[str]:
    return [html.unescape(_TAG.sub(" ", cell)).replace("\xa0", " ").strip() for cell in _CELL.findall(row_html)]


def parse(page: str) -> tuple[list[Figure], str]:
    unit_match = re.search(r"Unit:\s*(?:&nbsp;)?\s*([A-Z]+)", page)

    if "No records found" in page and not unit_match:
        raise NoData("TradeStat has no records for that month.")

    if not unit_match:
        raise SourceError("TradeStat answered a page without its results table.")

    unit = unit_match.group(1)
    figures: list[Figure] = []

    for row in _ROW.findall(page[unit_match.end():]):
        cells = _cells(row)

        if len(cells) < 4 or not cells[0].isdigit():
            continue

        name = re.sub(r"\s+", " ", cells[1]).strip()
        quantity = parse_number(cells[3])

        if not name or quantity is None or quantity <= 0:
            continue

        figures.append(Figure(partner=name.title(), quantity=quantity, unit=unit))

    return figures, unit


def fetch(session: requests.Session, *, code: str, year: int, month: int, flow: str, timeout: int = 90) -> MonthResult:
    path, prefix = PAGES[flow]
    url = f"{BASE}/{path}"
    headers = {"user-agent": "Mozilla/5.0", "referer": url}

    try:
        form = session.get(url, timeout=timeout, headers=headers)
        token = _TOKEN.search(form.text)

        if not token:
            raise SourceError("TradeStat's form carried no token; the page has changed.")

        response = session.post(
            url,
            data={
                "_token": token.group(1) or token.group(2),
                f"{prefix}HSCODE": code,
                f"{prefix}Month": str(month),
                f"{prefix}Year": str(year),
                f"{prefix}ReportVal": "2",  # quantity
                f"{prefix}ReportYear": "2",  # calendar year
            },
            timeout=timeout,
            headers=headers,
        )
    except requests.RequestException as error:
        raise SourceError(f"TradeStat could not be reached: {error}") from error

    if not response.ok:
        raise SourceError(f"TradeStat answered HTTP {response.status_code}.")

    figures, _unit = parse(response.text)

    if not figures:
        raise NoData("TradeStat has no figures for that code and month yet.")

    return MonthResult(figures=figures, source_url=url)
