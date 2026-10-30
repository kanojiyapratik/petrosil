"""The live-settings copy (app/db/copy_live.py): which columns travel when the
two databases are a migration apart."""

from app.db.copy_live import REPLACED, SITE_SETTINGS, shared


def test_only_columns_both_sides_have_travel_in_the_targets_order():
    assert shared(["id", "name", "old_column"], ["id", "new_column", "name"]) == ["id", "name"]


def test_a_sites_address_and_token_never_travel():
    assert "api_url" not in SITE_SETTINGS and "api_token" not in SITE_SETTINGS


def test_history_is_not_carried():
    for table in ("console_editorial_drafts", "console_reading_sets", "console_ai_usage", "console_audit", "console_users"):
        assert table not in REPLACED
