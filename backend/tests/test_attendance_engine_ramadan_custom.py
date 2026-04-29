"""Pure-logic tests for the Ramadan + Custom policy types (v1.0 P10).

The engine stays side-effect-free per the pilot-plan P10 / P9 / P10
red lines: no DB, no network. We construct synthetic events + a
policy and assert on the returned ``AttendanceRecord``.
"""

from __future__ import annotations

from datetime import date, datetime, time

from maugood.attendance.engine import ShiftPolicy, compute


# A typical Ramadan policy — short day, 08:00 → 14:00 with 6h
# required (PROJECT_CONTEXT § shift policies, Omran example).
RAMADAN = ShiftPolicy(
    id=10,
    name="Ramadan 2026",
    type="Ramadan",
    required_hours=6,
    start=time(8, 0),
    end=time(14, 0),
    grace_minutes=15,
    range_start=date(2026, 2, 18),
    range_end=date(2026, 3, 19),
)


# Custom-Fixed: half-day before a holiday — 08:00 → 12:00.
CUSTOM_FIXED = ShiftPolicy(
    id=11,
    name="Half-day eve",
    type="Custom",
    required_hours=4,
    start=time(8, 0),
    end=time(12, 0),
    grace_minutes=10,
    range_start=date(2026, 12, 31),
    range_end=date(2026, 12, 31),
    custom_inner_type="Fixed",
)


# Custom-Flex: a one-off Flex day — windows 09:00–10:00 in,
# 17:00–18:00 out, 8h required.
CUSTOM_FLEX = ShiftPolicy(
    id=12,
    name="Conference Flex day",
    type="Custom",
    required_hours=8,
    in_window_start=time(9, 0),
    in_window_end=time(10, 0),
    out_window_start=time(17, 0),
    out_window_end=time(18, 0),
    range_start=date(2026, 5, 1),
    range_end=date(2026, 5, 1),
    custom_inner_type="Flex",
)


def _ev(d: date, h: int, m: int) -> datetime:
    return datetime(d.year, d.month, d.day, h, m)


# ---------------------------------------------------------------------------
# Ramadan flag rules — Fixed-style math, shifted hours
# ---------------------------------------------------------------------------


def test_ramadan_arrival_inside_grace_is_on_time() -> None:
    d = date(2026, 3, 1)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=RAMADAN,
        events=[_ev(d, 8, 10), _ev(d, 14, 5)],
    )
    assert r.late is False
    assert r.early_out is False


def test_ramadan_arrival_past_grace_is_late() -> None:
    d = date(2026, 3, 1)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=RAMADAN,
        events=[_ev(d, 8, 16), _ev(d, 14, 5)],
    )
    assert r.late is True


def test_ramadan_short_hours_under_required() -> None:
    d = date(2026, 3, 1)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=RAMADAN,
        events=[_ev(d, 8, 0), _ev(d, 13, 0)],
    )
    # 5h total — under the 6h required.
    assert r.total_minutes == 5 * 60
    assert r.short_hours is True


def test_ramadan_overtime_beyond_required() -> None:
    d = date(2026, 3, 1)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=RAMADAN,
        events=[_ev(d, 8, 0), _ev(d, 14, 30)],
    )
    # 6h30m → 30 minutes overtime.
    assert r.total_minutes == 6 * 60 + 30
    assert r.overtime_minutes == 30


# ---------------------------------------------------------------------------
# Custom-Fixed flag rules
# ---------------------------------------------------------------------------


def test_custom_fixed_short_day_on_time() -> None:
    d = date(2026, 12, 31)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=CUSTOM_FIXED,
        events=[_ev(d, 8, 5), _ev(d, 12, 5)],
    )
    assert r.late is False
    assert r.early_out is False


def test_custom_fixed_short_day_late() -> None:
    d = date(2026, 12, 31)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=CUSTOM_FIXED,
        events=[_ev(d, 8, 11), _ev(d, 12, 5)],
    )
    # in_time 08:11 vs grace 10 minutes → start 08:00 + grace 10 = 08:10
    # → 08:11 > 08:10, late.
    assert r.late is True


# ---------------------------------------------------------------------------
# Custom-Flex flag rules
# ---------------------------------------------------------------------------


def test_custom_flex_inside_in_window_is_on_time() -> None:
    d = date(2026, 5, 1)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=CUSTOM_FLEX,
        events=[_ev(d, 9, 45), _ev(d, 17, 30)],
    )
    assert r.late is False
    assert r.early_out is False


def test_custom_flex_past_in_window_is_late() -> None:
    d = date(2026, 5, 1)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=CUSTOM_FLEX,
        events=[_ev(d, 10, 5), _ev(d, 17, 30)],
    )
    assert r.late is True


def test_custom_flex_before_out_window_is_early() -> None:
    d = date(2026, 5, 1)
    r = compute(
        employee_id=1,
        the_date=d,
        policy=CUSTOM_FLEX,
        events=[_ev(d, 9, 45), _ev(d, 16, 55)],
    )
    assert r.early_out is True
