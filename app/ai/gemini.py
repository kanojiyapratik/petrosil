"""Talks to Gemini's generateContent REST endpoint.

Two behaviours here are load-bearing and were both found the hard way, first
in the Laravel version and again in the TypeScript one:

1. Gemini can answer HTTP 200 with NO usable text -- an empty ``candidates``
   list plus ``promptFeedback.blockReason``. That shape is checked before
   candidates[0] is ever touched, and becomes a *declined* completion rather
   than a crash. A model decline must never surface as a 500.

2. The API key travels in the query string, so it appears in the request URL
   and in any error text that echoes it -- including transport failures that
   never produced a response. Every raised message goes through redaction,
   because an unredacted one ends up stored and shown to admins.

Retries twice (three attempts) and only on 429/5xx; a 4xx such as a bad
request or a bad key is not retried.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

import requests

MAX_ATTEMPTS = 3
DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"


class AiProviderError(RuntimeError):
    """A provider failure. Its message is always redacted."""


@dataclass(frozen=True)
class AiCompletion:
    status: str  # complete | declined
    text: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    error: str | None


def _declined(error: str) -> AiCompletion:
    return AiCompletion(
        status="declined", text=None, prompt_tokens=None, completion_tokens=None, error=error
    )


class GeminiDriver:
    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        session: requests.Session | None = None,
        timeout_seconds: int = 120,
        backoff_seconds: float = 0.05,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url
        self._session = session or requests.Session()
        self._timeout = timeout_seconds
        self._backoff = backoff_seconds
        self._sleep = sleep

    def generate(self, model: str, prompt: str) -> AiCompletion:
        url = f"{self._base_url}/v1beta/models/{model}:generateContent?key={self._api_key}"
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
        last_error: Exception | None = None

        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = self._session.post(url, json=body, timeout=self._timeout)
            except requests.RequestException as error:
                last_error = error

                if attempt < MAX_ATTEMPTS:
                    self._sleep(self._backoff * attempt)
                    continue

                # No HTTP response came back at all (DNS, TLS, timeout). The
                # message still embeds the full request URL, query string and
                # all, so it needs the same redaction as the HTTP branch.
                raise AiProviderError(self._redact(f"Gemini request failed: {error}")) from error

            if response.status_code == 429 or response.status_code >= 500:
                if attempt < MAX_ATTEMPTS:
                    self._sleep(self._backoff * attempt)
                    continue

            if not response.ok:
                raise AiProviderError(
                    self._redact(
                        f"Gemini request failed with HTTP {response.status_code}: {response.text}"
                    )
                )

            try:
                return self._parse(response.json())
            except ValueError as error:
                raise AiProviderError(
                    self._redact(f"Gemini returned a non-JSON body: {error}")
                ) from error

        raise AiProviderError(
            self._redact(f"Gemini request failed after {MAX_ATTEMPTS} attempts: {last_error}")
        )

    def _parse(self, data: dict) -> AiCompletion:
        candidates = data.get("candidates") or []
        feedback = data.get("promptFeedback") or {}

        # Checked BEFORE indexing candidates[0]: an empty candidates list with
        # a populated promptFeedback means the model declined, not that the
        # response is malformed.
        if not candidates and feedback.get("blockReason"):
            return _declined(f"The model declined to respond: {feedback['blockReason']}")

        text = None

        for candidate in candidates:
            parts = ((candidate or {}).get("content") or {}).get("parts") or []

            for part in parts:
                value = (part or {}).get("text")

                if isinstance(value, str) and value.strip():
                    text = value
                    break

            if text is not None:
                break

        if text is None:
            return _declined("The model returned no usable content.")

        usage = data.get("usageMetadata") or {}

        return AiCompletion(
            status="complete",
            text=text,
            prompt_tokens=usage.get("promptTokenCount"),
            completion_tokens=usage.get("candidatesTokenCount"),
            error=None,
        )

    def _redact(self, message: str) -> str:
        return message.replace(self._api_key, "***") if self._api_key else message
