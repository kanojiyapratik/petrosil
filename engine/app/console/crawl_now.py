"""Running a crawl pass on demand, from the console.

The crawler normally runs on its own fifteen-minute loop. This is the "check
now" button: after adding a URL, nobody wants to wait a quarter of an hour to
find out whether it works.

It exists at all because the module is one language now. The console can
import the crawler's own runner and call it against a site, rather than
shelling out or duplicating the logic -- the consolidation paying for itself.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from scraper.ai import DriverExtractor
from scraper.rules import RuleExtractor
from scraper.config import DEFAULT_USER_AGENT
from scraper.fetcher import Fetcher
from scraper.runner import run_once
from scraper.site import CrawlerSiteClient

from ..ai.providers import create_driver
from ..db.store import StoredSite
from .site_client import SiteClient

logger = logging.getLogger("console.crawl")


@dataclass(frozen=True)
class PassConfig:
    """The handful of settings run_once() reads. Deliberately not the
    crawler's full Config: this pass gets its site from the console, not from
    the environment."""

    max_urls_per_run: int
    max_region_chars: int


def crawl_site_now(site: StoredSite, use_rules: bool | None = None, providers=None) -> list:
    """One pass over one site's watched URLs. Returns the outcomes.

    Raises whatever the site client raises, so the screen can report why it
    could not be done rather than claiming it was.
    """
    # The provider this site was given on the AI screen, or the default, or
    # -- for a deployment that has configured neither -- the environment.
    chosen = providers.for_site(site.slug) if providers is not None else None
    api_key = chosen.api_key if chosen else os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")

    # The screen can ask for a run without the model; otherwise the
    # environment decides. Passing it in beats reading the environment here,
    # so a diagnostic run is a choice someone made rather than a deployment
    # setting nobody remembers.
    if use_rules is None:
        use_rules = os.environ.get("CRAWL_EXTRACTOR", "ai").lower() == "rules"

    if api_key == "" and not use_rules:
        raise RuntimeError(
            "No AI provider is configured, so pages cannot be read. Add one "
            "under Settings > AI."
        )

    client = CrawlerSiteClient(
        SiteClient(base_url=site.api_url, token=site.token, name=site.name)
    )
    fetcher = Fetcher(
        user_agent=os.environ.get("CRAWL_USER_AGENT", DEFAULT_USER_AGENT),
        timeout_seconds=int(os.environ.get("CRAWL_TIMEOUT_SECONDS", "30")),
    )
    extractor = (
        RuleExtractor()
        if use_rules
        else DriverExtractor(
            create_driver(
                chosen.provider if chosen else "gemini",
                api_key,
                chosen.model if chosen else os.environ.get("AI_MODEL", "gemini-2.5-flash"),
            )
        )
    )
    config = PassConfig(
        max_urls_per_run=int(os.environ.get("CRAWL_MAX_URLS", "50")),
        max_region_chars=int(os.environ.get("CRAWL_MAX_REGION_CHARS", "8000")),
    )

    outcomes = run_once(client, fetcher, extractor, config)

    for outcome in outcomes:
        logger.info(
            "%s -> %s (rows=%s ai=%s)", outcome.url, outcome.status, outcome.row_count,
            "yes" if outcome.used_ai else "no",
        )

    return outcomes


def describe(outcomes: list, used_rules: bool = False) -> str:
    """A sentence an admin can act on, rather than a status vocabulary.

    An unchanged pass is the normal, healthy outcome most of the time, so it
    must not read like a failure.
    """
    if not outcomes:
        return "No URLs are being watched, so there was nothing to check."

    prefix = (
        "Read without AI, so the labels are rough and this is a check that the "
        "crawler works — not data to publish. "
        if used_rules
        else ""
    )

    read = [o for o in outcomes if o.status == "read"]
    unchanged = [o for o in outcomes if o.status == "unchanged"]
    trouble = [o for o in outcomes if o.status in ("blocked", "disallowed", "failed")]
    nothing = [o for o in outcomes if o.status == "no_rows"]

    parts = [f"Checked {len(outcomes)} URL(s)."]

    if read:
        parts.append(f"{len(read)} had changed and were read.")

    if unchanged:
        parts.append(f"{len(unchanged)} had not changed.")

    if nothing:
        parts.append(f"{len(nothing)} had no prices to read.")

    if trouble:
        parts.append(f"{len(trouble)} could not be read — see the list below.")

    return prefix + " ".join(parts)


def propose_matches(
    unmatched: list[dict], location_titles: list[str], *, active, chosen, model, usage=None,
    site_slug: str | None = None,
) -> dict:
    """Which tracked location each crawled finding the site could not place
    probably is, with a caution when something is off (a different
    currency, per-litre pricing). The person confirms in a picker; a model
    failure just means no proposals.

    `unmatched` rows are {"id", "location", "price"}. Answers
    {finding id: {"match", "caution"}}.
    """
    from ..editorial.match import build_match_prompt, parse_match_answer

    if not unmatched or not location_titles or active is None:
        return {}

    try:
        prompt = build_match_prompt(
            [{"id": r["id"], "location": r.get("location"), "price": r.get("price")} for r in unmatched],
            location_titles,
        )
        completion = active.generate(prompt) if chosen is not None else active.generate(model, prompt)

        if usage is not None:
            usage.record(
                kind="crawler_match",
                provider=getattr(active, "provider_key", "gemini"),
                model=model,
                status=completion.status,
                prompt_tokens=completion.prompt_tokens,
                completion_tokens=completion.completion_tokens,
                site_slug=site_slug,
            )

        return parse_match_answer(completion.text, {r["id"] for r in unmatched}, location_titles)
    except Exception:  # noqa: BLE001 - proposals are a convenience, never a blocker
        return {}
