"""Tests for P11 read endpoints: detection-events, system health, audit-log."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select

from hadir.cameras import rtsp as rtsp_io
from hadir.config import get_settings
from hadir.db import (
    audit_log,
    cameras,
    detection_events,
    employee_photos,
    employees,
)
from hadir.employees.photos import encrypt_bytes


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdbffd9"
)


@pytest.fixture
def seeded_events(admin_engine, tmp_path):  # type: ignore[no-untyped-def]
    """Seed two cameras + one identified employee + a few detection events.

    Uses the configured Fernet key so the live decrypt path through the
    crop endpoint works. Cleans up after the test.
    """

    storage_root = Path(get_settings().faces_storage_path) / "captures" / "1"
    storage_root.mkdir(parents=True, exist_ok=True)

    with admin_engine.begin() as conn:
        conn.execute(delete(detection_events).where(detection_events.c.tenant_id == 1))
        conn.execute(delete(employee_photos).where(employee_photos.c.tenant_id == 1))
        conn.execute(delete(employees).where(employees.c.tenant_id == 1))
        conn.execute(delete(cameras).where(cameras.c.tenant_id == 1))

        cam_a = conn.execute(
            insert(cameras)
            .values(
                tenant_id=1,
                name="P11-Cam-A",
                location="Lobby",
                rtsp_url_encrypted=rtsp_io.encrypt_url("rtsp://fake/a"),
                worker_enabled=True,
            )
            .returning(cameras.c.id)
        ).scalar_one()
        cam_b = conn.execute(
            insert(cameras)
            .values(
                tenant_id=1,
                name="P11-Cam-B",
                location="Gate",
                rtsp_url_encrypted=rtsp_io.encrypt_url("rtsp://fake/b"),
                worker_enabled=True,
            )
            .returning(cameras.c.id)
        ).scalar_one()
        emp_id = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="P11-EMP",
                full_name="P11 Employee",
                email=None,
                department_id=1,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()

        # Two known events on cam A, one unidentified on cam B.
        crop_path = storage_root / "p11_crop.jpg"
        crop_path.write_bytes(encrypt_bytes(JPEG))

        ev_known_id = conn.execute(
            insert(detection_events)
            .values(
                tenant_id=1,
                camera_id=cam_a,
                captured_at=datetime.now(timezone.utc) - timedelta(minutes=5),
                bbox={"x": 0, "y": 0, "w": 50, "h": 50},
                face_crop_path=str(crop_path),
                employee_id=emp_id,
                confidence=0.91,
                track_id="t-known",
            )
            .returning(detection_events.c.id)
        ).scalar_one()
        ev_old_id = conn.execute(
            insert(detection_events)
            .values(
                tenant_id=1,
                camera_id=cam_a,
                captured_at=datetime.now(timezone.utc) - timedelta(hours=3),
                bbox={"x": 1, "y": 1, "w": 40, "h": 40},
                face_crop_path=str(crop_path),
                employee_id=emp_id,
                confidence=0.88,
                track_id="t-known-2",
            )
            .returning(detection_events.c.id)
        ).scalar_one()
        ev_unknown_id = conn.execute(
            insert(detection_events)
            .values(
                tenant_id=1,
                camera_id=cam_b,
                captured_at=datetime.now(timezone.utc) - timedelta(minutes=2),
                bbox={"x": 2, "y": 2, "w": 30, "h": 30},
                face_crop_path=str(crop_path),
                employee_id=None,
                confidence=None,
                track_id="t-unknown",
            )
            .returning(detection_events.c.id)
        ).scalar_one()

    try:
        yield {
            "cam_a": int(cam_a),
            "cam_b": int(cam_b),
            "emp_id": int(emp_id),
            "ev_known_id": int(ev_known_id),
            "ev_old_id": int(ev_old_id),
            "ev_unknown_id": int(ev_unknown_id),
            "crop_path": str(crop_path),
        }
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(detection_events).where(detection_events.c.tenant_id == 1))
            conn.execute(delete(employees).where(employees.c.tenant_id == 1))
            conn.execute(delete(cameras).where(cameras.c.tenant_id == 1))


# ---------------------------------------------------------------------------
# /api/detection-events list
# ---------------------------------------------------------------------------


def test_list_detection_events_default_returns_all(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    body = client.get("/api/detection-events").json()
    assert body["total"] == 3
    assert {item["track_id"] for item in body["items"]} == {
        "t-known",
        "t-known-2",
        "t-unknown",
    }


def test_filter_identified_only(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    body = client.get("/api/detection-events?identified=true").json()
    assert body["total"] == 2
    assert all(item["employee_id"] == seeded_events["emp_id"] for item in body["items"])


def test_filter_unidentified_only(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    body = client.get("/api/detection-events?identified=false").json()
    assert body["total"] == 1
    assert body["items"][0]["track_id"] == "t-unknown"


def test_filter_camera(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    body = client.get(
        f"/api/detection-events?camera_id={seeded_events['cam_b']}"
    ).json()
    assert body["total"] == 1
    assert body["items"][0]["camera_id"] == seeded_events["cam_b"]


def test_filter_date_range(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    body = client.get(
        "/api/detection-events", params={"start": one_hour_ago.isoformat()}
    ).json()
    # Only the two recent events fall after one_hour_ago; the 3-hour-old
    # one is outside the window.
    assert body["total"] == 2


def test_employee_role_is_403(
    client: TestClient, employee_user: dict, seeded_events
) -> None:
    _login(client, employee_user)
    assert client.get("/api/detection-events").status_code == 403


# ---------------------------------------------------------------------------
# /api/detection-events/{id}/crop
# ---------------------------------------------------------------------------


def test_crop_decrypts_and_streams_jpeg(
    client: TestClient, admin_user: dict, seeded_events, admin_engine
) -> None:
    _login(client, admin_user)
    eid = seeded_events["ev_known_id"]
    resp = client.get(f"/api/detection-events/{eid}/crop")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.content == JPEG

    # Audit row was written on this fetch.
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.entity_id, audit_log.c.after).where(
                audit_log.c.action == "detection_event.crop_viewed",
                audit_log.c.entity_id == str(eid),
            )
        ).all()
    assert rows, "expected an audit row for the crop view"


def test_crop_employee_role_403(
    client: TestClient, employee_user: dict, seeded_events
) -> None:
    _login(client, employee_user)
    eid = seeded_events["ev_known_id"]
    assert client.get(f"/api/detection-events/{eid}/crop").status_code == 403


def test_crop_404_when_unknown(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    assert client.get("/api/detection-events/999999/crop").status_code == 404


# ---------------------------------------------------------------------------
# /api/system/health
# ---------------------------------------------------------------------------


def test_system_health_shape(client: TestClient, admin_user: dict) -> None:
    _login(client, admin_user)
    body = client.get("/api/system/health").json()
    expected_keys = {
        "backend_uptime_seconds",
        "process_pid",
        "db_connections_active",
        "capture_workers_running",
        "attendance_scheduler_running",
        "rate_limiter_running",
        "enrolled_employees",
        "employees_active",
        "cameras_total",
        "cameras_enabled",
        "detection_events_today",
        "attendance_records_today",
    }
    assert expected_keys <= body.keys()
    assert body["backend_uptime_seconds"] >= 0
    assert isinstance(body["db_connections_active"], int)


def test_system_health_403_for_employee(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    assert client.get("/api/system/health").status_code == 403


def test_cameras_health_shape(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    body = client.get("/api/system/cameras-health").json()
    assert "items" in body
    assert {c["name"] for c in body["items"]} >= {"P11-Cam-A", "P11-Cam-B"}
    for cam in body["items"]:
        assert {
            "camera_id",
            "name",
            "rtsp_host",
            "latest_frames_last_minute",
            "latest_reachable",
            "series_24h",
        } <= cam.keys()
        # Host string never carries credentials (P7 red line).
        assert "@" not in cam["rtsp_host"]


# ---------------------------------------------------------------------------
# /api/audit-log
# ---------------------------------------------------------------------------


def test_audit_log_returns_distinct_filters(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    # First touch the crop endpoint so we have a known-shape row to look at.
    client.get(f"/api/detection-events/{seeded_events['ev_known_id']}/crop")
    body = client.get("/api/audit-log").json()
    assert body["total"] >= 1
    assert "auth.login.success" in body["distinct_actions"]
    assert "user" in body["distinct_entity_types"]


def test_audit_log_filter_by_action(
    client: TestClient, admin_user: dict, seeded_events
) -> None:
    _login(client, admin_user)
    client.get(f"/api/detection-events/{seeded_events['ev_known_id']}/crop")
    body = client.get(
        "/api/audit-log?action=detection_event.crop_viewed"
    ).json()
    assert body["total"] >= 1
    assert all(it["action"] == "detection_event.crop_viewed" for it in body["items"])


def test_audit_log_403_for_employee(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    assert client.get("/api/audit-log").status_code == 403
