"""The Petrosil app's crawler loop (scraper/estate.py): every brand, every
pass, one failing brand never costing the others."""

from __future__ import annotations

from dataclasses import dataclass

from scraper.estate import main, run_estate_pass
from scraper.runner import Outcome


@dataclass
class Site:
    slug: str
    enabled: bool = True


def outcome(status: str) -> Outcome:
    return Outcome(url_id=1, url="https://example.test/p", status=status)


def test_every_enabled_brand_is_crawled_in_turn():
    crawled = []

    def crawl(site):
        crawled.append(site.slug)
        return [outcome("read"), outcome("unchanged")]

    report = run_estate_pass([Site("baseoil"), Site("bitumart", enabled=False), Site("waxreport")], crawl)

    assert crawled == ["baseoil", "waxreport"]
    assert report == {"baseoil": 2, "waxreport": 2}


def test_a_brand_that_fails_is_reported_and_the_rest_still_run():
    def crawl(site):
        if site.slug == "bitumart":
            raise RuntimeError("No AI provider is configured")
        return []

    report = run_estate_pass([Site("baseoil"), Site("bitumart"), Site("waxreport")], crawl)

    assert report == {"baseoil": 0, "bitumart": "failed: No AI provider is configured", "waxreport": 0}


def test_a_stop_request_ends_the_pass_between_brands():
    asked = []

    report = run_estate_pass(
        [Site("baseoil"), Site("bitumart")],
        lambda site: asked.append(site.slug) or [],
        stop=lambda: len(asked) == 1,
    )

    assert asked == ["baseoil"]
    assert list(report) == ["baseoil"]


def test_without_the_engines_database_it_refuses_to_start(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)

    assert main(["--once"]) == 1
