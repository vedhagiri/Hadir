"""Regression test: attendance regenerate endpoints must be audited.

Previously `/api/attendance/regenerate{,-employee,-range}` mutated
``attendance_records`` but wrote no audit row. This asserts the
operator-triggered recompute now lands an ``attendance.regenerated``
audit row in the active tenant schema.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import desc, select

from maugood.auth.audit import audit_log
from maugood.db import get_engine, tenant_context


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def test_regenerate_writes_audit_row(client: TestClient, admin_user: dict) -> None:
    _login(client, admin_user)
    resp = client.post("/api/attendance/regenerate")
    assert resp.status_code == 200, resp.text

    with tenant_context("main"):
        with get_engine().begin() as conn:
            row = conn.execute(
                select(
                    audit_log.c.action,
                    audit_log.c.entity_type,
                    audit_log.c.actor_user_id,
                )
                .where(audit_log.c.action == "attendance.regenerated")
                .order_by(desc(audit_log.c.id))
                .limit(1)
            ).first()

    assert row is not None, "no attendance.regenerated audit row written"
    assert row.entity_type == "attendance"
    assert row.actor_user_id is not None
