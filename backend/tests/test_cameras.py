"""Tests for P7: cameras CRUD, RTSP encryption, host-only responses,
preview (stubbed to avoid needing a live camera in CI)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from hadir.cameras import rtsp as rtsp_io
from hadir.db import cameras


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


PLAIN_URL = "rtsp://hadir_admin:supersecret@10.0.0.50:8554/stream/main"
OTHER_HOST_URL = "rtsp://other:pw@10.0.0.99:8554/stream/main"


# ---------------------------------------------------------------------------
# Host parser + encryption round-trip
# ---------------------------------------------------------------------------


def test_rtsp_host_strips_userinfo_and_keeps_nonstandard_port() -> None:
    assert rtsp_io.rtsp_host("rtsp://u:p@10.0.0.50:8554/path") == "10.0.0.50:8554"
    assert rtsp_io.rtsp_host("rtsp://u:p@cam.local:554/path") == "cam.local"
    assert rtsp_io.rtsp_host("rtsp://cam.local/path") == "cam.local"


def test_rtsp_encrypt_decrypt_round_trip() -> None:
    token = rtsp_io.encrypt_url(PLAIN_URL)
    assert token != PLAIN_URL
    # Fernet urlsafe base64 tokens start with "gAAAA..."
    assert token.startswith("gAAAA")
    assert rtsp_io.decrypt_url(token) == PLAIN_URL


# ---------------------------------------------------------------------------
# CRUD: response never carries rtsp_url; DB carries only the ciphertext
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_cameras")
def test_create_returns_host_not_url_and_stores_ciphertext(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    resp = client.post(
        "/api/cameras",
        json={
            "name": "Lobby",
            "location": "HQ · Lobby",
            "rtsp_url": PLAIN_URL,
            "enabled": True,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["rtsp_host"] == "10.0.0.50:8554"
    # No credential-adjacent keys anywhere in the response.
    assert "rtsp_url" not in body
    assert "password" not in str(body).lower()
    assert "supersecret" not in str(body)

    # DB column is ciphertext, never plain.
    with admin_engine.begin() as conn:
        raw = conn.execute(
            select(cameras.c.rtsp_url_encrypted).where(
                cameras.c.id == body["id"]
            )
        ).scalar_one()
    assert "rtsp://" not in raw
    assert "supersecret" not in raw
    assert raw.startswith("gAAAA")


@pytest.mark.usefixtures("clean_cameras")
def test_list_returns_host_only(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    for name, url in [("Lobby", PLAIN_URL), ("Gate", OTHER_HOST_URL)]:
        client.post(
            "/api/cameras",
            json={"name": name, "location": "", "rtsp_url": url, "enabled": True},
        )

    body = client.get("/api/cameras").json()
    assert len(body["items"]) == 2
    for item in body["items"]:
        assert "rtsp_url" not in item
        assert "://" not in item["rtsp_host"]


# ---------------------------------------------------------------------------
# PATCH without rtsp_url leaves credential untouched
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_cameras")
def test_patch_without_rtsp_url_keeps_original_credential(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    create = client.post(
        "/api/cameras",
        json={
            "name": "Loading Dock",
            "location": "Warehouse A",
            "rtsp_url": PLAIN_URL,
            "enabled": True,
        },
    ).json()
    original_cipher = _raw_cipher(admin_engine, create["id"])

    # Edit only location — no rtsp_url in the body.
    resp = client.patch(
        f"/api/cameras/{create['id']}",
        json={"location": "Warehouse B"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["location"] == "Warehouse B"
    assert resp.json()["rtsp_host"] == "10.0.0.50:8554"

    assert _raw_cipher(admin_engine, create["id"]) == original_cipher


@pytest.mark.usefixtures("clean_cameras")
def test_patch_with_new_rtsp_url_rotates_cipher(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    create = client.post(
        "/api/cameras",
        json={
            "name": "Loading Dock",
            "location": "Warehouse A",
            "rtsp_url": PLAIN_URL,
            "enabled": True,
        },
    ).json()
    before_cipher = _raw_cipher(admin_engine, create["id"])

    resp = client.patch(
        f"/api/cameras/{create['id']}",
        json={"rtsp_url": OTHER_HOST_URL},
    )
    assert resp.status_code == 200
    assert resp.json()["rtsp_host"] == "10.0.0.99:8554"

    after_cipher = _raw_cipher(admin_engine, create["id"])
    assert after_cipher != before_cipher


# ---------------------------------------------------------------------------
# Audit records host only
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_cameras")
def test_audit_rows_never_contain_plain_url(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    from hadir.db import audit_log

    _login(client, admin_user)
    create = client.post(
        "/api/cameras",
        json={
            "name": "Lobby",
            "location": "",
            "rtsp_url": PLAIN_URL,
            "enabled": True,
        },
    ).json()
    client.patch(f"/api/cameras/{create['id']}", json={"location": "HQ"})
    client.delete(f"/api/cameras/{create['id']}")

    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.before, audit_log.c.after).where(
                audit_log.c.entity_type == "camera"
            )
        ).all()
    assert rows

    actions = {r.action for r in rows}
    assert {"camera.created", "camera.updated", "camera.deleted"} <= actions

    for row in rows:
        for blob in (row.before, row.after):
            s = str(blob)
            assert "rtsp://" not in s
            assert "supersecret" not in s
            # The audit is allowed to carry rtsp_host (no userinfo) only.
            if "rtsp_host" in s:
                assert "@" not in s


# ---------------------------------------------------------------------------
# Preview endpoint: stubbed grab returns canned JPEG
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_cameras")
def test_preview_endpoint_streams_stubbed_jpeg(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    create = client.post(
        "/api/cameras",
        json={
            "name": "Lobby",
            "location": "",
            "rtsp_url": PLAIN_URL,
            "enabled": True,
        },
    ).json()

    canned = b"\xff\xd8\xff\xe0STUBBED-JPEG-BYTES"

    def stub(plain_url: str, *, host_label: str) -> bytes:
        # The stub receives the plaintext URL because preview has to
        # decrypt-to-use; it's on us (prod) not to leak it. Make sure
        # the host_label at least doesn't carry userinfo.
        assert host_label == "10.0.0.50:8554"
        assert "@" not in host_label
        return canned

    rtsp_io.set_preview_stub(stub)
    try:
        resp = client.get(f"/api/cameras/{create['id']}/preview")
    finally:
        rtsp_io.clear_preview_stub()

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.content == canned


@pytest.mark.usefixtures("clean_cameras")
def test_preview_504_on_timeout(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    create = client.post(
        "/api/cameras",
        json={
            "name": "Dead Camera",
            "location": "",
            "rtsp_url": PLAIN_URL,
            "enabled": True,
        },
    ).json()

    def stub(_plain_url: str, *, host_label: str) -> bytes:  # noqa: ARG001
        raise RuntimeError("preview timed out")

    rtsp_io.set_preview_stub(stub)
    try:
        resp = client.get(f"/api/cameras/{create['id']}/preview")
    finally:
        rtsp_io.clear_preview_stub()

    assert resp.status_code == 504
    assert "timed out" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Role guard
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_cameras")
def test_employee_role_is_forbidden(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    assert client.get("/api/cameras").status_code == 403


def _raw_cipher(engine, camera_id: int) -> str:
    with engine.begin() as conn:
        return conn.execute(
            select(cameras.c.rtsp_url_encrypted).where(cameras.c.id == camera_id)
        ).scalar_one()
