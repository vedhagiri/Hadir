"""End-to-end coverage for the leave_calendar API (v1.0 P11).

Verifies CRUD round-trips for leave_types / holidays / approved_leaves,
the tenant_settings PATCH (including weekend_days + timezone validators),
the holiday Excel import, and a "leave clears absent" check that
exercises the engine through the resolver helpers.
"""

from __future__ import annotations

import secrets
from datetime import date as date_type, datetime, timedelta, timezone
from io import BytesIO
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from hadir.attendance.engine import compute, policy_from_row
from hadir.attendance.repository import (
    holidays_on,
    leaves_for_employee_on,
    load_tenant_settings,
)
from hadir.db import (
    approved_leaves,
    audit_log,
    employees,
    holidays as holidays_table,
    leave_types,
    shift_policies,
    tenant_settings,
)
from hadir.tenants.scope import TenantScope
from tests.conftest import TENANT_ID, department_id_by_code


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def smoke_employee(admin_engine: Engine) -> Iterator[int]:
    eng_id = department_id_by_code(admin_engine, "ENG")
    suffix = secrets.token_hex(2).upper()
    with admin_engine.begin() as conn:
        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P11E{suffix}",
                    full_name="P11 Worker",
                    email=f"p11-{suffix.lower()}@test.hadir",
                    department_id=eng_id,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
    try:
        yield emp_id
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(approved_leaves).where(
                    approved_leaves.c.employee_id == emp_id
                )
            )
            conn.execute(delete(employees).where(employees.c.id == emp_id))


@pytest.fixture
def reset_tenant_settings(admin_engine: Engine) -> Iterator[None]:
    """Restore tenant_id=1's tenant_settings around each test."""

    yield
    with admin_engine.begin() as conn:
        conn.execute(
            tenant_settings.update()
            .where(tenant_settings.c.tenant_id == TENANT_ID)
            .values(
                weekend_days=["Friday", "Saturday"],
                timezone="Asia/Muscat",
            )
        )


# ---------------------------------------------------------------------------
# Leave types
# ---------------------------------------------------------------------------


def _login(client: TestClient, *, email: str, password: str) -> None:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text


def test_leave_types_seeded_for_pilot_tenant(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    resp = client.get("/api/leave-types")
    assert resp.status_code == 200, resp.text
    codes = {r["code"] for r in resp.json()}
    assert {"Annual", "Sick", "Emergency", "Unpaid"}.issubset(codes)


def test_create_custom_leave_type_audits(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    suffix = secrets.token_hex(2).upper()
    code = f"P11LT{suffix}"
    try:
        resp = client.post(
            "/api/leave-types",
            json={"code": code, "name": "P11 custom", "is_paid": False},
        )
        assert resp.status_code == 201, resp.text
        new_id = resp.json()["id"]
        with admin_engine.begin() as conn:
            audits = conn.execute(
                select(audit_log.c.action).where(
                    audit_log.c.action == "leave_type.created",
                    audit_log.c.entity_id == str(new_id),
                )
            ).all()
        assert audits
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(leave_types).where(leave_types.c.code == code)
            )


def test_employee_role_cannot_manage_leave_types(
    client: TestClient, employee_user: dict
) -> None:
    _login(
        client, email=employee_user["email"], password=employee_user["password"]
    )
    assert client.get("/api/leave-types").status_code == 403
    assert (
        client.post(
            "/api/leave-types",
            json={"code": "X", "name": "X", "is_paid": True},
        ).status_code
        == 403
    )


# ---------------------------------------------------------------------------
# Holidays
# ---------------------------------------------------------------------------


def test_holiday_create_list_delete_round_trip(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    h_date = date_type(2026, 11, 18)
    try:
        create = client.post(
            "/api/holidays",
            json={"date": h_date.isoformat(), "name": "P11 Test National Day"},
        )
        assert create.status_code == 201, create.text
        new_id = create.json()["id"]

        listed = client.get("/api/holidays", params={"year": 2026})
        assert listed.status_code == 200
        assert any(h["id"] == new_id for h in listed.json())

        deleted = client.delete(f"/api/holidays/{new_id}")
        assert deleted.status_code == 204
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(holidays_table).where(holidays_table.c.date == h_date)
            )


def test_holiday_xlsx_import_idempotent(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])

    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "holidays"
    ws.append(["date", "name"])
    ws.append(["2026-11-18", "P11 import: National Day"])
    ws.append(["2026-12-31", "P11 import: NYE"])
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)

    try:
        first = client.post(
            "/api/holidays/import",
            files={
                "file": (
                    "holidays.xlsx",
                    buf.getvalue(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert first.status_code == 200, first.text
        body1 = first.json()
        assert len(body1) == 2

        # Re-import the same file → no new rows (idempotent).
        buf.seek(0)
        second = client.post(
            "/api/holidays/import",
            files={
                "file": (
                    "holidays.xlsx",
                    buf.getvalue(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert second.status_code == 200
        assert second.json() == []
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(holidays_table).where(
                    holidays_table.c.date.in_(
                        [date_type(2026, 11, 18), date_type(2026, 12, 31)]
                    )
                )
            )


# ---------------------------------------------------------------------------
# Approved leaves
# ---------------------------------------------------------------------------


def test_create_approved_leave_round_trip(
    client: TestClient,
    admin_user: dict,
    smoke_employee: int,
    admin_engine: Engine,
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    # Get the Annual leave_type id.
    with admin_engine.begin() as conn:
        annual_id = int(
            conn.execute(
                select(leave_types.c.id).where(
                    leave_types.c.tenant_id == TENANT_ID,
                    leave_types.c.code == "Annual",
                )
            ).scalar_one()
        )

    create = client.post(
        "/api/approved-leaves",
        json={
            "employee_id": smoke_employee,
            "leave_type_id": annual_id,
            "start_date": "2026-05-04",
            "end_date": "2026-05-08",
            "notes": "Spring trip",
        },
    )
    assert create.status_code == 201, create.text
    body = create.json()
    assert body["leave_type_code"] == "Annual"
    assert body["start_date"] == "2026-05-04"
    assert body["end_date"] == "2026-05-08"

    listed = client.get("/api/approved-leaves").json()
    assert any(r["id"] == body["id"] for r in listed)


def test_approved_leave_inverted_range_rejected(
    client: TestClient, admin_user: dict, smoke_employee: int, admin_engine: Engine
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    with admin_engine.begin() as conn:
        annual_id = int(
            conn.execute(
                select(leave_types.c.id).where(
                    leave_types.c.tenant_id == TENANT_ID,
                    leave_types.c.code == "Annual",
                )
            ).scalar_one()
        )
    bad = client.post(
        "/api/approved-leaves",
        json={
            "employee_id": smoke_employee,
            "leave_type_id": annual_id,
            "start_date": "2026-05-08",
            "end_date": "2026-05-04",
        },
    )
    assert bad.status_code == 422


# ---------------------------------------------------------------------------
# Tenant settings
# ---------------------------------------------------------------------------


def test_tenant_settings_get_returns_defaults(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    resp = client.get("/api/tenant-settings")
    assert resp.status_code == 200
    body = resp.json()
    assert sorted(body["weekend_days"]) == ["Friday", "Saturday"]
    assert body["timezone"] == "Asia/Muscat"


def test_tenant_settings_patch_round_trip(
    client: TestClient,
    admin_user: dict,
    reset_tenant_settings: None,
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    resp = client.patch(
        "/api/tenant-settings",
        json={
            "weekend_days": ["Saturday", "Sunday"],
            "timezone": "Europe/London",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["weekend_days"] == ["Saturday", "Sunday"]
    assert body["timezone"] == "Europe/London"


def test_tenant_settings_patch_rejects_unknown_timezone(
    client: TestClient, admin_user: dict, reset_tenant_settings: None
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    bad = client.patch(
        "/api/tenant-settings", json={"timezone": "Mars/Olympus_Mons"}
    )
    assert bad.status_code == 422


def test_tenant_settings_patch_rejects_unknown_weekday(
    client: TestClient, admin_user: dict, reset_tenant_settings: None
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    bad = client.patch(
        "/api/tenant-settings", json={"weekend_days": ["Funday"]}
    )
    assert bad.status_code == 422


# ---------------------------------------------------------------------------
# End-to-end: API → repository → engine
# ---------------------------------------------------------------------------


def test_end_to_end_leave_clears_absent_via_engine(
    client: TestClient,
    admin_user: dict,
    smoke_employee: int,
    admin_engine: Engine,
) -> None:
    """Create an approved leave through the API, then drive the
    engine via the repository helpers to prove the wiring."""

    _login(client, email=admin_user["email"], password=admin_user["password"])
    with admin_engine.begin() as conn:
        annual_id = int(
            conn.execute(
                select(leave_types.c.id).where(
                    leave_types.c.tenant_id == TENANT_ID,
                    leave_types.c.code == "Annual",
                )
            ).scalar_one()
        )

    leave_day = date_type(2026, 5, 4)  # a Monday
    resp = client.post(
        "/api/approved-leaves",
        json={
            "employee_id": smoke_employee,
            "leave_type_id": annual_id,
            "start_date": leave_day.isoformat(),
            "end_date": leave_day.isoformat(),
            "notes": "P11 e2e",
        },
    )
    assert resp.status_code == 201

    # Now drive the engine path through the repository helpers.
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        settings = load_tenant_settings(conn, scope)
        leaves = leaves_for_employee_on(
            conn, scope, employee_id=smoke_employee, the_date=leave_day
        )
        holidays_today = holidays_on(conn, scope, the_date=leave_day)
        # Pull *any* policy in tenant 1 to feed the engine.
        policy_row = conn.execute(
            select(
                shift_policies.c.id,
                shift_policies.c.name,
                shift_policies.c.type,
                shift_policies.c.config,
            )
            .where(shift_policies.c.tenant_id == TENANT_ID)
            .limit(1)
        ).first()
    assert policy_row is not None
    policy = policy_from_row(policy_row)

    record = compute(
        employee_id=smoke_employee,
        the_date=leave_day,
        policy=policy,
        events=[],
        leaves=leaves,
        holidays=holidays_today,
        weekend_days=settings.weekend_days,
    )
    assert record.absent is False
    assert record.leave_type_name == "Annual leave"
    assert record.leave_type_id == annual_id
