"""Pure-logic tests for the attendance engine.

The engine is side-effect-free by design (pilot-plan P10 red line): no
DB, no network, no threading. These tests construct synthetic events
and policies, call ``compute``, and assert on the returned record.
"""

from __future__ import annotations

from datetime import date, datetime, time

from maugood.attendance.engine import ShiftPolicy, compute


FIXED = ShiftPolicy(
    id=1,
    name="Default 07:30–15:30",
    type="Fixed",
    start=time(7, 30),
    end=time(15, 30),
    grace_minutes=15,
    required_hours=8,
)

D = date(2026, 4, 24)


def _ev(h: int, m: int, s: int = 0) -> datetime:
    return datetime(2026, 4, 24, h, m, s)


# ---------------------------------------------------------------------------
# Absent / empty inputs
# ---------------------------------------------------------------------------


def test_no_events_is_absent() -> None:
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=[])
    assert r.absent is True
    assert r.in_time is None
    assert r.out_time is None
    assert r.total_minutes is None
    assert r.late is False
    assert r.early_out is False
    assert r.short_hours is False
    assert r.overtime_minutes == 0


def test_leave_clears_absent_flag() -> None:
    from maugood.attendance.engine import LeaveRecord  # noqa: PLC0415

    r = compute(
        employee_id=1,
        the_date=D,
        policy=FIXED,
        events=[],
        leaves=[
            LeaveRecord(
                leave_type_id=1,
                leave_type_code="Annual",
                leave_type_name="Annual leave",
                is_paid=True,
                start_date=D,
                end_date=D,
            )
        ],
    )
    assert r.absent is False
    assert r.leave_type_name == "Annual leave"


# ---------------------------------------------------------------------------
# On-time, within grace
# ---------------------------------------------------------------------------


def test_single_event_sets_in_time_no_out_time() -> None:
    r = compute(
        employee_id=1, the_date=D, policy=FIXED, events=[_ev(7, 28, 42)]
    )
    assert r.in_time == time(7, 28, 42)
    assert r.out_time is None
    assert r.total_minutes is None
    assert r.late is False
    assert r.early_out is False
    assert r.absent is False


def test_on_time_full_day_has_no_flags() -> None:
    events = [_ev(7, 28), _ev(12, 5), _ev(15, 34)]
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=events)
    assert r.in_time == time(7, 28)
    assert r.out_time == time(15, 34)
    # 07:28 → 15:34 = 8 h 6 m = 486 min
    assert r.total_minutes == 486
    assert r.late is False
    assert r.early_out is False
    assert r.short_hours is False  # 486 >= 480
    assert r.overtime_minutes == 6
    assert r.absent is False


# ---------------------------------------------------------------------------
# Late
# ---------------------------------------------------------------------------


def test_arrival_exactly_at_grace_is_not_late() -> None:
    # start=07:30, grace=15 → 07:45 is *at* the cutoff; > check means
    # exactly-at-grace is still on time.
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=[_ev(7, 45)])
    assert r.late is False


def test_arrival_one_minute_past_grace_is_late() -> None:
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=[_ev(7, 46)])
    assert r.late is True


# ---------------------------------------------------------------------------
# Early out
# ---------------------------------------------------------------------------


def test_early_out_when_last_event_before_end_minus_grace() -> None:
    # end=15:30, grace=15 → 15:15 is the threshold; 15:10 < 15:15 → early_out.
    events = [_ev(7, 30), _ev(15, 10)]
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=events)
    assert r.early_out is True


def test_exact_end_minus_grace_is_not_early_out() -> None:
    events = [_ev(7, 30), _ev(15, 15)]
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=events)
    assert r.early_out is False


# ---------------------------------------------------------------------------
# Short hours / overtime
# ---------------------------------------------------------------------------


def test_short_hours_when_total_below_required() -> None:
    # Required = 8 h = 480 min; 07:30 → 11:30 = 240 min → short_hours
    events = [_ev(7, 30), _ev(11, 30)]
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=events)
    assert r.total_minutes == 240
    assert r.short_hours is True
    assert r.overtime_minutes == 0


def test_overtime_over_required() -> None:
    # 07:30 → 17:00 = 570 min → 90 min overtime
    events = [_ev(7, 30), _ev(17, 0)]
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=events)
    assert r.total_minutes == 570
    assert r.overtime_minutes == 90
    assert r.short_hours is False


# ---------------------------------------------------------------------------
# Intermediate events are ignored
# ---------------------------------------------------------------------------


def test_intermediate_events_are_not_used_for_summary() -> None:
    """Sent an unordered list; engine still picks first / last by timestamp."""

    events = [_ev(15, 34), _ev(7, 28), _ev(12, 5), _ev(8, 12)]
    r = compute(employee_id=1, the_date=D, policy=FIXED, events=events)
    assert r.in_time == time(7, 28)
    assert r.out_time == time(15, 34)
    assert r.total_minutes == 486


# ---------------------------------------------------------------------------
# Pure function — identical input produces identical output
# ---------------------------------------------------------------------------


def test_compute_is_deterministic() -> None:
    events = [_ev(7, 31), _ev(15, 20)]
    a = compute(employee_id=1, the_date=D, policy=FIXED, events=events)
    b = compute(employee_id=1, the_date=D, policy=FIXED, events=events)
    assert a == b
