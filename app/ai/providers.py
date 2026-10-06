"""One interface, several providers.

Gemini used to be written into two places -- the price-review narration and
the crawler's extractor -- each with its own retry loop and its own key
handling. Adding a second provider meant editing both, so neither could be
chosen by anyone but a deployer with access to environment variables.

Everything now goes through :func:`create_driver`, which turns a provider
name, a key and a model into something with one method. The prompt is the
caller's business; keys, retries, redaction and the shape of the answer are
this module's.
"""

from __future__ import annotations

import base64
import re
import time
from dataclasses import dataclass
from typing import Callable

import requests

MAX_ATTEMPTS = 3

# A production read of a 705 KB full-page scan (HPCLPriceList010926.pdf) blew
# past the 120s text timeout: transcribing that one image ran to 5,143
# completion tokens, versus 202 and 10,806 for ordinary text reads made from
# far smaller prompts. A vision call is doing real work a text completion
# never does, and MAX_IMAGES (see app/editorial/extract.py) allows up to six
# images in a single call, so the worst case is several such transcriptions
# back to back. This is generous enough to cover that batch on a slow
# provider without being so long that a wedged connection ties up the
# editor's browser for the whole request.
IMAGE_TIMEOUT_SECONDS = 300


class AiQuotaExhausted(RuntimeError):
    """The key is out of quota.

    Distinct from a general failure because it is not about this request:
    every further call will be refused too, so a batch of work should stop
    asking rather than burn the retries finding out.
    """


class AiProviderError(RuntimeError):
    """A provider failure. Its message is always redacted."""


@dataclass(frozen=True)
class AiCompletion:
    status: str  # complete | declined
    text: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    error: str | None


def declined(error: str) -> AiCompletion:
    return AiCompletion(
        status="declined", text=None, prompt_tokens=None, completion_tokens=None, error=error
    )


# Models the console offers when the key itself cannot be asked: a starting
# point for a provider being added, and the fallback when a listing call
# fails. Every provider here can be asked -- see available_models -- and the
# answer is always better than this list, which goes stale the day it is
# written.
PROVIDERS = {
    "gemini": {
        "label": "Google Gemini",
        "models": ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
        "key_hint": "An API key from aistudio.google.com",
    },
    "openai": {
        "label": "OpenAI",
        "models": ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
        "key_hint": "An API key from platform.openai.com, starting sk-",
    },
    "anthropic": {
        "label": "Anthropic Claude",
        "models": ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"],
        "key_hint": "An API key from console.anthropic.com, starting sk-ant-",
    },
    "groq": {
        "label": "Groq",
        "models": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
        "key_hint": "A free API key from console.groq.com, starting gsk_",
    },
}


# Everything an OpenAI-style key lists that is not a text model we could send
# a prompt to: pictures, sound, embeddings, moderation, search and the rest.
_NOT_TEXT = (
    "embedding", "tts", "whisper", "transcribe", "image", "audio", "realtime",
    "moderation", "sora", "search", "codex", "instruct", "dall-e", "davinci",
    "babbage", "computer-use", "guard", "robotics", "imagen", "veo", "-live-",
)

# A dated snapshot of a model already listed under its plain name -- three
# dozen of them, all duplicates as far as this screen is concerned.
_SNAPSHOT = re.compile(r"-\d{4}-\d{2}-\d{2}$")


def _is_text_model(model_id: str) -> bool:
    name = model_id.lower()

    if _SNAPSHOT.search(name) or name.startswith("gpt-3.5"):
        return False

    if any(word in name for word in _NOT_TEXT):
        return False

    return name.startswith(
        ("gpt-", "o1", "o3", "o4", "o5", "chat-", "llama", "claude", "gemini")
    )


def _newest_first(models: list[str]) -> list[str]:
    """Newest-looking first, so the top of the list is the current model.

    "gpt-5.10" must sort above "gpt-5.4", which is why the digits are compared
    as numbers rather than as text.
    """
    def natural(name: str):
        return [
            (0, int(part)) if part.isdigit() else (1, part)
            for part in re.split(r"(\d+)", name)
        ]

    ordered = sorted(set(models), key=natural, reverse=True)

    # The o-series sorts above everything alphabetically; it belongs after the
    # gpt line, not on top of it.
    return sorted(ordered, key=lambda name: 0 if name.lower().startswith(("gpt", "claude")) else 1)


def available_models(provider: str, api_key: str, session=None, timeout_seconds: int = 10) -> list[str]:
    """What this key can actually use, asked of the provider itself.

    The hardcoded list above was written in August and had the console still
    offering gpt-4o-mini as the biggest OpenAI model on a key that can reach
    the whole gpt-5 line. A list that has to be edited to stay true will
    always be out of date; the key knows.

    Never raises. A settings screen has to render with a wrong key, an expired
    key or no network at all, and the caller falls back to the list above.
    """
    provider = provider.lower()
    asked = session or requests

    try:
        if provider == "gemini":
            # The key rides in the query string for this API, so nothing from
            # this call may ever reach a message or a log.
            response = asked.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key, "pageSize": 200},
                timeout=timeout_seconds,
            )
            payload = response.json() if response.ok else {}
            names = [
                str(entry.get("name", "")).replace("models/", "")
                for entry in payload.get("models", [])
                if "generateContent" in (entry.get("supportedGenerationMethods") or [])
            ]

            return _newest_first([name for name in names if _is_text_model(name)])

        if provider == "anthropic":
            response = asked.get(
                "https://api.anthropic.com/v1/models",
                headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                params={"limit": 100},
                timeout=timeout_seconds,
            )
        else:
            base = "https://api.groq.com/openai" if provider == "groq" else "https://api.openai.com"
            response = asked.get(
                f"{base}/v1/models",
                headers={"authorization": f"Bearer {api_key}"},
                timeout=timeout_seconds,
            )

        if not response.ok:
            return []

        found = [str(entry.get("id", "")) for entry in (response.json().get("data") or [])]

        return _newest_first([name for name in found if _is_text_model(name)])
    except Exception:
        # Any failure at all is "we could not ask", never an error on screen.
        return []



class _Driver:
    """Shared plumbing: retries, redaction, and one shape of answer."""

    def __init__(
        self,
        api_key: str,
        model: str,
        session: requests.Session | None = None,
        timeout_seconds: int = 120,
        image_timeout_seconds: int = IMAGE_TIMEOUT_SECONDS,
        backoff_seconds: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._api_key = api_key
        self.model = model
        self._session = session or requests.Session()
        self._timeout = timeout_seconds
        self._image_timeout = image_timeout_seconds
        self._backoff = backoff_seconds
        self._sleep = sleep

    def generate(self, prompt: str) -> AiCompletion:
        return self._send(self._body(prompt), timeout=self._timeout)

    def generate_with_images(
        self, prompt: str, images: list[tuple[str, bytes]]
    ) -> AiCompletion:
        """The prompt plus pictures -- how a posted-price table embedded as a
        PNG gets read. images is a list of (mime_type, raw bytes).

        A vision call over a full-page scan runs long -- see
        IMAGE_TIMEOUT_SECONDS -- so it gets its own, longer timeout rather
        than the one sized for a plain text completion. A timeout here still
        raises the same AiProviderError as any other failed request: it is
        not retried and it is not swallowed."""
        return self._send(self._image_body(prompt, images), timeout=self._image_timeout)

    def _send(self, body: dict, timeout: int) -> AiCompletion:
        last_error: Exception | None = None

        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = self._session.post(
                    self._url(), json=body, headers=self._headers(),
                    timeout=timeout,
                )
            except requests.RequestException as error:
                last_error = error

                if attempt < MAX_ATTEMPTS:
                    self._sleep(self._backoff * attempt)
                    continue

                # No HTTP response at all. The message can still embed the
                # request URL, which for some providers carries the key.
                raise AiProviderError(self._redact(f"{self.name} could not be reached: {error}"))

            if response.status_code == 429:
                # Never retried: the answer will be the same, and for a
                # per-day quota the attempts themselves are what is scarce.
                raise AiQuotaExhausted(self._redact(self._explain(response)))

            if response.status_code >= 500 and attempt < MAX_ATTEMPTS:
                self._sleep(self._backoff * attempt)
                continue

            if not response.ok:
                raise AiProviderError(self._redact(self._explain(response)))

            try:
                return self._parse(response.json())
            except ValueError as error:
                raise AiProviderError(self._redact(f"{self.name} returned a non-JSON body: {error}"))

        raise AiProviderError(
            self._redact(f"{self.name} failed after {MAX_ATTEMPTS} attempts: {last_error}")
        )

    def _redact(self, message: str) -> str:
        """The key can reach an error message through a query string or an
        echoed request. Every message raised here is scrubbed, because an
        unredacted one ends up stored and shown to an admin."""
        return message.replace(self._api_key, "***") if self._api_key else message

    def _explain(self, response) -> str:
        """One sentence. A provider's own error body runs to a thousand
        characters of nested JSON, and it lands in a table on a screen."""
        detail = ""
        retry = ""
        code = ""

        try:
            body = response.json()
            error = body.get("error")

            # OpenAI (and the OpenAI-style Groq) answer 429 for two different
            # things: an account out of credit, and too much sent this minute.
            if isinstance(error, dict):
                code = str(error.get("code") or error.get("type") or "").lower()

            # Gemini says how long to wait; the others do not.
            if isinstance(error, dict):
                for item in error.get("details") or []:
                    if str((item or {}).get("@type", "")).endswith("RetryInfo"):
                        retry = str(item.get("retryDelay") or "")

            if isinstance(error, dict):
                detail = str(error.get("message") or "").split("\n")[0].strip()
            elif isinstance(error, str):
                detail = error
        except ValueError:
            detail = (getattr(response, "text", "") or "")[:160].strip()

        if response.status_code in (401, 403):
            return f"{self.name} rejected the API key."

        if response.status_code == 429:
            # The commonest failure of all, and the one with a clear action --
            # but the action differs: waiting never fixes an empty account.
            # Its own body runs to a thousand characters of nested JSON.
            if not retry:
                retry = str((getattr(response, "headers", None) or {}).get("retry-after") or "")
                retry = f"{retry} seconds" if retry.isdigit() else retry

            wait = f" Try again in about {retry}." if retry else ""

            if "insufficient_quota" in code or "billing" in detail.lower():
                return (
                    f"{self.name} account is out of credit — add credit on the provider's "
                    "billing page, then try again."
                )

            if "rate_limit" in code or "rate limit" in detail.lower():
                return f"{self.name} rate limit — too much was sent in one minute." + (
                    wait or " Wait a minute and try again."
                )

            return f"{self.name} quota exceeded — the API key has hit its limit.{wait}"

        return f"{self.name} answered HTTP {response.status_code}: {detail or 'no detail given'}"[:300]

    # Each provider fills these in.
    name = "The model"

    def _url(self) -> str:  # pragma: no cover - overridden
        raise NotImplementedError

    def _headers(self) -> dict:  # pragma: no cover - overridden
        raise NotImplementedError

    def _body(self, prompt: str) -> dict:  # pragma: no cover - overridden
        raise NotImplementedError

    def _image_body(self, prompt: str, images: list[tuple[str, bytes]]) -> dict:
        raise AiProviderError(
            f"{self.name} cannot read images with this model. "
            "Pick a vision-capable provider (Gemini, OpenAI or Claude) on the AI settings screen."
        )

    def _parse(self, payload: dict) -> AiCompletion:  # pragma: no cover - overridden
        raise NotImplementedError


class GeminiDriver(_Driver):
    name = "Gemini"
    base_url = "https://generativelanguage.googleapis.com"

    def _url(self) -> str:
        # The key travels in the query string here, which is exactly why
        # every raised message goes through redaction.
        return f"{self.base_url}/v1beta/models/{self.model}:generateContent?key={self._api_key}"

    def _headers(self) -> dict:
        return {"content-type": "application/json"}

    def _body(self, prompt: str) -> dict:
        return {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}

    def _image_body(self, prompt: str, images: list[tuple[str, bytes]]) -> dict:
        parts: list[dict] = [{"text": prompt}]

        for mime, data in images:
            parts.append(
                {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}
            )

        return {"contents": [{"role": "user", "parts": parts}]}

    def _parse(self, payload: dict) -> AiCompletion:
        candidates = payload.get("candidates") or []
        feedback = payload.get("promptFeedback") or {}

        # Gemini answers HTTP 200 with an empty candidates list and a
        # blockReason when it declines. Checked before indexing candidates[0],
        # or a decline becomes a crash.
        if not candidates and feedback.get("blockReason"):
            return declined(f"The model declined to respond: {feedback['blockReason']}")

        text = None

        for candidate in candidates:
            for part in ((candidate or {}).get("content") or {}).get("parts") or []:
                value = (part or {}).get("text")

                if isinstance(value, str) and value.strip():
                    text = value
                    break

            if text:
                break

        if not text:
            return declined("The model returned no usable content.")

        usage = payload.get("usageMetadata") or {}

        return AiCompletion(
            status="complete",
            text=text,
            prompt_tokens=usage.get("promptTokenCount"),
            completion_tokens=usage.get("candidatesTokenCount"),
            error=None,
        )


class OpenAiDriver(_Driver):
    name = "OpenAI"
    base_url = "https://api.openai.com"

    def _url(self) -> str:
        return f"{self.base_url}/v1/chat/completions"

    def _headers(self) -> dict:
        return {"authorization": f"Bearer {self._api_key}", "content-type": "application/json"}

    def _body(self, prompt: str) -> dict:
        return {"model": self.model, "messages": [{"role": "user", "content": prompt}]}

    def _image_body(self, prompt: str, images: list[tuple[str, bytes]]) -> dict:
        content: list[dict] = [{"type": "text", "text": prompt}]

        for mime, data in images:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"},
                }
            )

        return {"model": self.model, "messages": [{"role": "user", "content": content}]}

    def _parse(self, payload: dict) -> AiCompletion:
        choices = payload.get("choices") or []
        text = ((choices[0] if choices else {}).get("message") or {}).get("content")

        if not isinstance(text, str) or not text.strip():
            # A refusal arrives as an empty message rather than an error.
            return declined("The model returned no usable content.")

        usage = payload.get("usage") or {}

        return AiCompletion(
            status="complete",
            text=text,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            error=None,
        )


class AnthropicDriver(_Driver):
    name = "Claude"
    base_url = "https://api.anthropic.com"

    def _url(self) -> str:
        return f"{self.base_url}/v1/messages"

    def _headers(self) -> dict:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

    def _body(self, prompt: str) -> dict:
        # max_tokens is required by this API, unlike the other two.
        return {
            "model": self.model,
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": prompt}],
        }

    def _image_body(self, prompt: str, images: list[tuple[str, bytes]]) -> dict:
        content: list[dict] = [{"type": "text", "text": prompt}]

        for mime, data in images:
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime,
                        "data": base64.b64encode(data).decode(),
                    },
                }
            )

        return {
            "model": self.model,
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": content}],
        }

    def _parse(self, payload: dict) -> AiCompletion:
        text = "".join(
            block.get("text", "")
            for block in payload.get("content") or []
            if isinstance(block, dict) and block.get("type") == "text"
        )

        if not text.strip():
            return declined("The model returned no usable content.")

        usage = payload.get("usage") or {}

        return AiCompletion(
            status="complete",
            text=text,
            prompt_tokens=usage.get("input_tokens"),
            completion_tokens=usage.get("output_tokens"),
            error=None,
        )


class GroqDriver(OpenAiDriver):
    """Groq speaks OpenAI's chat-completions dialect on its own host. It is
    offered because its free tier lets the OpenAI-style flow be exercised
    without a paid key."""

    name = "Groq"
    base_url = "https://api.groq.com/openai"

    def _image_body(self, prompt: str, images: list[tuple[str, bytes]]) -> dict:
        # The llama models offered here have no vision; inheriting OpenAI's
        # image body would send pictures the model silently cannot see.
        return _Driver._image_body(self, prompt, images)


DRIVERS = {
    "gemini": GeminiDriver,
    "openai": OpenAiDriver,
    "anthropic": AnthropicDriver,
    "groq": GroqDriver,
}


def create_driver(provider: str, api_key: str, model: str, **kwargs) -> _Driver:
    """The one place a provider name becomes a driver."""
    driver = DRIVERS.get((provider or "").lower())

    if driver is None:
        raise AiProviderError(
            f"Unknown AI provider '{provider}'. Known ones: {', '.join(sorted(DRIVERS))}."
        )

    if not model:
        model = str(PROVIDERS[provider.lower()]["models"][0])

    return driver(api_key=api_key, model=model, **kwargs)
