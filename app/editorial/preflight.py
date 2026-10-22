"""The check that runs before a sheet leaves the building.

Between 8 and 21 October 2026 four mismatch files went back and forth with
the client, and the same dozen rows were queried in every one of them. Going
through the 16 October round by hand against Argus issue 26-41 turned up six
faults, and every one of them was visible from data already on this machine:
a published figure contradicting its own rule, its own rounding setting, or
the range it was quoted from. Nobody needed the client to find them. Nobody
needed the report.

So this module asks five questions of a finished draft:

  1. does every derived price satisfy the rule it was derived by?
  2. is every price on its location's step, taken the way that location
     takes it?
  3. does every price sit inside the range the report actually printed?
  4. could that range be one assessment at all?
  5. is the report it came from from the week the run is for?

Question 4 was added on 22 October, when a run read South Korea FOB as
"314.3-550" and published the midpoint with nothing flagged: questions 1 to
3 all passed, because 430 really is inside 314.3-550. The range was the
fault and nothing was asking about the range.

What it is NOT: a second opinion on whether a price is *right*. It cannot
know that, and neither can anything else without an editor. It only catches
the sheet disagreeing with itself -- which is the whole of what the hand
check found, and is the part that recurs.

Findings are ordered blockers first. A blocker is an internal contradiction:
there is no reading of the configuration under which the figure is correct,
so it must not ship. A warning is something an editor should see and may
well wave through -- a quiet week when Argus published nothing new is a real
thing, and refusing to publish because of it would be worse than the stale
figure it is guarding against.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from .rounding import normalise_direction, round_to_nearest, settings_for
from .rules import FIXED, PERCENT, PriceRule, adjustment_label

# Statuses that carry a figure about to be published. The same tuple the
# rounding pass uses, and for the same reason: anything else is either not a
# price yet or not a price at all.
PRICED_STATUSES = ("suggested", "near_match", "derived")

# A report this many days older than the run, OR MORE, is the previous
# issue rather than the current one. Seven, because the assessments this
# module reads are weekly: the issue for a run dated Friday 16 October is
# dated 16 October, and the one dated 9 October is last week's -- exactly
# seven days, which is why this is read as "or more" and not "more than".
DEFAULT_STALE_AFTER_DAYS = 7

# How much wider than its low a quoted range may be before it stops looking
# like one assessment. Every genuine range on the 22 October sheet was inside
# 4.2% -- Japan's 759-791, the widest of 25 -- and the fault it is there to
# catch was 75%. Twenty leaves the real ones a wide berth and still catches
# two figures off different lines read as one.
MAX_QUOTED_SPREAD = 0.20

BLOCKER = "blocker"
WARNING = "warning"


@dataclass(frozen=True)
class Finding:
    location: str
    check: str
    severity: str
    detail: str
    expected: float | None = None
    actual: float | None = None


def _settings(location: str, default_step, overrides: dict) -> tuple[float | None, str]:
    """Shared with the pass that does the rounding and the one that explains
    it, so a check cannot disagree with what actually happened."""
    return settings_for(location, default_step, overrides)


def _priced(row: dict) -> bool:
    """A row whose figure is about to be published as dollars.

    A figure still printed in another currency is skipped: fx.convert_rows
    either has not run or found no rate, so neither the step nor the range
    means what these checks would read into it.
    """
    return (
        row.get("status") in PRICED_STATUSES
        and row.get("suggested_price") is not None
        and not row.get("currency")
    )


def _midpoint(row: dict) -> float | None:
    low, high = row.get("suggested_min"), row.get("suggested_max")

    return (low + high) / 2 if low is not None and high is not None else None


def _adjusted(value: float, rule: PriceRule) -> float:
    if rule.adjustment_kind in FIXED:
        return value + rule.adjustment_value

    return value * (1 + (rule.adjustment_value / 100.0))


def check_rules(
    rows: list[dict], rules: list[PriceRule], default_step, overrides: dict
) -> list[Finding]:
    """Every derived price against the rule it was derived by.

    The rules engine runs on UNROUNDED references and both figures are
    rounded afterwards, so a percentage rule cannot be reproduced exactly
    from the rounded reference -- the two roundings do not commute. A fixed
    adjustment that is a whole number of steps does commute, and is held to
    the figure exactly. Everything else is allowed one step of slack, which
    is the most that double rounding can cost; a percentage that is further
    out than that is wrong for some other reason.
    """
    by_location = {row["location"]: row for row in rows}
    findings: list[Finding] = []

    for rule in rules:
        if not rule.enabled:
            continue

        target = by_location.get(rule.derived_location)
        reference = by_location.get(rule.reference_location)

        if target is None or reference is None:
            continue

        # Nothing to check against, and nothing to blame the target for.
        if not _priced(target) or not _priced(reference):
            continue

        step, direction = _settings(target["location"], default_step, overrides)
        expected = round_to_nearest(_adjusted(reference["suggested_price"], rule), step, direction)
        actual = target["suggested_price"]

        exact = rule.adjustment_kind in FIXED and (
            not step or step <= 0 or abs(rule.adjustment_value) % step == 0
        )
        slack = 0 if exact else (step or 0)

        if abs(actual - expected) <= slack:
            continue

        findings.append(
            Finding(
                location=target["location"],
                check="rule",
                severity=BLOCKER,
                detail=(
                    f"{rule.derived_location} is {rule.reference_location} "
                    f"{adjustment_label(rule)}. {rule.reference_location} was published at "
                    f"{_figure(reference['suggested_price'])}, which gives "
                    f"{_figure(expected)}; this sheet says {_figure(actual)}."
                ),
                expected=expected,
                actual=actual,
            )
        )

    return findings


def check_rounding(rows: list[dict], default_step, overrides: dict) -> list[Finding]:
    """Every price against its location's step and direction.

    Recomputed from the range rather than from the published figure, because
    the rounding pass overwrites `suggested_price` in place and keeps the
    figure it started from only in the rationale text.
    """
    findings: list[Finding] = []

    for row in rows:
        if not _priced(row):
            continue

        # A derived price is arithmetic on another row, not a midpoint of
        # its own; check_rules is what proves it, start to finish.
        if row.get("status") == "derived":
            continue

        midpoint = _midpoint(row)

        if midpoint is None:
            continue

        step, direction = _settings(row["location"], default_step, overrides)

        if not step or step <= 0:
            continue

        expected = round_to_nearest(midpoint, step, direction)
        actual = row["suggested_price"]

        if actual == expected:
            continue

        findings.append(
            Finding(
                location=row["location"],
                check="rounding",
                severity=BLOCKER,
                detail=(
                    f"The report gave {_figure(row['suggested_min'])}-"
                    f"{_figure(row['suggested_max'])}, mid {_figure(midpoint)}. "
                    f"{row['location']} rounds {_direction_words(direction)} "
                    f"{_figure(step)}, which is {_figure(expected)}; this sheet says "
                    f"{_figure(actual)}."
                ),
                expected=expected,
                actual=actual,
            )
        )

    return findings


def check_within_range(rows: list[dict], default_step, overrides: dict) -> list[Finding]:
    """A price outside the range it was quoted from.

    A midpoint cannot be outside its own low and high, so a figure that is
    has been overwritten by something -- the 16 October sheet published Japan
    at 840 against a quoted 759-791. One step of slack, because rounding a
    single-figure assessment legitimately steps outside it: 893 to the
    nearest 5 is 895.
    """
    findings: list[Finding] = []

    for row in rows:
        if not _priced(row) or row.get("status") == "derived":
            continue

        low, high = row.get("suggested_min"), row.get("suggested_max")

        if low is None or high is None:
            continue

        step, _ = _settings(row["location"], default_step, overrides)
        slack = step if step and step > 0 else 0
        actual = row["suggested_price"]

        if low - slack <= actual <= high + slack:
            continue

        findings.append(
            Finding(
                location=row["location"],
                check="range",
                severity=BLOCKER,
                detail=(
                    f"Published at {_figure(actual)}, but the report quoted "
                    f"{_figure(low)}-{_figure(high)}. A price cannot be outside the "
                    "range it came from."
                ),
                expected=None,
                actual=actual,
            )
        )

    return findings


def check_quoted_spread(rows: list[dict]) -> list[Finding]:
    """A range too wide to be one assessment.

    The 22 October run read South Korea FOB as "314.3-550" and published the
    midpoint, 430, with high confidence and not a single finding against it.
    Every check passed honestly: 430 really is inside 314.3-550, the step was
    right, the source was recorded. The range itself was the fault -- two
    unrelated figures off different lines, read as one assessment -- and
    nothing here asked whether a range could be real.

    A warning, not a blocker: a violent week is a real thing and the data
    cannot prove which it is. But the midpoint of a range this wide is not an
    assessment of anything, so an editor has to look.
    """
    findings: list[Finding] = []

    for row in rows:
        if not _priced(row) or row.get("status") == "derived":
            continue

        low, high = row.get("suggested_min"), row.get("suggested_max")

        if low is None or high is None or low <= 0:
            continue

        spread = (high - low) / low

        if spread <= MAX_QUOTED_SPREAD:
            continue

        findings.append(
            Finding(
                location=row["location"],
                check="quoted range",
                severity=WARNING,
                detail=(
                    f"quoted {_figure(low)}-{_figure(high)}, a high {spread:.0%} above the low. "
                    "A single assessment does not span that; this looks like two figures off "
                    "different lines read as one range, and the midpoint is then an average of "
                    "two unrelated prices. Check the report."
                ),
                expected=None,
                actual=row.get("suggested_price"),
            )
        )

    return findings


def check_provenance(rows: list[dict]) -> list[Finding]:
    """A published figure nobody can trace.

    A derived row is exempt from the range test: its evidence is its rule,
    and check_rules proves that end to end.
    """
    findings: list[Finding] = []

    for row in rows:
        if not _priced(row):
            continue

        if not row.get("source"):
            findings.append(
                Finding(
                    location=row["location"],
                    check="provenance",
                    severity=BLOCKER,
                    detail="Published with no source. Nothing says where this figure came from.",
                    actual=row["suggested_price"],
                )
            )
            continue

        if row.get("status") != "derived" and _midpoint(row) is None:
            findings.append(
                Finding(
                    location=row["location"],
                    check="provenance",
                    severity=BLOCKER,
                    detail=(
                        "Published with no quoted range behind it, and not derived from "
                        "another row. There is nothing to check it against."
                    ),
                    actual=row["suggested_price"],
                )
            )

    return findings


def check_report_dates(
    rows: list[dict], price_date: str | None, stale_after_days: int
) -> list[Finding]:
    """Whether the run was built on the week it is dated for.

    Reported once per stale date, not once per row: fifty rows off the same
    issue are one fact about the run, and fifty copies of it would bury the
    blockers. A warning, never a blocker -- a week when Argus published
    nothing new is a real thing, and refusing to publish over it would be
    worse than the staleness it guards against.
    """
    if not price_date:
        return []

    try:
        run_day = date.fromisoformat(price_date)
    except (TypeError, ValueError):
        return []

    stale: dict[str, int] = {}

    for row in rows:
        if not _priced(row):
            continue

        reported = row.get("price_date")

        if not reported:
            continue

        try:
            reported_day = date.fromisoformat(reported)
        except (TypeError, ValueError):
            continue

        if (run_day - reported_day).days >= stale_after_days:
            stale[reported] = stale.get(reported, 0) + 1

    findings: list[Finding] = []

    for reported in sorted(stale):
        rows_affected = stale[reported]
        age = (run_day - date.fromisoformat(reported)).days
        findings.append(
            Finding(
                location="",
                check="report_date",
                severity=WARNING,
                detail=(
                    f"This run is dated {price_date}, but {rows_affected} "
                    f"row{'s' if rows_affected != 1 else ''} came from a report dated "
                    f"{reported} -- {age} days earlier. Check it is the current issue."
                ),
            )
        )

    return findings


def preflight(
    rows: list[dict],
    *,
    rules: list[PriceRule] | None = None,
    default_step: float | None = None,
    overrides: dict | None = None,
    price_date: str | None = None,
    stale_after_days: int = DEFAULT_STALE_AFTER_DAYS,
) -> list[Finding]:
    """Everything the sheet can be asked about itself, blockers first."""
    rules = rules or []
    overrides = overrides or {}

    findings = [
        *check_rules(rows, rules, default_step, overrides),
        *check_rounding(rows, default_step, overrides),
        *check_within_range(rows, default_step, overrides),
        *check_quoted_spread(rows),
        *check_provenance(rows),
        *check_report_dates(rows, price_date, stale_after_days),
    ]

    # Stable: blockers first, then in the order the checks found them, so a
    # rerun of the same draft reads the same way twice.
    return sorted(findings, key=lambda finding: 0 if finding.severity == BLOCKER else 1)


def _figure(value) -> str:
    """A number as a person writes it: no trailing .0 on a whole figure."""
    if value is None:
        return "-"

    number = float(value)

    return str(int(number)) if number == int(number) else f"{number:g}"


def _direction_words(direction: str) -> str:
    return {
        "nearest": "to the nearest",
        "up": "up to the next",
        "down": "down to the previous",
    }[normalise_direction(direction)]
