"""Pure-logic tests for the P11 leave / holiday / weekend behaviour.

Engine stays side-effect-free per the running red line: no DB, no
network. Constructs synthetic events + a Fixed policy + the new
``LeaveRecord`` / ``HolidayRecord`` inputs and asserts on the
returned ``AttendanceRecord``.
"""

from __future__ import annotations

from datetime import date, datetime, time

from maugood.attendance.engine import (
    HolidayRecord,
    LeaveRecord,
    ShiftPolicy,
    compute,
)


FIXED = ShiftPolicy(
    id=1,
    name="Default 07:30–15:30",
    type="Fixed",
    required_hours=8,
    start=time(7, 30),
    end=time(15, 30),
    grace_minutes=15,
)


def _ev(d: date, h: int, m: int) -> datetime:
    return datetime(d.year, d.month, d.day, h, m)


def _leave(start: date, end: date, code: str = "Annual", paid: bool = True) -> LeaveRecord:
    return LeaveRecord(
        leave_type_id=1,
        leave_type_code=code,
        leave_type_name=f"{code} leave",
        is_paid=paid,
        start_date=start,
        end_date=end,
    )


# ---------------------------------------------------------------------------
# Leaves
# ---------------------------------------------------------------------------


def test_leave_clears_absent_and_surfaces_type() -> None:
    d = date(2026, 5, 4)  # a Monday
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[],
        leaves=[_leave(d, d)],
    )
    assert r.absent is False
    assert r.leave_type_name == "Annual leave"
    assert r.leave_type_id == 1
    assert r.in_time is None
    assert r.out_time is None


def test_leave_first_day_in_range() -> None:
    d = date(2026, 5, 4)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[],
        leaves=[_leave(d, date(2026, 5, 8))],
    )
    assert r.absent is False
    assert r.leave_type_name == "Annual leave"


def test_leave_last_day_in_range() -> None:
    end = date(2026, 5, 8)
    r = compute(
        employee_id=1,
        the_date=end,
        policy=FIXED,
        events=[],
        leaves=[_leave(date(2026, 5, 4), end)],
    )
    assert r.absent is False


def test_leave_day_after_range_does_not_cover() -> None:
    d = date(2026, 5, 9)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[],
        leaves=[_leave(date(2026, 5, 4), date(2026, 5, 8))],
    )
    # Outside the leave's range AND not a weekend (Saturday-Sunday
    # in this test's tuple) — should be absent.
    assert r.absent is True
    assert r.leave_type_name is None


# ---------------------------------------------------------------------------
# Holiday with work events → full overtime, no late/early/short
# ---------------------------------------------------------------------------


def test_holiday_with_events_is_full_overtime() -> None:
    d = date(2026, 11, 18)  # Oman National Day
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[_ev(d, 8, 0), _ev(d, 12, 30)],
        holidays=[HolidayRecord(date=d, name="National Day")],
    )
    # 4h30m total → ALL of it goes to overtime; per-type flags stay False.
    assert r.total_minutes == 4 * 60 + 30
    assert r.overtime_minutes == 4 * 60 + 30
    assert r.late is False
    assert r.early_out is False
    assert r.short_hours is False
    assert r.absent is False


def test_holiday_without_events_is_not_absent() -> None:
    d = date(2026, 11, 18)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[],
        holidays=[HolidayRecord(date=d, name="National Day")],
    )
    # No events on a holiday isn't absence — it's the holiday.
    assert r.absent is False
    assert r.in_time is None


# ---------------------------------------------------------------------------
# Weekend with work events → same overtime treatment
# ---------------------------------------------------------------------------


def test_weekend_friday_with_events_is_full_overtime() -> None:
    d = date(2026, 5, 1)  # Friday
    assert d.strftime("%A") == "Friday"
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[_ev(d, 9, 0), _ev(d, 13, 0)],
        weekend_days=("Friday", "Saturday"),
    )
    assert r.total_minutes == 4 * 60
    assert r.overtime_minutes == 4 * 60
    assert r.late is False
    assert r.early_out is False
    assert r.short_hours is False


def test_weekend_saturday_with_events_is_full_overtime() -> None:
    d = date(2026, 5, 2)  # Saturday
    assert d.strftime("%A") == "Saturday"
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[_ev(d, 8, 0), _ev(d, 16, 0)],
        weekend_days=("Friday", "Saturday"),
    )
    assert r.overtime_minutes == 8 * 60


def test_weekend_without_events_is_not_absent() -> None:
    d = date(2026, 5, 1)  # Friday
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[],
        weekend_days=("Friday", "Saturday"),
    )
    assert r.absent is False


def test_weekday_outside_weekend_set_is_normal() -> None:
    """The engine must not infer locale — empty weekend_days = no
    weekends. A normal Monday with no events is absent."""

    d = date(2026, 5, 4)  # Monday
    r = compute(
        employee_id=1, the_date=d, policy=FIXED, events=[], weekend_days=()
    )
    assert r.absent is True


# ---------------------------------------------------------------------------
# Holiday-on-weekend → no double counting
# ---------------------------------------------------------------------------


def test_holiday_on_weekend_with_events_single_overtime_treatment() -> None:
    d = date(2026, 5, 1)  # Friday
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[_ev(d, 8, 0), _ev(d, 12, 0)],
        holidays=[HolidayRecord(date=d, name="Labour Day")],
        weekend_days=("Friday", "Saturday"),
    )
    # 4h total, all overtime. The holiday + weekend collapse to one
    # treatment; we don't double the minutes.
    assert r.total_minutes == 4 * 60
    assert r.overtime_minutes == 4 * 60


def test_holiday_on_weekend_without_events_is_not_absent() -> None:
    d = date(2026, 5, 1)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[],
        holidays=[HolidayRecord(date=d, name="Labour Day")],
        weekend_days=("Friday", "Saturday"),
    )
    assert r.absent is False


# ---------------------------------------------------------------------------
# Leave + holiday on the same day — leave wins on the leave_type_name
# but the day is still treated as a holiday for overtime purposes
# (events count as full overtime). Real-world: an employee with
# pre-approved leave who comes in anyway on a holiday gets overtime
# for the time, with the audit row noting both.
# ---------------------------------------------------------------------------


def test_leave_and_holiday_overlapping_no_events() -> None:
    d = date(2026, 11, 18)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[],
        leaves=[_leave(d, d)],
        holidays=[HolidayRecord(date=d, name="National Day")],
    )
    assert r.absent is False
    assert r.leave_type_name == "Annual leave"


def test_leave_and_holiday_overlapping_with_events() -> None:
    d = date(2026, 11, 18)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=FIXED,
        events=[_ev(d, 9, 0), _ev(d, 11, 0)],
        leaves=[_leave(d, d)],
        holidays=[HolidayRecord(date=d, name="National Day")],
    )
    # Overtime path takes over because it's a holiday, but the
    # leave_type still surfaces on the record so the operator can see
    # both signals.
    assert r.overtime_minutes == 2 * 60
    assert r.short_hours is False
    assert r.leave_type_name == "Annual leave"
