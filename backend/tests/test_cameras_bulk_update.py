"""Tests for the bulk camera-toggle endpoint (POST /api/cameras/bulk-update).

Mirrors the single-PATCH mechanics: Admin-only, audited as
``camera.updated`` (with ``after.bulk_update == True``), unknown /
cross-tenant ids fall into ``not_found`` (never 403), and an all-``None``
toggle body is rejected with 400.
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


def _create(client: TestClient, name: str, url: str) -> dict:
    resp = client.post(
        "/api/cameras",
        json={
            "name": name,
            "location": "",
            "rtsp_url": url,
            # Start enabled so the bulk-disable flip is observable.
            "worker_enabled": True,
            "display_enabled": True,
            "detection_enabled": True,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.usefixtures("clean_cameras")
def test_bulk_disable_worker_and_detection_two_cameras(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    a = _create(client, "Lobby", PLAIN_URL)
    b = _create(client, "Gate", OTHER_HOST_URL)

    resp = client.post(
        "/api/cameras/bulk-update",
        json={
            "camera_ids": [a["id"], b["id"]],
            "worker_enabled": False,
            "detection_enabled": False,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["updated"] == 2
    assert body["not_found"] == []
    assert len(body["cameras"]) == 2

    for cam in body["cameras"]:
        assert cam["worker_enabled"] is False
        assert cam["detection_enabled"] is False
        # Untouched toggles stay as they were.
        assert cam["display_enabled"] is True

    # Audit rows: camera.updated with after.bulk_update == True for each.
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.entity_id, audit_log.c.after)
            .where(audit_log.c.entity_type == "camera")
            .where(audit_log.c.action == "camera.updated")
        ).all()
    bulk_rows = [r for r in rows if r.after and r.after.get("bulk_update") is True]
    updated_entities = {r.entity_id for r in bulk_rows}
    assert {str(a["id"]), str(b["id"])} <= updated_entities
    for r in bulk_rows:
        assert r.after["worker_enabled"] is False
        assert r.after["detection_enabled"] is False


@pytest.mark.usefixtures("clean_cameras")
def test_bulk_update_real_plus_nonexistent_id(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    a = _create(client, "Lobby", PLAIN_URL)
    ghost_id = a["id"] + 99999

    resp = client.post(
        "/api/cameras/bulk-update",
        json={
            "camera_ids": [a["id"], ghost_id],
            "display_enabled": False,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["updated"] == 1
    assert body["not_found"] == [ghost_id]
    assert len(body["cameras"]) == 1
    assert body["cameras"][0]["id"] == a["id"]
    assert body["cameras"][0]["display_enabled"] is False


@pytest.mark.usefixtures("clean_cameras")
def test_bulk_update_empty_toggles_is_400(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    a = _create(client, "Lobby", PLAIN_URL)

    resp = client.post(
        "/api/cameras/bulk-update",
        json={"camera_ids": [a["id"]]},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["field"] == "toggles"


@pytest.mark.usefixtures("clean_cameras")
def test_bulk_update_explicit_null_toggles_is_400(
    client: TestClient, admin_user: dict
) -> None:
    """All-``None`` toggles (sent explicitly) also reject — only present,
    non-null toggle keys count."""

    _login(client, admin_user)
    a = _create(client, "Lobby", PLAIN_URL)

    resp = client.post(
        "/api/cameras/bulk-update",
        json={
            "camera_ids": [a["id"]],
            "worker_enabled": None,
            "display_enabled": None,
            "detection_enabled": None,
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["field"] == "toggles"


@pytest.mark.usefixtures("clean_cameras")
def test_empty_camera_ids_is_422(client: TestClient, admin_user: dict) -> None:
    """``camera_ids`` requires at least one item (Field min_length=1)."""

    _login(client, admin_user)
    resp = client.post(
        "/api/cameras/bulk-update",
        json={"camera_ids": [], "worker_enabled": False},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.usefixtures("clean_cameras")
def test_employee_role_is_forbidden(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    resp = client.post(
        "/api/cameras/bulk-update",
        json={"camera_ids": [1], "worker_enabled": False},
    )
    assert resp.status_code == 403


@pytest.mark.usefixtures("clean_cameras")
def test_out_of_scope_camera_id_lands_in_not_found_never_403(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    """Tenant-isolation guard. A ``camera_id`` that doesn't resolve in
    the caller's tenant comes back in ``not_found`` (NOT 403), and no
    other camera in the tenant is touched as a side effect.

    The conftest harness is single-tenant, so this exercises the exact
    code path a cross-tenant id would hit: ``repo.get_camera`` (which
    filters ``WHERE tenant_id = :scope``) returns ``None``, so the id is
    skipped into ``not_found``. The true two-tenant cross-read guarantee
    is covered by the P5 isolation canaries
    (``tests/test_two_tenant_isolation.py``); this asserts the
    bulk-update handler honours the same contract — never a 403, never a
    modification of a non-matching row.
    """

    _login(client, admin_user)
    a = _create(client, "Lobby", PLAIN_URL)
    b = _create(client, "Gate", OTHER_HOST_URL)
    out_of_scope_id = max(a["id"], b["id"]) + 99999

    resp = client.post(
        "/api/cameras/bulk-update",
        json={
            "camera_ids": [a["id"], out_of_scope_id],
            "worker_enabled": False,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Out-of-scope id lands in not_found, never a 403.
    assert body["updated"] == 1
    assert body["not_found"] == [out_of_scope_id]
    assert [c["id"] for c in body["cameras"]] == [a["id"]]

    # The camera that was NOT in the request (b) is untouched — proving
    # the handler only mutates rows it explicitly resolved + matched.
    with admin_engine.begin() as conn:
        b_worker = conn.execute(
            select(cameras.c.worker_enabled).where(cameras.c.id == b["id"])
        ).scalar_one()
    assert b_worker is True
