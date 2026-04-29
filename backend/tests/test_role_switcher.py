"""Pytest coverage for the multi-role user switcher (v1.0 P7).

Verifies:

* Login seeds ``active_role`` to the user's highest role.
* ``/api/auth/me`` carries ``active_role`` + ``available_roles``.
* ``POST /api/auth/switch-role`` flips the active role for a held
  role and audits the transition.
* Switching to a role the user does NOT hold returns 403 — backend
  authorisation never trusts the frontend's claim about which
  roles are available.
* ``require_role`` re-evaluates per request: a user with Admin + HR
  whose active role is HR cannot reach ``/api/employees`` (Admin only)
  and CAN reach ``/api/audit-log`` (Admin + HR).

Wait — ``/api/audit-log`` is Admin-only too. The cleanest way to
prove the per-request re-evaluation is the OIDC config endpoint
(``/api/auth/oidc/config``, Admin only): with active=HR it 403s,
with active=Admin it 200s.
"""

from __future__ import annotations

import secrets
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from maugood.auth.passwords import hash_password
from maugood.db import audit_log, roles, user_roles, user_sessions, users


@pytest.fixture
def admin_hr_user(admin_engine: Engine) -> Iterator[dict]:
    """Create a user with both Admin and HR roles (pilot tenant)."""

    email = f"admin-hr-{secrets.token_hex(4)}@test.maugood"
    password = "test-multi-role-" + secrets.token_hex(6)
    pwh = hash_password(password)
    with admin_engine.begin() as conn:
        user_id = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=1,
                    email=email,
                    password_hash=pwh,
                    full_name="Multi-role Admin/HR",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        for code in ("Admin", "HR"):
            role_id = conn.execute(
                select(roles.c.id).where(
                    roles.c.tenant_id == 1, roles.c.code == code
                )
            ).scalar_one()
            conn.execute(
                insert(user_roles).values(
                    user_id=user_id, role_id=role_id, tenant_id=1
                )
            )
    try:
        yield {"id": user_id, "email": email, "password": password}
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(user_sessions).where(user_sessions.c.user_id == user_id)
            )
            conn.execute(
                delete(audit_log).where(audit_log.c.actor_user_id == user_id)
            )
            conn.execute(
                delete(user_roles).where(user_roles.c.user_id == user_id)
            )
            conn.execute(delete(users).where(users.c.id == user_id))


def _login(client: TestClient, *, email: str, password: str) -> dict:
    resp = client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------


def test_login_seeds_active_role_to_highest(
    client: TestClient, admin_hr_user: dict
) -> None:
    body = _login(
        client, email=admin_hr_user["email"], password=admin_hr_user["password"]
    )
    assert body["active_role"] == "Admin"
    assert sorted(body["available_roles"]) == ["Admin", "HR"]
    assert body["roles"] == ["Admin"], body


def test_me_carries_available_and_active(
    client: TestClient, admin_hr_user: dict
) -> None:
    _login(
        client, email=admin_hr_user["email"], password=admin_hr_user["password"]
    )
    me = client.get("/api/auth/me").json()
    assert me["active_role"] == "Admin"
    assert sorted(me["available_roles"]) == ["Admin", "HR"]


def test_switch_role_flips_active_and_audits(
    client: TestClient, admin_hr_user: dict, admin_engine: Engine
) -> None:
    _login(
        client, email=admin_hr_user["email"], password=admin_hr_user["password"]
    )

    sw = client.post("/api/auth/switch-role", json={"role": "HR"})
    assert sw.status_code == 200, sw.text
    body = sw.json()
    assert body["active_role"] == "HR"
    assert body["roles"] == ["HR"]

    me = client.get("/api/auth/me").json()
    assert me["active_role"] == "HR"

    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.before, audit_log.c.after).where(
                audit_log.c.action == "auth.role.switched",
                audit_log.c.actor_user_id == admin_hr_user["id"],
            )
            .order_by(audit_log.c.id.desc())
        ).all()
    assert rows
    assert rows[0].before == {"active_role": "Admin"}
    assert rows[0].after == {"active_role": "HR"}


def test_switch_role_refuses_unheld_role(
    client: TestClient, admin_hr_user: dict
) -> None:
    _login(
        client, email=admin_hr_user["email"], password=admin_hr_user["password"]
    )
    bad = client.post("/api/auth/switch-role", json={"role": "Manager"})
    assert bad.status_code == 403, bad.text


def test_switch_role_noop_returns_current_state_without_audit(
    client: TestClient, admin_hr_user: dict, admin_engine: Engine
) -> None:
    _login(
        client, email=admin_hr_user["email"], password=admin_hr_user["password"]
    )
    # Already Admin → switching to Admin should 200 without writing
    # an audit row.
    resp = client.post("/api/auth/switch-role", json={"role": "Admin"})
    assert resp.status_code == 200
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.id).where(
                audit_log.c.action == "auth.role.switched",
                audit_log.c.actor_user_id == admin_hr_user["id"],
            )
        ).all()
    assert rows == []


def test_role_guard_re_evaluates_per_request_after_switch(
    client: TestClient, admin_hr_user: dict
) -> None:
    """The Admin-only ``/api/auth/oidc/config`` endpoint:

    * 200 while active_role = Admin
    * 403 immediately after the user switches to HR
    """

    _login(
        client, email=admin_hr_user["email"], password=admin_hr_user["password"]
    )
    as_admin = client.get("/api/auth/oidc/config")
    assert as_admin.status_code == 200, as_admin.text

    sw = client.post("/api/auth/switch-role", json={"role": "HR"})
    assert sw.status_code == 200

    as_hr = client.get("/api/auth/oidc/config")
    assert as_hr.status_code == 403, as_hr.text


def test_switch_role_refuses_for_synthetic_super_admin(
    client: TestClient, admin_engine: Engine
) -> None:
    """The synthetic super-admin (no real session row) cannot switch."""

    # Provision a super-admin staff user + login + access-as the
    # pilot tenant in this test for self-containment.
    from maugood.db import mts_staff, super_admin_audit, super_admin_sessions, tenant_context

    email = f"sa-rs-{secrets.token_hex(4)}@super.maugood"
    password = "sa-rs-" + secrets.token_hex(6)
    pwh = hash_password(password)
    with tenant_context("public"):
        with admin_engine.begin() as conn:
            staff_id = int(
                conn.execute(
                    insert(mts_staff)
                    .values(
                        email=email,
                        password_hash=pwh,
                        full_name="SA Switch Test",
                        is_active=True,
                    )
                    .returning(mts_staff.c.id)
                ).scalar_one()
            )
    try:
        login = client.post(
            "/api/super-admin/login", json={"email": email, "password": password}
        )
        assert login.status_code == 200
        access = client.post("/api/super-admin/tenants/1/access-as")
        assert access.status_code == 200

        # /api/auth/me now returns the synthetic user.
        me = client.get("/api/auth/me").json()
        assert me["is_super_admin_impersonation"] is True
        assert me["id"] == 0

        bad = client.post("/api/auth/switch-role", json={"role": "HR"})
        assert bad.status_code == 400, bad.text
    finally:
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                conn.execute(
                    delete(super_admin_audit).where(
                        super_admin_audit.c.super_admin_user_id == staff_id
                    )
                )
                conn.execute(
                    delete(super_admin_sessions).where(
                        super_admin_sessions.c.mts_staff_id == staff_id
                    )
                )
                conn.execute(delete(mts_staff).where(mts_staff.c.id == staff_id))
