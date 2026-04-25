"""Pytest coverage for the policy resolution cascade + API (v1.0 P9).

Verifies:

* The cascade ``employee > department > tenant > legacy fallback`` —
  inserts assignments at each tier and asserts the right policy
  comes back per employee.
* Empty employee list returns an empty dict cleanly.
* Legacy fallback fires when ``policy_assignments`` is empty (the
  pilot path).
* The Policies / Assignments API round-trips a Flex policy + a
  department-scoped assignment + audits both.
"""

from __future__ import annotations

import secrets
from datetime import date as date_type, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from hadir.attendance.repository import resolve_policies_for_employees
from hadir.db import (
    audit_log,
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
def two_employees(admin_engine: Engine) -> Iterator[dict]:
    """One Eng employee + one Ops employee, plus a clean assignments table."""

    eng_id = department_id_by_code(admin_engine, "ENG")
    ops_id = department_id_by_code(admin_engine, "OPS")
    suffix = secrets.token_hex(2).upper()
    with admin_engine.begin() as conn:
        # Wipe any prior P9 assignments so the tests start clean.
        conn.execute(delete(policy_assignments))
        eng_emp = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P9E{suffix}",
                    full_name="P9 Eng",
                    email=f"p9e-{suffix.lower()}@test.hadir",
                    department_id=eng_id,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        ops_emp = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P9O{suffix}",
                    full_name="P9 Ops",
                    email=f"p9o-{suffix.lower()}@test.hadir",
                    department_id=ops_id,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
    try:
        yield {
            "eng_employee_id": eng_emp,
            "ops_employee_id": ops_emp,
            "eng_dept_id": eng_id,
            "ops_dept_id": ops_id,
        }
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(policy_assignments))
            conn.execute(
                delete(employees).where(
                    employees.c.id.in_([eng_emp, ops_emp])
                )
            )


@pytest.fixture
def two_policies(admin_engine: Engine) -> Iterator[dict]:
    """One Fixed + one Flex policy live in tenant 1 for the whole test."""

    today = date_type.today()
    fixed_config = {
        "start": "07:30",
        "end": "15:30",
        "grace_minutes": 15,
        "required_hours": 8,
    }
    flex_config = {
        "in_window_start": "07:30",
        "in_window_end": "08:30",
        "out_window_start": "15:30",
        "out_window_end": "16:30",
        "required_hours": 8,
    }
    with admin_engine.begin() as conn:
        fixed_id = int(
            conn.execute(
                insert(shift_policies)
                .values(
                    tenant_id=TENANT_ID,
                    name="P9 Fixed Resolved",
                    type="Fixed",
                    config=fixed_config,
                    active_from=today,
                    active_until=None,
                )
                .returning(shift_policies.c.id)
            ).scalar_one()
        )
        flex_id = int(
            conn.execute(
                insert(shift_policies)
                .values(
                    tenant_id=TENANT_ID,
                    name="P9 Flex Resolved",
                    type="Flex",
                    config=flex_config,
                    active_from=today,
                    active_until=None,
                )
                .returning(shift_policies.c.id)
            ).scalar_one()
        )
    try:
        yield {"fixed_id": fixed_id, "flex_id": flex_id}
    finally:
        from hadir.db import attendance_records  # noqa: PLC0415

        with admin_engine.begin() as conn:
            # Drop assignments first, then any attendance_records
            # rows that pin to either policy (RESTRICT FK), then the
            # shift_policies rows themselves. Test-only cleanup —
            # production lifecycle uses soft-delete via
            # ``shift_policies.active_until``.
            conn.execute(
                delete(policy_assignments).where(
                    policy_assignments.c.policy_id.in_([fixed_id, flex_id])
                )
            )
            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.policy_id.in_([fixed_id, flex_id])
                )
            )
            conn.execute(
                delete(shift_policies).where(
                    shift_policies.c.id.in_([fixed_id, flex_id])
                )
            )


# ---------------------------------------------------------------------------
# Resolver cascade
# ---------------------------------------------------------------------------


def test_empty_employee_list_returns_empty_dict(admin_engine: Engine) -> None:
    scope = TenantScope(tenant_id=TENANT_ID)
    today = date_type.today()
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn, scope, the_date=today, employee_ids=[]
        )
    assert out == {}


def test_resolver_falls_back_to_legacy_when_no_assignments(
    admin_engine: Engine, two_employees: dict
) -> None:
    """No policy_assignments rows → uses any active shift_policies row.

    The pilot's seeded "Default 07:30–15:30" Fixed policy fits this
    case directly.
    """

    scope = TenantScope(tenant_id=TENANT_ID)
    today = date_type.today()
    with admin_engine.begin() as conn:
        out = resolve_policies_for_employees(
            conn,
            scope,
            the_date=today,
            employee_ids=[
                two_employees["eng_employee_id"],
                two_employees["ops_employee_id"],
            ],
        )
    # Both employees resolve to *some* policy, and they're the same
    # one (legacy fallback is tenant-wide).
    assert set(out.keys()) == {
        two_employees["eng_employee_id"],
        two_employees["ops_employee_id"],
    }
    eng_pol = out[two_employees["eng_employee_id"]]
    ops_pol = out[two_employees["ops_employee_id"]]
    assert eng_pol.id == ops_pol.id


def test_resolver_employee_beats_department_beats_tenant(
    admin_engine: Engine, two_employees: dict, two_policies: dict
) -> None:
    """Insert an assignment at every tier and verify each employee
    picks the highest-priority match.

    Setup:
      * Tenant assignment → Fixed policy
      * Department=Eng assignment → Flex policy
      * Employee=ops_employee assignment → Fixed policy

    Expected:
      * eng_employee → Flex (department wins over tenant)
      * ops_employee → Fixed (employee wins over tenant; there's no
        Ops-dept assignment, so the path is ``employee > tenant``).
    """

    today = date_type.today()
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        conn.execute(
            insert(policy_assignments).values(
                tenant_id=TENANT_ID,
                policy_id=two_policies["fixed_id"],
                scope_type="tenant",
                scope_id=None,
                active_from=today,
                active_until=None,
            )
        )
        conn.execute(
            insert(policy_assignments).values(
                tenant_id=TENANT_ID,
                policy_id=two_policies["flex_id"],
                scope_type="department",
                scope_id=two_employees["eng_dept_id"],
                active_from=today,
                active_until=None,
            )
        )
        conn.execute(
            insert(policy_assignments).values(
                tenant_id=TENANT_ID,
                policy_id=two_policies["fixed_id"],
                scope_type="employee",
                scope_id=two_employees["ops_employee_id"],
                active_from=today,
                active_until=None,
            )
        )
        out = resolve_policies_for_employees(
            conn,
            scope,
            the_date=today,
            employee_ids=[
                two_employees["eng_employee_id"],
                two_employees["ops_employee_id"],
            ],
        )
    assert out[two_employees["eng_employee_id"]].id == two_policies["flex_id"]
    assert out[two_employees["ops_employee_id"]].id == two_policies["fixed_id"]


def test_resolver_skips_dept_assignment_when_employee_assignment_exists(
    admin_engine: Engine, two_employees: dict, two_policies: dict
) -> None:
    """Employee-scope wins even when a department-scope row also exists."""

    today = date_type.today()
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        # Department gets Flex.
        conn.execute(
            insert(policy_assignments).values(
                tenant_id=TENANT_ID,
                policy_id=two_policies["flex_id"],
                scope_type="department",
                scope_id=two_employees["eng_dept_id"],
                active_from=today,
                active_until=None,
            )
        )
        # Eng employee gets Fixed at the personal level.
        conn.execute(
            insert(policy_assignments).values(
                tenant_id=TENANT_ID,
                policy_id=two_policies["fixed_id"],
                scope_type="employee",
                scope_id=two_employees["eng_employee_id"],
                active_from=today,
                active_until=None,
            )
        )
        out = resolve_policies_for_employees(
            conn,
            scope,
            the_date=today,
            employee_ids=[two_employees["eng_employee_id"]],
        )
    assert out[two_employees["eng_employee_id"]].id == two_policies["fixed_id"]


def test_assignment_outside_date_window_is_ignored(
    admin_engine: Engine, two_employees: dict, two_policies: dict
) -> None:
    """An expired assignment (active_until < today) is ignored."""

    today = date_type.today()
    scope = TenantScope(tenant_id=TENANT_ID)
    with admin_engine.begin() as conn:
        # Expired Eng-dept → Flex
        conn.execute(
            insert(policy_assignments).values(
                tenant_id=TENANT_ID,
                policy_id=two_policies["flex_id"],
                scope_type="department",
                scope_id=two_employees["eng_dept_id"],
                active_from=today - timedelta(days=10),
                active_until=today - timedelta(days=1),
            )
        )
        out = resolve_policies_for_employees(
            conn,
            scope,
            the_date=today,
            employee_ids=[two_employees["eng_employee_id"]],
        )
    # No active dept assignment → resolver falls through to legacy.
    pol = out.get(two_employees["eng_employee_id"])
    assert pol is not None
    assert pol.id != two_policies["flex_id"]  # not the expired one


# ---------------------------------------------------------------------------
# Policies + assignments API
# ---------------------------------------------------------------------------


def test_create_flex_policy_and_assign_to_department(
    client: TestClient,
    admin_user: dict,
    two_employees: dict,
    admin_engine: Engine,
) -> None:
    login = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert login.status_code == 200, login.text

    today = date_type.today().isoformat()
    policy_id: int | None = None
    try:
        # 1. Create a Flex policy.
        create = client.post(
            "/api/policies",
            json={
                "name": "P9 Flex API Test",
                "type": "Flex",
                "config": {
                    "in_window_start": "07:30",
                    "in_window_end": "08:30",
                    "out_window_start": "15:30",
                    "out_window_end": "16:30",
                    "required_hours": 8,
                },
                "active_from": today,
            },
        )
        assert create.status_code == 201, create.text
        policy_id = create.json()["id"]

        # 2. Assign to the Eng department.
        asg = client.post(
            "/api/policy-assignments",
            json={
                "policy_id": policy_id,
                "scope_type": "department",
                "scope_id": two_employees["eng_dept_id"],
                "active_from": today,
            },
        )
        assert asg.status_code == 201, asg.text

        # 3. Audit rows.
        with admin_engine.begin() as conn:
            rows = conn.execute(
                select(audit_log.c.action).where(
                    audit_log.c.actor_user_id == admin_user["id"],
                    audit_log.c.action.in_(
                        ["shift_policy.created", "policy_assignment.created"]
                    ),
                )
                .order_by(audit_log.c.id.desc())
                .limit(2)
            ).all()
        actions = {r.action for r in rows}
        assert actions == {"shift_policy.created", "policy_assignment.created"}
    finally:
        # Cleanup so the API-created policy doesn't leak into other
        # tests that assume a single policy in tenant_id=1.
        if policy_id is not None:
            from hadir.db import attendance_records  # noqa: PLC0415

            with admin_engine.begin() as conn:
                conn.execute(
                    delete(policy_assignments).where(
                        policy_assignments.c.policy_id == policy_id
                    )
                )
                conn.execute(
                    delete(attendance_records).where(
                        attendance_records.c.policy_id == policy_id
                    )
                )
                conn.execute(
                    delete(shift_policies).where(
                        shift_policies.c.id == policy_id
                    )
                )


def test_employee_role_cannot_manage_policies(
    client: TestClient, employee_user: dict
) -> None:
    login = client.post(
        "/api/auth/login",
        json={"email": employee_user["email"], "password": employee_user["password"]},
    )
    assert login.status_code == 200
    assert client.get("/api/policies").status_code == 403
    assert (
        client.post(
            "/api/policies",
            json={
                "name": "x",
                "type": "Fixed",
                "config": {
                    "start": "08:00",
                    "end": "16:00",
                    "required_hours": 8,
                },
                "active_from": date_type.today().isoformat(),
            },
        ).status_code
        == 403
    )


def test_create_fixed_policy_rejects_missing_times(
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
            "name": "missing-fields",
            "type": "Fixed",
            "config": {"required_hours": 8},
            "active_from": date_type.today().isoformat(),
        },
    )
    assert bad.status_code == 422, bad.text


def test_create_flex_policy_rejects_missing_window(
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
            "name": "missing-windows",
            "type": "Flex",
            "config": {
                "in_window_start": "07:30",
                # in_window_end missing
                "out_window_start": "15:30",
                "out_window_end": "16:30",
                "required_hours": 8,
            },
            "active_from": date_type.today().isoformat(),
        },
    )
    assert bad.status_code == 422, bad.text
