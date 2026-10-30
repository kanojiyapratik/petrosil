"""Showing and hiding a site from the Sites screen.

A hidden site is not merely unlinked: the site list is built from
enabled_sites() and every site screen guards on `enabled`, so a site being
set up cannot be reached by anyone who guesses its address. That makes the
switch a real access control, which is why it is one button rather than a
re-save of the site's whole configuration -- re-saving is how a token gets
overwritten by accident.
"""

from app.db.store import Store


class FakeConnection:
    def __init__(self, log, row):
        self._log = log
        self._row = row
        self.committed = False

    def execute(self, sql, params=None):
        self._log.append((" ".join(sql.split()), params))

        return self

    def commit(self):
        self.committed = True

    def fetchone(self):
        return self._row

    def fetchall(self):
        return []


class FakePool:
    def __init__(self, row=None):
        self.statements = []
        self._row = row

    def connection(self):
        log, row = self.statements, self._row

        class Scope:
            def __enter__(self):
                return FakeConnection(log, row)

            def __exit__(self, *args):
                return False

        return Scope()


A_SITE = (1, "waxreport", "Wax Report", "http://wax/api", "tok", True, None, None, None)


class TestTheSwitchTouchesOnlyVisibility:
    def test_hiding_a_site_writes_only_the_enabled_column(self):
        pool = FakePool(row=A_SITE)

        Store(pool).set_site_enabled("waxreport", False)

        sql, params = pool.statements[0]

        assert sql.startswith("UPDATE console_sites SET enabled = %s")
        assert params[0] is False and params[1] == "waxreport"
        # The token and address are the credential every screen depends on, so
        # they must not be in what this statement WRITES. They do appear in its
        # RETURNING clause, which only reads them back -- so assert against the
        # SET clause alone rather than the whole statement.
        written = sql.split("RETURNING")[0]

        assert "api_token" not in written
        assert "api_url" not in written

    def test_showing_a_site_writes_true(self):
        pool = FakePool(row=A_SITE)

        Store(pool).set_site_enabled("waxreport", True)

        assert pool.statements[0][1][0] is True

    def test_an_unknown_site_is_none_rather_than_a_crash(self):
        # The slug comes off a URL, so it is whatever someone typed.
        assert Store(FakePool(row=None)).set_site_enabled("nosuchsite", True) is None
