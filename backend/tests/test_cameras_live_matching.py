"""Tests for migration 0072: per-camera ``live_matching_enabled``.

Moves live face-recognition/matching off the tenant-wide
``tenant_settings.live_matching_enabled`` flag onto each camera row.
Covers the API surface: create default (False), create explicit True,
PATCH round-trip, bulk-update across cameras, and that the audit
before/after payload carries the flag so a flip is visible.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from maugood.db import audit_log, cameras

PLAIN_URL = "rtsp://maugood_admin:supersecret@10.0.0.50:8554/stream/main"
OTHER_HOST_URL = "rtsp://other:pw@10.0.0.99:8554/stream/main"


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _create(client: TestClient, name: str, url: str, **extra) -> dict:
    body = {"name": name, "location": "", "rtsp_url": url}
    body.update(extra)
    resp = client.post("/api/cameras", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.usefixtures("clean_cameras")
def test_create_defaults_live_matching_false(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    """A freshly-added camera does nothing until the operator turns on
    what they want — live matching defaults OFF (per migration 0072 +
    the API default)."""

    _login(client, admin_user)
    cam = _create(client, "Lobby", PLAIN_URL)
    assert cam["live_matching_enabled"] is False

    with admin_engine.begin() as conn:
        db_val = conn.execute(
            select(cameras.c.live_matching_enabled).where(
                cameras.c.id == cam["id"]
            )
        ).scalar_one()
    assert db_val is False


@pytest.mark.usefixtures("clean_cameras")
def test_create_with_live_matching_true(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    cam = _create(client, "Gate", PLAIN_URL, live_matching_enabled=True)
    assert cam["live_matching_enabled"] is True

    with admin_engine.begin() as conn:
        db_val = conn.execute(
            select(cameras.c.live_matching_enabled).where(
                cameras.c.id == cam["id"]
            )
        ).scalar_one()
    assert db_val is True


@pytest.mark.usefixtures("clean_cameras")
def test_patch_toggles_live_matching_and_audits(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    """PATCH round-trips the flag and the audit before/after carries it."""

    _login(client, admin_user)
    cam = _create(client, "Lobby", PLAIN_URL)
    assert cam["live_matching_enabled"] is False

    resp = client.patch(
        f"/api/cameras/{cam['id']}",
        json={"live_matching_enabled": True},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["live_matching_enabled"] is True

    with admin_engine.begin() as conn:
        db_val = conn.execute(
            select(cameras.c.live_matching_enabled).where(
                cameras.c.id == cam["id"]
            )
        ).scalar_one()
    assert db_val is True

    # Audit before=False, after=True on the camera.updated row.
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(
                audit_log.c.action,
                audit_log.c.before,
                audit_log.c.after,
            )
            .where(audit_log.c.entity_type == "camera")
            .where(audit_log.c.entity_id == str(cam["id"]))
            .where(audit_log.c.action == "camera.updated")
        ).all()
    matched = [
        r
        for r in rows
        if r.before
        and r.after
        and r.before.get("live_matching_enabled") is False
        and r.after.get("live_matching_enabled") is True
    ]
    assert matched, f"no audit row captured the live_matching flip: {rows}"


@pytest.mark.usefixtures("clean_cameras")
def test_bulk_update_sets_live_matching_across_cameras(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    a = _create(client, "Lobby", PLAIN_URL)
    b = _create(client, "Gate", OTHER_HOST_URL)
    assert a["live_matching_enabled"] is False
    assert b["live_matching_enabled"] is False

    resp = client.post(
        "/api/cameras/bulk-update",
        json={
            "camera_ids": [a["id"], b["id"]],
            "live_matching_enabled": True,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["updated"] == 2
    assert body["not_found"] == []
    for cam in body["cameras"]:
        assert cam["live_matching_enabled"] is True

    with admin_engine.begin() as conn:
        vals = conn.execute(
            select(cameras.c.id, cameras.c.live_matching_enabled).where(
                cameras.c.id.in_([a["id"], b["id"]])
            )
        ).all()
    assert all(v.live_matching_enabled is True for v in vals)

    # Audit rows carry the flag + the bulk marker.
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.entity_id, audit_log.c.after)
            .where(audit_log.c.entity_type == "camera")
            .where(audit_log.c.action == "camera.updated")
        ).all()
    bulk_rows = [
        r for r in rows if r.after and r.after.get("bulk_update") is True
    ]
    touched = {r.entity_id for r in bulk_rows}
    assert {str(a["id"]), str(b["id"])} <= touched
    for r in bulk_rows:
        assert r.after["live_matching_enabled"] is True
