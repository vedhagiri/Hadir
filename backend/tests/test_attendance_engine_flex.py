"""Pure-logic tests for the Flex policy type (v1.0 P9).

Engine stays side-effect-free per the P10 / P9 red lines: no DB, no
network. Constructs synthetic events + a Flex policy and asserts on
the returned ``AttendanceRecord``.
"""

from __future__ import annotations

from datetime import date, datetime, time

from maugood.attendance.engine import ShiftPolicy, compute


FLEX = ShiftPolicy(
    id=42,
    name="Flex 07:30–08:30 / 15:30–16:30",
    type="Flex",
    required_hours=8,
    in_window_start=time(7, 30),
    in_window_end=time(8, 30),
    out_window_start=time(15, 30),
    out_window_end=time(16, 30),
)

D = date(2026, 4, 24)


def _ev(h: int, m: int, s: int = 0) -> datetime:
    return datetime(2026, 4, 24, h, m, s)


# --- Arrival inside / outside the in-window --------------------------------


def test_arrival_inside_in_window_is_on_time() -> None:
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(8, 25), _ev(15, 35)],
    )
    assert r.late is False
    assert r.in_time == time(8, 25)


def test_arrival_at_in_window_end_is_on_time() -> None:
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(8, 30), _ev(15, 35)],
    )
    assert r.late is False


def test_arrival_one_minute_past_in_window_end_is_late() -> None:
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(8, 31), _ev(15, 35)],
    )
    assert r.late is True


# --- Departure inside / outside the out-window -----------------------------


def test_departure_inside_out_window_is_on_time() -> None:
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(7, 35), _ev(15, 45)],
    )
    assert r.early_out is False


def test_departure_at_out_window_start_is_on_time() -> None:
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(7, 35), _ev(15, 30)],
    )
    assert r.early_out is False


def test_departure_one_minute_before_out_window_start_is_early() -> None:
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(7, 35), _ev(15, 29)],
    )
    assert r.early_out is True


# --- Total minutes / short / overtime --------------------------------------


def test_short_hours_under_required() -> None:
    # 6h45m total — well under the 8h required.
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(8, 0), _ev(14, 45)],
    )
    assert r.total_minutes == 6 * 60 + 45
    assert r.short_hours is True
    assert r.overtime_minutes == 0


def test_exactly_required_minutes_is_neither_short_nor_overtime() -> None:
    # 8h flat.
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(8, 0), _ev(16, 0)],
    )
    assert r.total_minutes == 8 * 60
    assert r.short_hours is False
    assert r.overtime_minutes == 0


def test_overtime_minutes_above_required() -> None:
    # 8h45m total → 45 minutes overtime.
    r = compute(
        employee_id=1,
        the_date=D,
        policy=FLEX,
        events=[_ev(7, 35), _ev(16, 20)],
    )
    assert r.total_minutes == 8 * 60 + 45
    assert r.overtime_minutes == 45


# --- Absent ----------------------------------------------------------------


def test_no_events_is_absent_for_flex() -> None:
    r = compute(employee_id=1, the_date=D, policy=FLEX, events=[])
    assert r.absent is True
    assert r.in_time is None
    assert r.out_time is None
    assert r.total_minutes is None
