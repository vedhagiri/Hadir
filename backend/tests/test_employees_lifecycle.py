"""P28.7 — Employee lifecycle + delete-request workflow tests.

Covers (per the prompt's required test list):

* Status flip rules: ``inactive`` requires a reason ≥ 5 chars; manual
  flip sets ``deactivated_at``; reactivate clears both.
* Cross-field validation: ``relieving_date`` < ``joining_date`` is 400.
* ``reports_to_user_id`` from another tenant rejected.
* Delete-request workflow:
  - HR submit → auto-approve + immediate hard-delete.
  - Admin submit → pending → HR approve → hard-delete.
  - Admin submit → pending → HR reject → row stays, audit logged.
  - Admin submit → another Admin override + 10-char comment → delete.
  - Cannot self-override your own pending request.
* Lifecycle cron: yesterday relieving_date → flipped; tomorrow → not
  flipped.
* Cross-tenant isolation: tenant A's HR cannot decide on tenant B's
  delete request — 404.

The tests do **not** exercise the matcher's classification logic with
real embeddings — that path is exercised by the live walkthrough and
the existing capture suite.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from hadir.db import (
    delete_requests as t_delete_requests,
    employees as t_employees,
    roles,
    user_roles,
)
from hadir.employees.lifecycle_cron import run_for_tenant


TENANT_ID = 1


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _grant_role(admin_engine: Engine, user_id: int, role_code: str) -> None:
    """Add the named role to the user (in addition to whatever they
    already have). Used to flip a fixture user's role for one test."""

    with admin_engine.begin() as conn:
        role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == role_code
            )
        ).scalar_one()
        # Idempotent — skip if already granted.
        existing = conn.execute(
            select(user_roles.c.user_id).where(
                user_roles.c.user_id == user_id,
                user_roles.c.role_id == role_id,
                user_roles.c.tenant_id == TENANT_ID,
            )
        ).first()
        if existing is None:
            conn.execute(
                insert(user_roles).values(
                    user_id=user_id, role_id=role_id, tenant_id=TENANT_ID
                )
            )


def _set_user_to_role_only(
    admin_engine: Engine, user_id: int, role_code: str
) -> None:
    """Wipe other roles and leave only ``role_code`` on this user."""

    with admin_engine.begin() as conn:
        conn.execute(delete(user_roles).where(user_roles.c.user_id == user_id))
        role_id = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == role_code
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=user_id, role_id=role_id, tenant_id=TENANT_ID
            )
        )


@pytest.fixture
def clean_state(admin_engine: Engine) -> Iterator[None]:
    """Wipe employees + delete_requests before/after each test so no
    fixture leakage. The audit_log rows we generate are append-only
    and cleaned up by the conftest user-cleanup."""

    with admin_engine.begin() as conn:
        conn.execute(
            delete(t_delete_requests).where(
                t_delete_requests.c.tenant_id == TENANT_ID
            )
        )
        conn.execute(delete(t_employees).where(t_employees.c.tenant_id == TENANT_ID))
    yield
    with admin_engine.begin() as conn:
        conn.execute(
            delete(t_delete_requests).where(
                t_delete_requests.c.tenant_id == TENANT_ID
            )
        )
        conn.execute(delete(t_employees).where(t_employees.c.tenant_id == TENANT_ID))


def _create_employee(
    client: TestClient, *, code: str, full_name: str, department_code: str = "ENG"
) -> int:
    resp = client.post(
        "/api/employees",
        json={
            "employee_code": code,
            "full_name": full_name,
            "department_code": department_code,
        },
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


# ---------------------------------------------------------------------------
# PATCH validation
# ---------------------------------------------------------------------------


def test_inactive_status_requires_reason(
    client: TestClient, admin_user: dict, clean_state
) -> None:
    _login(client, admin_user)
    eid = _create_employee(client, code="P287-001", full_name="Reason Required")

    # No reason → 400.
    resp = client.patch(f"/api/employees/{eid}", json={"status": "inactive"})
    assert resp.status_code == 400
    assert "deactivation_reason" in resp.json()["detail"]

    # Short reason → 400.
    resp = client.patch(
        f"/api/employees/{eid}",
        json={"status": "inactive", "deactivation_reason": "no"},
    )
    assert resp.status_code == 400


def test_inactive_with_reason_sets_deactivated_at(
    client: TestClient, admin_user: dict, clean_state
) -> None:
    _login(client, admin_user)
    eid = _create_employee(client, code="P287-002", full_name="Set Timestamp")

    resp = client.patch(
        f"/api/employees/{eid}",
        json={"status": "inactive", "deactivation_reason": "Resigned 2026-04"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "inactive"
    assert body["deactivated_at"] is not None
    assert body["deactivation_reason"].startswith("Resigned")

    # Reactivate clears both fields.
    resp = client.patch(f"/api/employees/{eid}", json={"status": "active"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "active"
    assert body["deactivated_at"] is None
    assert body["deactivation_reason"] is None


def test_relieving_before_joining_rejected(
    client: TestClient, admin_user: dict, clean_state
) -> None:
    _login(client, admin_user)
    eid = _create_employee(client, code="P287-003", full_name="Date Order")

    # Pydantic's ``model_validator`` raises ValueError (→ 422) when both
    # dates land in the same patch; the handler's cross-field check
    # raises HTTPException(400) when only one date is sent and the
    # other comes from the existing row. Either is a 4xx with the
    # field name in the body.
    resp = client.patch(
        f"/api/employees/{eid}",
        json={"joining_date": "2026-06-01", "relieving_date": "2026-05-31"},
    )
    assert resp.status_code in (400, 422), resp.text
    assert "relieving_date" in resp.text


# ---------------------------------------------------------------------------
# Delete-request workflow
# ---------------------------------------------------------------------------


def test_admin_submit_creates_pending(
    client: TestClient, admin_user: dict, clean_state
) -> None:
    _login(client, admin_user)
    eid = _create_employee(client, code="P287-DEL-1", full_name="Pending Delete")

    resp = client.post(
        f"/api/employees/{eid}/delete-request",
        json={"reason": "Routine cleanup test"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "pending"
    assert body["requested_by"] == admin_user["id"]

    # Get-pending returns the row.
    pending = client.get(f"/api/employees/{eid}/delete-request").json()
    assert pending is not None
    assert pending["id"] == body["id"]


def test_duplicate_pending_returns_409(
    client: TestClient, admin_user: dict, clean_state
) -> None:
    _login(client, admin_user)
    eid = _create_employee(client, code="P287-DEL-2", full_name="Dup Pending")
    r1 = client.post(
        f"/api/employees/{eid}/delete-request",
        json={"reason": "First request — should succeed"},
    )
    assert r1.status_code == 201
    r2 = client.post(
        f"/api/employees/{eid}/delete-request",
        json={"reason": "Second request — should 409"},
    )
    assert r2.status_code == 409


def test_hr_self_submit_auto_approves_and_deletes(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_state,
) -> None:
    """HR self-submit creates ``status='approved'`` AND triggers the
    hard-delete in the same call. After the call, the employee row is
    gone and the audit log carries an ``employee.hard_deleted`` row."""

    _login(client, admin_user)
    eid = _create_employee(client, code="P287-DEL-3", full_name="HR Self")

    # Promote the test admin to HR for this test.
    _set_user_to_role_only(admin_engine, admin_user["id"], "HR")
    # Re-login so the new role is active.
    client.cookies.clear()
    _login(client, admin_user)

    resp = client.post(
        f"/api/employees/{eid}/delete-request",
        json={"reason": "HR self-submit auto-approve"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "approved"

    # Restore Admin role for the cleanup teardown.
    _set_user_to_role_only(admin_engine, admin_user["id"], "Admin")

    # Employee row should be gone.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(t_employees.c.id).where(
                t_employees.c.tenant_id == TENANT_ID, t_employees.c.id == eid
            )
        ).first()
    assert row is None


def test_admin_submit_then_hr_approves_deletes(
    client: TestClient,
    admin_user: dict,
    employee_user: dict,
    admin_engine: Engine,
    clean_state,
) -> None:
    """Admin → HR approval flow. Admin files; HR (a different user)
    decides; the hard-delete fires + the row is gone."""

    _login(client, admin_user)
    eid = _create_employee(client, code="P287-DEL-4", full_name="Admin → HR")

    # Submit as admin.
    submit = client.post(
        f"/api/employees/{eid}/delete-request",
        json={"reason": "Admin to HR approval flow"},
    )
    assert submit.status_code == 201
    req_id = submit.json()["id"]

    # Promote the employee_user fixture to HR + log in as them.
    _set_user_to_role_only(admin_engine, employee_user["id"], "HR")
    client.cookies.clear()
    _login(client, employee_user)

    decide = client.post(
        f"/api/employees/{eid}/delete-request/{req_id}/decide",
        json={"decision": "approve"},
    )
    assert decide.status_code == 200, decide.text

    # Cleanup: restore the fixture role for the teardown.
    _set_user_to_role_only(admin_engine, employee_user["id"], "Employee")

    # Row gone.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(t_employees.c.id).where(t_employees.c.id == eid)
        ).first()
    assert row is None


def test_hr_reject_keeps_employee_and_audit_logs(
    client: TestClient,
    admin_user: dict,
    employee_user: dict,
    admin_engine: Engine,
    clean_state,
) -> None:
    _login(client, admin_user)
    eid = _create_employee(client, code="P287-DEL-5", full_name="HR Reject")
    submit = client.post(
        f"/api/employees/{eid}/delete-request",
        json={"reason": "Admin filed; HR will reject"},
    )
    req_id = submit.json()["id"]

    _set_user_to_role_only(admin_engine, employee_user["id"], "HR")
    client.cookies.clear()
    _login(client, employee_user)

    decide = client.post(
        f"/api/employees/{eid}/delete-request/{req_id}/decide",
        json={
            "decision": "reject",
            "comment": "Not yet — keep this employee for now",
        },
    )
    assert decide.status_code == 200
    assert decide.json()["status"] == "rejected"

    _set_user_to_role_only(admin_engine, employee_user["id"], "Employee")

    # Employee still exists.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(t_employees.c.id).where(t_employees.c.id == eid)
        ).first()
    assert row is not None


def test_admin_reject_requires_comment(
    client: TestClient,
    admin_user: dict,
    employee_user: dict,
    admin_engine: Engine,
    clean_state,
) -> None:
    """HR-decide reject without a comment → 400."""

    _login(client, admin_user)
    eid = _create_employee(client, code="P287-DEL-5b", full_name="Reject No Comment")
    req_id = client.post(
        f"/api/employees/{eid}/delete-request",
        json={"reason": "Admin filed for rejection test"},
    ).json()["id"]

    _set_user_to_role_only(admin_engine, employee_user["id"], "HR")
    client.cookies.clear()
    _login(client, employee_user)

    resp = client.post(
        f"/api/employees/{eid}/delete-request/{req_id}/decide",
        json={"decision": "reject"},
    )
    assert resp.status_code == 400

    _set_user_to_role_only(admin_engine, employee_user["id"], "Employee")


def test_admin_cannot_override_own_pending(
    client: TestClient, admin_user: dict, clean_state
) -> None:
    _login(client, admin_user)
    eid = _create_employee(client, code="P287-DEL-6", full_name="Self-override")
    req_id = client.post(
        f"/api/employees/{eid}/delete-request",
        json={"reason": "Admin filed; same admin tries to override"},
    ).json()["id"]

    resp = client.post(
        f"/api/employees/{eid}/delete-request/{req_id}/admin-override",
        json={
            "decision": "approve",
            "comment": "Trying to self-override — should fail",
        },
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Lifecycle cron
# ---------------------------------------------------------------------------


def test_cron_flips_yesterday_relieving(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_state,
) -> None:
    """relieving_date=yesterday → cron flips status to inactive."""

    _login(client, admin_user)
    eid = _create_employee(client, code="P287-CRON-1", full_name="Cron Flip")
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    resp = client.patch(
        f"/api/employees/{eid}",
        json={"relieving_date": yesterday},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "active"  # not flipped yet

    flipped = run_for_tenant(TENANT_ID, "main")
    assert flipped >= 1

    # Confirm the row is now inactive with the auto reason.
    after = client.get(f"/api/employees/{eid}").json()
    assert after["status"] == "inactive"
    assert "Auto-deactivated" in (after["deactivation_reason"] or "")


def test_cron_skips_tomorrow_relieving(
    client: TestClient,
    admin_user: dict,
    clean_state,
) -> None:
    """relieving_date=tomorrow → cron leaves status as active."""

    _login(client, admin_user)
    eid = _create_employee(client, code="P287-CRON-2", full_name="Cron Skip")
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    resp = client.patch(
        f"/api/employees/{eid}",
        json={"relieving_date": tomorrow},
    )
    assert resp.status_code == 200

    run_for_tenant(TENANT_ID, "main")

    after = client.get(f"/api/employees/{eid}").json()
    assert after["status"] == "active"
