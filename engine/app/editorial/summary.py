"""A plain-English note about a price update that has just gone live.

The note is shown above the site's price trends table, which is a PUBLIC page:
it deliberately hides every figure from visitors who have not subscribed. So
the note is built from directions and percentages and nothing else. The model
is never told what a price is, which makes leaking one impossible rather than
merely discouraged -- an instruction in a prompt is a request, and this is the
paywall.
"""

from __future__ import annotations

from app.ai.providers import AiCompletion


def _movement(item: dict) -> str:
    """How this row moved, in words, with no absolute price in it."""
    pct = item.get("delta_pct")
    old = item.get("old_price")

    # A row new on its date usually is not the market's first price. A site
    # that says what the price was before (`previous_price`, sent beside the
    # usual keys by the Petrosil app) gets the move from it; one that does
    # not -- the PHP sites -- reads as it always has.
    previous = item.get("previous_price")

    if pct is None and old is None and previous:
        try:
            pct = (float(item.get("new_price")) - float(previous)) / float(previous) * 100
        except (TypeError, ValueError, ZeroDivisionError):
            pct = None

    if pct is None:
        return "priced for the first time" if old is None else "updated"

    if round(float(pct), 1) == 0.0:
        return "unchanged"

    direction = "up" if float(pct) > 0 else "down"

    return f"{direction} {abs(float(pct)):.1f}%"


def digest(items: list[dict]) -> list[str]:
    """One line per row the admin is actually publishing."""
    lines = []

    for item in items or []:
        if not item.get("is_included"):
            continue

        location = (item.get("location") or item.get("raw_location") or "").strip()

        if not location:
            continue

        lines.append(f"{location}: {_movement(item)}")

    return lines


def build_summary_prompt(items: list[dict], source: str) -> str:
    """The whole prompt. Carries movements, never prices."""
    lines = digest(items)

    where = {
        "crawl": "an automatic crawl of the price pages we watch",
        "editorial": "an AI reading of this week's market reports",
        "upload": "a spreadsheet the desk uploaded",
        "bulk_edit": "a bulk edit by the desk",
    }.get(source, "a price update by the desk")

    return "\n".join(
        [
            "You write one short note for the top of a public base-oil price page.",
            "",
            f"The update below came from {where} and has just been published.",
            "Each line is a location and how its price moved. There are no",
            "figures here on purpose: the page hides prices from visitors who",
            "have not subscribed, and your note must not invent or imply one.",
            "",
            "What changed:",
            *lines,
            "",
            "Write 2 to 4 sentences of plain English for a trade reader. Say which",
            "regions and grades moved and in which direction, roughly how far in",
            "percentage terms, and what held steady. Do not quote an absolute",
            "price, a currency amount or a price range. Do not use bullet points,",
            "headings or markdown. Reply with the note itself and nothing else.",
        ]
    )


def write_summary(driver, model: str | None, items: list[dict], source: str) -> str | None:
    """Ask the model for the note.

    Returns None rather than raising: this runs immediately after a batch has
    been committed, and a provider having a bad day must never make a
    successful publish look like a failure.
    """
    if not digest(items):
        return None

    prompt = build_summary_prompt(items, source)

    try:
        completion: AiCompletion = (
            driver.generate(prompt) if model is None else driver.generate(model, prompt)
        )
    except Exception:  # noqa: BLE001 - see the docstring: never break a commit
        return None

    if completion.status != "complete" or not completion.text:
        return None

    text = completion.text.strip()

    return text or None
