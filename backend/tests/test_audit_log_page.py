"""Audit Log page read surface: filters, summary, actors, CSV export.

Covers the read-only additions to ``/api/audit-log`` (text search,
category / kind / hide-routine filters, ``/summary``, ``/actors``,
``/export.csv``) plus a cross-tenant no-leak check: rows stamped with
another tenant's id in the same schema must never surface through any
of the endpoints (the explicit ``WHERE tenant_id`` wall).
"""

from __future__ import annotations

import csv
import io
import secrets
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select

from maugood.audit_log import catalog
from maugood.db import audit_log

OWN_TENANT = 1
FOREIGN_TENANT = 2


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login", json={"email": user["email"], "password": user["password"]}
    )
    assert resp.status_code == 200, resp.text


@pytest.fixture
def seeded(admin_engine, admin_user):  # type: ignore[no-untyped-def]
    """Seed a marker-tagged set of audit rows for tenant 1 plus one
    foreign-tenant row carrying the same marker."""

    marker = f"audit-page-{secrets.token_hex(4)}"
    now = datetime.now(timezone.utc)
    rows = [
        # (tenant, actor, action, entity_type, entity_id, after)
        (OWN_TENANT, admin_user["id"], "employee.created", "employee", "991", {"full_name": f"{marker} Person"}),
        (OWN_TENANT, admin_user["id"], "employee.updated", "employee", "991", {"note": marker}),
        (OWN_TENANT, admin_user["id"], "auth.login.failure", "user", None, {"reason": "wrong_password", "m": marker}),
        (OWN_TENANT, admin_user["id"], "detection_event.crop_viewed", "detection_event", "5", {"m": marker}),
        (OWN_TENANT, admin_user["id"], "detection_event.crop_viewed", "detection_event", "6", {"m": marker}),
        (OWN_TENANT, None, "clip_cleanup.auto_deleted_after_processing", "person_clips", "4139", {"m": marker}),
        (FOREIGN_TENANT, None, "employee.purged", "employee", "777", {"full_name": f"{marker} Foreign"}),
    ]
    ids: list[int] = []
    with admin_engine.begin() as conn:
        for tid, actor, action, etype, eid, after in rows:
            ids.append(
                conn.execute(
                    insert(audit_log)
                    .values(
                        tenant_id=tid,
                        actor_user_id=actor,
                        action=action,
                        entity_type=etype,
                        entity_id=eid,
                        after=after,
                        created_at=now - timedelta(minutes=1),
                    )
                    .returning(audit_log.c.id)
                ).scalar_one()
            )
    try:
        yield {"marker": marker, "ids": ids, "start": (now - timedelta(hours=1)).isoformat()}
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(audit_log).where(audit_log.c.id.in_(ids)))
            conn.execute(delete(audit_log).where(audit_log.c.action == "audit_log.exported", audit_log.c.actor_user_id == admin_user["id"]))


def test_catalog_classification() -> None:
    assert catalog.category_of("auth.login.failure") == "security"
    assert catalog.category_of("auth.preferred_theme.updated") == "settings"
    assert catalog.category_of("employee.created") == "people"
    assert catalog.category_of("clip_cleanup.auto_deleted_after_processing") == "storage"
    assert catalog.category_of("something.unknown") == "other"
    assert catalog.severity_of("employee.hard_deleted") == "high"
    assert catalog.severity_of("auth.login.failure") == "warning"
    assert catalog.severity_of("employee.created") == "info"
    assert catalog.is_routine("detection_event.crop_viewed")
    assert catalog.is_routine("photo.viewed")
    assert not catalog.is_routine("employee.created")
    assert catalog.is_failure("auth.login.failure")
    assert catalog.is_change("employee.updated")
    assert not catalog.is_change("photo.viewed")
    assert catalog.humanize("clip_cleanup.executed") == "Clip cleanup executed"


def test_text_search_and_item_shape(client: TestClient, admin_user: dict, seeded) -> None:
    _login(client, admin_user)
    body = client.get("/api/audit-log", params={"q": seeded["marker"]}).json()
    # 6 own-tenant rows match; the foreign one never does.
    assert body["total"] == 6
    created = next(i for i in body["items"] if i["action"] == "employee.created")
    assert created["category"] == "people"
    assert created["severity"] == "info"
    assert created["entity_label"] == f"{seeded['marker']} Person"
    assert created["actor_name"] == "Test Admin"
    viewed = next(i for i in body["items"] if i["action"] == "detection_event.crop_viewed")
    assert viewed["is_routine"] is True


def test_hide_routine_category_kind_and_actor_filters(client: TestClient, admin_user: dict, seeded) -> None:
    _login(client, admin_user)
    base = {"q": seeded["marker"]}
    assert client.get("/api/audit-log", params={**base, "hide_routine": "true"}).json()["total"] == 4
    sec = client.get("/api/audit-log", params={**base, "category": "security"}).json()
    assert [i["action"] for i in sec["items"]] == ["auth.login.failure"]
    multi = client.get("/api/audit-log", params=[("q", seeded["marker"]), ("category", "people"), ("category", "storage")]).json()
    assert multi["total"] == 3
    assert client.get("/api/audit-log", params={**base, "kind": "system"}).json()["total"] == 1
    assert client.get("/api/audit-log", params={**base, "kind": "changes"}).json()["total"] == 3
    assert client.get("/api/audit-log", params={**base, "kind": "failures"}).json()["total"] == 1
    assert client.get("/api/audit-log", params={**base, "actor": "system"}).json()["total"] == 1
    assert client.get("/api/audit-log", params={**base, "actor_user_id": admin_user["id"]}).json()["total"] == 5
    assert client.get("/api/audit-log", params={"category": "nope"}).status_code == 400
    assert client.get("/api/audit-log", params={"kind": "nope"}).status_code == 400


def test_summary_counts(client: TestClient, admin_user: dict, seeded) -> None:
    _login(client, admin_user)
    s = client.get("/api/audit-log/summary", params={"q": seeded["marker"], "hide_routine": "true"}).json()
    assert s["total"] == 4
    assert s["routine_hidden"] == 2
    assert s["security"] == 1
    assert s["failures"] == 1
    assert s["changes"] == 3
    assert s["system"] == 1
    assert s["by_category"]["people"] == 2
    # The tile kind is ignored by /summary so tiles don't zero each other.
    s2 = client.get("/api/audit-log/summary", params={"q": seeded["marker"], "hide_routine": "true", "kind": "system"}).json()
    assert s2["total"] == 4


def test_actors_lists_log_users(client: TestClient, admin_user: dict, seeded) -> None:
    _login(client, admin_user)
    body = client.get("/api/audit-log/actors").json()
    me = next(a for a in body["items"] if a["id"] == admin_user["id"])
    assert me["email"] == admin_user["email"]
    assert me["events"] >= 5
    assert body["system_events"] >= 1


def test_csv_export_and_audit_row(client: TestClient, admin_user: dict, seeded, admin_engine) -> None:
    _login(client, admin_user)
    resp = client.get("/api/audit-log/export.csv", params={"q": seeded["marker"], "hide_routine": "true"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    rows = list(csv.DictReader(io.StringIO(resp.text.lstrip("﻿"))))
    assert len(rows) == 4
    assert {r["action"] for r in rows} == {
        "employee.created",
        "employee.updated",
        "auth.login.failure",
        "clip_cleanup.auto_deleted_after_processing",
    }
    assert seeded["marker"] not in " ".join(r["entity_label"] for r in rows if r["action"] == "employee.purged")
    with admin_engine.begin() as conn:
        n = conn.execute(
            select(audit_log.c.id).where(
                audit_log.c.action == "audit_log.exported",
                audit_log.c.actor_user_id == admin_user["id"],
            )
        ).all()
    assert len(n) == 1


def test_no_cross_tenant_leak(client: TestClient, admin_user: dict, seeded) -> None:
    """A foreign-tenant row in the same schema never surfaces."""

    _login(client, admin_user)
    m = seeded["marker"]
    foreign_id = seeded["ids"][-1]
    listed = client.get("/api/audit-log", params={"q": m, "page_size": 200}).json()
    assert foreign_id not in {i["id"] for i in listed["items"]}
    assert all("Foreign" not in str(i["after"]) for i in listed["items"])
    by_id = client.get("/api/audit-log", params={"entity_id": "777", "entity_type": "employee", "start": seeded["start"]}).json()
    assert foreign_id not in {i["id"] for i in by_id["items"]}
    summ = client.get("/api/audit-log/summary", params={"q": f"{m} Foreign"}).json()
    assert summ["total"] == 0
    csv_body = client.get("/api/audit-log/export.csv", params={"q": m}).text
    assert "Foreign" not in csv_body
    assert "employee.purged" not in csv_body


def test_new_endpoints_admin_only(client: TestClient, employee_user: dict) -> None:
    _login(client, employee_user)
    for path in ("/api/audit-log/summary", "/api/audit-log/actors", "/api/audit-log/export.csv"):
        assert client.get(path).status_code == 403


def test_no_write_routes_on_audit_log() -> None:
    from maugood.audit_log.router import router

    for route in router.routes:
        assert getattr(route, "methods", {"GET"}) <= {"GET", "HEAD"}, route


def test_sensitive_payload_values_are_redacted(client: TestClient, admin_user: dict, admin_engine) -> None:
    """Session ids (= session tokens) and other secrets never leave the
    API — not in the list, a filtered single-row lookup, the CSV, nor as
    a search oracle. The stored row itself is untouched (append-only)."""

    secret_session = "SESS" + secrets.token_urlsafe(24)
    secret_token = "TOK" + secrets.token_urlsafe(16)
    marker = f"redact-{secrets.token_hex(4)}"
    with admin_engine.begin() as conn:
        rid = conn.execute(
            insert(audit_log)
            .values(
                tenant_id=OWN_TENANT,
                actor_user_id=admin_user["id"],
                action="auth.login.success",
                entity_type="user",
                entity_id=marker,
                before={"Client_Secret": "cs-" + secret_token},
                after={
                    "ip": "10.0.0.1",
                    "session_id": secret_session,
                    "nested": {"push_token": secret_token, "Password": "pw", "cookie": "c=1"},
                    "items": [{"api_key": secret_token}],
                },
            )
            .returning(audit_log.c.id)
        ).scalar_one()
    try:
        _login(client, admin_user)
        listed = client.get("/api/audit-log", params={"entity_id": marker})
        assert listed.status_code == 200
        body = listed.text
        assert secret_session not in body and secret_token not in body
        item = listed.json()["items"][0]
        assert item["id"] == rid
        assert item["after"]["session_id"] == "[redacted]"
        assert item["after"]["nested"]["push_token"] == "[redacted]"
        assert item["after"]["nested"]["Password"] == "[redacted]"
        assert item["after"]["nested"]["cookie"] == "[redacted]"
        assert item["after"]["items"][0]["api_key"] == "[redacted]"
        assert item["before"]["Client_Secret"] == "[redacted]"
        assert item["after"]["ip"] == "10.0.0.1"
        csv_text = client.get("/api/audit-log/export.csv", params={"entity_id": marker}).text
        assert secret_session not in csv_text and secret_token not in csv_text
        assert "[redacted]" in csv_text
        # Searching for the secret must not find (and so confirm) the row.
        probe = client.get("/api/audit-log", params={"q": secret_session[:20]}).json()
        assert rid not in {i["id"] for i in probe["items"]}
        # The stored row is unchanged.
        with admin_engine.begin() as conn:
            stored = conn.execute(select(audit_log.c.after).where(audit_log.c.id == rid)).scalar_one()
        assert stored["session_id"] == secret_session
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(audit_log).where(audit_log.c.id == rid))
            conn.execute(delete(audit_log).where(audit_log.c.action == "audit_log.exported", audit_log.c.actor_user_id == admin_user["id"]))
