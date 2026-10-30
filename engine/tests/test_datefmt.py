"""One date format on every screen: DD-MM-YY, the owner's ask."""

from app.console.routes import datefmt


def test_an_iso_date_reads_day_first():
    assert datefmt("2026-08-25") == "25-08-26"


def test_a_timestamp_keeps_only_its_date():
    assert datefmt("2026-08-25T12:32:04+05:30") == "25-08-26"


def test_anything_unrecognisable_passes_through():
    assert datefmt("") == ""
    assert datefmt(None) == "—"
    assert datefmt("soon") == "soon"
