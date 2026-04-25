"""Pytest coverage for the Super-Admin role + console (v1.0 P3).

Covers:

* Login + logout + ``/me`` round-trip with ``hadir_super_session``.
* Bad credentials → 401, audit row written to
  ``public.super_admin_audit``.
* Tenants list returns the seeded pilot tenant.
* "Access as" sets ``impersonated_tenant_id`` and the next request
  carries it on ``request.state``.
* Dual audit on tenant-context writes during impersonation: a row
  appears in BOTH ``main.audit_log`` and ``public.super_admin_audit``.
* Super-Admin without impersonation cannot write to tenant data
  (the tenant-side endpoints return 401 because no ``hadir_session``
  cookie is present).
* Tenant suspension toggles the status column + emits an audit row.
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
    audit_log,
    mts_staff,
    super_admin_audit,
    super_admin_sessions,
    tenant_context,
    tenants,
)


@pytest.fixture
def super_admin_user(admin_engine: Engine) -> Iterator[dict]:
    """Create an MTS staff user, yield its credentials, then clean up."""

    email = f"sa-{secrets.token_hex(4)}@super.hadir"
    password = "super-pw-" + secrets.token_hex(6)
    password_hash = hash_password(password)

    # Wrap each DB op in tenant_context so we don't leak ``public``
    # into the test body — other autouse fixtures (clean_employees) need
    # the default ``main`` schema.
    with tenant_context("public"):
        with admin_engine.begin() as conn:
            staff_id = conn.execute(
                insert(mts_staff)
                .values(
                    email=email,
                    password_hash=password_hash,
                    full_name="Test Super Admin",
                    is_active=True,
                )
                .returning(mts_staff.c.id)
            ).scalar_one()
    try:
        yield {"id": int(staff_id), "email": email, "password": password}
    finally:
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                # Sessions cascade on staff delete; audit rows reference
                # staff via RESTRICT so clear them first.
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


def _login(client: TestClient, *, email: str, password: str) -> str:
    """Log in as Super-Admin and return the session cookie."""

    resp = client.post(
        "/api/super-admin/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text
    cookie = client.cookies.get("hadir_super_session")
    assert cookie, "expected super-session cookie"
    return cookie


def _audit_rows_for_super_admin(engine: Engine, super_admin_user_id: int) -> list[dict]:
    with tenant_context("public"):
        with engine.begin() as conn:
            rows = conn.execute(
                select(
                    super_admin_audit.c.action,
                    super_admin_audit.c.entity_type,
                    super_admin_audit.c.entity_id,
                    super_admin_audit.c.tenant_id,
                    super_admin_audit.c.after,
                )
                .where(super_admin_audit.c.super_admin_user_id == super_admin_user_id)
                .order_by(super_admin_audit.c.id.desc())
            ).all()
    return [dict(r._mapping) for r in rows]


def test_super_admin_login_logout_and_me(
    client: TestClient, super_admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, email=super_admin_user["email"], password=super_admin_user["password"])

    me = client.get("/api/super-admin/me")
    assert me.status_code == 200
    body = me.json()
    assert body["email"].lower() == super_admin_user["email"].lower()
    assert body["impersonated_tenant_id"] is None

    out = client.post("/api/super-admin/logout")
    assert out.status_code == 204

    # Cookie cleared — second /me must 401.
    me_after = client.get("/api/super-admin/me")
    assert me_after.status_code == 401

    # Audit: login.success + logout, both for our staff id.
    rows = _audit_rows_for_super_admin(admin_engine, super_admin_user["id"])
    actions = [r["action"] for r in rows]
    assert "super_admin.login.success" in actions
    assert "super_admin.logout" in actions


def test_super_admin_login_failure_audits(
    client: TestClient, super_admin_user: dict, admin_engine: Engine
) -> None:
    resp = client.post(
        "/api/super-admin/login",
        json={"email": super_admin_user["email"], "password": "wrong-pw"},
    )
    assert resp.status_code == 401

    rows = _audit_rows_for_super_admin(admin_engine, super_admin_user["id"])
    actions = [r["action"] for r in rows]
    assert "super_admin.login.failure" in actions


def test_super_admin_lists_tenants(
    client: TestClient, super_admin_user: dict
) -> None:
    _login(client, email=super_admin_user["email"], password=super_admin_user["password"])
    resp = client.get("/api/super-admin/tenants")
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert any(t["schema_name"] == "main" for t in items), items
    pilot = next(t for t in items if t["schema_name"] == "main")
    assert pilot["status"] == "active"
    assert pilot["admin_count"] >= 0
    assert pilot["employee_count"] >= 0


def test_super_admin_access_as_sets_impersonation(
    client: TestClient, super_admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, email=super_admin_user["email"], password=super_admin_user["password"])

    resp = client.post("/api/super-admin/tenants/1/access-as")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tenant_id"] == 1
    assert body["tenant_schema"] == "main"

    # /me now reports the impersonation.
    me = client.get("/api/super-admin/me").json()
    assert me["impersonated_tenant_id"] == 1

    # Audit row written for the start.
    rows = _audit_rows_for_super_admin(admin_engine, super_admin_user["id"])
    actions = [r["action"] for r in rows]
    assert "super_admin.access_as.start" in actions

    # Exit impersonation.
    out = client.post("/api/super-admin/exit-impersonation")
    assert out.status_code == 204

    me2 = client.get("/api/super-admin/me").json()
    assert me2["impersonated_tenant_id"] is None

    rows_after = _audit_rows_for_super_admin(admin_engine, super_admin_user["id"])
    actions_after = [r["action"] for r in rows_after]
    assert "super_admin.access_as.end" in actions_after


def test_super_admin_dual_audit_on_tenant_write(
    client: TestClient,
    super_admin_user: dict,
    admin_engine: Engine,
    clean_employees: None,
) -> None:
    """Impersonating + creating a tenant employee → row in both audit logs."""

    _login(client, email=super_admin_user["email"], password=super_admin_user["password"])
    resp = client.post("/api/super-admin/tenants/1/access-as")
    assert resp.status_code == 200

    # Create an employee (tenant-context write).
    from tests.conftest import department_id_by_code  # noqa: PLC0415

    dept_id = department_id_by_code(admin_engine, "ENG")
    create = client.post(
        "/api/employees",
        json={
            "employee_code": f"SA{secrets.token_hex(2).upper()}",
            "full_name": "Audit Probe",
            "email": "probe@test.hadir",
            "department_id": dept_id,
        },
    )
    assert create.status_code == 201, create.text
    employee_id = create.json()["id"]

    # Tenant-side audit: row exists, marked with the super-admin id.
    with admin_engine.begin() as conn:
        tenant_rows = conn.execute(
            select(audit_log.c.action, audit_log.c.after).where(
                audit_log.c.action == "employee.created",
                audit_log.c.entity_id == str(employee_id),
            )
        ).all()
    assert len(tenant_rows) == 1, "expected exactly one tenant audit row"
    assert (
        tenant_rows[0].after.get("impersonated_by_super_admin_user_id")
        == super_admin_user["id"]
    )

    # Operator-side audit: paired row in public.super_admin_audit.
    sa_rows = _audit_rows_for_super_admin(admin_engine, super_admin_user["id"])
    create_rows = [r for r in sa_rows if r["action"] == "employee.created"]
    assert len(create_rows) == 1, sa_rows
    assert create_rows[0]["tenant_id"] == 1
    assert create_rows[0]["entity_id"] == str(employee_id)


def test_super_admin_without_impersonation_cannot_write(
    client: TestClient, super_admin_user: dict
) -> None:
    """No impersonation, no hadir_session → tenant write endpoints reject."""

    _login(client, email=super_admin_user["email"], password=super_admin_user["password"])
    # Note: we deliberately did NOT call /access-as.

    resp = client.post(
        "/api/employees",
        json={
            "employee_code": "NOWRITE",
            "full_name": "Should not land",
            "email": "x@test.hadir",
            "department_id": 1,
        },
    )
    assert resp.status_code == 401, resp.text


def test_super_admin_suspend_unsuspend(
    client: TestClient, super_admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, email=super_admin_user["email"], password=super_admin_user["password"])
    try:
        # Suspend the pilot tenant.
        resp = client.post(
            "/api/super-admin/tenants/1/status", json={"status": "suspended"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "suspended"

        # /access-as while suspended → refused.
        access = client.post("/api/super-admin/tenants/1/access-as")
        assert access.status_code == 400

        # Audit rows (suspended).
        rows = _audit_rows_for_super_admin(admin_engine, super_admin_user["id"])
        assert any(r["action"] == "super_admin.tenant.suspended" for r in rows)
    finally:
        # Always restore the pilot tenant for downstream tests.
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                conn.execute(
                    tenants.update()
                    .where(tenants.c.id == 1)
                    .values(status="active")
                )
