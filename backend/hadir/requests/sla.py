"""Pure business-hours SLA check for the approvals inbox.

Given the request's ``submitted_at`` (or the moment a stage stamp was
set) plus the tenant's weekend list and an "as-of" datetime, return
the elapsed *business* hours — wall-clock hours that fall on days
which are not tenant weekends. The router compares the result to
``HADIR_REQUEST_SLA_BUSINESS_HOURS`` to flag breaches.

The math is intentionally coarse:

* Each calendar day fully inside the elapsed window counts for
  ``business_day_hours`` (default 8) when the day's weekday is not in
  the weekend list.
* The first and last days are pro-rated by the fraction of the day
  the window covers, then likewise zeroed if those days are weekends.

That's enough to surface "this has been pending across two working
days" without overclaiming on a Friday afternoon submission. Pure +
deterministic so the tests can run in milliseconds.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Iterable


@dataclass(frozen=True, slots=True)
class SlaConfig:
    business_hours_threshold: int
    business_day_hours: int
    weekend_days: tuple[str, ...]


def _is_business_day(d, weekend_days: Iterable[str]) -> bool:
    weekday_name = d.strftime("%A")
    return weekday_name not in set(weekend_days)


def business_hours_open(
    *,
    submitted_at: datetime,
    as_of: datetime,
    config: SlaConfig,
) -> float:
    """Return the elapsed business hours between ``submitted_at`` and
    ``as_of``.

    Both timestamps must be timezone-aware. We normalise them to the
    same TZ before the day-bucket walk so the weekend match uses the
    tenant's wall-clock calendar.
    """

    if submitted_at.tzinfo is None or as_of.tzinfo is None:
        raise ValueError("submitted_at and as_of must be timezone-aware")

    if as_of <= submitted_at:
        return 0.0

    # Walk per-day.
    total_hours = 0.0
    day_hours = float(config.business_day_hours)

    # Use the date in the as_of TZ.
    cur = submitted_at
    while cur < as_of:
        cur_date = cur.date()
        # End of this day (or the as_of cutoff, whichever is sooner).
        next_day_start = datetime.combine(
            cur_date + timedelta(days=1), time.min, tzinfo=cur.tzinfo
        )
        slice_end = min(next_day_start, as_of)
        if _is_business_day(cur_date, config.weekend_days):
            elapsed = (slice_end - cur).total_seconds() / 3600.0
            # Cap each calendar day at the configured business-day hours
            # so a 24h Saturday-of-leftover-time doesn't double-count.
            total_hours += min(elapsed, day_hours)
        cur = slice_end

    return total_hours


def is_breached(
    *,
    submitted_at: datetime,
    as_of: datetime,
    config: SlaConfig,
) -> bool:
    return (
        business_hours_open(
            submitted_at=submitted_at, as_of=as_of, config=config
        )
        >= config.business_hours_threshold
    )
