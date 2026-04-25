"""Pure attendance computation.

Two policy types are supported in v1.0 P9: ``Fixed`` (pilot rules,
unchanged) and ``Flex`` (windowed arrival + windowed departure).
``Ramadan`` and ``Custom`` slots stay reserved on the type enum but
the compute path falls back to Fixed flags until those phases land.

Common rules (apply to every type):

* ``in_time`` = first event of day by ``captured_at``;
  ``out_time`` = last event. Intermediate events stay in
  ``detection_events`` but are irrelevant to the daily summary
  (PROJECT_CONTEXT §3).
* ``total_minutes`` = minutes between in_time and out_time.
* ``absent`` = ``events.empty and no leave covers this date``.
* ``overtime_minutes`` = ``max(0, total_minutes - required_minutes)``.

Per-type rules:

* **Fixed** — late = ``in_time > policy.start + grace_minutes``;
  early_out = ``out_time < policy.end - grace_minutes``;
  short_hours = ``total_minutes < required_minutes``.
* **Flex** — late = ``in_time > policy.in_window_end``;
  early_out = ``out_time < policy.out_window_start``;
  short_hours = ``total_minutes < required_minutes``.

**Red line (pilot-plan P10, reaffirmed in P9 prompt)**: this module
is pure — no DB, no network, no side effects. Callers pass inputs;
we return a value. Policy *resolution* is the only DB-touching part
of the system, and it lives in ``hadir.attendance.repository``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Literal, Optional, Sequence


PolicyType = Literal["Fixed", "Flex", "Ramadan", "Custom"]


@dataclass(frozen=True, slots=True)
class ShiftPolicy:
    """Policy value object the engine takes as input.

    The dataclass holds the union of all policy-type fields. Fixed
    populates ``start`` / ``end`` / ``grace_minutes`` (existing pilot
    contract). Flex populates the four window times. Both populate
    ``required_hours`` for the short-hours / overtime check.

    The engine dispatches on ``type`` to pick the matching flag
    helpers — see ``_fixed_flags`` / ``_flex_flags`` below.
    """

    id: int
    name: str
    type: PolicyType

    # Common
    required_hours: int = 8

    # Fixed-only
    start: Optional[time] = None
    end: Optional[time] = None
    grace_minutes: int = 15

    # Flex-only
    in_window_start: Optional[time] = None
    in_window_end: Optional[time] = None
    out_window_start: Optional[time] = None
    out_window_end: Optional[time] = None

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


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Flags:
    """Common shape returned by every per-type flag helper."""

    late: bool
    early_out: bool
    short_hours: bool
    overtime_minutes: int


def _time_to_minutes(t: time) -> int:
    return t.hour * 60 + t.minute + t.second // 60


def _minutes_between(earlier: time, later: time) -> int:
    return _time_to_minutes(later) - _time_to_minutes(earlier)


def _fixed_flags(
    policy: ShiftPolicy,
    *,
    in_time: time,
    out_time: Optional[time],
    total_minutes: Optional[int],
    the_date: date,
) -> _Flags:
    if policy.start is None or policy.end is None:
        raise ValueError(
            f"Fixed policy {policy.id} missing start/end times in config"
        )
    grace = timedelta(minutes=policy.grace_minutes)
    start_plus_grace = (datetime.combine(the_date, policy.start) + grace).time()
    late = in_time > start_plus_grace

    early_out = False
    if out_time is not None:
        end_minus_grace = (datetime.combine(the_date, policy.end) - grace).time()
        early_out = out_time < end_minus_grace

    short_hours = (
        total_minutes is not None and total_minutes < policy.required_minutes
    )
    overtime = (
        max(0, total_minutes - policy.required_minutes)
        if total_minutes is not None
        else 0
    )
    return _Flags(
        late=late,
        early_out=early_out,
        short_hours=short_hours,
        overtime_minutes=overtime,
    )


def _flex_flags(
    policy: ShiftPolicy,
    *,
    in_time: time,
    out_time: Optional[time],
    total_minutes: Optional[int],
) -> _Flags:
    if policy.in_window_end is None or policy.out_window_start is None:
        raise ValueError(
            f"Flex policy {policy.id} missing in/out window times in config"
        )
    # Flex is the cleaner of the two formulations: arrival anywhere
    # inside the in-window is on time, anywhere after it is late. Same
    # symmetry on the out-window.
    late = in_time > policy.in_window_end
    early_out = out_time is not None and out_time < policy.out_window_start

    short_hours = (
        total_minutes is not None and total_minutes < policy.required_minutes
    )
    overtime = (
        max(0, total_minutes - policy.required_minutes)
        if total_minutes is not None
        else 0
    )
    return _Flags(
        late=late,
        early_out=early_out,
        short_hours=short_hours,
        overtime_minutes=overtime,
    )


def _flags_for(
    policy: ShiftPolicy,
    *,
    in_time: time,
    out_time: Optional[time],
    total_minutes: Optional[int],
    the_date: date,
) -> _Flags:
    """Dispatch on policy.type to the right per-type flag helper."""

    if policy.type == "Flex":
        return _flex_flags(
            policy,
            in_time=in_time,
            out_time=out_time,
            total_minutes=total_minutes,
        )
    # Fixed (default) — Ramadan + Custom fall back to Fixed flags
    # until their respective phases ship.
    return _fixed_flags(
        policy,
        in_time=in_time,
        out_time=out_time,
        total_minutes=total_minutes,
        the_date=the_date,
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


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

    ``events`` must already be filtered to ``the_date`` and expressed
    in the same wall-clock timezone as the policy's window times. The
    scheduler handles the timezone conversion before calling us.

    The engine is agnostic to how the caller sources events
    (detection pipeline, manual import, backfill) — it just needs
    timestamps.
    """

    has_events = len(events) > 0
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
    out_time = (
        last.time().replace(microsecond=0) if len(ordered) > 1 else None
    )

    total_minutes: Optional[int] = None
    if out_time is not None:
        total_minutes = max(0, _minutes_between(in_time, out_time))

    flags = _flags_for(
        policy,
        in_time=in_time,
        out_time=out_time,
        total_minutes=total_minutes,
        the_date=the_date,
    )

    return AttendanceRecord(
        employee_id=employee_id,
        date=the_date,
        policy_id=policy.id,
        in_time=in_time,
        out_time=out_time,
        total_minutes=total_minutes,
        late=flags.late,
        early_out=flags.early_out,
        short_hours=flags.short_hours,
        absent=False,
        overtime_minutes=flags.overtime_minutes,
    )


# ---------------------------------------------------------------------------
# Row → ShiftPolicy inflation (still pure — pure data shaping)
# ---------------------------------------------------------------------------


def _parse_time(value: object) -> time:
    if isinstance(value, time):
        return value
    if isinstance(value, str):
        hh, mm = value.split(":")
        return time(hour=int(hh), minute=int(mm))
    raise ValueError(f"invalid time value: {value!r}")


def policy_from_row(row) -> ShiftPolicy:  # type: ignore[no-untyped-def]
    """Inflate a ``shift_policies`` row into a ``ShiftPolicy`` value.

    Kept here (not in the repository) so tests that want to construct
    a policy without the DB can import a single helper. Dispatches on
    ``row.type`` to read the right config fields.
    """

    config = row.config or {}
    policy_type = str(row.type)
    required_hours = int(config.get("required_hours", 8))

    if policy_type == "Flex":
        return ShiftPolicy(
            id=int(row.id),
            name=str(row.name),
            type="Flex",
            required_hours=required_hours,
            in_window_start=_parse_time(config.get("in_window_start", "07:30")),
            in_window_end=_parse_time(config.get("in_window_end", "08:30")),
            out_window_start=_parse_time(config.get("out_window_start", "15:30")),
            out_window_end=_parse_time(config.get("out_window_end", "16:30")),
        )

    # Fixed (default). Ramadan / Custom fall through here too — those
    # phases will add their own branches.
    return ShiftPolicy(
        id=int(row.id),
        name=str(row.name),
        type=policy_type,  # type: ignore[arg-type]
        required_hours=required_hours,
        start=_parse_time(config.get("start", "07:30")),
        end=_parse_time(config.get("end", "15:30")),
        grace_minutes=int(config.get("grace_minutes", 15)),
    )
