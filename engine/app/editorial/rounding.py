"""Rounding a suggested price to the site's chosen step.

The client's rulebook ends nearly every line the same way: "Take Average
from Report, round off closest multiple of 5" -- and, for the handful that
differ, "closest multiple of 10" (Turkey's own-currency price). The average
already happens in code (review.py's midpoint); the rounding never did, so
every price reaching the client had to be hand-rounded before it was
published.

A step belongs to the LOCATION, not to a price rule: most of the client's
~38 locations carry no rule at all -- they come straight from a report --
so console_price_rules (keyed by site and DERIVED location, and only ever
populated for one) is the wrong home for it on its own. Instead every site
has a default step (bitumart: 5) and a location may override it (Turkey:
10). See app/db/store.py's StoredSite.round_to_nearest and RoundingStore
for where those two live and why.

Applied once, here, after FX conversion and the rules engine have both run
(see app/console/routes_editorial.py's analyse route) -- the same stage
app/editorial/rules.py's `_whole` already rounds a derived price to a whole
unit at. That placement is what puts a direct price, a converted price and
a derived price on the same grid: whichever path a number took to become a
USD suggestion, it reaches the editor already rounded.

Purely arithmetic, so it is code's job, never the model's: nothing about a
step is ever asked of a prompt, and the report's own printed figure (step
one, review.py's build_rows) is never touched.
"""

from __future__ import annotations

import math

from ..price_review.differ import js_number

# A row in one of these statuses carries a USD figure that is about to be
# offered to the editor as a price to save -- a direct suggestion, a close
# match awaiting confirmation, or a rule-derived price. `needs_rate` and
# `foreign` rows are still printed in another currency (fx.convert_rows
# has not turned them into a USD suggestion, or could not), and
# `no_evidence`/`invalid` rows carry no figure at all -- none of those are
# touched.
ROUNDABLE_STATUSES = ("suggested", "near_match", "derived")

# Which way a price that sits between two multiples is taken. "nearest" is
# the client's rulebook ("closest multiple of 5") and stays the default
# everywhere; "up" and "down" are for the locations he always takes one way
# -- at a step of 5, 97 is 100 rounding up and 95 rounding down, and both
# leave an exact 95 alone.
DIRECTIONS = ("nearest", "up", "down")

# How each direction reads in a rationale and on the settings screen:
# "to the nearest 5", "up to the next 5", "down to the previous 5".
DIRECTION_LABELS = {
    "nearest": "to the nearest",
    "up": "up to the next",
    "down": "down to the previous",
}


def normalise_direction(direction: str | None) -> str:
    """Anything unrecognised -- blank, None, an old row written before this
    column existed -- means the rulebook's own "closest multiple of"."""
    chosen = (direction or "").strip().lower()

    return chosen if chosen in DIRECTIONS else "nearest"


def round_to_nearest(value: float, step: float | None, direction: str | None = "nearest") -> float:
    """A multiple of `step`: the nearest one (half away from zero -- the same
    rule `app.editorial.rules._whole` already uses for a whole USD/MT, so a
    step of 1 agrees with it exactly), or the one above or below when the
    location says always to go that way.

    "Up" and "down" are the number line's up and down, not the magnitude's:
    on a negative figure, down is the more negative multiple. Nothing in
    this module prices below zero, but a silent sign flip would be worse
    than an arithmetic that simply reads the way it is named.

    A step that is missing, zero or negative means "do not round": today's
    behaviour, and never a crash or a division by zero.
    """
    if not step or step <= 0:
        return value

    scaled = value / step
    way = normalise_direction(direction)

    if way == "up":
        rounded_units = math.ceil(scaled)
    elif way == "down":
        rounded_units = math.floor(scaled)
    else:
        rounded_units = math.floor(scaled + 0.5) if scaled >= 0 else math.ceil(scaled - 0.5)

    return rounded_units * step


def _step_and_direction(override) -> tuple[float | None, str]:
    """An override is either a plain step (how this module was first called,
    and how every caller that does not care about direction still calls it)
    or a (step, direction) pair."""
    if isinstance(override, (tuple, list)):
        step = override[0]
        direction = override[1] if len(override) > 1 else "nearest"

        return step, normalise_direction(direction)

    return override, "nearest"


def settings_for(location: str, default_step, overrides: dict | None) -> tuple[float | None, str]:
    """What step and direction one location is rounded on.

    A location's own setting always beats the site default; either may be a
    bare step or a (step, direction) pair. Public because three modules have
    to agree on the answer: this one applies it, preflight checks a published
    figure against it, and workings tells the client what was applied. Three
    copies of the lookup would be three chances for the check and the
    explanation to disagree with what actually happened.
    """
    overrides = overrides or {}

    return _step_and_direction(
        overrides[location] if location in overrides else default_step
    )


def apply_rounding(
    rows: list[dict],
    default_step: float | None,
    overrides: dict[str, float | tuple[float, str]] | None = None,
) -> list[dict]:
    """Rounds every priced row's suggested price to its location's step.

    A location's own step (`overrides`) always beats the site's default;
    either one being empty, zero or negative leaves the row exactly as it
    was. An override may carry its own direction as a (step, direction)
    pair; a bare number, and the site default, mean "nearest". Never
    silent: a row whose price actually moves says so in its rationale, the
    same way a derived price already states its calculation ("Calculated
    from Singapore Bulk +20 USD") -- an editor must be able to see that
    1,647 became 1,645 and why, not just the 1,645.
    """
    overrides = overrides or {}

    for row in rows:
        if row.get("status") not in ROUNDABLE_STATUSES or row.get("suggested_price") is None:
            continue

        # Still printed in another currency -- fx.convert_rows either hasn't
        # run or found no rate for it. Rounding a lira figure as though it
        # were dollars would be worse than not rounding it.
        if row.get("currency"):
            continue

        step, direction = _step_and_direction(
            overrides[row["location"]] if row["location"] in overrides else default_step
        )

        if not step or step <= 0:
            continue

        original = row["suggested_price"]
        rounded = round_to_nearest(original, step, direction)

        if rounded == original:
            continue

        # A figure that rounds away to nothing was never a price at this
        # location's scale -- TRY 145 read off the wrong row became EUR 2.57
        # and then 0, offered as the price to save. Say so; offer nothing.
        if rounded <= 0:
            row["status"] = "invalid"
            row["suggested_price"] = None
            note = (
                f"Rounds to {js_number(rounded)} at a step of {js_number(step)} "
                f"(was {js_number(original)}) -- far too small to be this "
                "location's price. Check the report."
            )
            row["rationale"] = f"{row['rationale']} {note}" if row.get("rationale") else note
            continue

        row["suggested_price"] = js_number(rounded)
        # Which way it went matters to an editor checking a figure against
        # the report, not just that it moved.
        note = (
            f"Rounded {DIRECTION_LABELS[direction]} {js_number(step)} "
            f"(was {js_number(original)})."
        )
        row["rationale"] = f"{row['rationale']} {note}" if row.get("rationale") else note

    return rows
