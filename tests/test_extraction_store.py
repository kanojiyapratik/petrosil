"""The one part of the reading store that is not plain SQL.

update_row builds its SET clause from the caller's keyword names, so the
allowlist is the only thing standing between a typo -- or worse -- and the
statement. The rest of this store is SQL the other stores' style leaves
untested; it is exercised through the routes in test_reading_routes.py.

set_by_id's used_at column gets its own pin below: it is what analyse()
checks before spending a reading a second time, and nothing else in the
test suite talks to a real database to prove the SELECT actually carries it.
"""

import datetime

from app.db.store import ExtractionStore


class FakeConnection:
    def __init__(self, log):
        self._log = log
        self.committed = False

    def execute(self, sql, params=None):
        self._log.append((" ".join(sql.split()), params))

        return self

    def commit(self):
        self.committed = True

    def fetchone(self):
        return None

    def fetchall(self):
        return []


class FakePool:
    def __init__(self):
        self.statements = []

    def connection(self):
        log = self.statements

        class Scope:
            def __enter__(self):
                return FakeConnection(log)

            def __exit__(self, *args):
                return False

        return Scope()


class TestCorrectingAReadRow:
    def test_a_correction_names_only_the_field_it_changes(self):
        pool = FakePool()

        ExtractionStore(pool).update_row(7, price=1650.0)

        sql, params = pool.statements[0]

        assert sql == "UPDATE console_reading_rows SET price = %s WHERE id = %s"
        assert params == (1650.0, 7)

    def test_several_fields_travel_with_their_values_in_the_same_order(self):
        pool = FakePool()

        ExtractionStore(pool).update_row(7, name="FOB Asia SN 150", kept=False)

        sql, params = pool.statements[0]

        assert sql.count("= %s") == 3  # two fields plus the id
        assert params[-1] == 7
        assert set(params[:-1]) == {"FOB Asia SN 150", False}

    def test_a_field_that_is_not_a_column_never_reaches_the_statement(self):
        # The SET clause is built from these names. Anything not on the
        # allowlist has to be dropped before it gets there.
        pool = FakePool()

        ExtractionStore(pool).update_row(7, price=10.0, site_slug="other", id=99)

        sql, _ = pool.statements[0]

        assert "site_slug" not in sql
        assert "id = %s WHERE" not in sql

    def test_a_correction_that_changes_nothing_writes_nothing(self):
        pool = FakePool()

        ExtractionStore(pool).update_row(7, nonsense="x")

        assert pool.statements == []


class FakeConnectionReturning:
    """Like FakeConnection, but answers fetchone/fetchall with fixed rows --
    for the one query (set_by_id) whose result shape matters here."""

    def __init__(self, log, row, files_rows):
        self._log = log
        self._row = row
        self._files_rows = files_rows

    def execute(self, sql, params=None):
        self._log.append((" ".join(sql.split()), params))

        return self

    def commit(self):
        pass

    def fetchone(self):
        return self._row

    def fetchall(self):
        return list(self._files_rows)


class FakePoolReturning:
    def __init__(self, row, files_rows=()):
        self.statements = []
        self._row = row
        self._files_rows = files_rows

    def connection(self):
        log = self.statements
        row, files_rows = self._row, self._files_rows

        class Scope:
            def __enter__(self):
                return FakeConnectionReturning(log, row, files_rows)

            def __exit__(self, *args):
                return False

        return Scope()


class TestReadingSetById:
    """analyse() refuses a reading that is already used, and the reading
    routes' own guards need the site it belongs to -- both come from this
    one query, so both columns have to actually be in it."""

    def test_the_query_selects_used_at_and_it_reaches_the_reading_set(self):
        used = datetime.datetime(2026, 8, 2)
        pool = FakePoolReturning(
            row=(7, "baseoil", "editor@local.test", datetime.datetime(2026, 8, 1), used),
        )

        reading = ExtractionStore(pool).set_by_id(7)

        sql, _ = pool.statements[0]
        assert "used_at" in sql
        assert reading.used_at == used
        assert reading.site_slug == "baseoil"

    def test_an_unused_reading_has_no_used_at(self):
        pool = FakePoolReturning(
            row=(7, "baseoil", "editor@local.test", datetime.datetime(2026, 8, 1), None),
        )

        reading = ExtractionStore(pool).set_by_id(7)

        assert reading.used_at is None

    def test_a_missing_set_is_none(self):
        pool = FakePoolReturning(row=None)

        assert ExtractionStore(pool).set_by_id(999) is None
