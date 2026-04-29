"""Pure attendance computation.

Four policy types are supported as of v1.0 P10:

* ``Fixed`` — start, end, grace_minutes (pilot rules).
* ``Flex`` — windowed arrival + windowed departure (P9).
* ``Ramadan`` — Fixed shape with a calendar date range. The
  resolver gates this; the engine itself uses the Fixed flag
  helper. One per year, typically.
* ``Custom`` — wraps a Fixed-shaped or a Flex-shaped inner
  policy plus a date range. Used for one-off days (half-day
  before a holiday, etc.). The dispatcher reads
  ``policy.custom_inner_type`` to pick the right flag helper.

Common rules (apply to every type):

* ``in_time`` = first event of day by ``captured_at``;
  ``out_time`` = last event. Intermediate events stay in
  ``detection_events`` but are irrelevant to the daily summary
  (PROJECT_CONTEXT §3).
* ``total_minutes`` = minutes between in_time and out_time.
* ``absent`` = ``events.empty and no leave covers this date``.
* ``overtime_minutes`` = ``max(0, total_minutes - required_minutes)``.

Per-type flag rules:

* **Fixed / Ramadan / Custom-Fixed** — late =
  ``in_time > policy.start + grace_minutes``; early_out =
  ``out_time < policy.end - grace_minutes``;
  short_hours = ``total_minutes < required_minutes``.
* **Flex / Custom-Flex** — late =
  ``in_time > policy.in_window_end``; early_out =
  ``out_time < policy.out_window_start``;
  short_hours = ``total_minutes < required_minutes``.

**Red line (pilot-plan P10, reaffirmed in P9 + P10 prompts)**:
this module is pure — no DB, no network, no side effects. Callers
pass inputs; we return a value. Policy *resolution* is the only
DB-touching part of the pipeline, and it lives in
``maugood.attendance.repository``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Literal, Optional, Sequence


PolicyType = Literal["Fixed", "Flex", "Ramadan", "Custom"]


@dataclass(frozen=True, slots=True)
class ShiftPolicy:
    """Policy value object the engine takes as input.

    The dataclass holds the union of every policy-type field; each
    type populates the relevant subset:

    * **Fixed** uses ``start`` / ``end`` / ``grace_minutes``.
    * **Flex** uses the four window times.
    * **Ramadan** uses the Fixed fields PLUS ``range_start`` /
      ``range_end`` for the resolver's date-range check. The engine
      itself dispatches Ramadan to the Fixed flag helper.
    * **Custom** uses ``range_start`` / ``range_end`` PLUS one of
      the inner policy shapes. ``custom_inner_type`` tells the
      engine which one.
    * Every type uses ``required_hours``.
    """

    id: int
    name: str
    type: PolicyType

    # Common
    required_hours: int = 8

    # Fixed / Ramadan / Custom-Fixed
    start: Optional[time] = None
    end: Optional[time] = None
    grace_minutes: int = 15

    # Flex / Custom-Flex
    in_window_start: Optional[time] = None
    in_window_end: Optional[time] = None
    out_window_start: Optional[time] = None
    out_window_end: Optional[time] = None

    # Ramadan + Custom: the calendar range over which this policy
    # applies. The resolver gates by these — the engine doesn't
    # check the date itself, it just uses the right flag helper.
    range_start: Optional[date] = None
    range_end: Optional[date] = None

    # Custom only — names which inner shape the engine should use.
    # ``None`` for non-Custom types (Custom always sets it).
    custom_inner_type: Optional[Literal["Fixed", "Flex"]] = None

    @property
    def required_minutes(self) -> int:
        return self.required_hours * 60


@dataclass(frozen=True, slots=True)
class LeaveRecord:
    """An approved leave covering some date range.

    The engine receives a list of these (typically already filtered
    to the relevant ``the_date`` by the repository) and matches via
    ``start_date <= the_date <= end_date``.
    """

    leave_type_id: int
    leave_type_code: str
    leave_type_name: str
    is_paid: bool
    start_date: date
    end_date: date


@dataclass(frozen=True, slots=True)
class HolidayRecord:
    """A tenant-wide non-working day."""

    date: date
    name: str


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
    # P11: when an approved leave covers ``date``, both fields are
    # populated and the per-type flag rules don't run (no late /
    # early / short on a leave day).
    leave_type_id: Optional[int] = None
    leave_type_name: Optional[str] = None


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
    """Dispatch on policy.type to the right per-type flag helper.

    * ``Flex`` → ``_flex_flags``.
    * ``Custom`` with ``custom_inner_type='Flex'`` → ``_flex_flags``.
    * Everything else (``Fixed``, ``Ramadan``, ``Custom`` with
      ``custom_inner_type='Fixed'``) → ``_fixed_flags``. Ramadan
      reuses Fixed flag math because its shape *is* Fixed; the
      resolver filters by date range, not the engine.
    """

    if policy.type == "Flex":
        return _flex_flags(
            policy,
            in_time=in_time,
            out_time=out_time,
            total_minutes=total_minutes,
        )
    if policy.type == "Custom" and policy.custom_inner_type == "Flex":
        return _flex_flags(
            policy,
            in_time=in_time,
            out_time=out_time,
            total_minutes=total_minutes,
        )
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
    leaves: Sequence[LeaveRecord] = (),
    holidays: Sequence[HolidayRecord] = (),
    weekend_days: Sequence[str] = (),
) -> AttendanceRecord:
    """Compute one ``AttendanceRecord`` from the day's events.

    ``events`` must already be filtered to ``the_date`` and expressed
    in the same wall-clock timezone as the policy's window times. The
    scheduler handles the timezone conversion before calling us.

    P11 inputs:

    * ``leaves`` — every approved leave the caller wants the engine
      to consider. The engine matches by ``start_date <= the_date
      <= end_date``; first match wins.
    * ``holidays`` — list of ``HolidayRecord`` for the date.
    * ``weekend_days`` — weekday names matched against
      ``the_date.strftime("%A")``. Empty tuple = no weekends (the
      engine doesn't infer locale).

    The engine stays agnostic to how the caller sources any of these.
    Holiday-on-weekend collapses to a single overtime treatment — no
    double-counting.
    """

    has_events = len(events) > 0

    matching_leave: Optional[LeaveRecord] = None
    for lv in leaves:
        if lv.start_date <= the_date <= lv.end_date:
            matching_leave = lv
            break

    on_holiday = any(h.date == the_date for h in holidays)
    weekday_name = the_date.strftime("%A")
    on_weekend = weekday_name in weekend_days
    is_overtime_day = on_holiday or on_weekend

    leave_id_value = matching_leave.leave_type_id if matching_leave else None
    leave_name_value = matching_leave.leave_type_name if matching_leave else None

    if not has_events:
        # Absent if NEITHER a leave NOR a holiday/weekend covers the date.
        absent = (matching_leave is None) and (not is_overtime_day)
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
            leave_type_id=leave_id_value,
            leave_type_name=leave_name_value,
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

    if is_overtime_day:
        # Holiday or weekend with work events: skip per-type flag
        # math entirely. The whole day is overtime; late/early/short
        # don't apply when the day isn't a working day.
        return AttendanceRecord(
            employee_id=employee_id,
            date=the_date,
            policy_id=policy.id,
            in_time=in_time,
            out_time=out_time,
            total_minutes=total_minutes,
            late=False,
            early_out=False,
            short_hours=False,
            absent=False,
            overtime_minutes=total_minutes if total_minutes is not None else 0,
            leave_type_id=leave_id_value,
            leave_type_name=leave_name_value,
        )

    # Regular working day with events.
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
        leave_type_id=leave_id_value,
        leave_type_name=leave_name_value,
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


def _parse_date(value: object) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        # ISO date — ``date.fromisoformat`` handles ``YYYY-MM-DD``.
        return date.fromisoformat(value)
    raise ValueError(f"invalid date value: {value!r}")


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

    if policy_type == "Ramadan":
        # Functionally a Fixed policy that's only valid inside the
        # date range. The resolver filters by ``range_start`` /
        # ``range_end``; the engine uses ``_fixed_flags``.
        return ShiftPolicy(
            id=int(row.id),
            name=str(row.name),
            type="Ramadan",
            required_hours=required_hours,
            start=_parse_time(config.get("start", "08:00")),
            end=_parse_time(config.get("end", "14:00")),
            grace_minutes=int(config.get("grace_minutes", 15)),
            range_start=_parse_date(config.get("start_date")),
            range_end=_parse_date(config.get("end_date")),
        )

    if policy_type == "Custom":
        inner = str(config.get("inner_type", "Fixed"))
        if inner == "Flex":
            return ShiftPolicy(
                id=int(row.id),
                name=str(row.name),
                type="Custom",
                required_hours=required_hours,
                in_window_start=_parse_time(
                    config.get("in_window_start", "07:30")
                ),
                in_window_end=_parse_time(
                    config.get("in_window_end", "08:30")
                ),
                out_window_start=_parse_time(
                    config.get("out_window_start", "15:30")
                ),
                out_window_end=_parse_time(
                    config.get("out_window_end", "16:30")
                ),
                range_start=_parse_date(config.get("start_date")),
                range_end=_parse_date(config.get("end_date")),
                custom_inner_type="Flex",
            )
        # Custom-Fixed (default).
        return ShiftPolicy(
            id=int(row.id),
            name=str(row.name),
            type="Custom",
            required_hours=required_hours,
            start=_parse_time(config.get("start", "07:30")),
            end=_parse_time(config.get("end", "15:30")),
            grace_minutes=int(config.get("grace_minutes", 15)),
            range_start=_parse_date(config.get("start_date")),
            range_end=_parse_date(config.get("end_date")),
            custom_inner_type="Fixed",
        )

    # Fixed (default).
    return ShiftPolicy(
        id=int(row.id),
        name=str(row.name),
        type=policy_type,  # type: ignore[arg-type]
        required_hours=required_hours,
        start=_parse_time(config.get("start", "07:30")),
        end=_parse_time(config.get("end", "15:30")),
        grace_minutes=int(config.get("grace_minutes", 15)),
    )
