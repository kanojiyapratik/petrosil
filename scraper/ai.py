"""The model does the reading.

Every page goes to Gemini rather than to a CSS selector or a regex, because
these pages write prices as prose ("Group I SN500 held at $845/t in
Singapore"), publish them in tables that get restyled, and get redesigned
without notice. A selector breaks silently, and a silent break on a job that
runs every fifteen minutes means stale prices nobody questions.

The model is only ever asked to *read*. Every number it returns still goes
through :func:`to_price`, and every location it names must match one the site
already has — the model cannot invent either.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field

import requests

from .normalise import normalise_title

MAX_ATTEMPTS = 3
DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"

_FENCE = re.compile(r"^\s*```(?:json)?|```\s*$", re.IGNORECASE)
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NOT_NUMERIC = re.compile(r"[^0-9eE.+-]")


class AiQuotaExhausted(RuntimeError):
    """The key is out of quota.

    Distinct from a general provider failure because it is not about this
    page: every further call in the pass will be refused too, so the pass
    should stop asking rather than burn the retries finding out.
    """


class AiProviderError(RuntimeError):
    """A provider failure. Its message is always redacted — see below."""


@dataclass(frozen=True)
class ExtractedRow:
    location: str
    date: str
    price: float


@dataclass(frozen=True)
class Extraction:
    rows: list[ExtractedRow] = field(default_factory=list)
    notes: str | None = None
    declined: bool = False
    error: str | None = None


def explain_failure(response) -> str:
    """One sentence, not the provider's entire JSON.

    This message is stored against the URL and shown on the crawler screen. A
    quota refusal arrives as roughly a thousand characters of nested JSON, and
    pasting that into a table buries the only two things that matter: what
    went wrong, and what to do about it.
    """
    detail = ""
    retry = ""

    try:
        body = response.json()
        error = body.get("error") or {}
        detail = str(error.get("message") or "").split("\n")[0].strip()

        for item in error.get("details") or []:
            if str(item.get("@type", "")).endswith("RetryInfo"):
                retry = str(item.get("retryDelay") or "")
    except Exception:  # noqa: BLE001 - a non-JSON error body is still an error
        detail = (getattr(response, "text", "") or "")[:160].strip()

    if response.status_code == 429:
        # By far the most common failure, and the one with a clear action.
        wait = f" Try again in about {retry}." if retry else ""

        return f"Gemini quota exceeded — the API key has hit its limit.{wait}"

    if response.status_code in (401, 403):
        return "Gemini rejected the API key."

    return f"Gemini answered HTTP {response.status_code}: {detail or 'no detail given'}"[:300]


def build_prompt(url: str, text: str, locations: list[str], today: str) -> str:
    """The extraction prompt. Deliberately narrow about what counts."""
    known = ", ".join(locations) if locations else "(the site tracks none)"

    lines = [
        "You extract published prices from a web page. Read only; do not "
        "estimate, convert, or infer a price that is not printed.",
        "",
        f"Page: {url}",
        f"Today: {today}",
        f"Locations this site already tracks: {known}",
        "",
        "Rules:",
        "- Return JSON only. No markdown, no commentary outside the JSON.",
        '- Shape: {"rows":[{"location":"...","date":"YYYY-MM-DD","price":123.45}],"notes":"..."}',
        "- Return EVERY published price on the page, whichever region, grade "
        "or product it belongs to. Do not leave one out because it is not in "
        "the tracked list above.",
        "- location is the label the page itself gives the price — its region, "
        "grade or product name, copied as printed (for example 'China', "
        "'Base Oil UAE CFR', 'SN 500 Europe').",
        "- If a price clearly belongs to one of the tracked locations, use that "
        "exact spelling so the site can match it. Otherwise keep the page's own "
        "wording rather than inventing a mapping.",
        "- price must be a plain number: no currency symbol, no thousands "
        "separator, no units.",
        "- date is the date the page states the price applies to. Resolve "
        'relative wording ("today", "week ending Friday") against Today. If '
        "the page states no date, use Today.",
        "- One row per location per date; if a location appears more than "
        "once, keep the most recently dated.",
        "- Ignore percentages, volumes, indices, year-on-year changes and "
        "anything that is not a price level.",
        "- If you are not confident a number is a published price, leave it "
        "out and say so in notes.",
        '- If the page carries no prices you can attribute, return {"rows":[]}.',
        "",
        "Page text:",
        '"""',
        text,
        '"""',
    ]

    return "\n".join(lines)


class DriverExtractor:
    """Extraction on top of whichever driver it is handed.

    The provider is chosen on a screen now, so this must not know or care
    which one it is talking to. Everything provider-shaped -- keys, retries,
    redaction, the shape of the answer -- belongs to the driver.
    """

    def __init__(self, driver) -> None:
        self._driver = driver

    def extract(self, url: str, text: str, locations: list[str], today: str) -> Extraction:
        prompt = build_prompt(url, text, locations, today)

        try:
            completion = self._driver.generate(prompt)
        except Exception:
            # Quota and provider errors both belong to the caller: the pass
            # decides whether to stop asking.
            raise

        if completion.status != "complete" or not completion.text:
            return Extraction(declined=True, error=completion.error or "No usable content.")

        data = _extract_json(completion.text)

        if data is None:
            return Extraction(declined=True, error="The model did not return JSON.")

        raw_rows = data.get("rows")

        if not isinstance(raw_rows, list):
            return Extraction(declined=True, error="The model's JSON had no usable rows array.")

        notes = data.get("notes")

        return Extraction(
            rows=clean_rows(raw_rows, locations, today),
            notes=notes if isinstance(notes, str) and notes.strip() else None,
        )


class GeminiExtractor:
    def __init__(
        self,
        api_key: str,
        model: str = "gemini-2.5-flash",
        base_url: str = DEFAULT_BASE_URL,
        session: requests.Session | None = None,
        timeout_seconds: int = 120,
        backoff_seconds: float = 1.0,
        sleep=None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url
        self._session = session or requests.Session()
        self._timeout = timeout_seconds
        self._backoff = backoff_seconds

        if sleep is None:
            import time

            sleep = time.sleep

        self._sleep = sleep

    def extract(
        self, url: str, text: str, locations: list[str], today: str
    ) -> Extraction:
        prompt = build_prompt(url, text, locations, today)

        try:
            payload = self._generate(prompt)
        except AiQuotaExhausted:
            # Raised, not swallowed: the pass has to know to stop asking.
            raise
        except AiProviderError as error:
            return Extraction(error=str(error))

        candidates = payload.get("candidates") or []
        feedback = payload.get("promptFeedback") or {}

        # Gemini can answer HTTP 200 with NO usable text: an empty candidates
        # list plus a blockReason. Check that shape BEFORE indexing
        # candidates[0], or a model decline becomes a crash.
        if not candidates and feedback.get("blockReason"):
            return Extraction(
                declined=True,
                error=f"The model declined to respond: {feedback['blockReason']}",
            )

        answer = _first_text(candidates)

        if not answer:
            return Extraction(
                declined=True, error="The model returned no usable content."
            )

        data = _extract_json(answer)

        if data is None:
            return Extraction(declined=True, error="The model did not return JSON.")

        raw_rows = data.get("rows")

        if not isinstance(raw_rows, list):
            return Extraction(
                declined=True, error="The model's JSON had no usable rows array."
            )

        notes = data.get("notes")

        return Extraction(
            rows=clean_rows(raw_rows, locations, today),
            notes=notes if isinstance(notes, str) and notes.strip() else None,
        )

    def _generate(self, prompt: str) -> dict:
        url = f"{self._base_url}/v1beta/models/{self._model}:generateContent?key={self._api_key}"
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
        last_error: Exception | None = None

        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = self._session.post(url, json=body, timeout=self._timeout)
            except requests.RequestException as error:
                # No HTTP response at all (DNS, TLS, timeout). The message
                # still embeds the request URL, query string and all, so it
                # gets the same redaction as the HTTP branch below.
                last_error = error

                if attempt < MAX_ATTEMPTS:
                    self._sleep(self._backoff * attempt)
                    continue

                raise AiProviderError(
                    self._redact(f"Gemini request failed: {error}")
                ) from error

            # A 5xx is worth retrying; a quota refusal is not -- the answer
            # will be the same, and the daily limit counts the attempts.
            if response.status_code >= 500 and attempt < MAX_ATTEMPTS:
                self._sleep(self._backoff * attempt)
                continue

            if not response.ok:
                message = self._redact(explain_failure(response))

                if response.status_code == 429:
                    raise AiQuotaExhausted(message)

                raise AiProviderError(message)

            try:
                return response.json()
            except ValueError as error:
                raise AiProviderError(
                    self._redact(f"Gemini returned a non-JSON body: {error}")
                ) from error

        raise AiProviderError(
            self._redact(f"Gemini request failed after {MAX_ATTEMPTS} attempts: {last_error}")
        )

    def _redact(self, message: str) -> str:
        """The API key travels in the query string, so it turns up in error
        text — including transport errors that never reached the API. Every
        message this class raises is redacted, because an unredacted one ends
        up in ``price_crawl_urls.last_error`` and on an admin's screen."""
        return message.replace(self._api_key, "***") if self._api_key else message


def clean_rows(
    raw_rows: list, locations: list[str], today: str
) -> list[ExtractedRow]:
    """Treat the model's output as untrusted input, because it is."""
    canonical = {normalise_title(name): name for name in locations}
    seen: set[tuple[str, str]] = set()
    cleaned: list[ExtractedRow] = []

    for raw in raw_rows:
        if not isinstance(raw, dict):
            continue

        price = to_price(raw.get("price"))

        if price is None:
            continue

        name = str(raw.get("location", "")).strip()

        if not name:
            continue

        # Snapped to the site's own spelling when it matches one, so the site
        # can resolve it; otherwise kept exactly as the page printed it.
        #
        # Dropping unfamiliar labels here was the old behaviour, and it threw
        # away the only record of what the page actually said -- a page
        # quoting "China 445" reported nothing at all. What to do with a label
        # the site does not recognise is the site's decision, not this one's.
        location = canonical.get(normalise_title(name), name)

        date = str(raw.get("date") or "").strip()

        if not _ISO_DATE.match(date):
            date = today

        key = (location, date)

        if key in seen:
            continue

        seen.add(key)
        cleaned.append(ExtractedRow(location=location, date=date, price=price))

    return cleaned


def to_price(value) -> float | None:
    """A price, or None. Never a silent zero and never a negative.

    ``bool`` is excluded on purpose: it is a subclass of ``int`` in Python,
    so ``True`` would otherwise sail through as a price of 1.0.
    """
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        stripped = _NOT_NUMERIC.sub("", value.replace(",", ""))

        if stripped.strip() in ("", "-", "+", ".", "-.", "+."):
            return None

        try:
            number = float(stripped)
        except ValueError:
            return None
    else:
        return None

    if math.isnan(number) or math.isinf(number) or number < 0:
        return None

    return number


def _first_text(candidates: list) -> str:
    for candidate in candidates:
        parts = ((candidate or {}).get("content") or {}).get("parts") or []

        for part in parts:
            text = (part or {}).get("text")

            if isinstance(text, str) and text.strip():
                return text

    return ""


def _extract_json(text: str) -> dict | None:
    """Models wrap JSON in fences even when told not to, and sometimes add a
    sentence before it. Fall back to the outermost braces."""
    candidate = _FENCE.sub("", text).strip()

    try:
        parsed = json.loads(candidate)
    except ValueError:
        start = candidate.find("{")
        end = candidate.rfind("}")

        if start == -1 or end <= start:
            return None

        try:
            parsed = json.loads(candidate[start : end + 1])
        except ValueError:
            return None

    return parsed if isinstance(parsed, dict) else None
