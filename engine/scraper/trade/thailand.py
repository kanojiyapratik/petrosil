"""Thai Customs Department statistics (customs.go.th).

One stateless GET per product code and month: the "by country" report,
which answers a row per partner with its ISO code, the month's quantity,
its value, and the year to date. Quantities only come back for the full
eleven-digit statistical codes (AHTN eight plus a three-digit suffix);
base oil is 27101941000 "lubricating oil feedstock", in litres.

The page carries a 250-option country <select> and Thai text before the
table, so parsing starts at the table's "HS-CODE" heading.
"""

from __future__ import annotations

import html
import re

import requests

from .base import Figure, MonthResult, NoData, SourceError, parse_number

URL = "https://www.customs.go.th/statistic_report.php"

_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")


def _cells(row_html: str) -> list[str]:
    return [html.unescape(_TAG.sub(" ", cell)).strip() for cell in _CELL.findall(row_html)]


def parse(page: str, unit: str) -> list[Figure]:
    """The partner rows of one report page. The month's quantity is the
    first number after the country name; the year to date comes later."""
    at = page.find("HS-CODE")

    if at < 0:
        raise SourceError("Thai Customs answered a page without its statistics table.")

    figures: list[Figure] = []

    for row in _ROW.findall(page[at:]):
        cells = [cell for cell in _cells(row) if cell != ""]

        if len(cells) < 3 or not re.fullmatch(r"[A-Z]{2}", cells[0]):
            continue

        code, name = cells[0], cells[1]
        quantity = parse_number(cells[2])

        if quantity is None or quantity <= 0:
            continue

        figures.append(Figure(partner=name.title(), quantity=quantity, unit=unit, iso2=code))

    return figures


def unit_of(page: str) -> str:
    """The unit printed beside the code (LTR, KGM, ...). Litres when absent,
    as for every 2710 line."""
    # Printed after the statistic code's description: "Lubricating oil
    # feedstock (LTR)". A bare search for KG or MT finds them in the page's
    # scripts and country list first.
    match = re.search(r"Statistic code\s*:.*?\((LTR|KGM|KG|TNE|MT|KL|C62)\)", page, re.S)

    return match.group(1) if match else "LTR"


def fetch(session: requests.Session, *, code: str, year: int, month: int, flow: str, timeout: int = 60) -> MonthResult:
    params = {
        "lang": "en",
        "show_search": "1",
        "tab": "by_country",
        "imex_type": "import" if flow == "import" else "export",
        "tariff_code": code,
        "country_code": "",
        "month": str(month),
        "year": str(year),
    }

    try:
        response = session.get(URL, params=params, timeout=timeout)
    except requests.RequestException as error:
        raise SourceError(f"Thai Customs could not be reached: {error}") from error

    if not response.ok:
        raise SourceError(f"Thai Customs answered HTTP {response.status_code}.")

    page = response.text
    released = re.search(r"Latest released\s*:?\s*([A-Za-z]+)\s+(\d{4})", page)

    if released:
        months = ["january", "february", "march", "april", "may", "june", "july", "august",
                  "september", "october", "november", "december"]
        name = released.group(1).lower()

        if name in months and (year, month) > (int(released.group(2)), months.index(name) + 1):
            raise NoData(f"Thai Customs has released up to {released.group(1)} {released.group(2)}.")

    figures = parse(page, unit_of(page))

    if not figures:
        raise NoData("Thai Customs has no figures for that month yet.")

    return MonthResult(figures=figures, source_url=response.url)
