"""Tests for person clips — API surface + clip recording.

Run with: ``docker compose exec backend pytest tests/test_person_clips.py -q``
"""

from __future__ import annotations

import struct
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import select

from maugood.db import (
    cameras,
    get_engine,
    person_clips,
)
from maugood.cameras.rtsp import encrypt_url
from maugood.employees.photos import encrypt_bytes, decrypt_bytes
from maugood.tenants.scope import TenantScope


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_dummy_jpeg(width: int = 160, height: int = 120) -> bytes:
    """Return a minimal valid JPEG (1×1 grey pixel)."""
    import cv2  # noqa: PLC0415
    img = np.zeros((height, width, 3), dtype=np.uint8) + 128
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 50])
    assert ok
    return bytes(buf.tobytes())


def _login(client, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# API tests
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("clean_cameras", "clean_employees")
class TestPersonClipsAPI:
    """Test the person-clips endpoints. Requires seeded clips in the DB."""

    def _seed_camera(self, admin_engine, tenant_id: int, camera_id: int) -> None:
        """Ensure a camera row exists for the given id."""
        from sqlalchemy import insert, select
        with admin_engine.begin() as conn:
            existing = conn.execute(
                select(cameras.c.id).where(
                    cameras.c.id == camera_id,
                    cameras.c.tenant_id == tenant_id,
                )
            ).first()
            if existing is None:
                conn.execute(
                    insert(cameras).values(
                        id=camera_id,
                        tenant_id=tenant_id,
                        name=f"Test Camera {camera_id}",
                        location="Test",
                        rtsp_url_encrypted=encrypt_url("rtsp://test:test@localhost/test"),
                        worker_enabled=True,
                        display_enabled=True,
                        detection_enabled=True,
                    )
                )

    def _seed_clip(self, admin_engine, tenant_id: int, camera_id: int,
                   employee_id: int | None = None) -> int:
        """Insert a fake person_clips row. Returns the new id."""
        self._seed_camera(admin_engine, tenant_id, camera_id)
        from sqlalchemy import insert
        now = datetime.now(tz=timezone.utc)
        fake_path = f"/tmp/test-clip-{tenant_id}-{camera_id}-{int(now.timestamp())}.mp4"
        with admin_engine.begin() as conn:
            result = conn.execute(
                insert(person_clips).values(
                    tenant_id=tenant_id,
                    camera_id=camera_id,
                    employee_id=employee_id,
                    track_id="test-track",
                    clip_start=now,
                    clip_end=now,
                    duration_seconds=5.0,
                    file_path=fake_path,
                    filesize_bytes=1024,
                    frame_count=50,
                ).returning(person_clips.c.id)
            )
            return int(result.scalar_one())

    def test_list_empty(self, client, admin_user) -> None:
        _login(client, admin_user)
        resp = client.get("/api/person-clips")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 0
        assert body["items"] == []

    def test_list_with_data(self, client, admin_user, admin_engine) -> None:
        _login(client, admin_user)
        tid = 1
        cid = 1
        clip_id = self._seed_clip(admin_engine, tid, cid)

        resp = client.get("/api/person-clips")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] >= 1
        ids = [item["id"] for item in body["items"]]
        assert clip_id in ids

    def test_list_filter_by_camera(self, client, admin_user, admin_engine) -> None:
        _login(client, admin_user)
        self._seed_clip(admin_engine, 1, 1)
        self._seed_clip(admin_engine, 1, 2)

        resp = client.get("/api/person-clips?camera_id=1")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        for item in body["items"]:
            assert item["camera_id"] == 1

    def test_stats(self, client, admin_user, admin_engine) -> None:
        _login(client, admin_user)
        self._seed_clip(admin_engine, 1, 1)

        resp = client.get("/api/person-clips/stats")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total_clips"] >= 1
        assert body["total_size_bytes"] >= 1024

    def test_stream_missing_returns_410(self, client, admin_user) -> None:
        _login(client, admin_user)
        resp = client.get("/api/person-clips/99999/stream")
        assert resp.status_code == 404, resp.text

    def test_stream_with_fake_file(self, client, admin_user, admin_engine) -> None:
        _login(client, admin_user)
        self._seed_camera(admin_engine, 1, 1)
        # Insert a row pointing at a real file.
        from sqlalchemy import insert
        now = datetime.now(tz=timezone.utc)
        tmp = Path(f"/tmp/test-clip-stream-{int(now.timestamp())}.mp4")
        plain = b"fake-mp4-content-" + struct.pack(">I", int(now.timestamp()))
        tmp.write_bytes(encrypt_bytes(plain))

        with admin_engine.begin() as conn:
            result = conn.execute(
                insert(person_clips).values(
                    tenant_id=1,
                    camera_id=1,
                    track_id="s-test",
                    clip_start=now,
                    clip_end=now,
                    duration_seconds=3.0,
                    file_path=str(tmp),
                    filesize_bytes=len(plain),
                    frame_count=30,
                ).returning(person_clips.c.id)
            )
            cid = int(result.scalar_one())

        resp = client.get(f"/api/person-clips/{cid}/stream")
        assert resp.status_code == 200, resp.text
        assert resp.content == plain
        assert resp.headers["content-type"] == "video/mp4"

        tmp.unlink(missing_ok=True)

    def test_delete(self, client, admin_user, admin_engine) -> None:
        _login(client, admin_user)
        self._seed_camera(admin_engine, 1, 1)
        now = datetime.now(tz=timezone.utc)
        tmp = Path(f"/tmp/test-clip-del-{int(now.timestamp())}.mp4")
        tmp.write_bytes(encrypt_bytes(b"delete-me"))
        from sqlalchemy import insert
        with admin_engine.begin() as conn:
            result = conn.execute(
                insert(person_clips).values(
                    tenant_id=1,
                    camera_id=1,
                    track_id="d-test",
                    clip_start=now,
                    clip_end=now,
                    duration_seconds=1.0,
                    file_path=str(tmp),
                    filesize_bytes=9,
                    frame_count=10,
                ).returning(person_clips.c.id)
            )
            cid = int(result.scalar_one())

        resp = client.delete(f"/api/person-clips/{cid}")
        assert resp.status_code == 204, resp.text
        assert not tmp.exists()

    def test_hr_can_list(self, client, hr_user, admin_engine) -> None:
        _login(client, hr_user)
        self._seed_clip(admin_engine, 1, 1)
        resp = client.get("/api/person-clips")
        assert resp.status_code == 200, resp.text

    def test_employee_cannot_list(self, client, employee_user) -> None:
        _login(client, employee_user)
        resp = client.get("/api/person-clips")
        assert resp.status_code == 403, resp.text

    def test_employee_cannot_delete(self, client, employee_user) -> None:
        _login(client, employee_user)
        resp = client.delete("/api/person-clips/1")
        assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# Clip encryption round-trip
# ---------------------------------------------------------------------------

def test_clip_encrypt_round_trip() -> None:
    plain = b"fake-mp4-frame-data-" * 100
    encrypted = encrypt_bytes(plain)
    assert encrypted != plain
    assert encrypted.startswith(b"gAAA")
    decrypted = decrypt_bytes(encrypted)
    assert decrypted == plain
