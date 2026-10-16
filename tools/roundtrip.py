"""The acceptance gate from the spec, run for real.

The price module's OWN SiteClient -- not a copy, not a mock -- pointed at the
new platform instead of a Laravel site. If this passes with zero changes to
the module, the compat API is doing its job.
"""
import sys

sys.path.insert(0, "/app")

from app.console.site_client import SiteClient  # noqa: E402

BASE = "http://host.docker.internal:3100/api/compat/baseoil"
TOKEN = sys.argv[1]

c = SiteClient(BASE, TOKEN, "the new platform")
ok = True


def check(label, condition, detail=""):
    global ok
    ok = ok and bool(condition)
    print(f"{'PASS' if condition else 'FAIL'}  {label}{(' — ' + str(detail)) if detail else ''}")


locs = c.locations()["data"]
check("locations", len(locs) == 3, f"{len(locs)} rows, first={locs[0]}")

staged = c.stage_rows(
    rows=[
        {"location": "Singapore SN 150 FOB Group I", "price": 1520},
        {"location": "UAE SN 500 Group II", "price": 1340},
        {"location": "Atlantis FOB", "price": 999},
    ],
    price_date="2099-02-02",
    source="editorial",
)
batch_id = staged["batch"]["id"]
check("stage_rows", staged["batch"]["source"] == "editorial", staged["summary"])
check("blocked while a row needs attention", staged["committable"] is False,
      f"needs_attention={staged['needs_attention']}")

full = c.batch(batch_id)
items = full["items"]
check("batch detail", len(items) == 3, [i["status"] for i in items])

bad = next(i for i in items if i["status"] == "unmatched")
c.update_item(bad["id"], {"is_included": False})
check("exclude the unmatched row", c.batch(batch_id)["committable"] is True)

result = c.commit_batch(batch_id)
check("commit", result == {"applied": 0, "created": 2, "conflicts": 0}, result)

after = {l["title"]: l["latest_price"] for l in c.locations()["data"]}
check("prices published", after["Singapore SN 150 FOB Group I"] == 1520, after)

note = c.post_summary("Base oils eased in Asia this week; the Gulf held.", "editorial", batch_id)
check("price summary", note["id"] > 0, note)

listing = c.batches()
check("batch list", listing["meta"]["total"] == 1, listing["meta"])

rolled = c.rollback_batch(batch_id)
check("rollback", rolled == {"reverted": 0, "removed": 2, "skipped": 0}, rolled)

back = {l["title"]: l["latest_price"] for l in c.locations()["data"]}
check("prices withdrawn", all(v is None for v in back.values()), back)

try:
    SiteClient(BASE, "not-a-real-token", "x").locations()
    check("bad token refused", False)
except Exception as error:
    check("bad token refused", "refused the request" in str(error), str(error)[:90])

# ---- the crawler half: the same client, the calls the crawler itself makes ----

replaced = c.replace_watched_urls(
    "https://example.test/base-oils\nhttps://example.test/weekly",
    instructions="Read the table headed 'Weekly assessments'.",
)
check("replace watched urls", replaced["added"] == 2, replaced)

sources = c.sources()
check(
    "sources",
    sources["interval_minutes"] == 15
    and len(sources["urls"]) == 2
    and "Singapore SN 150 FOB Group I" in sources["locations"],
    f"{len(sources['urls'])} urls, {len(sources['locations'])} locations",
)

first = sources["urls"][0]["id"]
reported = c.report(
    [
        {
            "url_id": first,
            "status": "read",
            "content_hash": "hash-1",
            "rows": [
                {"location": "Singapore SN 150 FOB Group I", "price": 1540, "date": "2099-02-02"},
                {"location": "Somewhere Nobody Tracks", "price": 101},
            ],
        },
        {"url_id": sources["urls"][1]["id"], "status": "unchanged"},
    ]
)
check(
    "report a pass",
    reported[0]["status"] == "updated" and reported[0]["unmatched"] == 1,
    reported,
)

watched = c.watched_urls()
check(
    "watched urls",
    len(watched["data"]) == 2 and watched["data"][0]["last_status_text"] == "Price change found",
    watched["data"][0]["last_status_text"],
)

found = c.activity(limit=10)["data"]
check("activity", len(found) == 2, [f["location"] for f in found])

staged_crawl = c.stage(activity_ids=[f["id"] for f in found])
check(
    "stage findings",
    staged_crawl["rows"] == 1 and staged_crawl["skipped"] == 1,
    staged_crawl,
)
check("staged as a crawl batch", c.batch(staged_crawl["batch_id"])["batch"]["source"] == "crawl")

cleared = c.clear_activity()
check("clear activity", cleared["removed"] == 2, cleared)
check("activity emptied", c.activity(limit=10)["data"] == [])

print("\nROUND TRIP:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
