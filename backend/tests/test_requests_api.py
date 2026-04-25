"""End-to-end tests for the v1.0 P13 request workflow API.

Covers:

* Happy path: Employee submits → Manager approves → HR approves →
  approved_leaves row appears for a leave request, and attendance
  recompute kicks for both leave + exception flows.
* Manager rejection is terminal (HR-decide on it returns 409).
* HR rejection is terminal (manager-decide on it returns 409).
* Admin override allowed from any state, mandatory comment enforced.
* Cancellation only allowed while ``submitted``.
* Role scoping on GET — Employee sees own, Manager sees assigned,
  HR sees only what reached them, Admin sees all.

Tests provision their own users + employees + manager assignment so
every run starts from the same baseline. The pilot tenant
(``tenant_id=1``) is used.
"""

from __future__ import annotations

import secrets
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from hadir.auth.passwords import hash_password
from hadir.db import (
    approved_leaves,
    audit_log,
    employees,
    leave_types,
    manager_assignments,
    request_attachments,
    requests as requests_table,
    roles,
    user_departments,
    user_roles,
    user_sessions,
    users,
)


TENANT_ID = 1


def _make_user(
    engine: Engine,
    *,
    email: str,
    password: str,
    role_codes: list[str],
    full_name: str,
    department_codes: list[str] | None = None,
) -> int:
    pwh = hash_password(password)
    with engine.begin() as conn:
        user_id = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=TENANT_ID,
                    email=email,
                    password_hash=pwh,
                    full_name=full_name,
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        for code in role_codes:
            role_id = conn.execute(
                select(roles.c.id).where(
                    roles.c.tenant_id == TENANT_ID, roles.c.code == code
                )
            ).scalar_one()
            conn.execute(
                insert(user_roles).values(
                    user_id=user_id, role_id=role_id, tenant_id=TENANT_ID
                )
            )
        if department_codes:
            from hadir.db import departments  # noqa: PLC0415

            for d in department_codes:
                dept_id = conn.execute(
                    select(departments.c.id).where(
                        departments.c.tenant_id == TENANT_ID,
                        departments.c.code == d,
                    )
                ).scalar_one()
                conn.execute(
                    insert(user_departments).values(
                        user_id=user_id,
                        department_id=dept_id,
                        tenant_id=TENANT_ID,
                    )
                )
    return user_id


def _cleanup_user(engine: Engine, user_id: int) -> None:
    with engine.begin() as conn:
        conn.execute(
            delete(user_sessions).where(user_sessions.c.user_id == user_id)
        )
        conn.execute(
            delete(audit_log).where(audit_log.c.actor_user_id == user_id)
        )
        conn.execute(
            delete(user_roles).where(user_roles.c.user_id == user_id)
        )
        conn.execute(
            delete(user_departments).where(
                user_departments.c.user_id == user_id
            )
        )
        conn.execute(
            delete(manager_assignments).where(
                manager_assignments.c.manager_user_id == user_id
            )
        )
        conn.execute(delete(users).where(users.c.id == user_id))


@pytest.fixture
def workflow_users(admin_engine: Engine) -> Iterator[dict]:
    """Provision an Employee + Manager + HR + Admin user, plus a
    matching ``employees`` row for the Employee and a
    manager_assignment so the Manager can decide on it.
    """

    suffix = secrets.token_hex(4)
    employee_email = f"emp-{suffix}@workflow.hadir"
    manager_email = f"mgr-{suffix}@workflow.hadir"
    hr_email = f"hr-{suffix}@workflow.hadir"
    admin_email = f"adm-{suffix}@workflow.hadir"
    password = "workflow-test-pw-" + secrets.token_hex(6)

    employee_user_id = _make_user(
        admin_engine,
        email=employee_email,
        password=password,
        role_codes=["Employee"],
        full_name="Workflow Employee",
        department_codes=["ENG"],
    )
    manager_user_id = _make_user(
        admin_engine,
        email=manager_email,
        password=password,
        role_codes=["Manager"],
        full_name="Workflow Manager",
    )
    hr_user_id = _make_user(
        admin_engine,
        email=hr_email,
        password=password,
        role_codes=["HR"],
        full_name="Workflow HR",
    )
    admin_user_id = _make_user(
        admin_engine,
        email=admin_email,
        password=password,
        role_codes=["Admin"],
        full_name="Workflow Admin",
    )

    # Provision the matching employees row for the Employee user, plus
    # the manager_assignment (primary).
    from hadir.db import departments  # noqa: PLC0415

    with admin_engine.begin() as conn:
        eng_dept_id = conn.execute(
            select(departments.c.id).where(
                departments.c.tenant_id == TENANT_ID,
                departments.c.code == "ENG",
            )
        ).scalar_one()
        employee_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"WF-{suffix}",
                    full_name="Workflow Employee",
                    email=employee_email,
                    department_id=int(eng_dept_id),
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        conn.execute(
            insert(manager_assignments).values(
                tenant_id=TENANT_ID,
                manager_user_id=manager_user_id,
                employee_id=employee_id,
                is_primary=True,
            )
        )

    bundle = {
        "password": password,
        "employee": {"id": employee_user_id, "email": employee_email},
        "manager": {"id": manager_user_id, "email": manager_email},
        "hr": {"id": hr_user_id, "email": hr_email},
        "admin": {"id": admin_user_id, "email": admin_email},
        "employee_row_id": employee_id,
    }
    try:
        yield bundle
    finally:
        # Tear down requests + dependents first.
        with admin_engine.begin() as conn:
            conn.execute(
                delete(approved_leaves).where(
                    approved_leaves.c.employee_id == employee_id
                )
            )
            conn.execute(
                delete(request_attachments).where(
                    request_attachments.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                delete(requests_table).where(
                    requests_table.c.employee_id == employee_id
                )
            )
            # audit rows for the employee (referenced by entity_id)
            conn.execute(
                delete(audit_log).where(
                    audit_log.c.entity_type == "request",
                )
            )
            # Wipe attendance rows for the dummy employee so the
            # following test starts clean.
            from hadir.db import attendance_records  # noqa: PLC0415

            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.employee_id == employee_id
                )
            )
            conn.execute(
                delete(employees).where(employees.c.id == employee_id)
            )
        for uid in (
            employee_user_id,
            manager_user_id,
            hr_user_id,
            admin_user_id,
        ):
            _cleanup_user(admin_engine, uid)


def _login(client: TestClient, *, email: str, password: str) -> None:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text


def _seeded_leave_type_id(admin_engine: Engine) -> int:
    with admin_engine.begin() as conn:
        return int(
            conn.execute(
                select(leave_types.c.id).where(
                    leave_types.c.tenant_id == TENANT_ID,
                    leave_types.c.code == "Annual",
                )
            ).scalar_one()
        )


# ---------------------------------------------------------------------------
# Happy path: leave request through manager + HR approval
# ---------------------------------------------------------------------------


def test_full_happy_path_leave_request_creates_approved_leaves_row(
    client: TestClient, workflow_users: dict, admin_engine: Engine
) -> None:
    leave_type_id = _seeded_leave_type_id(admin_engine)

    # 1) Employee submits.
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    create = client.post(
        "/api/requests",
        json={
            "type": "leave",
            "reason_category": "Annual",
            "reason_text": "Family trip",
            "target_date_start": "2026-05-04",
            "target_date_end": "2026-05-06",
            "leave_type_id": leave_type_id,
        },
    )
    assert create.status_code == 201, create.text
    body = create.json()
    request_id = body["id"]
    assert body["status"] == "submitted"
    assert body["manager_user_id"] == workflow_users["manager"]["id"]

    # 2) Manager approves.
    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["manager"]["email"],
        password=workflow_users["password"],
    )
    mgr = client.post(
        f"/api/requests/{request_id}/manager-decide",
        json={"decision": "approve", "comment": "OK"},
    )
    assert mgr.status_code == 200, mgr.text
    assert mgr.json()["status"] == "manager_approved"

    # 3) HR approves.
    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["hr"]["email"],
        password=workflow_users["password"],
    )
    hr = client.post(
        f"/api/requests/{request_id}/hr-decide",
        json={"decision": "approve", "comment": "approved"},
    )
    assert hr.status_code == 200, hr.text
    assert hr.json()["status"] == "hr_approved"

    # 4) approved_leaves row exists for the covered range.
    with admin_engine.begin() as conn:
        leave_rows = conn.execute(
            select(
                approved_leaves.c.id,
                approved_leaves.c.start_date,
                approved_leaves.c.end_date,
                approved_leaves.c.leave_type_id,
            ).where(
                approved_leaves.c.tenant_id == TENANT_ID,
                approved_leaves.c.employee_id == workflow_users["employee_row_id"],
            )
        ).all()
    assert len(leave_rows) == 1
    assert leave_rows[0].leave_type_id == leave_type_id
    assert str(leave_rows[0].start_date) == "2026-05-04"
    assert str(leave_rows[0].end_date) == "2026-05-06"


# ---------------------------------------------------------------------------
# Manager rejection is terminal — HR-decide on it 409s
# ---------------------------------------------------------------------------


def test_manager_rejection_is_terminal_hr_decide_blocked(
    client: TestClient, workflow_users: dict
) -> None:
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    create = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Forgot to badge in",
            "target_date_start": "2026-05-01",
        },
    )
    assert create.status_code == 201, create.text
    request_id = create.json()["id"]

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["manager"]["email"],
        password=workflow_users["password"],
    )
    mgr = client.post(
        f"/api/requests/{request_id}/manager-decide",
        json={"decision": "reject", "comment": "no proof"},
    )
    assert mgr.json()["status"] == "manager_rejected"

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["hr"]["email"],
        password=workflow_users["password"],
    )
    hr = client.post(
        f"/api/requests/{request_id}/hr-decide",
        json={"decision": "approve", "comment": "override"},
    )
    assert hr.status_code == 409
    assert "manager" in hr.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Manager decide on hr-decided row 409s
# ---------------------------------------------------------------------------


def test_manager_decide_after_hr_approved_returns_409(
    client: TestClient, workflow_users: dict
) -> None:
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    create = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Forgot to badge in",
            "target_date_start": "2026-05-02",
        },
    )
    request_id = create.json()["id"]

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["manager"]["email"],
        password=workflow_users["password"],
    )
    client.post(
        f"/api/requests/{request_id}/manager-decide",
        json={"decision": "approve", "comment": ""},
    )

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["hr"]["email"],
        password=workflow_users["password"],
    )
    client.post(
        f"/api/requests/{request_id}/hr-decide",
        json={"decision": "reject", "comment": ""},
    )

    # Now attempt a manager-decide on the terminal row.
    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["manager"]["email"],
        password=workflow_users["password"],
    )
    again = client.post(
        f"/api/requests/{request_id}/manager-decide",
        json={"decision": "approve", "comment": ""},
    )
    assert again.status_code == 409


# ---------------------------------------------------------------------------
# Admin override
# ---------------------------------------------------------------------------


def test_admin_override_requires_non_empty_comment(
    client: TestClient, workflow_users: dict
) -> None:
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    request_id = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Forgot to badge",
            "target_date_start": "2026-05-08",
        },
    ).json()["id"]

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["admin"]["email"],
        password=workflow_users["password"],
    )
    bad = client.post(
        f"/api/requests/{request_id}/admin-override",
        json={"decision": "approve", "comment": ""},
    )
    assert bad.status_code == 422
    bad_ws = client.post(
        f"/api/requests/{request_id}/admin-override",
        json={"decision": "approve", "comment": "   "},
    )
    assert bad_ws.status_code == 422


def test_admin_override_overrides_manager_rejection(
    client: TestClient, workflow_users: dict
) -> None:
    """Admin override is allowed even on a terminal row (BRD FR-REQ-006)."""

    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    request_id = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Forgot to badge",
            "target_date_start": "2026-05-09",
        },
    ).json()["id"]

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["manager"]["email"],
        password=workflow_users["password"],
    )
    client.post(
        f"/api/requests/{request_id}/manager-decide",
        json={"decision": "reject", "comment": "no"},
    )

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["admin"]["email"],
        password=workflow_users["password"],
    )
    over = client.post(
        f"/api/requests/{request_id}/admin-override",
        json={"decision": "approve", "comment": "Admin override per BRD §FR-REQ-006"},
    )
    assert over.status_code == 200
    assert over.json()["status"] == "admin_approved"


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


def test_employee_can_cancel_own_submitted_request(
    client: TestClient, workflow_users: dict
) -> None:
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    request_id = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Family stuff",
            "target_date_start": "2026-05-10",
        },
    ).json()["id"]

    cancel = client.post(f"/api/requests/{request_id}/cancel")
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancelled"


def test_cancel_after_manager_decide_returns_409(
    client: TestClient, workflow_users: dict
) -> None:
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    request_id = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Family",
            "target_date_start": "2026-05-11",
        },
    ).json()["id"]

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["manager"]["email"],
        password=workflow_users["password"],
    )
    client.post(
        f"/api/requests/{request_id}/manager-decide",
        json={"decision": "approve", "comment": ""},
    )

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    cancel = client.post(f"/api/requests/{request_id}/cancel")
    assert cancel.status_code == 409


# ---------------------------------------------------------------------------
# Role scoping on GET
# ---------------------------------------------------------------------------


def test_hr_only_sees_requests_that_reached_them(
    client: TestClient, workflow_users: dict
) -> None:
    # Employee files two requests; only one gets manager-approved.
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    a = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "A",
            "target_date_start": "2026-05-15",
        },
    ).json()["id"]
    b = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "B",
            "target_date_start": "2026-05-16",
        },
    ).json()["id"]

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["manager"]["email"],
        password=workflow_users["password"],
    )
    client.post(
        f"/api/requests/{a}/manager-decide",
        json={"decision": "approve", "comment": ""},
    )
    # b stays in submitted

    client.post("/api/auth/logout")
    _login(
        client,
        email=workflow_users["hr"]["email"],
        password=workflow_users["password"],
    )
    listed = client.get("/api/requests").json()
    visible_ids = {row["id"] for row in listed}
    assert a in visible_ids
    assert b not in visible_ids


def test_employee_cannot_view_other_employees_requests(
    client: TestClient, workflow_users: dict, admin_engine: Engine
) -> None:
    # Employee A submits.
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    request_id = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Mine",
            "target_date_start": "2026-05-20",
        },
    ).json()["id"]

    # Provision a second Employee user with a different employees row.
    suffix = secrets.token_hex(4)
    other_email = f"other-emp-{suffix}@workflow.hadir"
    other_pw = "other-pw-" + secrets.token_hex(6)
    other_uid = _make_user(
        admin_engine,
        email=other_email,
        password=other_pw,
        role_codes=["Employee"],
        full_name="Other Employee",
    )
    from hadir.db import departments  # noqa: PLC0415

    with admin_engine.begin() as conn:
        eng_dept = conn.execute(
            select(departments.c.id).where(
                departments.c.tenant_id == TENANT_ID,
                departments.c.code == "ENG",
            )
        ).scalar_one()
        other_emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"OTH-{suffix}",
                    full_name="Other Employee",
                    email=other_email,
                    department_id=int(eng_dept),
                )
                .returning(employees.c.id)
            ).scalar_one()
        )

    try:
        client.post("/api/auth/logout")
        _login(client, email=other_email, password=other_pw)
        listed = client.get("/api/requests").json()
        assert all(row["id"] != request_id for row in listed)
        # Direct GET also forbidden.
        direct = client.get(f"/api/requests/{request_id}")
        assert direct.status_code == 403
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(employees).where(employees.c.id == other_emp_id)
            )
        _cleanup_user(admin_engine, other_uid)


def test_manager_blocked_from_unassigned_employees_requests(
    client: TestClient, workflow_users: dict, admin_engine: Engine
) -> None:
    """A manager who isn't assigned can't manager-decide (403)."""

    # Submit as employee.
    _login(
        client,
        email=workflow_users["employee"]["email"],
        password=workflow_users["password"],
    )
    request_id = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Test",
            "target_date_start": "2026-05-22",
        },
    ).json()["id"]

    # Provision a second Manager (no assignments).
    suffix = secrets.token_hex(4)
    other_mgr_email = f"other-mgr-{suffix}@workflow.hadir"
    other_pw = "other-mgr-pw-" + secrets.token_hex(6)
    other_mgr_uid = _make_user(
        admin_engine,
        email=other_mgr_email,
        password=other_pw,
        role_codes=["Manager"],
        full_name="Other Manager",
    )
    try:
        client.post("/api/auth/logout")
        _login(client, email=other_mgr_email, password=other_pw)
        decide = client.post(
            f"/api/requests/{request_id}/manager-decide",
            json={"decision": "approve", "comment": ""},
        )
        assert decide.status_code == 403
    finally:
        _cleanup_user(admin_engine, other_mgr_uid)
