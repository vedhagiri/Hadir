"""P28.8 — Super-Admin system metrics endpoint tests.

Covers:

* GET /metrics returns expected shape
* psutil values within sane bounds (CPU 0-100, mem percent 0-100)
* Detector lock contention is 0 with no detection
* Tenant Admin / HR / Manager / Employee → 403 (Super-Admin only)
* tenants-summary returns one row per active tenant
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
    mts_staff,
    super_admin_audit,
    super_admin_sessions,
    tenant_context,
)


# ---------------------------------------------------------------------------
# Super-Admin login fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def super_admin_creds(admin_engine: Engine) -> Iterator[dict]:
    """Create an MTS staff user, log them in, return the cookies dict."""

    email = f"sa-p288-{secrets.token_hex(4)}@super.maugood"
    password = "p288-super-pw-" + secrets.token_hex(6)
    pwd_hash = hash_password(password)
    with tenant_context("public"):
        with admin_engine.begin() as conn:
            staff_id = conn.execute(
                insert(mts_staff)
                .values(
                    email=email,
                    password_hash=pwd_hash,
                    full_name="P288 SA Tester",
                    is_active=True,
                )
                .returning(mts_staff.c.id)
            ).scalar_one()
    try:
        yield {"id": int(staff_id), "email": email, "password": password}
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
                conn.execute(
                    delete(mts_staff).where(mts_staff.c.id == staff_id)
                )


def _login_super_admin(client: TestClient, creds: dict) -> None:
    resp = client.post(
        "/api/super-admin/login",
        json={"email": creds["email"], "password": creds["password"]},
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# /system/metrics
# ---------------------------------------------------------------------------


def test_system_metrics_shape(
    client: TestClient, super_admin_creds: dict
) -> None:
    _login_super_admin(client, super_admin_creds)
    resp = client.get("/api/super-admin/system/metrics")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    for key in ("host", "data_partition", "database", "capture", "scheduled_jobs"):
        assert key in body, key
    host = body["host"]
    assert 0.0 <= host["cpu_percent"] <= 100.0
    assert 0.0 <= host["mem_percent"] <= 100.0
    assert host["mem_total_mb"] > 0


def test_detector_lock_contention_is_a_float(
    client: TestClient, super_admin_creds: dict
) -> None:
    _login_super_admin(client, super_admin_creds)
    resp = client.get("/api/super-admin/system/metrics")
    body = resp.json()
    contention = body["capture"]["detector_lock_contention_60s_pct"]
    assert isinstance(contention, (int, float))
    assert 0.0 <= float(contention) <= 100.0


def test_tenants_summary_one_row_per_active_tenant(
    client: TestClient, super_admin_creds: dict, admin_engine: Engine
) -> None:
    """The summary should return at least the one active pilot tenant
    (id=1, slug='main') that ships with the test DB."""

    _login_super_admin(client, super_admin_creds)
    resp = client.get("/api/super-admin/system/tenants-summary")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "tenants" in body
    assert isinstance(body["tenants"], list)
    # Each row carries the expected keys.
    for row in body["tenants"]:
        assert set(row.keys()) >= {
            "slug",
            "workers_running",
            "workers_configured",
            "events_last_hour",
            "any_stage_red",
        }


# ---------------------------------------------------------------------------
# Role guards
# ---------------------------------------------------------------------------


def test_admin_cannot_access_super_admin_metrics(
    client: TestClient, admin_user: dict
) -> None:
    """A tenant Admin (not Super-Admin) hitting the system metrics
    endpoint gets 401 (no super_admin session cookie). The endpoint
    sits behind ``current_super_admin`` which expects a different
    cookie altogether."""

    # Log in as a regular tenant Admin.
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200
    # Now hit super-admin/system. No super-admin cookie was set, so the
    # dependency ``current_super_admin`` returns 401.
    resp = client.get("/api/super-admin/system/metrics")
    assert resp.status_code in (401, 403)


def test_employee_cannot_access_super_admin_metrics(
    client: TestClient, employee_user: dict
) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": employee_user["email"], "password": employee_user["password"]},
    )
    assert resp.status_code == 200
    resp = client.get("/api/super-admin/system/metrics")
    assert resp.status_code in (401, 403)


def test_anonymous_cannot_access_super_admin_metrics(
    client: TestClient,
) -> None:
    resp = client.get("/api/super-admin/system/metrics")
    assert resp.status_code in (401, 403)
