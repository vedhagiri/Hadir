"""Pytest coverage for the P10 resolver tiers (Custom + Ramadan).

Verifies the load-bearing priority order:
``Custom > Ramadan > employee > department > tenant > legacy``.
Plus boundary cases on the date range — first day, last day, day
before, day after — and the API-level shape validators.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert
from sqlalchemy.engine import Engine

from hadir.attendance.repository import resolve_policies_for_employees
from hadir.db import (
    attendance_records,
    departments,
    employees,
    policy_assignments,
    shift_policies,
)
from hadir.tenants.scope import TenantScope
from tests.conftest import TENANT_ID, department_id_by_code


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def one_employee(admin_engine: Engine) -> Iterator[int]:
    """One employee + a wide-range Fixed policy that always wins the
    legacy fallback when the higher tiers don't apply.

    The pilot's seeded "Default 07:30–15:30" policy has its
    ``active_from`` at the migration date (post-April 2026) and so
    doesn't cover the early-2026 Ramadan dates these tests work
    with. The fixture's ``P10 Fallback`` policy spans well outside
    every range used below so the resolver's legacy fallback has
    something to land on when Ramadan / Custom don't fire.
    """

    eng_id = department_id_by_code(admin_engine, "ENG")
    suffix = secrets.token_hex(2).upper()
    with admin_engine.begin() as conn:
        # Wipe any prior P10 policies so the resolver tier checks
        # don't see stale rows.
        conn.execute(delete(policy_assignments))
        conn.execute(
            delete(shift_policies).where(
                shift_policies.c.name.like("P10 %")
            )
        )
        # Wide-range fallback Fixed policy.
        conn.execute(
            insert(shift_policies).values(
                tenant_id=TENANT_ID,
                name="P10 Fallback",
                type="Fixed",
                config={
                    "start": "07:30",
                    "end": "15:30",
                    "grace_minutes": 15,
                    "required_hours": 8,
                },
                active_from=date(2025, 1, 1),
                active_until=date(2030, 12, 31),
            )
        )
        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P10E{suffix}",
                    full_name="P10 Worker",
                    email=f"p10-{suffix.lower()}@test.hadir",
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
            conn.execute(delete(policy_assignments))
            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(employees).where(employees.c.id == emp_id)
            )
            conn.execute(
                delete(shift_policies).where(
                    shift_policies.c.name.like("P10 %")
                )
            )


def _insert_policy(
    admin_engine: Engine,
    *,
    name: str,
    policy_type: str,
    config: dict,
    active_from: date,
    active_until: date | None = None,
) -> int:
    with admin_engine.begin() as conn:
        return int(
            conn.execute(
                insert(shift_policies)
                .values(
                    tenant_id=TENANT_ID,
                    name=name,
                    type=policy_type,
                    config=config,
                    active_from=active_from,
                    active_until=active_until,
                )
                .returning(shift_policies.c.id)
            ).scalar_one()
        )


# ---------------------------------------------------------------------------
# Date-range boundaries on Ramadan
# ---------------------------------------------------------------------------


def test_ramadan_inside_range_resolves(
    admin_engine: Engine, one_employee: int
) -> None:
    range_start = date(2026, 2, 18)
    range_end = date(2026, 3, 19)
    pid = _insert_policy(
        admin_engine,
        name="P10 Ramadan",
        policy_type="Ramadan",
        config={
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "start": "08:00",
            "end": "14:00",
            "grace_minutes": 15,
            "required_hours": 6,
        },
        active_from=range_start,
        active_until=range_end,
    )
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn, scope, the_date=date(2026, 3, 1), employee_ids=[one_employee]
        )
    assert out[one_employee].id == pid
    assert out[one_employee].type == "Ramadan"


def test_ramadan_first_day_in_range(
    admin_engine: Engine, one_employee: int
) -> None:
    range_start = date(2026, 2, 18)
    range_end = date(2026, 3, 19)
    pid = _insert_policy(
        admin_engine,
        name="P10 Ramadan",
        policy_type="Ramadan",
        config={
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "start": "08:00",
            "end": "14:00",
            "required_hours": 6,
        },
        active_from=range_start,
        active_until=range_end,
    )
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn, scope, the_date=range_start, employee_ids=[one_employee]
        )
    assert out[one_employee].id == pid


def test_ramadan_last_day_in_range(
    admin_engine: Engine, one_employee: int
) -> None:
    range_start = date(2026, 2, 18)
    range_end = date(2026, 3, 19)
    pid = _insert_policy(
        admin_engine,
        name="P10 Ramadan",
        policy_type="Ramadan",
        config={
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "start": "08:00",
            "end": "14:00",
            "required_hours": 6,
        },
        active_from=range_start,
        active_until=range_end,
    )
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn, scope, the_date=range_end, employee_ids=[one_employee]
        )
    assert out[one_employee].id == pid


def test_ramadan_day_before_range_falls_through(
    admin_engine: Engine, one_employee: int
) -> None:
    range_start = date(2026, 2, 18)
    range_end = date(2026, 3, 19)
    _insert_policy(
        admin_engine,
        name="P10 Ramadan",
        policy_type="Ramadan",
        config={
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "start": "08:00",
            "end": "14:00",
            "required_hours": 6,
        },
        active_from=range_start,
        active_until=range_end,
    )
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn,
            scope,
            the_date=range_start - timedelta(days=1),
            employee_ids=[one_employee],
        )
    # Day before the range — Ramadan tier must NOT apply. Resolver
    # falls through; legacy fallback (the seeded "Default 07:30–
    # 15:30" Fixed policy) returns instead.
    pol = out[one_employee]
    assert pol.type == "Fixed"


def test_ramadan_day_after_range_falls_through(
    admin_engine: Engine, one_employee: int
) -> None:
    range_start = date(2026, 2, 18)
    range_end = date(2026, 3, 19)
    _insert_policy(
        admin_engine,
        name="P10 Ramadan",
        policy_type="Ramadan",
        config={
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "start": "08:00",
            "end": "14:00",
            "required_hours": 6,
        },
        active_from=range_start,
        active_until=range_end,
    )
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn,
            scope,
            the_date=range_end + timedelta(days=1),
            employee_ids=[one_employee],
        )
    assert out[one_employee].type == "Fixed"


# ---------------------------------------------------------------------------
# Custom > Ramadan precedence
# ---------------------------------------------------------------------------


def test_custom_overrides_ramadan_when_both_cover_date(
    admin_engine: Engine, one_employee: int
) -> None:
    """A Custom policy on a date inside the Ramadan range wins."""

    overlap = date(2026, 3, 5)
    _insert_policy(
        admin_engine,
        name="P10 Ramadan",
        policy_type="Ramadan",
        config={
            "start_date": "2026-02-18",
            "end_date": "2026-03-19",
            "start": "08:00",
            "end": "14:00",
            "required_hours": 6,
        },
        active_from=date(2026, 2, 18),
        active_until=date(2026, 3, 19),
    )
    custom_id = _insert_policy(
        admin_engine,
        name="P10 Custom Pre-Eid",
        policy_type="Custom",
        config={
            "start_date": overlap.isoformat(),
            "end_date": overlap.isoformat(),
            "inner_type": "Fixed",
            "start": "08:00",
            "end": "12:00",
            "required_hours": 4,
        },
        active_from=overlap,
        active_until=overlap,
    )

    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn, scope, the_date=overlap, employee_ids=[one_employee]
        )
    assert out[one_employee].id == custom_id
    assert out[one_employee].type == "Custom"


def test_custom_only_applies_inside_its_own_range(
    admin_engine: Engine, one_employee: int
) -> None:
    custom_day = date(2026, 12, 31)
    _insert_policy(
        admin_engine,
        name="P10 Custom NYE",
        policy_type="Custom",
        config={
            "start_date": custom_day.isoformat(),
            "end_date": custom_day.isoformat(),
            "inner_type": "Fixed",
            "start": "08:00",
            "end": "12:00",
            "required_hours": 4,
        },
        active_from=custom_day,
        active_until=custom_day,
    )
    scope = TenantScope(tenant_id=TENANT_ID)
    # The day before — Custom tier doesn't fire.
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn,
            scope,
            the_date=custom_day - timedelta(days=1),
            employee_ids=[one_employee],
        )
    assert out[one_employee].type != "Custom"


# ---------------------------------------------------------------------------
# Tenant-wide application — Custom/Ramadan apply to every employee
# ---------------------------------------------------------------------------


def test_ramadan_applies_to_every_employee_in_tenant(
    admin_engine: Engine, one_employee: int
) -> None:
    """Ramadan's tier-0 application is tenant-wide — even if there's
    an employee-scope assignment to a different policy."""

    range_start = date(2026, 2, 18)
    range_end = date(2026, 3, 19)
    pid_ramadan = _insert_policy(
        admin_engine,
        name="P10 Ramadan",
        policy_type="Ramadan",
        config={
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "start": "08:00",
            "end": "14:00",
            "required_hours": 6,
        },
        active_from=range_start,
        active_until=range_end,
    )
    pid_custom_fixed = _insert_policy(
        admin_engine,
        name="P10 Lower Fixed",
        policy_type="Fixed",
        config={
            "start": "07:00",
            "end": "15:00",
            "grace_minutes": 0,
            "required_hours": 8,
        },
        active_from=range_start,
        active_until=None,
    )
    # Make the lower-tier assignment employee-specific — Ramadan
    # still beats it on dates in range.
    with admin_engine.begin() as conn:
        conn.execute(
            insert(policy_assignments).values(
                tenant_id=TENANT_ID,
                policy_id=pid_custom_fixed,
                scope_type="employee",
                scope_id=one_employee,
                active_from=range_start,
                active_until=None,
            )
        )

    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn,
            scope,
            the_date=date(2026, 3, 1),
            employee_ids=[one_employee],
        )
    assert out[one_employee].id == pid_ramadan


# ---------------------------------------------------------------------------
# API: create + audit
# ---------------------------------------------------------------------------


def test_create_ramadan_policy_via_api(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    login = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert login.status_code == 200, login.text

    resp = client.post(
        "/api/policies",
        json={
            "name": "P10 Ramadan API",
            "type": "Ramadan",
            "config": {
                "start_date": "2026-02-18",
                "end_date": "2026-03-19",
                "start": "08:00",
                "end": "14:00",
                "grace_minutes": 15,
                "required_hours": 6,
            },
            "active_from": "2026-02-18",
            "active_until": "2026-03-19",
        },
    )
    try:
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["type"] == "Ramadan"
        assert body["config"]["start_date"] == "2026-02-18"
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(shift_policies).where(
                    shift_policies.c.name == "P10 Ramadan API"
                )
            )


def test_create_ramadan_rejects_missing_date_range(
    client: TestClient, admin_user: dict
) -> None:
    login = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert login.status_code == 200
    bad = client.post(
        "/api/policies",
        json={
            "name": "P10 Ramadan invalid",
            "type": "Ramadan",
            "config": {
                "start": "08:00",
                "end": "14:00",
                "required_hours": 6,
            },
            "active_from": "2026-02-18",
        },
    )
    assert bad.status_code == 422, bad.text


def test_create_custom_rejects_inverted_range(
    client: TestClient, admin_user: dict
) -> None:
    login = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert login.status_code == 200
    bad = client.post(
        "/api/policies",
        json={
            "name": "P10 Custom inverted",
            "type": "Custom",
            "config": {
                "start_date": "2026-12-31",
                "end_date": "2026-12-30",  # earlier than start_date
                "inner_type": "Fixed",
                "start": "08:00",
                "end": "12:00",
                "required_hours": 4,
            },
            "active_from": "2026-12-30",
        },
    )
    assert bad.status_code == 422, bad.text


def test_create_custom_flex_round_trip(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    login = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert login.status_code == 200, login.text

    resp = client.post(
        "/api/policies",
        json={
            "name": "P10 Custom Flex Day",
            "type": "Custom",
            "config": {
                "start_date": "2026-05-01",
                "end_date": "2026-05-01",
                "inner_type": "Flex",
                "in_window_start": "09:00",
                "in_window_end": "10:00",
                "out_window_start": "17:00",
                "out_window_end": "18:00",
                "required_hours": 8,
            },
            "active_from": "2026-05-01",
            "active_until": "2026-05-01",
        },
    )
    try:
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["config"]["inner_type"] == "Flex"
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(shift_policies).where(
                    shift_policies.c.name == "P10 Custom Flex Day"
                )
            )
