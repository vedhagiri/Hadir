"""Tests for ``/api/insights/*`` — the interactive attendance dashboards.

* Shape of the three endpoints (overview / department / employee).
* Golden rule: the overview's KPIs + department ranking equal the
  Template 1 PDF context for the same filters (single day + range).
* No ``data:`` URLs anywhere in a response — crops/photos are ids.
* Manager scoping: in-scope → 200, out-of-scope department/employee → 404.
* Employee role → 403. Cross-tenant / unknown ids → 404.
* Bad ranges → 4xx.
"""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, text

from maugood.db import (
    audit_log,
    departments,
    employees,
    manager_assignments,
    roles,
    tenant_context,
    user_departments,
    user_roles,
    user_sessions,
    users,
)
from maugood.reporting import pdf as P
from maugood.tenants.scope import TenantScope
from tests.test_p13_reports import _login, seeded_attendance  # noqa: F401

API = "/api/insights"


def _q(start, end) -> str:  # type: ignore[no-untyped-def]
    return f"start={start.isoformat()}&end={end.isoformat()}"


def _emp_ids(admin_engine) -> dict[str, int]:  # type: ignore[no-untyped-def]
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(employees.c.employee_code, employees.c.id).where(employees.c.tenant_id == 1)
        ).all()
    return {str(r.employee_code): int(r.id) for r in rows}


# ---------------------------------------------------------------------------
# Shape
# ---------------------------------------------------------------------------


def test_overview_shape(client: TestClient, admin_user: dict, seeded_attendance) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    resp = client.get(f"{API}/overview?{_q(today - timedelta(days=1), today)}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {
        "period",
        "scope",
        "kpis",
        "breakdown",
        "trend",
        "arrivals",
        "departments",
        "exceptions",
        "exceptions_total",
        "top_late",
        "top_absent",
        "compare",
        "weekday",
        "shift",
        "watchlist",
        "heatmap",
    }
    assert body["period"]["days"] == 2
    assert body["period"]["is_single_day"] is False
    assert set(body["kpis"]) == {
        "total",
        "present",
        "present_pct",
        "late",
        "early",
        "absent",
        "absent_pct",
        "leave",
        "ot_hours",
        "ot_employees",
        "avg_hours",
        "avg_late_minutes",
        "attendance_pct",
        "punctuality_pct",
        "avg_in",
        "avg_out",
        "expected_days",
        "present_days",
    }
    assert body["kpis"]["total"] == 2
    assert body["kpis"]["present"] == 3  # person-days
    assert len(body["trend"]) == 2
    assert {
        "date",
        "weekday",
        "is_weekend",
        "is_holiday",
        "holiday_name",
        "present",
        "late",
        "absent",
        "leave",
        "headcount",
        "present_pct",
    } <= set(body["trend"][0])
    assert sum(a["count"] for a in body["arrivals"]) == 3
    assert all(a["bucket"].count(":") == 1 for a in body["arrivals"])
    assert {d["department_id"] for d in body["departments"]} == {1, 2}
    pcts = [d["pct"] for d in body["departments"]]
    assert pcts == sorted(pcts, reverse=True)
    assert "data:" not in resp.text


def test_overview_defaults_to_tenant_today(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    resp = client.get(f"{API}/overview")
    assert resp.status_code == 200, resp.text
    p = resp.json()["period"]
    assert p["start"] == p["end"] and p["is_single_day"] is True


def test_department_shape(client: TestClient, admin_user: dict, seeded_attendance) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    resp = client.get(f"{API}/departments/1?{_q(today - timedelta(days=1), today)}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {
        "department",
        "period",
        "kpis",
        "breakdown",
        "trend",
        "arrivals",
        "employees",
        "exceptions",
        "exceptions_total",
        "compare",
        "weekday",
        "shift",
        "watchlist",
        "company",
    }
    assert body["department"]["id"] == 1
    assert {"id", "name", "code", "division", "headcount", "managers"} == set(body["department"])
    assert [e["employee_code"] for e in body["employees"]] == ["P13-ENG"]
    e = body["employees"][0]
    assert e["present_days"] == 2
    assert e["avg_in"] is not None and len(e["avg_in"]) == 5
    assert "primary_photo_id" in e and "last_status" in e
    assert "data:" not in resp.text


def test_employee_shape(
    client: TestClient, admin_user: dict, seeded_attendance, admin_engine
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    eid = _emp_ids(admin_engine)["P13-ENG"]
    resp = client.get(f"{API}/employees/{eid}?{_q(today - timedelta(days=2), today)}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {
        "profile",
        "policy",
        "period",
        "kpis",
        "days",
        "requests",
        "compare",
        "highlights",
    }
    assert body["profile"]["id"] == eid
    assert body["profile"]["employee_code"] == "P13-ENG"
    assert body["policy"] is not None and body["policy"]["required_hours"] >= 1
    assert len(body["days"]) == 3
    assert body["kpis"]["present_days"] == 2
    assert body["kpis"]["avg_in"] is not None
    present = [d for d in body["days"] if d["in_time"]]
    assert len(present) == 2
    assert {"first_event_id", "last_event_id", "camera", "flags", "ot_minutes"} <= set(present[0])
    assert "data:" not in resp.text


# ---------------------------------------------------------------------------
# Golden rule: same numbers as the PDF
# ---------------------------------------------------------------------------


def _pdf_ctx(admin_engine, start, end, department_ids=None):  # type: ignore[no-untyped-def]
    """Build the PDF context exactly as ``build_pdf`` does (minus crops)."""

    scope = TenantScope(tenant_id=1)
    with tenant_context("main"), admin_engine.begin() as conn:
        fmt = P.load_tenant_formatter(conn, 1)
        ts = P.load_tenant_settings(conn, scope)
        tz = P._tz(ts.timezone)
        wd = tuple(ts.weekend_days)
        raw = P._query_rows(
            conn,
            scope,
            start_date=start,
            end_date=end,
            department_ids=department_ids,
            employee_id=None,
        )
        hol = P._holidays_between(conn, scope, start, end)
        pc = P._policy_cache(fmt)
        rows = [
            P._mk_row(
                r,
                fmt=fmt,
                pcache=pc,
                holiday_names=hol,
                weekend_days=wd,
                sight=None,
                with_crops=False,
            )
            for r in raw
        ]
        if start == end:
            return P._daily_context(
                conn,
                scope,
                rows,
                the_date=start,
                department_ids=department_ids,
                department_label=None,
                fmt=fmt,
                tz=tz,
                holiday_names=hol,
                weekend_days=wd,
                pcache=pc,
                report_id="x",
                generated_at_label="x",
                generated_by_email="x",
            )
        return P._range_context(
            rows,
            start=start,
            end=end,
            department_label=None,
            fmt=fmt,
            tz=tz,
            holiday_names=hol,
            weekend_days=wd,
            report_id="x",
            generated_at_label="x",
            generated_by_email="x",
            with_crops=False,
        )


def test_overview_single_day_matches_pdf_context(
    client: TestClient, admin_user: dict, seeded_attendance, admin_engine
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    body = client.get(f"{API}/overview?{_q(today, today)}").json()
    ctx = _pdf_ctx(admin_engine, today, today)
    k = ctx["k"]
    for key in (
        "total",
        "present",
        "present_pct",
        "late",
        "early",
        "absent",
        "absent_pct",
        "leave",
        "ot_hours",
        "ot_employees",
    ):
        assert body["kpis"][key] == k[key], key
    assert body["kpis"]["avg_hours"] == (
        round(k["avg_hours"], 2) if k["avg_hours"] is not None else None
    )
    assert [(d["name"], d["present"], d["pct"], d["headcount"]) for d in body["departments"]] == [
        (d["name"], d["present"], d["pct"], d["headcount"]) for d in ctx["departments"]
    ]
    assert [(b["key"], b["count"], b["delta"]) for b in body["breakdown"]] == [
        (b["key"], b["count"], b["delta"]) for b in ctx["breakdown"]["rows"]
    ]
    assert body["exceptions_total"] == ctx["exceptions_total"]
    assert body["period"]["prev_label"] == ctx["breakdown"]["prev_label"]


def test_overview_range_matches_pdf_context(
    client: TestClient, admin_user: dict, seeded_attendance, admin_engine
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    start = today - timedelta(days=1)
    body = client.get(f"{API}/overview?{_q(start, today)}").json()
    ctx = _pdf_ctx(admin_engine, start, today)
    k = ctx["k"]
    assert body["kpis"]["total"] == k["total"]
    assert body["kpis"]["present"] == k["present_days"]
    assert body["kpis"]["present_pct"] == k["present_pct"]
    assert body["kpis"]["late"] == k["late"]
    assert body["kpis"]["absent"] == k["absent"]
    assert body["kpis"]["leave"] == k["leave"]
    assert body["kpis"]["ot_hours"] == k["ot_hours"]
    assert body["kpis"]["ot_employees"] == k["ot_employees"]
    assert body["period"]["working_days"] == k["working_days"]
    assert [(d["name"], d["present"], d["pct"]) for d in body["departments"]] == [
        (d["name"], d["present"], d["pct"]) for d in ctx["departments"]
    ]
    assert body["exceptions_total"] == ctx["exceptions_total"]

    # Top late / most absent are ranked over the whole period and agree
    # with the PDF's exception rows (the seed is well under the 300 cap).
    for key, status in (("top_late", "late"), ("top_absent", "absent")):
        expected: dict[int, int] = {}
        for r in ctx["exceptions"]:
            if r["exception_status"] == status:
                expected[r["employee_id"]] = expected.get(r["employee_id"], 0) + 1
        got = {p["employee_id"]: p["count"] for p in body[key]}
        assert got == dict(sorted(expected.items(), key=lambda kv: -kv[1])[:6]) or (
            len(expected) > 6 and set(got.values()) <= set(expected.values())
        )
        counts = [p["count"] for p in body[key]]
        assert counts == sorted(counts, reverse=True)


# ---------------------------------------------------------------------------
# Roles + scoping
# ---------------------------------------------------------------------------


def test_employee_role_403(
    client: TestClient, employee_user: dict, seeded_attendance, admin_engine
) -> None:
    _login(client, employee_user)
    eid = _emp_ids(admin_engine)["P13-ENG"]
    assert client.get(f"{API}/overview").status_code == 403
    assert client.get(f"{API}/departments/1").status_code == 403
    assert client.get(f"{API}/employees/{eid}").status_code == 403


@pytest.fixture
def eng_manager(admin_engine) -> Iterator[dict]:  # type: ignore[no-untyped-def]
    suffix = secrets.token_hex(3)
    email = f"mgr-ins-{suffix}@insights.maugood"
    password = "ins-pw-" + secrets.token_hex(6)
    from maugood.auth.passwords import hash_password  # noqa: PLC0415

    with admin_engine.begin() as conn:
        uid = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=1,
                    email=email,
                    password_hash=hash_password(password),
                    full_name="Insights Manager",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        rid = conn.execute(
            select(roles.c.id).where(roles.c.tenant_id == 1, roles.c.code == "Manager")
        ).scalar_one()
        conn.execute(insert(user_roles).values(user_id=uid, role_id=int(rid), tenant_id=1))
        conn.execute(insert(user_departments).values(user_id=uid, department_id=1, tenant_id=1))
    try:
        yield {"email": email, "password": password, "id": uid}
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(user_sessions).where(user_sessions.c.user_id == uid))
            conn.execute(delete(audit_log).where(audit_log.c.actor_user_id == uid))
            conn.execute(delete(user_roles).where(user_roles.c.user_id == uid))
            conn.execute(delete(user_departments).where(user_departments.c.user_id == uid))
            conn.execute(
                delete(manager_assignments).where(manager_assignments.c.manager_user_id == uid)
            )
            conn.execute(delete(users).where(users.c.id == uid))


def test_manager_scoping(
    client: TestClient, eng_manager: dict, seeded_attendance, admin_engine
) -> None:
    _login(client, eng_manager)
    today = seeded_attendance["today"]
    ids = _emp_ids(admin_engine)
    q = _q(today - timedelta(days=1), today)

    ov = client.get(f"{API}/overview?{q}")
    assert ov.status_code == 200, ov.text
    assert ov.json()["kpis"]["total"] == 1  # ENG only
    assert {d["department_id"] for d in ov.json()["departments"]} == {1}

    assert client.get(f"{API}/overview?{q}&department_id=1").status_code == 200
    assert client.get(f"{API}/overview?{q}&department_id=2").status_code == 404

    dept_in = client.get(f"{API}/departments/1?{q}")
    assert dept_in.status_code == 200
    assert "Insights Manager" in dept_in.json()["department"]["managers"]
    assert client.get(f"{API}/departments/2?{q}").status_code == 404

    assert client.get(f"{API}/employees/{ids['P13-ENG']}?{q}").status_code == 200
    out = client.get(f"{API}/employees/{ids['P13-OPS']}?{q}")
    assert out.status_code == 404
    assert out.json()["detail"] == "employee not found"


def test_unknown_ids_404(client: TestClient, admin_user: dict, seeded_attendance) -> None:
    _login(client, admin_user)
    assert client.get(f"{API}/employees/999999999").status_code == 404
    assert client.get(f"{API}/departments/999999999").status_code == 404
    assert client.get(f"{API}/overview?department_id=999999999").status_code == 404


def test_cross_tenant_employee_id_404(
    client: TestClient, admin_user: dict, seeded_attendance, admin_engine
) -> None:
    """An employee that exists only in another tenant's schema is
    invisible to a tenant-1 Admin (404, not 403/200)."""

    _login(client, admin_user)
    with admin_engine.begin() as conn:
        other = conn.execute(
            text("SELECT id, schema_name FROM public.tenants WHERE id <> 1 ORDER BY id LIMIT 1")
        ).first()
    if other is None:
        pytest.skip("no second tenant provisioned on this database")
    tid, schema = int(other.id), str(other.schema_name)
    with tenant_context(schema), admin_engine.begin() as conn:
        dept = conn.execute(
            select(departments.c.id).where(departments.c.tenant_id == tid).limit(1)
        ).scalar()
        if dept is None:
            pytest.skip("second tenant has no departments")
        foreign_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=tid,
                    employee_code=f"XT-{secrets.token_hex(3)}",
                    full_name="Cross Tenant",
                    department_id=int(dept),
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
    try:
        if foreign_id in _emp_ids(admin_engine).values():
            pytest.skip("id collides with a tenant-1 employee")
        resp = client.get(f"{API}/employees/{foreign_id}")
        assert resp.status_code == 404
        assert "Cross Tenant" not in resp.text
    finally:
        with tenant_context(schema), admin_engine.begin() as conn:
            conn.execute(
                delete(employees).where(employees.c.id == foreign_id, employees.c.tenant_id == tid)
            )


# ---------------------------------------------------------------------------
# Date validation
# ---------------------------------------------------------------------------


def test_bad_ranges(client: TestClient, admin_user: dict, seeded_attendance, admin_engine) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    eid = _emp_ids(admin_engine)["P13-ENG"]
    for path in ("overview", "departments/1", f"employees/{eid}"):
        inverted = client.get(f"{API}/{path}?{_q(today, today - timedelta(days=1))}")
        assert inverted.status_code == 400, path
        assert "end must be on or after start" in inverted.json()["detail"]
        too_long = client.get(f"{API}/{path}?{_q(today - timedelta(days=92), today)}")
        assert too_long.status_code == 400, path
        assert "92" in too_long.json()["detail"]
        assert client.get(f"{API}/{path}?start=not-a-date").status_code == 422
    # 92 days inclusive is allowed.
    assert client.get(f"{API}/overview?{_q(today - timedelta(days=91), today)}").status_code == 200


# ---------------------------------------------------------------------------
# v2 — comparisons, weekday, shift, watchlists, heatmap, people picker
# ---------------------------------------------------------------------------


@pytest.fixture
def absent_employee(admin_engine, seeded_attendance):  # type: ignore[no-untyped-def]
    """A third (ENG) employee absent yesterday + today — never seen.
    Cleaned up by ``seeded_attendance``'s teardown."""

    from maugood.db import attendance_records, shift_policies  # noqa: PLC0415

    today = seeded_attendance["today"]
    with admin_engine.begin() as conn:
        pid = conn.execute(
            select(shift_policies.c.id)
            .where(shift_policies.c.tenant_id == 1)
            .order_by(shift_policies.c.id.asc())
            .limit(1)
        ).scalar_one()
        eid = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=1,
                    employee_code="P13-ABS",
                    full_name="Absent Person",
                    department_id=1,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        for d in (today - timedelta(days=1), today):
            conn.execute(
                insert(attendance_records).values(
                    tenant_id=1,
                    employee_id=eid,
                    date=d,
                    policy_id=pid,
                    late=False,
                    early_out=False,
                    short_hours=False,
                    absent=True,
                    overtime_minutes=0,
                )
            )
    return eid


def _working_dates(body: dict) -> list[str]:
    return [t["date"] for t in body["trend"] if not t["is_weekend"] and not t["is_holiday"]]


def test_overview_v2_kpis_match_pdf(
    client: TestClient, admin_user: dict, seeded_attendance, admin_engine
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    # Range: expected = PDF slots (employees × working days).
    start = today - timedelta(days=1)
    body = client.get(f"{API}/overview?{_q(start, today)}").json()
    k = _pdf_ctx(admin_engine, start, today)["k"]
    kp = body["kpis"]
    assert kp["expected_days"] == k["slots"]
    assert kp["present_days"] == k["present_days"] == kp["present"]
    assert kp["attendance_pct"] == k["present_pct"] == kp["present_pct"]
    assert kp["punctuality_pct"] == P._pct(k["present_days"] - k["late"], k["present_days"])
    # Seed in-times: 07:28, 07:31, 07:50 → mean 07:36.
    assert kp["avg_in"] == "07:36"
    assert kp["avg_out"] is not None and len(kp["avg_out"]) == 5
    # Single day: expected = the daily PDF's total.
    one = client.get(f"{API}/overview?{_q(today, today)}").json()["kpis"]
    kd = _pdf_ctx(admin_engine, today, today)["k"]
    assert one["expected_days"] == kd["total"]
    assert one["attendance_pct"] == kd["present_pct"]
    assert one["punctuality_pct"] == 50  # ENG on time, OPS late


def test_overview_compare_equals_previous_period(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    yday = today - timedelta(days=1)
    body = client.get(f"{API}/overview?{_q(today, today)}").json()
    cmp_ = body["compare"]
    assert cmp_ is not None
    assert cmp_["start"] == cmp_["end"] == yday.isoformat()
    prev = client.get(f"{API}/overview?{_q(yday, yday)}").json()["kpis"]
    for key in (
        "attendance_pct",
        "punctuality_pct",
        "avg_in",
        "avg_hours",
        "late",
        "absent",
        "leave",
        "ot_hours",
        "present_days",
        "expected_days",
    ):
        assert cmp_["kpis"][key] == prev[key], key
    # No rows in the previous 2 days → null.
    two = client.get(f"{API}/overview?{_q(yday, today)}").json()
    assert two["compare"] is None


def test_overview_weekday_shift_heatmap(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    start = today - timedelta(days=1)
    body = client.get(f"{API}/overview?{_q(start, today)}").json()
    working = _working_dates(body)
    from datetime import date as _date  # noqa: PLC0415

    wd = sorted({_date.fromisoformat(d).weekday() for d in working})
    assert [w["weekday"] for w in body["weekday"]] == wd
    for w in body["weekday"]:
        assert w["name"] == ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[w["weekday"]]
        assert w["working_days"] >= 1
    assert sum(w["late"] for w in body["weekday"]) == sum(
        t["late"] for t in body["trend"] if t["date"] in working
    )

    shift = body["shift"]
    if shift is not None:
        assert len(shift["start"]) == 5 and len(shift["end"]) == 5
        assert isinstance(shift["grace_minutes"], int)

    hm = body["heatmap"]
    assert hm["dates"] == working
    assert [r["department_id"] for r in hm["rows"]] == [
        d["department_id"] for d in body["departments"]
    ]
    for r in hm["rows"]:
        assert len(r["cells"]) == len(working)
        assert all(c is None or 0 <= c <= 100 for c in r["cells"])
    single = client.get(f"{API}/overview?{_q(today, today)}").json()
    assert single["heatmap"] == {"dates": [], "rows": []}


def test_overview_watchlists(
    client: TestClient, admin_user: dict, seeded_attendance, absent_employee
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    start = today - timedelta(days=1)
    body = client.get(f"{API}/overview?{_q(start, today)}").json()
    wl = body["watchlist"]
    # Range: late needs >= 2 days — OPS was late once → not listed.
    assert wl["frequent_late"] == [] and wl["totals"]["frequent_late"] == 0
    # ENG worked 8 min overtime.
    assert [(p["employee_code"], p["ot_minutes"]) for p in wl["overtime"]] == [("P13-ENG", 8)]
    absent_rows = [p for p in wl["repeated_absent"] if p["employee_id"] == absent_employee]
    assert len(absent_rows) == 1
    assert absent_rows[0]["count"] == 2
    assert absent_rows[0]["longest_streak"] == len(_working_dates(body))
    assert absent_rows[0]["department_id"] == 1
    assert [p["employee_id"] for p in wl["never_seen"]] == [absent_employee]
    assert wl["totals"]["never_seen"] == 1
    # Single day: threshold drops to 1 → OPS (late today) is listed.
    one = client.get(f"{API}/overview?{_q(today, today)}").json()["watchlist"]
    assert [p["employee_code"] for p in one["frequent_late"]] == ["P13-OPS"]
    assert one["frequent_late"][0]["count"] == 1
    # v1 lists still there.
    assert "top_late" in body and "top_absent" in body


def test_department_v2(
    client: TestClient, admin_user: dict, eng_manager: dict, seeded_attendance, absent_employee
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    start = today - timedelta(days=1)
    q = _q(start, today)
    body = client.get(f"{API}/departments/1?{q}").json()
    assert body["kpis"]["attendance_pct"] == body["kpis"]["present_pct"]
    assert body["watchlist"]["never_seen"][0]["employee_id"] == absent_employee
    assert body["watchlist"]["overtime"][0]["employee_code"] == "P13-ENG"
    by_code = {e["employee_code"]: e for e in body["employees"]}
    eng, absent = by_code["P13-ENG"], by_code["P13-ABS"]
    assert eng["punctuality_pct"] == 100 and absent["punctuality_pct"] is None
    assert len(eng["strip"]) == 2 and len(absent["strip"]) == 2
    assert all(st in ("present", "late", "early") for st in eng["strip"])
    assert absent["strip"] == ["absent", "absent"]
    # Company (Admin = whole tenant) = the overview headline for the same range.
    ov = client.get(f"{API}/overview?{q}").json()["kpis"]
    for key in ("attendance_pct", "punctuality_pct", "avg_in", "avg_hours"):
        assert body["company"][key] == ov[key], key

    # Manager (ENG only): "company" is limited to the caller's scope.
    client.post("/api/auth/logout")
    _login(client, eng_manager)
    mbody = client.get(f"{API}/departments/1?{q}").json()
    for key in ("attendance_pct", "punctuality_pct", "avg_in", "avg_hours"):
        assert mbody["company"][key] == mbody["kpis"][key], key


def test_employee_v2(client: TestClient, admin_user: dict, seeded_attendance, admin_engine) -> None:
    from sqlalchemy import update  # noqa: PLC0415

    _login(client, admin_user)
    today = seeded_attendance["today"]
    yday = today - timedelta(days=1)
    eid = seeded_attendance["eng_id"]
    with admin_engine.begin() as conn:
        conn.execute(update(employees).where(employees.c.id == eid).values(joining_date=today))

    body = client.get(f"{API}/employees/{eid}?{_q(today, today)}").json()
    cmp_ = body["compare"]
    prev = cmp_["previous"]
    assert prev is not None
    pk = client.get(f"{API}/employees/{eid}?{_q(yday, yday)}").json()["kpis"]
    assert prev["attendance_pct"] == pk["attendance_pct"]
    assert prev["avg_in"] == pk["avg_in"] == "07:31"
    assert prev["late_days"] == pk["late_days"] and prev["absent_days"] == pk["absent_days"]
    ov = client.get(f"{API}/overview?{_q(today, today)}").json()["kpis"]
    for key in ("attendance_pct", "punctuality_pct", "avg_in", "avg_hours"):
        assert cmp_["company"][key] == ov[key], key
    dept = client.get(f"{API}/departments/1?{_q(today, today)}").json()["kpis"]
    for key in ("attendance_pct", "punctuality_pct", "avg_in", "avg_hours"):
        assert cmp_["department"][key] == dept[key], key

    two = client.get(f"{API}/employees/{eid}?{_q(yday, today)}").json()
    assert [d["before_joining"] for d in two["days"]] == [True, False]
    h = two["highlights"]
    assert set(h) == {
        "current_streak",
        "longest_present_streak",
        "most_late_weekday",
        "avg_late_minutes",
        "avg_minutes_vs_shift_start",
    }
    n_work = len([d for d in two["days"] if not d["is_weekend"] and not d["is_holiday"]])
    assert h["longest_present_streak"] == n_work
    if n_work:
        assert h["current_streak"] == {"status": "present", "days": n_work}
    assert h["most_late_weekday"] is None and h["avg_late_minutes"] is None
    # OPS was late today → most-late weekday = today's abbreviation.
    ops = client.get(f"{API}/employees/{seeded_attendance['ops_id']}?{_q(today, today)}").json()[
        "highlights"
    ]
    assert ops["most_late_weekday"] == today.strftime("%a")


def test_people_shape_sort_search_paging(
    client: TestClient, admin_user: dict, seeded_attendance, absent_employee
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    q = _q(today - timedelta(days=1), today)
    resp = client.get(f"{API}/people?{q}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"period", "total", "page", "page_size", "items"}
    assert body["page"] == 1 and body["page_size"] == 24 and body["total"] == 3
    items = {i["employee_code"]: i for i in body["items"]}
    assert set(items) == {"P13-ENG", "P13-OPS", "P13-ABS"}
    eng = items["P13-ENG"]
    assert eng["present_days"] == 2 and eng["avg_in"] == "07:30"
    assert eng["ot_minutes"] == 8 and eng["needs_attention"] is False
    absent = items["P13-ABS"]
    assert absent["needs_attention"] is True
    assert "never_seen" in absent["attention_reasons"]
    assert "absent" in absent["attention_reasons"]  # 2 days → threshold 1
    assert absent["punctuality_pct"] is None
    # Default sort = needs attention first.
    assert body["items"][0]["employee_code"] == "P13-ABS"
    names = [i["full_name"] for i in client.get(f"{API}/people?{q}&sort=name").json()["items"]]
    assert names == sorted(names, key=str.lower)
    late = client.get(f"{API}/people?{q}&sort=late").json()["items"]
    assert late[0]["employee_code"] == "P13-OPS"
    # Search by code / name / department.
    assert [
        i["employee_code"] for i in client.get(f"{API}/people?{q}&q=p13-ops").json()["items"]
    ] == ["P13-OPS"]
    assert client.get(f"{API}/people?{q}&q=tariq").json()["total"] == 1
    # Department filter + paging.
    d1 = client.get(f"{API}/people?{q}&department_id=1").json()
    assert {i["employee_code"] for i in d1["items"]} == {"P13-ENG", "P13-ABS"}
    p2 = client.get(f"{API}/people?{q}&sort=name&page=2&page_size=2").json()
    assert p2["total"] == 3 and len(p2["items"]) == 1 and p2["items"][0]["full_name"] == names[2]
    assert client.get(f"{API}/people?{q}&page_size=101").status_code == 422
    assert client.get(f"{API}/people?{q}&sort=bogus").status_code == 422
    assert client.get(f"{API}/people?{_q(today, today - timedelta(days=1))}").status_code == 400
    # Default range = this month to date.
    dflt = client.get(f"{API}/people").json()["period"]
    assert dflt["start"][8:] == "01" and dflt["start"][:7] == dflt["end"][:7]
    assert "data:" not in resp.text


def test_people_roles_and_scoping(
    client: TestClient,
    eng_manager: dict,
    employee_user: dict,
    seeded_attendance,
    absent_employee,
) -> None:
    today = seeded_attendance["today"]
    q = _q(today - timedelta(days=1), today)
    _login(client, eng_manager)
    body = client.get(f"{API}/people?{q}").json()
    assert {i["employee_code"] for i in body["items"]} == {"P13-ENG", "P13-ABS"}
    assert client.get(f"{API}/people?{q}&department_id=1").status_code == 200
    out = client.get(f"{API}/people?{q}&department_id=2")
    assert out.status_code == 404 and out.json()["detail"] == "department not found"
    # Search can't reach out of scope either.
    assert client.get(f"{API}/people?{q}&q=fatima").json()["total"] == 0
    client.post("/api/auth/logout")
    _login(client, employee_user)
    assert client.get(f"{API}/people?{q}").status_code == 403


def test_people_cross_tenant(
    client: TestClient, admin_user: dict, seeded_attendance, admin_engine
) -> None:
    """Another tenant's department id → 404; its employees never appear."""

    _login(client, admin_user)
    with admin_engine.begin() as conn:
        other = conn.execute(
            text("SELECT id, schema_name FROM public.tenants WHERE id <> 1 ORDER BY id LIMIT 1")
        ).first()
    if other is None:
        pytest.skip("no second tenant provisioned on this database")
    tid, schema = int(other.id), str(other.schema_name)
    with tenant_context(schema), admin_engine.begin() as conn:
        dept = conn.execute(
            select(departments.c.id)
            .where(departments.c.tenant_id == tid)
            .order_by(departments.c.id.desc())
            .limit(1)
        ).scalar()
        if dept is None:
            pytest.skip("second tenant has no departments")
        foreign_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=tid,
                    employee_code=f"XT-{secrets.token_hex(3)}",
                    full_name="Cross Tenant Person",
                    department_id=int(dept),
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
    try:
        with admin_engine.begin() as conn:
            local_depts = set(
                conn.execute(select(departments.c.id).where(departments.c.tenant_id == 1)).scalars()
            )
        if int(dept) not in local_depts:
            assert client.get(f"{API}/people?department_id={int(dept)}").status_code == 404
        resp = client.get(f"{API}/people?q=Cross%20Tenant")
        assert resp.status_code == 200
        assert resp.json()["total"] == 0
        assert "Cross Tenant Person" not in client.get(f"{API}/people?page_size=100").text
    finally:
        with tenant_context(schema), admin_engine.begin() as conn:
            conn.execute(
                delete(employees).where(employees.c.id == foreign_id, employees.c.tenant_id == tid)
            )


def test_overview_department_rows_v2(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    yday = today - timedelta(days=1)
    # Range: dept attendance_pct == the PDF's pct; ENG in-times 07:28 + 07:31.
    rng = {
        d["department_id"]: d
        for d in client.get(f"{API}/overview?{_q(yday, today)}").json()["departments"]
    }
    for d in rng.values():
        assert d["attendance_pct"] == d["pct"]
        assert d["prev_attendance_pct"] is None  # no rows in the previous 2 days
    assert rng[1]["avg_in"] == "07:30" and rng[1]["punctuality_pct"] == 100
    assert rng[2]["punctuality_pct"] == 0  # OPS late
    # Single day: prev = yesterday; ENG had a row, OPS didn't.
    one = {
        d["department_id"]: d
        for d in client.get(f"{API}/overview?{_q(today, today)}").json()["departments"]
    }
    prev_eng = client.get(f"{API}/departments/1?{_q(yday, yday)}").json()["kpis"]
    assert one[1]["prev_attendance_pct"] == prev_eng["attendance_pct"]
    assert one[2]["prev_attendance_pct"] is None
    # Scoped to the department == the department page headline.
    dept = client.get(f"{API}/departments/1?{_q(today, today)}").json()["kpis"]
    for key in ("attendance_pct", "punctuality_pct", "avg_in"):
        assert one[1][key] == dept[key], key


def test_employee_profile_department_id(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    body = client.get(f"{API}/employees/{seeded_attendance['ops_id']}").json()
    assert body["profile"]["department_id"] == 2
