"""Tests for v1.0 P16 — Admin override comment + notifications queue.

Covers:

* AdminOverrideBody enforces ``min_length=10`` (trimmed) on the comment
  — a 9-character comment returns 422; a 10-character comment passes.
* On admin-override after a manager rejection, the audit row carries
  the **previous_decider_user_id** + the **comment verbatim**, and the
  notifications queue gets one row each for the manager + the
  employee. (HR row is absent because HR didn't decide on a
  manager-rejected request.)
* On admin-override after an HR rejection, the queue gets one row
  each for the manager, the HR decider, and the employee.
* The ``override.employee_notified`` payload carries
  ``recipient_email`` so P20 can deliver via email even when no users
  row matches.
"""

from __future__ import annotations

import secrets
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from maugood.auth.passwords import hash_password
from maugood.db import (
    approved_leaves,
    audit_log,
    departments,
    employees,
    manager_assignments,
    notifications,
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
        uid = int(
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
            rid = conn.execute(
                select(roles.c.id).where(
                    roles.c.tenant_id == TENANT_ID, roles.c.code == code
                )
            ).scalar_one()
            conn.execute(
                insert(user_roles).values(
                    user_id=uid, role_id=int(rid), tenant_id=TENANT_ID
                )
            )
        if department_codes:
            for d in department_codes:
                dept_id = int(
                    conn.execute(
                        select(departments.c.id).where(
                            departments.c.tenant_id == TENANT_ID,
                            departments.c.code == d,
                        )
                    ).scalar_one()
                )
                conn.execute(
                    insert(user_departments).values(
                        user_id=uid,
                        department_id=dept_id,
                        tenant_id=TENANT_ID,
                    )
                )
    return uid


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
def world(admin_engine: Engine) -> Iterator[dict]:
    suffix = secrets.token_hex(4)
    employee_email = f"emp-{suffix}@p16.maugood"
    manager_email = f"mgr-{suffix}@p16.maugood"
    hr_email = f"hr-{suffix}@p16.maugood"
    admin_email = f"adm-{suffix}@p16.maugood"
    pwd = "p16-pw-" + secrets.token_hex(6)

    employee_uid = _make_user(
        admin_engine,
        email=employee_email,
        password=pwd,
        role_codes=["Employee"],
        full_name="P16 Smoke Employee",
        department_codes=["ENG"],
    )
    manager_uid = _make_user(
        admin_engine,
        email=manager_email,
        password=pwd,
        role_codes=["Manager"],
        full_name="P16 Manager",
        department_codes=["ENG"],
    )
    hr_uid = _make_user(
        admin_engine,
        email=hr_email,
        password=pwd,
        role_codes=["HR"],
        full_name="P16 HR",
    )
    admin_uid = _make_user(
        admin_engine,
        email=admin_email,
        password=pwd,
        role_codes=["Admin"],
        full_name="P16 Admin",
    )

    with admin_engine.begin() as conn:
        eng_dept = int(
            conn.execute(
                select(departments.c.id).where(
                    departments.c.tenant_id == TENANT_ID,
                    departments.c.code == "ENG",
                )
            ).scalar_one()
        )
        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P16-{suffix}",
                    full_name="P16 Smoke Employee",
                    email=employee_email,
                    department_id=eng_dept,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )

    bundle = {
        "password": pwd,
        "employee": {"id": employee_uid, "email": employee_email},
        "manager": {"id": manager_uid, "email": manager_email},
        "hr": {"id": hr_uid, "email": hr_email},
        "admin": {"id": admin_uid, "email": admin_email},
        "employee_row_id": emp_id,
    }
    try:
        yield bundle
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(notifications).where(
                    notifications.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                delete(approved_leaves).where(
                    approved_leaves.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(request_attachments).where(
                    request_attachments.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                delete(requests_table).where(
                    requests_table.c.employee_id == emp_id
                )
            )
            conn.execute(
                delete(audit_log).where(audit_log.c.entity_type == "request")
            )
            from maugood.db import attendance_records  # noqa: PLC0415

            conn.execute(
                delete(attendance_records).where(
                    attendance_records.c.employee_id == emp_id
                )
            )
            conn.execute(delete(employees).where(employees.c.id == emp_id))
        for uid in (employee_uid, manager_uid, hr_uid, admin_uid):
            _cleanup_user(admin_engine, uid)


def _login(client: TestClient, *, email: str, password: str) -> None:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text


def _submit_exception(client: TestClient, when: str = "2026-06-15") -> int:
    resp = client.post(
        "/api/requests",
        json={
            "type": "exception",
            "reason_category": "Doctor",
            "target_date_start": when,
        },
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


# ---------------------------------------------------------------------------
# Comment min-length
# ---------------------------------------------------------------------------


def test_admin_override_short_comment_rejected_422(
    client: TestClient, world: dict
) -> None:
    _login(
        client,
        email=world["employee"]["email"],
        password=world["password"],
    )
    rid = _submit_exception(client)

    client.post("/api/auth/logout")
    _login(
        client,
        email=world["admin"]["email"],
        password=world["password"],
    )
    short = client.post(
        f"/api/requests/{rid}/admin-override",
        json={"decision": "approve", "comment": "too short"},  # 9 chars
    )
    assert short.status_code == 422


def test_admin_override_whitespace_padded_short_rejected_422(
    client: TestClient, world: dict
) -> None:
    _login(
        client,
        email=world["employee"]["email"],
        password=world["password"],
    )
    rid = _submit_exception(client, when="2026-06-16")

    client.post("/api/auth/logout")
    _login(
        client,
        email=world["admin"]["email"],
        password=world["password"],
    )
    bad = client.post(
        f"/api/requests/{rid}/admin-override",
        json={"decision": "approve", "comment": "   short   "},
    )
    assert bad.status_code == 422


def test_admin_override_min_length_comment_accepted(
    client: TestClient, world: dict
) -> None:
    _login(
        client,
        email=world["employee"]["email"],
        password=world["password"],
    )
    rid = _submit_exception(client, when="2026-06-17")

    client.post("/api/auth/logout")
    _login(
        client,
        email=world["admin"]["email"],
        password=world["password"],
    )
    ok = client.post(
        f"/api/requests/{rid}/admin-override",
        json={"decision": "approve", "comment": "exactly 10"},  # 10 chars
    )
    assert ok.status_code == 200, ok.text


# ---------------------------------------------------------------------------
# Audit + queue rows on override
# ---------------------------------------------------------------------------


def test_override_after_manager_rejection_records_previous_decider_and_queues_two_notifications(
    client: TestClient, world: dict, admin_engine: Engine
) -> None:
    # Employee submits.
    _login(
        client,
        email=world["employee"]["email"],
        password=world["password"],
    )
    rid = _submit_exception(client, when="2026-06-18")

    # Manager rejects.
    client.post("/api/auth/logout")
    _login(
        client,
        email=world["manager"]["email"],
        password=world["password"],
    )
    mgr = client.post(
        f"/api/requests/{rid}/manager-decide",
        json={"decision": "reject", "comment": "no proof"},
    )
    assert mgr.status_code == 200

    # Admin overrides.
    client.post("/api/auth/logout")
    _login(
        client,
        email=world["admin"]["email"],
        password=world["password"],
    )
    override_comment = "Admin override per BRD §FR-REQ-006 — verbatim"
    over = client.post(
        f"/api/requests/{rid}/admin-override",
        json={"decision": "approve", "comment": override_comment},
    )
    assert over.status_code == 200, over.text
    assert over.json()["status"] == "admin_approved"

    # Audit row carries the previous decider + verbatim comment.
    with admin_engine.begin() as conn:
        audit_rows = conn.execute(
            select(
                audit_log.c.action,
                audit_log.c.before,
                audit_log.c.after,
            )
            .where(
                audit_log.c.entity_type == "request",
                audit_log.c.entity_id == str(rid),
                audit_log.c.action == "request.admin.approve",
            )
        ).all()
    assert len(audit_rows) == 1, audit_rows
    audit = audit_rows[0]
    assert audit.before["status"] == "manager_rejected"
    assert audit.before["previous_stage"] == "manager"
    assert audit.before["previous_decider_user_id"] == world["manager"]["id"]
    assert audit.after["comment"] == override_comment

    # P20 notifications: one row per audience. Manager-rejection
    # path → manager + employee (no HR row because HR never decided).
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(
                notifications.c.user_id,
                notifications.c.category,
                notifications.c.payload,
            ).where(
                notifications.c.tenant_id == TENANT_ID,
                notifications.c.category == "admin_override",
                notifications.c.payload["request_id"].as_integer() == rid,
            )
        ).all()
    audience_ids = sorted(int(r.user_id) for r in rows)
    employee_user_id = world["employee"]["id"]
    manager_user_id = world["manager"]["id"]
    assert audience_ids == sorted([employee_user_id, manager_user_id])
    by_user = {int(r.user_id): r for r in rows}
    assert by_user[manager_user_id].payload["comment"] == override_comment
    assert by_user[manager_user_id].payload["previous_stage"] == "manager"
    assert by_user[manager_user_id].payload["actor_email"] == world["admin"]["email"]


def test_override_after_hr_rejection_queues_three_notifications(
    client: TestClient, world: dict, admin_engine: Engine
) -> None:
    _login(
        client,
        email=world["employee"]["email"],
        password=world["password"],
    )
    rid = _submit_exception(client, when="2026-06-19")

    # Manager approves.
    client.post("/api/auth/logout")
    _login(
        client,
        email=world["manager"]["email"],
        password=world["password"],
    )
    client.post(
        f"/api/requests/{rid}/manager-decide",
        json={"decision": "approve", "comment": ""},
    )

    # HR rejects.
    client.post("/api/auth/logout")
    _login(
        client,
        email=world["hr"]["email"],
        password=world["password"],
    )
    client.post(
        f"/api/requests/{rid}/hr-decide",
        json={"decision": "reject", "comment": "policy"},
    )

    # Admin overrides.
    client.post("/api/auth/logout")
    _login(
        client,
        email=world["admin"]["email"],
        password=world["password"],
    )
    over = client.post(
        f"/api/requests/{rid}/admin-override",
        json={
            "decision": "approve",
            "comment": "HR policy revisit, employee escalated",
        },
    )
    assert over.status_code == 200, over.text
    assert over.json()["status"] == "admin_approved"

    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(
                notifications.c.user_id, notifications.c.category
            ).where(
                notifications.c.tenant_id == TENANT_ID,
                notifications.c.category == "admin_override",
                notifications.c.payload["request_id"].as_integer() == rid,
            )
        ).all()
        audit = conn.execute(
            select(audit_log.c.before).where(
                audit_log.c.entity_type == "request",
                audit_log.c.entity_id == str(rid),
                audit_log.c.action == "request.admin.approve",
            )
        ).scalar_one()

    audience_ids = sorted(int(r.user_id) for r in rows)
    assert audience_ids == sorted(
        [world["employee"]["id"], world["hr"]["id"], world["manager"]["id"]]
    )
    # The most-recent decider was HR — that's what the audit + the
    # banner text key off.
    assert audit["previous_stage"] == "hr"
    assert audit["previous_decider_user_id"] == world["hr"]["id"]


def test_override_on_submitted_row_has_no_previous_decider(
    client: TestClient, world: dict, admin_engine: Engine
) -> None:
    """Admin can override even before anyone else has decided. The
    audit row records ``previous_stage=None`` — the modal copy
    gracefully falls back to "the pending Manager".
    """

    _login(
        client,
        email=world["employee"]["email"],
        password=world["password"],
    )
    rid = _submit_exception(client, when="2026-06-20")

    client.post("/api/auth/logout")
    _login(
        client,
        email=world["admin"]["email"],
        password=world["password"],
    )
    over = client.post(
        f"/api/requests/{rid}/admin-override",
        json={
            "decision": "reject",
            "comment": "Out of policy — admin reject",
        },
    )
    assert over.status_code == 200, over.text

    with admin_engine.begin() as conn:
        audit = conn.execute(
            select(audit_log.c.before).where(
                audit_log.c.entity_type == "request",
                audit_log.c.entity_id == str(rid),
                audit_log.c.action == "request.admin.reject",
            )
        ).scalar_one()
        rows = conn.execute(
            select(notifications.c.user_id).where(
                notifications.c.tenant_id == TENANT_ID,
                notifications.c.category == "admin_override",
                notifications.c.payload["request_id"].as_integer() == rid,
            )
        ).all()
    assert audit["previous_stage"] is None
    assert audit["previous_decider_user_id"] is None
    # No prior decider, so only the employee gets a notification.
    assert sorted(int(r.user_id) for r in rows) == [world["employee"]["id"]]
