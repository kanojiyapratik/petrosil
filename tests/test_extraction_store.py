"""The one part of the reading store that is not plain SQL.

update_row builds its SET clause from the caller's keyword names, so the
allowlist is the only thing standing between a typo -- or worse -- and the
statement. The rest of this store is SQL the other stores' style leaves
untested; it is exercised through the routes in test_reading_routes.py.
"""

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
