import pytest

from scraper.config import ConfigError, load
from scraper.normalise import normalise_title

MINIMAL = {
    "SITE_API_URL": "https://baseoilreport.com/api",
    "SITE_API_TOKEN": "site-token",
    "GOOGLE_GENERATIVE_AI_API_KEY": "k",
}


class TestLoad:
    def test_defaults_to_the_owners_cadence(self):
        config = load(MINIMAL)

        assert config.interval_seconds == 900
        assert config.model == "gemini-2.5-flash"

    def test_reads_overrides(self):
        config = load({**MINIMAL, "CRAWL_INTERVAL_SECONDS": "300", "AI_MODEL": "gemini-2.5-pro"})

        assert config.interval_seconds == 300
        assert config.model == "gemini-2.5-pro"

    def test_trims_a_trailing_slash_off_the_api_url(self):
        # So the client can join paths without producing a double slash.
        assert load({**MINIMAL, "SITE_API_URL": "https://x.com/api/"}).site_api_url == (
            "https://x.com/api"
        )

    def test_refuses_to_start_without_a_site_to_serve(self):
        # Pointing at one site is the crawler's entire configuration; a
        # crawler with no site has no job.
        with pytest.raises(ConfigError) as error:
            load({"GOOGLE_GENERATIVE_AI_API_KEY": "k"})

        assert "SITE_API_URL" in str(error.value)
        assert "SITE_API_TOKEN" in str(error.value)

    def test_refuses_to_start_without_a_key(self):
        # The model does the reading, so a keyless crawler has no job either.
        with pytest.raises(ConfigError) as error:
            load({k: v for k, v in MINIMAL.items() if "GOOGLE" not in k})

        assert "GOOGLE_GENERATIVE_AI_API_KEY" in str(error.value)

    def test_caps_the_url_list(self):
        assert load(MINIMAL).max_urls_per_run == 50
        assert load({**MINIMAL, "CRAWL_MAX_URLS": "5"}).max_urls_per_run == 5


class TestNormaliseTitle:
    def test_matches_the_php_resolver_rule(self):
        assert normalise_title("  Europe   SN 500 ") == "europe sn 500"
        assert normalise_title("SINGAPORE") == "singapore"
        assert normalise_title("") == ""
        assert normalise_title(None) == ""


class TestTimeouts:
    def test_the_site_gets_a_longer_budget_than_a_watched_page(self):
        # A watched page either answers promptly or is not worth waiting for.
        # baseoil itself is a cold Laravel 7 that regularly takes 15-20s, and
        # sharing the page timeout meant a pass could die before it started.
        config = load(MINIMAL)

        assert config.timeout_seconds == 30
        assert config.site_timeout_seconds == 120

    def test_both_timeouts_can_be_set_independently(self):
        config = load(
            {**MINIMAL, "CRAWL_TIMEOUT_SECONDS": "10", "SITE_API_TIMEOUT_SECONDS": "45"}
        )

        assert config.timeout_seconds == 10
        assert config.site_timeout_seconds == 45
