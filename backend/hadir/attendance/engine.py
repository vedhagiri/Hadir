"""Pure attendance computation.

Rules (pilot-plan P10):

* ``in_time`` = first event of day by ``captured_at``; ``out_time`` = last
  event. Intermediate events stay in ``detection_events`` but are
  irrelevant to the summary (PROJECT_CONTEXT §3).
* ``late`` = ``in_time > policy.start + grace_minutes``
* ``early_out`` = ``out_time < policy.end - grace_minutes``
* ``total_minutes`` = minutes between in_time and out_time (break
  deductions are a v1.0 concern).
* ``short_hours`` = ``total_minutes < policy.required_hours * 60``
* ``absent`` = ``events.empty and no leave covers this date``. Pilot
  always passes an empty leaves list per PROJECT_CONTEXT §8.
* ``overtime_minutes`` = ``max(0, total_minutes - required_minutes)``

**Red line (pilot-plan P10)**: this module is pure — no DB, no network,
no side effects. Callers pass inputs; we return a value. That keeps it
testable and makes the v1.0 multi-policy engine a clean extension.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Literal, Optional, Sequence


PolicyType = Literal["Fixed", "Flex", "Ramadan", "Custom"]


@dataclass(frozen=True, slots=True)
class ShiftPolicy:
    """Pilot policy shape. ``Fixed`` is the only type the engine handles today."""

    id: int
    name: str
    type: PolicyType
    start: time
    end: time
    grace_minutes: int
    required_hours: int

    @property
    def required_minutes(self) -> int:
        return self.required_hours * 60


@dataclass(frozen=True, slots=True)
class AttendanceRecord:
    """Value object returned by ``compute`` — persistence is the caller's job."""

    employee_id: int
    date: date
    policy_id: int
    in_time: Optional[time]
    out_time: Optional[time]
    total_minutes: Optional[int]
    late: bool
    early_out: bool
    short_hours: bool
    absent: bool
    overtime_minutes: int


def _time_to_minutes(t: time) -> int:
    return t.hour * 60 + t.minute + t.second // 60


def _minutes_between(earlier: time, later: time) -> int:
    return _time_to_minutes(later) - _time_to_minutes(earlier)


def compute(
    *,
    employee_id: int,
    the_date: date,
    policy: ShiftPolicy,
    events: Sequence[datetime],
    leaves: Sequence = (),  # pilot: always empty (pilot-plan P10)
    holidays: Sequence = (),  # pilot: always empty (pilot-plan P10)
) -> AttendanceRecord:
    """Compute one ``AttendanceRecord`` from the day's events.

    ``events`` must already be filtered to ``the_date`` and expressed in
    the same wall-clock timezone as ``policy.start`` / ``policy.end``. The
    scheduler handles the timezone conversion before calling us.

    The engine is agnostic to how the caller sources events (detection
    pipeline, manual import, backfill) — it just needs timestamps.
    """

    has_events = len(events) > 0
    # Pilot never has leaves; the signature stays compatible with v1.0.
    covered_by_leave = bool(leaves)
    absent = (not has_events) and (not covered_by_leave)

    if not has_events:
        return AttendanceRecord(
            employee_id=employee_id,
            date=the_date,
            policy_id=policy.id,
            in_time=None,
            out_time=None,
            total_minutes=None,
            late=False,
            early_out=False,
            short_hours=False,
            absent=absent,
            overtime_minutes=0,
        )

    ordered = sorted(events)
    first = ordered[0]
    last = ordered[-1]
    in_time = first.time().replace(microsecond=0)
    out_time = last.time().replace(microsecond=0) if len(ordered) > 1 else None

    # ``late`` compares the arrival against (policy.start + grace).
    grace = timedelta(minutes=policy.grace_minutes)
    start_plus_grace = (
        datetime.combine(the_date, policy.start) + grace
    ).time()
    late = in_time > start_plus_grace

    early_out = False
    if out_time is not None:
        end_minus_grace = (
            datetime.combine(the_date, policy.end) - grace
        ).time()
        early_out = out_time < end_minus_grace

    total_minutes: Optional[int] = None
    short_hours = False
    overtime_minutes = 0
    if out_time is not None:
        total_minutes = max(0, _minutes_between(in_time, out_time))
        short_hours = total_minutes < policy.required_minutes
        overtime_minutes = max(0, total_minutes - policy.required_minutes)

    return AttendanceRecord(
        employee_id=employee_id,
        date=the_date,
        policy_id=policy.id,
        in_time=in_time,
        out_time=out_time,
        total_minutes=total_minutes,
        late=late,
        early_out=early_out,
        short_hours=short_hours,
        absent=False,
        overtime_minutes=overtime_minutes,
    )


def policy_from_row(row) -> ShiftPolicy:  # type: ignore[no-untyped-def]
    """Inflate a ``shift_policies`` row into a ``ShiftPolicy`` value.

    Kept here (not in the repository) so tests that want to construct a
    policy without the DB can import a single helper.
    """

    config = row.config or {}

    def _parse_time(value: object) -> time:
        if isinstance(value, time):
            return value
        if isinstance(value, str):
            hh, mm = value.split(":")
            return time(hour=int(hh), minute=int(mm))
        raise ValueError(f"invalid time value: {value!r}")

    return ShiftPolicy(
        id=int(row.id),
        name=str(row.name),
        type=str(row.type),  # type: ignore[arg-type]
        start=_parse_time(config.get("start", "07:30")),
        end=_parse_time(config.get("end", "15:30")),
        grace_minutes=int(config.get("grace_minutes", 15)),
        required_hours=int(config.get("required_hours", 8)),
    )
