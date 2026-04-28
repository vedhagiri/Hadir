"""POST /api/users + GET /api/users/roles tests.

Covers the Add Employee drawer's "Platform access" path: an Admin
creates a user with one or more role codes; password is Argon2id-
hashed; the response never echoes the password; an audit row lands
under ``user.created``. Validates the four canonical refusals:
short password, unknown role code, duplicate email, non-Admin caller.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.engine import Engine

from hadir.db import audit_log, user_roles, users


@pytest.fixture
def clean_test_users(admin_engine: Engine):
    # Drop any leftover test rows before AND after so a re-run is clean.
    def _wipe() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(users).where(users.c.email.like("user-create-%@example.com"))
            )
    _wipe()
    yield
    _wipe()


def _login_admin(client: TestClient, admin_user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _login_employee(client: TestClient, employee_user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={
            "email": employee_user["email"],
            "password": employee_user["password"],
        },
    )
    assert resp.status_code == 200, resp.text


def test_list_roles_returns_seed_codes(
    client: TestClient, admin_user: dict
) -> None:
    _login_admin(client, admin_user)
    resp = client.get("/api/users/roles")
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    codes = {r["code"] for r in items}
    # Migration 0001 seeds the four canonical roles per tenant.
    assert {"Admin", "HR", "Manager", "Employee"} <= codes


def test_create_user_with_roles_round_trips_and_audits(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_test_users: None,
) -> None:
    _login_admin(client, admin_user)
    resp = client.post(
        "/api/users",
        json={
            "email": "user-create-ok@example.com",
            "full_name": "Roundtrip User",
            "password": "abcdefghijkl",  # 12 chars exactly
            "role_codes": ["HR", "Manager"],
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["email"] == "user-create-ok@example.com"
    assert body["is_active"] is True
    assert sorted(body["role_codes"]) == ["HR", "Manager"]
    assert "password" not in body  # never echo the password.

    new_id = int(body["id"])
    with admin_engine.begin() as conn:
        # Roles persisted.
        rs = conn.execute(
            select(user_roles.c.role_id).where(user_roles.c.user_id == new_id)
        ).all()
        assert len(rs) == 2
        # Audit row landed (after = email + full_name + role_codes;
        # password never appears).
        audit = conn.execute(
            select(audit_log.c.action, audit_log.c.after)
            .where(audit_log.c.action == "user.created")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert audit is not None
    assert audit.after["email"] == "user-create-ok@example.com"
    assert "password" not in audit.after


def test_create_user_rejects_short_password(
    client: TestClient, admin_user: dict, clean_test_users: None
) -> None:
    _login_admin(client, admin_user)
    resp = client.post(
        "/api/users",
        json={
            "email": "user-create-short@example.com",
            "full_name": "Short Pw",
            "password": "abc",  # < 12 chars
            "role_codes": ["Employee"],
        },
    )
    # Pydantic field validation surfaces as 422 by default.
    assert resp.status_code == 422, resp.text


def test_create_user_rejects_unknown_role_code(
    client: TestClient, admin_user: dict, clean_test_users: None
) -> None:
    _login_admin(client, admin_user)
    resp = client.post(
        "/api/users",
        json={
            "email": "user-create-bad-role@example.com",
            "full_name": "Bad Role",
            "password": "abcdefghijkl",
            "role_codes": ["BogusRole"],
        },
    )
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["field"] == "role_codes"
    assert "BogusRole" in detail["message"]


def test_create_user_409_on_duplicate_email(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_test_users: None,
) -> None:
    _login_admin(client, admin_user)
    body = {
        "email": "user-create-dup@example.com",
        "full_name": "First",
        "password": "abcdefghijkl",
        "role_codes": ["Employee"],
    }
    r1 = client.post("/api/users", json=body)
    assert r1.status_code == 201, r1.text
    r2 = client.post("/api/users", json=body)
    assert r2.status_code == 409, r2.text
    assert r2.json()["detail"]["field"] == "email"


def test_create_user_403_for_non_admin(
    client: TestClient, employee_user: dict
) -> None:
    _login_employee(client, employee_user)
    resp = client.post(
        "/api/users",
        json={
            "email": "user-create-403@example.com",
            "full_name": "Forbidden",
            "password": "abcdefghijkl",
            "role_codes": ["Employee"],
        },
    )
    assert resp.status_code == 403, resp.text


def test_get_user_by_email_returns_detail(
    client: TestClient,
    admin_user: dict,
    clean_test_users: None,
) -> None:
    _login_admin(client, admin_user)
    r1 = client.post(
        "/api/users",
        json={
            "email": "user-create-lookup@example.com",
            "full_name": "Lookup",
            "password": "abcdefghijkl",
            "role_codes": ["Employee"],
        },
    )
    assert r1.status_code == 201
    r2 = client.get("/api/users/by-email/user-create-lookup@example.com")
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["email"] == "user-create-lookup@example.com"
    assert body["role_codes"] == ["Employee"]


def test_get_user_by_email_404_when_missing(
    client: TestClient, admin_user: dict
) -> None:
    _login_admin(client, admin_user)
    r = client.get("/api/users/by-email/no-such@example.com")
    assert r.status_code == 404


def test_patch_user_replaces_role_codes_and_audits(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_test_users: None,
) -> None:
    _login_admin(client, admin_user)
    r1 = client.post(
        "/api/users",
        json={
            "email": "user-create-patch@example.com",
            "full_name": "Patch",
            "password": "abcdefghijkl",
            "role_codes": ["Employee"],
        },
    )
    assert r1.status_code == 201
    new_id = r1.json()["id"]

    r2 = client.patch(
        f"/api/users/{new_id}",
        json={"role_codes": ["Manager", "HR"]},
    )
    assert r2.status_code == 200, r2.text
    assert sorted(r2.json()["role_codes"]) == ["HR", "Manager"]

    with admin_engine.begin() as conn:
        audit = conn.execute(
            select(audit_log.c.before, audit_log.c.after)
            .where(audit_log.c.action == "user.updated")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert audit is not None
    assert audit.before["role_codes"] == ["Employee"]
    assert sorted(audit.after["role_codes"]) == ["HR", "Manager"]


def test_patch_user_rejects_unknown_role(
    client: TestClient,
    admin_user: dict,
    clean_test_users: None,
) -> None:
    _login_admin(client, admin_user)
    r1 = client.post(
        "/api/users",
        json={
            "email": "user-create-bad-patch@example.com",
            "full_name": "Bad",
            "password": "abcdefghijkl",
            "role_codes": ["Employee"],
        },
    )
    new_id = r1.json()["id"]
    r2 = client.patch(
        f"/api/users/{new_id}", json={"role_codes": ["Bogus"]}
    )
    assert r2.status_code == 422
    assert r2.json()["detail"]["field"] == "role_codes"


def test_password_reset_audits_without_echoing_password(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    clean_test_users: None,
) -> None:
    _login_admin(client, admin_user)
    r1 = client.post(
        "/api/users",
        json={
            "email": "user-create-pwreset@example.com",
            "full_name": "PwReset",
            "password": "abcdefghijkl",
            "role_codes": ["Employee"],
        },
    )
    new_id = r1.json()["id"]
    r2 = client.post(
        f"/api/users/{new_id}/password-reset",
        json={"password": "newpassword123"},
    )
    assert r2.status_code == 204, r2.text
    # Audit row landed with no password.
    with admin_engine.begin() as conn:
        audit = conn.execute(
            select(audit_log.c.action, audit_log.c.after)
            .where(audit_log.c.action == "user.password_reset")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert audit is not None
    assert "password" not in audit.after
    # The new password works for login.
    r3 = client.post(
        "/api/auth/login",
        json={
            "email": "user-create-pwreset@example.com",
            "password": "newpassword123",
        },
    )
    assert r3.status_code == 200, r3.text
