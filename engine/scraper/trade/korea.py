"""South Korea: Korea Customs Service, "trade by item and country"
(data.go.kr dataset 15100475, nitemtrade). Needs KOREA_CUSTOMS_API_KEY,
free from data.go.kr (활용신청 on the dataset; the development tier is
approved automatically with 10,000 calls a day).

The service wants one country per call, so a month is one call per
partner. Weights are in kilograms. Base oil is 2710195020 (윤활유 기유).

Without the key this source says so plainly, and a feed can be pointed at
UN Comtrade meanwhile.
"""

from __future__ import annotations

import os
import re
import time
from decimal import Decimal

import requests

from .base import Figure, MonthResult, NoData, SourceError

URL = "https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList"

# The partners Korea's base oil and bitumen trade actually runs with; one
# call each. Extended by KOREA_CUSTOMS_COUNTRIES (comma-separated ISO codes).
DEFAULT_PARTNERS = (
    "CN IN SG TH VN ID MY PH TW HK JP US AE SA QA KW BH OM AU NZ PK BD LK NL BE DE GB FR IT ES TR "
    "RU KZ ZA NG EG MX BR CL PE CA MM KH LA"
).split()

_ITEM = re.compile(r"<item>(.*?)</item>", re.S)


def _field(item: str, name: str) -> str | None:
    match = re.search(rf"<{name}>(.*?)</{name}>", item, re.S)

    return match.group(1).strip() if match else None


def fetch(session: requests.Session, *, code: str, year: int, month: int, flow: str, timeout: int = 60) -> MonthResult:
    key = os.environ.get("KOREA_CUSTOMS_API_KEY", "")

    if not key:
        raise SourceError("South Korea needs KOREA_CUSTOMS_API_KEY (free from data.go.kr). Point this feed at UN Comtrade until it is set.")

    extra = [c.strip().upper() for c in os.environ.get("KOREA_CUSTOMS_COUNTRIES", "").split(",") if c.strip()]
    period = f"{year}{month:02d}"
    weight_field = "impWgt" if flow == "import" else "expWgt"
    figures: list[Figure] = []

    for partner in dict.fromkeys(DEFAULT_PARTNERS + extra):
        try:
            response = session.get(URL, params={"serviceKey": key, "strtYymm": period, "endYymm": period,
                                                "hsSgn": code, "cntyCd": partner}, timeout=timeout)
        except requests.RequestException as error:
            raise SourceError(f"Korea Customs could not be reached: {error}") from error

        if response.status_code in (401, 403):
            raise SourceError("Korea Customs refused the key (KOREA_CUSTOMS_API_KEY).")

        for item in _ITEM.findall(response.text):
            weight = _field(item, weight_field)

            if weight and Decimal(weight) > 0:
                figures.append(Figure(partner=partner, quantity=Decimal(weight), unit="KG", iso2=partner))

        time.sleep(0.1)  # the gateway also limits calls per second

    if not figures:
        raise NoData("Korea Customs has no figures for that month yet.")

    return MonthResult(figures=figures, source_url=URL)
