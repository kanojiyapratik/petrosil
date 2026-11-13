"""Japan: Ministry of Finance trade statistics, as e-Stat publishes them.

The commodity-by-country table (品別国別表) is published as one CSV per HS
chapter group per month, each a year-to-date table with Jan..Dec columns.
The download id (statInfId) changes every month, so the month's listing
page is read and the file picked by its chapter range.

Columns: Exp or Imp, Year, HS ('271320000' quoted), Country (MoF code),
Unit1, Unit2, Quantity1-Year, Quantity2-Year, Value-Year, then
Quantity1/Quantity2/Value for each month. Petroleum lines carry KL with
KG; bitumen carries MT alone in Unit2. The figure used is Unit1 when it
has one, else Unit2 — what reproduces bitumart's history.
"""

from __future__ import annotations

import csv
import io
import re
from decimal import Decimal
from pathlib import Path

import requests

from .base import Figure, MonthResult, NoData, SourceError, parse_number

LIST_URL = "https://www.e-stat.go.jp/stat-search/files"
FILE_URL = "https://www.e-stat.go.jp/stat-search/file-download"
COMMON = {"toukei": "00350300", "tstat": "000001013141", "tclass1": "000001013180"}
TCLASS2 = {"export": "000001013181", "import": "000001013182"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _countries() -> dict[str, str]:
    table: dict[str, str] = {}
    path = Path(__file__).parent / "data" / "japan_countries.tsv"

    for line in path.read_text(encoding="utf-8").splitlines():
        code, _, name = line.partition("\t")

        if code.strip():
            table[code.strip()] = name.strip()

    return table


COUNTRIES = _countries()


def chapter_of(code: str) -> int:
    return int(code[:2])


def pick_file(listing: str, chapter: int) -> str | None:
    """The statInfId whose title's chapter range ("25-27類", "15類") holds
    the chapter. Full-width digits are folded first."""
    text = listing.translate(str.maketrans("０１２３４５６７８９－", "0123456789-"))

    for match in re.finditer(r"statInfId=(\d{12})", text):
        # The title sits shortly before the link in the listing markup.
        window = text[max(0, match.start() - 1500) : match.start()]
        ranges = re.findall(r"(\d{1,2})(?:-(\d{1,2}))?類", window)

        if not ranges:
            continue

        low, high = ranges[-1]
        low_n, high_n = int(low), int(high or low)

        if low_n <= chapter <= high_n:
            return match.group(1)

    return None


def parse(text: str, code: str, month: int) -> list[Figure]:
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)

    if not header or "HS" not in header:
        raise SourceError("The Japanese statistics file has an unexpected layout.")

    q1 = header.index(f"Quantity1-{MONTHS[month - 1]}")
    q2 = header.index(f"Quantity2-{MONTHS[month - 1]}")
    figures: list[Figure] = []

    for row in reader:
        if len(row) <= q2:
            continue

        hs = row[2].strip().strip("'")

        if not hs.startswith(code):
            continue

        unit1, unit2 = row[4].strip(), row[5].strip()
        first, second = parse_number(row[q1]), parse_number(row[q2])
        quantity, unit = (first, unit1) if unit1 else (second, unit2)

        if quantity is None or quantity <= 0:
            continue

        name = COUNTRIES.get(row[3].strip(), f"Japan country {row[3].strip()}")
        figures.append(Figure(partner=name, quantity=quantity, unit=unit))

    return figures


def fetch(session: requests.Session, *, code: str, year: int, month: int, flow: str, timeout: int = 90) -> MonthResult:
    # e-Stat files a month under its year with a month code it does not
    # derive from the date, so the year's listing is read and the month's
    # files told apart by their "YYYY年M月" heading.
    params = {**COMMON, "tclass2": TCLASS2[flow], "layout": "datalist", "page": "1", "year": f"{year}0",
              "cycle": "1", "data": "1", "metadata": "1", "cycle_facet": "cycle", "tclass3val": "0"}

    try:
        listing = session.get(LIST_URL, params=params, timeout=timeout)
    except requests.RequestException as error:
        raise SourceError(f"e-Stat could not be reached: {error}") from error

    if not listing.ok:
        raise SourceError(f"e-Stat answered HTTP {listing.status_code}.")

    # The year's listing shows its newest month's files ("2026年9月分 ...").
    # Each is the year to date, so that file holds the month wanted -- and
    # holds it final (確報) rather than the first print, once a later month
    # is out.
    page = listing.text
    newest = [int(n) for n in re.findall(rf"{year}年\s*(\d{{1,2}})月分", page)]

    if not newest or max(newest) < month:
        raise NoData(f"e-Stat has not published {MONTHS[month - 1]} {year} yet.")

    file_id = pick_file(page, chapter_of(code))

    if not file_id:
        raise NoData("e-Stat lists no file for that chapter in that month yet.")

    try:
        response = session.get(FILE_URL, params={"statInfId": file_id, "fileKind": "1"}, timeout=timeout)
    except requests.RequestException as error:
        raise SourceError(f"e-Stat could not be reached: {error}") from error

    if not response.ok:
        raise SourceError(f"e-Stat answered HTTP {response.status_code} for the file.")

    text = response.content.decode("utf-8-sig", errors="replace")
    figures = parse(text, code, month)

    if not figures:
        raise NoData("The Japanese file has no figures for that code and month.")

    return MonthResult(figures=figures, source_url=f"{FILE_URL}?statInfId={file_id}&fileKind=1")


__all__ = ["fetch", "parse", "pick_file", "Decimal"]
