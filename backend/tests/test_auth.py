"""Tests for P3: login, sessions, role guards, audit writes."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import update

from maugood.auth import require_any_role, require_department, require_role
from maugood.db import user_sessions
from maugood.main import app
from tests.conftest import audit_rows_for_email, audit_rows_for_user


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_login_happy_path_sets_cookie_and_me_returns_profile(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["email"] == admin_user["email"]
    assert body["roles"] == ["Admin"]
    assert body["departments"] == []

    assert "maugood_session" in client.cookies
    cookie = client.cookies.get("maugood_session")
    assert cookie and len(cookie) > 40  # token is base64url of 48 bytes

    # /me reflects the same user and works with the cookie jar.
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == admin_user["email"]

    # Audit: exactly one success row for this user.
    rows = audit_rows_for_user(admin_engine, admin_user["id"])
    actions = [r["action"] for r in rows]
    assert "auth.login.success" in actions
    success = next(r for r in rows if r["action"] == "auth.login.success")
    assert success["after"]["session_id"]
    # Defence-in-depth: no plain-password-ish field in the payload.
    assert "password" not in str(success["after"]).lower()


def test_login_email_is_case_insensitive(
    client: TestClient, admin_user: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"].upper(), "password": admin_user["password"]},
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------


def test_login_wrong_password_returns_401_and_audits(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": "wrong-password"},
    )
    assert resp.status_code == 401
    assert "maugood_session" not in client.cookies

    # Exactly one failure row, referencing the email but not the password.
    rows = audit_rows_for_email(admin_engine, admin_user["email"])
    failures = [r for r in rows if r["action"] == "auth.login.failure"]
    assert failures, "expected an auth.login.failure audit row"
    row = failures[0]
    assert row["after"]["email_attempted"] == admin_user["email"]
    assert row["after"]["reason"] == "wrong_password"
    assert "wrong-password" not in str(row["after"])  # defence-in-depth


def test_login_unknown_email_returns_401_and_audits(
    client: TestClient, admin_engine
) -> None:
    # Unique bogus email so the assertion doesn't collide with other test runs.
    bogus = "does-not-exist-p3@test.maugood"
    resp = client.post(
        "/api/auth/login",
        json={"email": bogus, "password": "irrelevant"},
    )
    assert resp.status_code == 401

    rows = audit_rows_for_email(admin_engine, bogus)
    failures = [r for r in rows if r["action"] == "auth.login.failure"]
    assert failures
    assert failures[0]["after"]["reason"] == "unknown_email"


def test_me_without_cookie_is_401(client: TestClient) -> None:
    assert client.get("/api/auth/me").status_code == 401


# ---------------------------------------------------------------------------
# Tenant routing on login
# ---------------------------------------------------------------------------


def test_login_with_friendly_slug_succeeds(
    client: TestClient, admin_user: dict
) -> None:
    """The pilot tenant's friendly slug is ``main`` (backfilled by
    migration 0026). Passing it as ``tenant_slug`` resolves the row,
    reads its ``schema_name`` (also ``main``, by pilot pre-history),
    and routes the user lookup under that schema."""

    resp = client.post(
        "/api/auth/login",
        json={
            "email": admin_user["email"],
            "password": admin_user["password"],
            "tenant_slug": "main",
        },
    )
    assert resp.status_code == 200, resp.text
    # The cookie carries the schema name (internal routing state) —
    # for the pilot, slug == schema, so the assertion is the same
    # value either way. For other tenants the cookie would hold
    # ``tenant_<slug>`` while the body sent ``<slug>``.
    assert client.cookies.get("maugood_tenant") == "main"


def test_login_with_raw_schema_name_returns_401(
    client: TestClient, admin_user: dict
) -> None:
    """Schema names ride a different namespace from friendly slugs.
    Posting ``tenant_main`` (a schema-name-shaped string) must 401:
    no row in ``public.tenants.slug`` carries that value, and the
    handler rejects rather than silently accepting either form.

    There is exactly one valid identifier per tenant (the friendly
    slug); accepting both would make the API ambiguous."""

    resp = client.post(
        "/api/auth/login",
        json={
            "email": admin_user["email"],
            "password": admin_user["password"],
            "tenant_slug": "tenant_main",
        },
    )
    assert resp.status_code == 401, resp.text
    assert resp.json()["detail"] == "invalid credentials"


def test_login_with_unknown_tenant_slug_returns_401(client: TestClient) -> None:
    """Unknown slug must 401 ``invalid credentials`` — never 404 — so
    attackers can't enumerate tenants by trying slugs."""

    resp = client.post(
        "/api/auth/login",
        json={
            "email": "anyone@example.com",
            "password": "irrelevant",
            "tenant_slug": "tenant_does_not_exist_xyz",
        },
    )
    assert resp.status_code == 401, resp.text
    assert resp.json()["detail"] == "invalid credentials"


def test_login_with_invalid_tenant_slug_format_returns_400(
    client: TestClient,
) -> None:
    """Slug must match the regex enforced by the Postgres CHECK; an
    obviously-bad slug short-circuits to 400 before any DB hit."""

    resp = client.post(
        "/api/auth/login",
        json={
            "email": "anyone@example.com",
            "password": "irrelevant",
            "tenant_slug": "1bad slug!",
        },
    )
    assert resp.status_code == 400, resp.text


def test_login_in_multi_mode_requires_tenant_slug(
    client: TestClient,
    admin_user: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``MAUGOOD_TENANT_MODE=multi`` removes the pilot's ``main`` fallback —
    a missing ``tenant_slug`` must 400, not silently log into ``main``."""

    monkeypatch.setenv("MAUGOOD_TENANT_MODE", "multi")
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "tenant_slug is required"


# ---------------------------------------------------------------------------
# Session expiry
# ---------------------------------------------------------------------------


def test_expired_session_is_rejected_and_audited(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    # Log in normally.
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200
    session_id = client.cookies.get("maugood_session")
    assert session_id

    # Poke ``expires_at`` into the past. Admin engine — app can't UPDATE
    # sessions with weird timestamps in prod either.
    with admin_engine.begin() as conn:
        conn.execute(
            update(user_sessions)
            .where(user_sessions.c.id == session_id)
            .values(expires_at=datetime.now(tz=timezone.utc) - timedelta(seconds=1))
        )

    # Next authenticated call must 401.
    assert client.get("/api/auth/me").status_code == 401

    # Audit must have an expiry row for this user/session.
    rows = audit_rows_for_user(admin_engine, admin_user["id"])
    expiries = [
        r for r in rows
        if r["action"] == "auth.session.expired" and r["entity_id"] == session_id
    ]
    assert expiries, "expected an auth.session.expired audit row"


# ---------------------------------------------------------------------------
# Logout
# ---------------------------------------------------------------------------


def test_logout_clears_session_and_cookie(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200
    session_id = client.cookies.get("maugood_session")
    assert session_id

    out = client.post("/api/auth/logout")
    assert out.status_code == 204

    # Cookie is cleared: either absent from the jar, or the jar has the
    # expired-cookie marker. Easiest: hitting /me afterwards is 401.
    assert client.get("/api/auth/me").status_code == 401

    # Audit row exists.
    rows = audit_rows_for_user(admin_engine, admin_user["id"])
    logouts = [
        r for r in rows if r["action"] == "auth.logout" and r["entity_id"] == session_id
    ]
    assert logouts, "expected an auth.logout audit row"


# ---------------------------------------------------------------------------
# Role guards
# ---------------------------------------------------------------------------
# Mount a tiny ad-hoc router to exercise the guard deps directly. We don't
# ship guarded endpoints until P5+, so this is the cleanest way to unit-test
# the dep shapes today.

_guard_router = APIRouter(prefix="/api/_test")


@_guard_router.get("/admin-only")
def _admin_only(user=Depends(require_role("Admin"))):
    return {"user_id": user.id}


@_guard_router.get("/admin-or-hr")
def _admin_or_hr(user=Depends(require_any_role("Admin", "HR"))):
    return {"user_id": user.id}


@_guard_router.get("/dept/{department_id}")
def _dept_scoped(user=Depends(require_department)):
    return {"user_id": user.id}


app.include_router(_guard_router)


def _login(client: TestClient, email: str, password: str) -> None:
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text


def test_require_role_allows_admin(client: TestClient, admin_user: dict) -> None:
    _login(client, admin_user["email"], admin_user["password"])
    assert client.get("/api/_test/admin-only").status_code == 200


def test_require_role_denies_employee(client: TestClient, employee_user: dict) -> None:
    _login(client, employee_user["email"], employee_user["password"])
    resp = client.get("/api/_test/admin-only")
    assert resp.status_code == 403
    assert "Admin" in resp.json()["detail"]


def test_require_any_role_allows_admin(client: TestClient, admin_user: dict) -> None:
    _login(client, admin_user["email"], admin_user["password"])
    assert client.get("/api/_test/admin-or-hr").status_code == 200


def test_require_any_role_denies_employee(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user["email"], employee_user["password"])
    assert client.get("/api/_test/admin-or-hr").status_code == 403


def test_require_department_admin_bypasses(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user["email"], admin_user["password"])
    # Admin bypasses the department check even for a non-existent dept id.
    assert client.get("/api/_test/dept/9999").status_code == 200


def test_require_department_denies_non_member(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user["email"], employee_user["password"])
    # Employee has no department assignments in the fixture.
    assert client.get("/api/_test/dept/9999").status_code == 403
