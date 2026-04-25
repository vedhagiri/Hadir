"""Pytest coverage for manager assignments (v1.0 P8).

Verifies:

* GET returns the grouped (managers, unassigned) shape.
* POST creates an assignment + audits it.
* POST with ``is_primary=true`` clears any prior primary on the
  same employee before inserting (so the partial unique index
  isn't violated).
* The partial unique index itself rejects a buggy direct INSERT
  that tries to make two primaries for the same employee.
* DELETE drops the row + audits it.
* The Manager scope helper unions department membership with
  direct assignments — a Manager assigned to an Ops employee
  outside their Engineering department now sees that employee on
  ``/api/attendance``.
* Non-Admins cannot read or mutate via the API (403).
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from hadir.auth.passwords import hash_password
from hadir.db import (
    attendance_records,
    audit_log,
    departments,
    employees,
    manager_assignments,
    roles,
    user_departments,
    user_roles,
    users,
)
from tests.conftest import TENANT_ID, department_id_by_code


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def manager_user(admin_engine: Engine) -> Iterator[dict]:
    """A Manager-role user assigned to the Engineering department."""

    eng_id = department_id_by_code(admin_engine, "ENG")
    email = f"mgr-{secrets.token_hex(4)}@test.hadir"
    password = "test-mgr-pw-" + secrets.token_hex(6)
    pwh = hash_password(password)
    with admin_engine.begin() as conn:
        user_id = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=TENANT_ID,
                    email=email,
                    password_hash=pwh,
                    full_name="Manager Test",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Manager"
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=user_id, role_id=role_id, tenant_id=TENANT_ID
            )
        )
        conn.execute(
            insert(user_departments).values(
                user_id=user_id, department_id=eng_id, tenant_id=TENANT_ID
            )
        )
    try:
        yield {"id": user_id, "email": email, "password": password, "dept": eng_id}
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(manager_assignments).where(
                    manager_assignments.c.manager_user_id == user_id
                )
            )
            conn.execute(
                delete(user_departments).where(user_departments.c.user_id == user_id)
            )
            conn.execute(
                delete(audit_log).where(audit_log.c.actor_user_id == user_id)
            )
            conn.execute(
                delete(user_roles).where(user_roles.c.user_id == user_id)
            )
            conn.execute(delete(users).where(users.c.id == user_id))


@pytest.fixture
def two_employees(admin_engine: Engine) -> Iterator[dict]:
    """One Engineering employee + one Operations employee."""

    eng_id = department_id_by_code(admin_engine, "ENG")
    ops_id = department_id_by_code(admin_engine, "OPS")
    suffix = secrets.token_hex(2).upper()
    with admin_engine.begin() as conn:
        # Wipe any leftover rows from prior runs (clean_employees
        # fixture isn't always used by this file).
        conn.execute(delete(manager_assignments))
        eng_emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"MGREE{suffix}",
                    full_name="Eng Worker",
                    email=f"eng-{suffix.lower()}@test.hadir",
                    department_id=eng_id,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        ops_emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"MGROO{suffix}",
                    full_name="Ops Worker",
                    email=f"ops-{suffix.lower()}@test.hadir",
                    department_id=ops_id,
                    status="active",
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
    try:
        yield {
            "eng_employee_id": eng_emp_id,
            "ops_employee_id": ops_emp_id,
            "eng_dept_id": eng_id,
            "ops_dept_id": ops_id,
        }
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(manager_assignments).where(
                    manager_assignments.c.employee_id.in_(
                        [eng_emp_id, ops_emp_id]
                    )
                )
            )
            conn.execute(
                delete(employees).where(
                    employees.c.id.in_([eng_emp_id, ops_emp_id])
                )
            )


def _login(client: TestClient, *, email: str, password: str) -> None:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# API tests
# ---------------------------------------------------------------------------


def test_list_returns_grouped_managers_and_unassigned(
    client: TestClient,
    admin_user: dict,
    manager_user: dict,
    two_employees: dict,
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    resp = client.get("/api/manager-assignments")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "managers" in body and "unassigned" in body
    # Our manager appears in the list.
    mgr_ids = [m["manager_user_id"] for m in body["managers"]]
    assert manager_user["id"] in mgr_ids
    # The seeded employees are unassigned.
    unassigned_ids = {e["employee_id"] for e in body["unassigned"]}
    assert two_employees["eng_employee_id"] in unassigned_ids
    assert two_employees["ops_employee_id"] in unassigned_ids


def test_create_assignment_writes_audit(
    client: TestClient,
    admin_user: dict,
    manager_user: dict,
    two_employees: dict,
    admin_engine: Engine,
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    resp = client.post(
        "/api/manager-assignments",
        json={
            "manager_user_id": manager_user["id"],
            "employee_id": two_employees["ops_employee_id"],
            "is_primary": False,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["is_primary"] is False
    assert body["manager_user_id"] == manager_user["id"]
    assert body["employee_id"] == two_employees["ops_employee_id"]

    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.after).where(
                audit_log.c.action == "manager_assignment.created",
                audit_log.c.actor_user_id == admin_user["id"],
            )
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).all()
    assert rows
    assert rows[0].after["employee_id"] == two_employees["ops_employee_id"]


def test_set_primary_clears_prior_primary(
    client: TestClient,
    admin_user: dict,
    manager_user: dict,
    two_employees: dict,
    admin_engine: Engine,
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    employee_id = two_employees["eng_employee_id"]

    # First primary.
    first = client.post(
        "/api/manager-assignments",
        json={
            "manager_user_id": manager_user["id"],
            "employee_id": employee_id,
            "is_primary": True,
        },
    )
    assert first.status_code == 201
    first_id = first.json()["id"]

    # Make a second manager + flip primary to them. The DB partial
    # unique index would refuse if we didn't demote the first.
    with admin_engine.begin() as conn:
        # A second Manager user.
        other_id = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=TENANT_ID,
                    email=f"mgr2-{secrets.token_hex(4)}@test.hadir",
                    password_hash=hash_password("x"),
                    full_name="Other Manager",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Manager"
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=other_id, role_id=role_id, tenant_id=TENANT_ID
            )
        )
    try:
        flip = client.post(
            "/api/manager-assignments",
            json={
                "manager_user_id": other_id,
                "employee_id": employee_id,
                "is_primary": True,
            },
        )
        assert flip.status_code == 201, flip.text

        # The original assignment is no longer primary.
        with admin_engine.begin() as conn:
            row = conn.execute(
                select(manager_assignments.c.is_primary).where(
                    manager_assignments.c.id == first_id
                )
            ).first()
        assert row is not None
        assert row.is_primary is False
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(manager_assignments).where(
                    manager_assignments.c.manager_user_id == other_id
                )
            )
            conn.execute(
                delete(user_roles).where(user_roles.c.user_id == other_id)
            )
            conn.execute(delete(users).where(users.c.id == other_id))


def test_partial_unique_index_rejects_two_primaries_at_db_level(
    admin_engine: Engine,
    manager_user: dict,
    two_employees: dict,
) -> None:
    """A direct INSERT that bypasses the API still hits the index."""

    employee_id = two_employees["eng_employee_id"]
    other_email = f"mgr3-{secrets.token_hex(4)}@test.hadir"
    with admin_engine.begin() as conn:
        # Insert primary #1 via the manager_user fixture's user.
        conn.execute(
            insert(manager_assignments).values(
                tenant_id=TENANT_ID,
                manager_user_id=manager_user["id"],
                employee_id=employee_id,
                is_primary=True,
                created_at=datetime.now(tz=timezone.utc),
                updated_at=datetime.now(tz=timezone.utc),
            )
        )
        # Make a second Manager user.
        other_id = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=TENANT_ID,
                    email=other_email,
                    password_hash=hash_password("x"),
                    full_name="Index Test Manager",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Manager"
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=other_id, role_id=role_id, tenant_id=TENANT_ID
            )
        )

    # Attempting a SECOND primary directly via the admin engine must
    # raise IntegrityError from the partial unique index.
    try:
        with pytest.raises(IntegrityError):
            with admin_engine.begin() as conn:
                conn.execute(
                    insert(manager_assignments).values(
                        tenant_id=TENANT_ID,
                        manager_user_id=other_id,
                        employee_id=employee_id,
                        is_primary=True,
                        created_at=datetime.now(tz=timezone.utc),
                        updated_at=datetime.now(tz=timezone.utc),
                    )
                )
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(manager_assignments).where(
                    manager_assignments.c.employee_id == employee_id
                )
            )
            conn.execute(
                delete(user_roles).where(user_roles.c.user_id == other_id)
            )
            conn.execute(delete(users).where(users.c.id == other_id))


def test_delete_assignment_writes_audit(
    client: TestClient,
    admin_user: dict,
    manager_user: dict,
    two_employees: dict,
    admin_engine: Engine,
) -> None:
    _login(client, email=admin_user["email"], password=admin_user["password"])
    create = client.post(
        "/api/manager-assignments",
        json={
            "manager_user_id": manager_user["id"],
            "employee_id": two_employees["ops_employee_id"],
            "is_primary": False,
        },
    )
    assert create.status_code == 201
    asg_id = create.json()["id"]

    out = client.delete(f"/api/manager-assignments/{asg_id}")
    assert out.status_code == 204

    # Row gone from DB.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(manager_assignments.c.id).where(
                manager_assignments.c.id == asg_id
            )
        ).first()
    assert row is None

    # Audit row written.
    with admin_engine.begin() as conn:
        audits = conn.execute(
            select(audit_log.c.action, audit_log.c.before).where(
                audit_log.c.action == "manager_assignment.deleted",
                audit_log.c.actor_user_id == admin_user["id"],
            )
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).all()
    assert audits


def test_employee_role_cannot_read_or_mutate(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, email=employee_user["email"], password=employee_user["password"])
    assert client.get("/api/manager-assignments").status_code == 403
    assert (
        client.post(
            "/api/manager-assignments",
            json={"manager_user_id": 1, "employee_id": 1, "is_primary": False},
        ).status_code
        == 403
    )


# ---------------------------------------------------------------------------
# Manager scope union — the load-bearing behaviour change
# ---------------------------------------------------------------------------


def test_manager_attendance_includes_directly_assigned_out_of_dept(
    client: TestClient,
    admin_user: dict,
    manager_user: dict,
    two_employees: dict,
    admin_engine: Engine,
) -> None:
    """An Eng Manager assigned to an Ops employee sees that employee
    on the daily attendance list — even though the employee isn't in
    the manager's department."""

    # Admin assigns the Ops employee to the Eng manager.
    _login(client, email=admin_user["email"], password=admin_user["password"])
    asg = client.post(
        "/api/manager-assignments",
        json={
            "manager_user_id": manager_user["id"],
            "employee_id": two_employees["ops_employee_id"],
            "is_primary": False,
        },
    )
    assert asg.status_code == 201

    # Seed an attendance row for today for the Ops employee so the
    # GET /api/attendance has something to return.
    from hadir.attendance.repository import local_tz  # noqa: PLC0415

    today = datetime.now(timezone.utc).astimezone(local_tz()).date()
    with admin_engine.begin() as conn:
        # Pull a Fixed policy id (seeded by 0006).
        from hadir.db import shift_policies  # noqa: PLC0415

        policy_id = conn.execute(
            select(shift_policies.c.id).where(
                shift_policies.c.tenant_id == TENANT_ID
            )
        ).scalar_one()
        conn.execute(
            insert(attendance_records).values(
                tenant_id=TENANT_ID,
                employee_id=two_employees["ops_employee_id"],
                date=today,
                policy_id=int(policy_id),
                late=False,
                early_out=False,
                short_hours=False,
                absent=False,
                overtime_minutes=0,
            )
        )

    # Fresh client (separate cookie jar) — log in as the manager.
    with TestClient(client.app) as mgr_client:
        login = mgr_client.post(
            "/api/auth/login",
            json={
                "email": manager_user["email"],
                "password": manager_user["password"],
            },
        )
        assert login.status_code == 200, login.text
        att = mgr_client.get("/api/attendance")
        assert att.status_code == 200, att.text
        codes = [r["employee_code"] for r in att.json()["items"]]

    # The Ops employee — outside the manager's Eng department — must
    # appear thanks to the direct assignment.
    assert any(code.startswith("MGROO") for code in codes), codes

    # Cleanup the attendance row we seeded.
    with admin_engine.begin() as conn:
        conn.execute(
            delete(attendance_records).where(
                attendance_records.c.employee_id
                == two_employees["ops_employee_id"]
            )
        )
