"""DraftStore: the kept copy of every AI draft.

Like the usage ledger it must never break the work it records, and the draft
id a save links to arrives from a form, so a save only ever touches a draft
of the same site.
"""

import json

from app.db.store import DraftStore


class FakeConnection:
    def __init__(self, pool):
        self._pool = pool
        self._last = ""

    def execute(self, sql, params=None):
        sql = " ".join(sql.split())
        self._pool.statements.append((sql, params))

        if self._pool.fail_on and self._pool.fail_on in sql:
            raise RuntimeError("relation does not exist")

        self._last = sql

        return self

    def fetchone(self):
        if self._last.startswith("INSERT INTO console_editorial_drafts"):
            return (42,)

        if self._last.startswith("UPDATE console_editorial_drafts"):
            return self._pool.found

        return None

    def commit(self):
        self._pool.committed += 1

    def rollback(self):
        self._pool.rolled_back += 1


class FakePool:
    def __init__(self, fail_on=None, found=(42,)):
        self.statements = []
        self.fail_on = fail_on
        self.found = found
        self.committed = 0
        self.rolled_back = 0

    def connection(self):
        pool = self

        class Scope:
            def __enter__(self):
                return FakeConnection(pool)

            def __exit__(self, *args):
                return False

        return Scope()


ROW = {
    "location": "Turkey Domestic USD", "status": "suggested", "suggested_min": 620,
    "suggested_max": 630, "suggested_price": 625, "confidence": "high",
    "rationale": "TRY 30,000 converted", "flag": None, "fx_rate": 48.0,
    "conversion": "TRY 30,000 / 48.0000 TRY/USD",
}
BENCHMARK = {"location": "Report: FOB Asia SN 150", "status": "suggested", "suggested_price": 1300}


def row_inserts(pool):
    return [
        params for sql, params in pool.statements
        if sql.startswith("INSERT INTO console_editorial_draft_rows")
    ]


class TestKeepingADraft:
    def test_one_draft_and_one_row_per_location_benchmarks_marked(self):
        pool = FakePool()

        draft_id = DraftStore(pool).create(
            site_slug="bitumart", created_by="editor@local.test", rows=[ROW],
            benchmark_rows=[BENCHMARK], reading_set_id=7, price_date="2026-09-24",
            provider="openai", model="gpt-4o-mini", analysis_status="complete",
        )

        assert draft_id == 42
        assert pool.committed == 1
        location_row, benchmark_row = row_inserts(pool)
        assert location_row[:4] == (42, 0, "Turkey Domestic USD", False)
        assert benchmark_row[:4] == (42, 1, "Report: FOB Asia SN 150", True)

    def test_everything_the_row_carried_is_kept_in_detail(self):
        pool = FakePool()

        DraftStore(pool).create(site_slug="bitumart", created_by="e", rows=[ROW])

        detail = json.loads(row_inserts(pool)[0][-1])
        assert detail["fx_rate"] == 48.0
        assert detail["conversion"] == "TRY 30,000 / 48.0000 TRY/USD"

    def test_a_failure_loses_the_record_not_the_draft(self):
        pool = FakePool(fail_on="INSERT INTO console_editorial_drafts")

        assert DraftStore(pool).create(site_slug="s", created_by="e", rows=[ROW]) is None


class TestMarkingADraftSaved:
    def test_kept_rows_get_their_price_and_the_rest_are_marked_not_kept(self):
        pool = FakePool()

        linked = DraftStore(pool).mark_saved(
            42, "bitumart", batch_id=31, saved_by="editor@local.test",
            prices={"Turkey Domestic USD": 620.0},
        )

        assert linked is True
        sqls = [sql for sql, _ in pool.statements]
        assert "WHERE id = %s AND site_slug = %s" in sqls[0]
        assert pool.statements[0][1] == (31, "editor@local.test", 42, "bitumart")
        assert "ticked = FALSE" in sqls[1] and "NOT is_benchmark" in sqls[1]
        assert pool.statements[2][1] == (620.0, 42, "Turkey Domestic USD")
        assert pool.committed == 1

    def test_another_sites_draft_is_left_alone(self):
        pool = FakePool(found=None)

        linked = DraftStore(pool).mark_saved(
            42, "baseoil", batch_id=31, saved_by="e", prices={"X": 1.0},
        )

        assert linked is False
        assert len(pool.statements) == 1
        assert pool.rolled_back == 1

    def test_a_failure_loses_the_link_not_the_save(self):
        pool = FakePool(fail_on="UPDATE console_editorial_drafts")

        assert DraftStore(pool).mark_saved(
            42, "s", batch_id=31, saved_by="e", prices={}
        ) is False
