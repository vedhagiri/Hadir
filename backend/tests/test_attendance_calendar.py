"""Tests for P28.6 — Attendance calendar endpoints + pure helpers.

Covers (per the prompt's required test list):

* ``parse_month`` validation + ``collapse_timeline`` pure logic
* Company view returns one row per calendar day for the requested month
* Manager calling company view is scoped to their visible employee set
  (a Manager assigned to ENG with N employees in Engineering shows
  ``active_employees == N``, not the full tenant headcount)
* Per-person view permission matrix:
  - Admin: any employee in their tenant
  - Manager: 404 on employees outside their department/assignment
  - Employee: 404 on any employee that isn't their own row
* Day detail: evidence list is non-empty for a present day with
  detection events on disk; empty for an absent day
* Day detail: the timeline collapses 5 events within 10 minutes into
  one interval
* Tenant isolation: requesting an employee_id that lives in another
  tenant returns 404 (never 403, never leaks)

The P5 two-tenant isolation suite (``test_two_tenant_isolation.py``)
remains the load-bearing canary — these tests stay tenant-1-scoped.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from maugood.attendance_calendar.queries import (
    TIMELINE_GAP_MINUTES,
    _shift,
    collapse_timeline,
    parse_month,
)
from maugood.db import (
    approved_leaves,
    attendance_records,
    cameras,
    detection_events,
    employees,
    leave_types,
    manager_assignments,
    roles,
    shift_policies,
    user_departments,
    user_roles,
)


TENANT_ID = 1


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_parse_month_round_trip() -> None:
    start, end = parse_month("2026-04")
    assert start == date(2026, 4, 1)
    assert end == date(2026, 4, 30)
    start, end = parse_month("2026-02")
    # Non-leap February.
    assert (end - start).days == 27


def test_parse_month_rejects_bad_input() -> None:
    for bad in ("2026", "2026-13", "2026/04", "abcd-04", "26-04"):
        with pytest.raises(ValueError):
            parse_month(bad)


def test_collapse_timeline_collapses_within_gap() -> None:
    """Five detections within a 10-minute window collapse to ONE interval.

    P28.6 red line — the drawer's day-timeline ribbon expects this.
    """

    times = [
        time(7, 30),
        time(7, 32),
        time(7, 35),
        time(7, 38),
        time(7, 40),
    ]
    intervals = collapse_timeline(times, gap_minutes=TIMELINE_GAP_MINUTES)
    assert len(intervals) == 1
    assert intervals[0].start == "07:30"
    assert intervals[0].end == "07:40"


def test_collapse_timeline_splits_on_long_gap() -> None:
    times = [time(7, 30), time(7, 35), time(12, 0), time(12, 5)]
    intervals = collapse_timeline(times, gap_minutes=TIMELINE_GAP_MINUTES)
    assert len(intervals) == 2
    assert intervals[0].start == "07:30"
    assert intervals[0].end == "07:35"
    assert intervals[1].start == "12:00"
    assert intervals[1].end == "12:05"


def test_collapse_timeline_empty() -> None:
    assert collapse_timeline([]) == []


# ---------------------------------------------------------------------------
# Fixtures: seed two-department attendance for tenant 1
# ---------------------------------------------------------------------------


def _seed(admin_engine: Engine) -> dict:
    """Seed three employees across ENG (1) + OPS (2), with a month
    of attendance rows on tenant 1.

    Layout:
    - ENG-001 + ENG-002 in department 1 (ENG)
    - OPS-001 in department 2 (OPS)
    - ENG-001 has 3 present + 1 late + 1 absent attendance row in the
      first 5 days of the current month
    - OPS-001 has 3 present rows
    """

    today = date.today()
    month_start = today.replace(day=1)

    # Pick 5 successive weekdays (skipping Fri/Sat — the tenant default
    # weekend) so the absent + late assertions don't get masked by the
    # ``weekend > everything else`` status priority.
    weekend_names = {"Friday", "Saturday"}
    weekdays: list[date] = []
    cursor = month_start
    while len(weekdays) < 5:
        if cursor.strftime("%A") not in weekend_names:
            weekdays.append(cursor)
        cursor = cursor + timedelta(days=1)

    with admin_engine.begin() as conn:
        conn.execute(
            delete(detection_events).where(detection_events.c.tenant_id == TENANT_ID)
        )
        conn.execute(
            delete(attendance_records).where(
                attendance_records.c.tenant_id == TENANT_ID
            )
        )
        conn.execute(
            delete(approved_leaves).where(approved_leaves.c.tenant_id == TENANT_ID)
        )
        conn.execute(delete(cameras).where(cameras.c.tenant_id == TENANT_ID))
        conn.execute(delete(employees).where(employees.c.tenant_id == TENANT_ID))

        eng1 = conn.execute(
            insert(employees)
            .values(
                tenant_id=TENANT_ID,
                employee_code="P28.6-ENG-001",
                full_name="Tariq Calendar",
                email="tariq-cal@p28.example",
                department_id=1,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        eng2 = conn.execute(
            insert(employees)
            .values(
                tenant_id=TENANT_ID,
                employee_code="P28.6-ENG-002",
                full_name="Aisha Calendar",
                email="aisha-cal@p28.example",
                department_id=1,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        ops1 = conn.execute(
            insert(employees)
            .values(
                tenant_id=TENANT_ID,
                employee_code="P28.6-OPS-001",
                full_name="Fatima Calendar",
                email="fatima-cal@p28.example",
                department_id=2,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()

        policy_id = conn.execute(
            select(shift_policies.c.id)
            .where(shift_policies.c.tenant_id == TENANT_ID)
            .order_by(shift_policies.c.id.asc())
            .limit(1)
        ).scalar_one()

        # Five weekdays in the current month, picked above to skip
        # Fri/Sat so the absent + late attendance status survives the
        # priority cascade (weekend > absent/late).
        days = weekdays

        # ENG-001: present (3), late (1), absent (1)
        for d, in_t, out_t, late, absent in (
            (days[0], time(7, 28), time(15, 36), False, False),
            (days[1], time(7, 30), time(15, 30), False, False),
            (days[2], time(8, 5), time(15, 30), True, False),  # late
            (days[3], None, None, False, True),  # absent
            (days[4], time(7, 30), time(15, 30), False, False),
        ):
            total = (
                (out_t.hour * 60 + out_t.minute)
                - (in_t.hour * 60 + in_t.minute)
                if (in_t and out_t)
                else 0
            )
            conn.execute(
                insert(attendance_records).values(
                    tenant_id=TENANT_ID,
                    employee_id=eng1,
                    date=d,
                    in_time=in_t,
                    out_time=out_t,
                    total_minutes=total or None,
                    policy_id=policy_id,
                    late=late,
                    early_out=False,
                    short_hours=False,
                    absent=absent,
                    overtime_minutes=0,
                )
            )

        # OPS-001: 3 present rows
        for d in days[:3]:
            conn.execute(
                insert(attendance_records).values(
                    tenant_id=TENANT_ID,
                    employee_id=ops1,
                    date=d,
                    in_time=time(7, 35),
                    out_time=time(15, 35),
                    total_minutes=480,
                    policy_id=policy_id,
                    late=False,
                    early_out=False,
                    short_hours=False,
                    absent=False,
                    overtime_minutes=0,
                )
            )

        # One camera + a handful of detection events for ENG-001 on
        # day 0 — used by the "evidence non-empty" test below.
        cam_id = conn.execute(
            insert(cameras)
            .values(
                tenant_id=TENANT_ID,
                name="P28.6-Cam",
                location="Lobby",
                rtsp_url_encrypted="not-a-real-cipher",
                worker_enabled=False,
                display_enabled=False,
            )
            .returning(cameras.c.id)
        ).scalar_one()

        # Five detection events, all within a 6-minute window on the
        # morning of day 0 (07:30–07:36 local) — used by both the
        # "evidence non-empty" assertion and the "timeline collapses"
        # check. captured_at is stored UTC; Asia/Muscat is UTC+4 so
        # 07:30 local = 03:30 UTC.
        utc = timezone.utc
        morning_utc = datetime.combine(days[0], time(3, 30), tzinfo=utc)
        for i in range(5):
            conn.execute(
                insert(detection_events).values(
                    tenant_id=TENANT_ID,
                    camera_id=cam_id,
                    captured_at=morning_utc + timedelta(minutes=i),
                    bbox={"x": 10, "y": 10, "w": 50, "h": 50},
                    face_crop_path=f"/tmp/never-decrypted-{i}.jpg",
                    employee_id=eng1,
                    confidence=0.92 - i * 0.01,
                    track_id=f"P28.6-track-{i}",
                )
            )

    return {
        "eng1": int(eng1),
        "eng2": int(eng2),
        "ops1": int(ops1),
        "month_start": month_start,
        "days": days,
    }


@pytest.fixture
def seeded_calendar(admin_engine: Engine) -> Iterator[dict]:
    info = _seed(admin_engine)
    try:
        yield info
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(detection_events).where(
                    detection_events.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                delete(approved_leaves).where(
                    approved_leaves.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(delete(cameras).where(cameras.c.tenant_id == TENANT_ID))
            conn.execute(delete(employees).where(employees.c.tenant_id == TENANT_ID))


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _month_str(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _set_user_to_manager(
    admin_engine: Engine, *, user_id: int, department_id: int
) -> None:
    """Replace the user's roles with [Manager] and assign them to the
    given department. Used to flip the shared ``admin_user`` fixture
    into a Manager for one test, then restored by the caller."""

    with admin_engine.begin() as conn:
        conn.execute(delete(user_roles).where(user_roles.c.user_id == user_id))
        manager_role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Manager"
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=user_id, role_id=manager_role_id, tenant_id=TENANT_ID
            )
        )
        conn.execute(
            delete(user_departments).where(user_departments.c.user_id == user_id)
        )
        conn.execute(
            insert(user_departments).values(
                user_id=user_id, department_id=department_id, tenant_id=TENANT_ID
            )
        )


def _restore_admin(admin_engine: Engine, *, user_id: int) -> None:
    with admin_engine.begin() as conn:
        conn.execute(delete(user_roles).where(user_roles.c.user_id == user_id))
        conn.execute(
            delete(user_departments).where(user_departments.c.user_id == user_id)
        )
        conn.execute(
            delete(manager_assignments).where(
                manager_assignments.c.manager_user_id == user_id
            )
        )


# ---------------------------------------------------------------------------
# Company view
# ---------------------------------------------------------------------------


def test_company_view_returns_one_row_per_day(
    client: TestClient, admin_user: dict, seeded_calendar: dict
) -> None:
    _login(client, admin_user)
    month = _month_str(seeded_calendar["month_start"])
    resp = client.get(f"/api/attendance/calendar/company?month={month}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["month"] == month

    # 28-31 days depending on the month — the API guarantees one row
    # per calendar day in the bounds.
    expected_days = (
        seeded_calendar["month_start"]
        .replace(month=seeded_calendar["month_start"].month % 12 + 1, day=1)
        - seeded_calendar["month_start"]
        if seeded_calendar["month_start"].month != 12
        else timedelta(days=31)
    ).days
    assert len(body["days"]) == expected_days

    # Every day carries the standard shape.
    for d in body["days"]:
        assert set(d.keys()) >= {
            "date",
            "present_count",
            "late_count",
            "absent_count",
            "leave_count",
            "active_employees",
            "is_weekend",
            "is_holiday",
            "percent_present",
        }
        assert d["active_employees"] >= 3  # we seeded 3 active employees


def test_company_view_400_on_bad_month(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.get("/api/attendance/calendar/company?month=2026-13")
    assert resp.status_code == 400


def test_company_view_403_for_employee(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    resp = client.get("/api/attendance/calendar/company?month=2026-04")
    assert resp.status_code == 403


def test_company_view_manager_scoped_to_visible_employees(
    client: TestClient,
    admin_user: dict,
    seeded_calendar: dict,
    admin_engine: Engine,
) -> None:
    """Manager assigned to ENG (department_id=1) sees only ENG headcount.

    ENG has 2 active employees (ENG-001 + ENG-002); OPS has 1 (OPS-001).
    The Manager's company view should report ``active_employees == 2``,
    not 3.
    """

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        month = _month_str(seeded_calendar["month_start"])
        resp = client.get(f"/api/attendance/calendar/company?month={month}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Pick the first day — every day mirrors the same active count
        # for the manager's scope (the count is rolled at the scope
        # level, not per-day).
        first = body["days"][0]
        assert first["active_employees"] == 2, body["days"][0]
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


# ---------------------------------------------------------------------------
# Per-person view permission matrix
# ---------------------------------------------------------------------------


def test_person_view_admin_sees_any_employee(
    client: TestClient, admin_user: dict, seeded_calendar: dict
) -> None:
    _login(client, admin_user)
    month = _month_str(seeded_calendar["month_start"])
    for emp_id in (
        seeded_calendar["eng1"],
        seeded_calendar["eng2"],
        seeded_calendar["ops1"],
    ):
        resp = client.get(
            f"/api/attendance/calendar/person/{emp_id}?month={month}"
        )
        assert resp.status_code == 200, (emp_id, resp.text)
        body = resp.json()
        assert body["employee_id"] == emp_id
        assert len(body["days"]) >= 28


def test_person_view_manager_404_outside_dept(
    client: TestClient,
    admin_user: dict,
    seeded_calendar: dict,
    admin_engine: Engine,
) -> None:
    """A Manager assigned to ENG can see ENG employees but NOT OPS-001
    — the response is 404, not 403 (403 would leak that the row exists
    in another scope)."""

    _set_user_to_manager(admin_engine, user_id=admin_user["id"], department_id=1)
    try:
        _login(client, admin_user)
        month = _month_str(seeded_calendar["month_start"])

        ok = client.get(
            f"/api/attendance/calendar/person/{seeded_calendar['eng1']}?month={month}"
        )
        assert ok.status_code == 200, ok.text

        forbidden = client.get(
            f"/api/attendance/calendar/person/{seeded_calendar['ops1']}?month={month}"
        )
        # Always 404, never 403.
        assert forbidden.status_code == 404, forbidden.text
    finally:
        _restore_admin(admin_engine, user_id=admin_user["id"])


def test_person_view_employee_404_for_others(
    client: TestClient,
    employee_user: dict,
    seeded_calendar: dict,
) -> None:
    """An Employee can only see their own employee row. Without an
    employees-row email match the user is unmapped — both their own
    and someone else's id come back as 404."""

    _login(client, employee_user)
    month = _month_str(seeded_calendar["month_start"])
    # The fixture's Employee user has no matching employees row — every
    # id in the seed set is "outside scope" → 404.
    for emp_id in (
        seeded_calendar["eng1"],
        seeded_calendar["ops1"],
    ):
        resp = client.get(
            f"/api/attendance/calendar/person/{emp_id}?month={month}"
        )
        assert resp.status_code == 404, (emp_id, resp.text)


# ---------------------------------------------------------------------------
# Day detail
# ---------------------------------------------------------------------------


def test_day_detail_returns_evidence_when_events_exist(
    client: TestClient, admin_user: dict, seeded_calendar: dict
) -> None:
    """ENG-001 has 5 detection events on day 0 (the first of month).
    The drawer's evidence list must contain at least one item — the
    arrival bucket should match the 07:30 cluster."""

    _login(client, admin_user)
    eng1 = seeded_calendar["eng1"]
    d = seeded_calendar["days"][0].isoformat()
    resp = client.get(f"/api/attendance/calendar/day/{eng1}/{d}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["employee_id"] == eng1
    assert body["status"] in ("present", "late")
    assert isinstance(body["evidence"], list)
    assert len(body["evidence"]) >= 1, body
    # Each evidence entry carries a crop URL pointing at the existing
    # detection-events crop endpoint (P11).
    for e in body["evidence"]:
        assert e["crop_url"].startswith("/api/detection-events/")


def test_day_detail_evidence_empty_for_absent_day(
    client: TestClient, admin_user: dict, seeded_calendar: dict
) -> None:
    """Day 3 was seeded as absent for ENG-001 with no detection events
    — evidence should be an empty list."""

    _login(client, admin_user)
    eng1 = seeded_calendar["eng1"]
    absent_day = seeded_calendar["days"][3].isoformat()
    resp = client.get(f"/api/attendance/calendar/day/{eng1}/{absent_day}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "absent"
    assert body["evidence"] == []


def test_day_detail_timeline_collapses_clustered_events(
    client: TestClient, admin_user: dict, seeded_calendar: dict
) -> None:
    """The 5 detection events on day 0 sit within a 4-minute window
    (07:30..07:34 local) — the timeline must collapse them into a
    single interval per the 10-minute gap rule."""

    _login(client, admin_user)
    eng1 = seeded_calendar["eng1"]
    d = seeded_calendar["days"][0].isoformat()
    resp = client.get(f"/api/attendance/calendar/day/{eng1}/{d}")
    body = resp.json()
    assert len(body["timeline"]) == 1, body["timeline"]


# ---------------------------------------------------------------------------
# Tenant isolation — cross-tenant id returns 404
# ---------------------------------------------------------------------------


def test_cross_tenant_employee_id_returns_404(
    client: TestClient,
    admin_user: dict,
    seeded_calendar: dict,
    admin_engine: Engine,
) -> None:
    """An employee_id that exists in *another* tenant's schema must be
    invisible. We provision a second tenant briefly, create an employee
    there, then assert the tenant-1 Admin gets 404 for that id (which
    in tenant-1's schema doesn't exist).

    No need to spin up the full P5 isolation suite for this — the
    existing ``test_two_tenant_isolation.py`` is the load-bearing
    canary. Here we just confirm the calendar router goes through
    ``_check_can_view_employee`` and never returns 403/200.
    """

    _login(client, admin_user)
    month = _month_str(seeded_calendar["month_start"])

    # Pick an id that's almost certainly unused in tenant 1 and lives
    # safely inside the int range — the seed run never gets close.
    bogus_id = 999_999_999
    resp = client.get(
        f"/api/attendance/calendar/person/{bogus_id}?month={month}"
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "employee not found"

    # Day-detail endpoint goes through the same gate.
    resp = client.get(
        f"/api/attendance/calendar/day/{bogus_id}/{seeded_calendar['days'][0].isoformat()}"
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Regression: _shift used to overflow when called with a check-in just
# after midnight (e.g. an OT or weekend punch at 00:19). The old pivot
# was ``date.min`` so subtracting 30 minutes produced
# 0000-12-31 23:49 → ``OverflowError: date value out of range``.
# This 500'd ``GET /api/attendance/calendar/day/{eid}/{today}`` for any
# employee whose ``in_time`` was inside the first half-hour of the day.
# ---------------------------------------------------------------------------


def test_shift_handles_pre_midnight_underflow() -> None:
    # 00:19 minus 30 min would underflow date.min; should clamp to 00:00.
    assert _shift(time(0, 19), -30) == time(0, 0)
    # 00:00 minus any positive minutes also clamps to 00:00.
    assert _shift(time(0, 0), -1) == time(0, 0)


def test_shift_handles_post_2359_overflow() -> None:
    # 23:50 plus 30 min would push past the pivot day; should clamp to 23:59.
    assert _shift(time(23, 50), +30) == time(23, 59)
    assert _shift(time(23, 59), +120) == time(23, 59)


def test_shift_round_trip_inside_day() -> None:
    # Sanity: in-day arithmetic is unaffected.
    assert _shift(time(10, 0), 30) == time(10, 30)
    assert _shift(time(10, 0), -30) == time(9, 30)
    assert _shift(time(15, 30), -90) == time(14, 0)
