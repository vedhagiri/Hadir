"""Tests for camera bulk JSON import/export.

Two layers:
  * Pure classifier (``classify_imports``) — the create/update/skip/error
    decision matrix, exercised without a database.
  * Endpoints — export round-trip (plaintext rtsp_url is included by
    operator choice), import-preview, and the import apply path
    (create / update / skip), plus the role guard and the
    no-plaintext-in-audit red line for the export row.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from maugood.cameras.schemas import CameraImportItem
from maugood.cameras.transfer import ExistingCamera, classify_imports

PLAIN_URL = "rtsp://maugood_admin:supersecret@10.0.0.50:8554/stream/main"
SECOND_URL = "rtsp://op:pw@10.0.0.51:554/stream/main"
THIRD_URL = "rtsp://op:pw@10.0.0.52:554/stream/main"


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Pure classifier
# ---------------------------------------------------------------------------


def test_classify_create_when_no_match() -> None:
    rows = classify_imports(
        [],
        [CameraImportItem(name="Lobby", rtsp_url=PLAIN_URL)],
        mode="update",
    )
    assert [r.action for r in rows] == ["create"]
    assert rows[0].rtsp_host == "10.0.0.50:8554"


def test_classify_update_on_code_match() -> None:
    existing = [ExistingCamera(id=7, name="Lobby", camera_code="CAM-001", canon=None)]
    rows = classify_imports(
        existing,
        [CameraImportItem(camera_code="CAM-001", name="Lobby (new)")],
        mode="update",
    )
    assert rows[0].action == "update"
    assert rows[0].matched_id == 7


def test_classify_skip_on_code_match_when_mode_skip() -> None:
    existing = [ExistingCamera(id=7, name="Lobby", camera_code="CAM-001", canon=None)]
    rows = classify_imports(
        existing,
        [CameraImportItem(camera_code="CAM-001", name="Lobby")],
        mode="skip",
    )
    assert rows[0].action == "skip"
    assert rows[0].matched_id is None


def test_classify_skip_when_stream_already_exists() -> None:
    from maugood.cameras.rtsp import canonical_stream_id

    existing = [
        ExistingCamera(
            id=3,
            name="Gate",
            camera_code="CAM-009",
            canon=canonical_stream_id(PLAIN_URL),
        )
    ]
    # No code match, but the RTSP stream is already in use → skip.
    rows = classify_imports(
        existing,
        [CameraImportItem(name="Lobby copy", rtsp_url=PLAIN_URL)],
        mode="update",
    )
    assert rows[0].action == "skip"
    assert "already exists" in rows[0].message


def test_classify_error_missing_name_and_url() -> None:
    rows = classify_imports(
        [],
        [
            CameraImportItem(rtsp_url=PLAIN_URL),  # no name
            CameraImportItem(name="No URL"),  # no url
            CameraImportItem(name="Bad URL", rtsp_url="http://10.0.0.1/x"),
        ],
        mode="update",
    )
    assert [r.action for r in rows] == ["error", "error", "error"]
    assert "name is required" in rows[0].message
    assert "rtsp_url is required" in rows[1].message
    assert "invalid rtsp_url" in rows[2].message


def test_classify_within_file_duplicate_stream() -> None:
    rows = classify_imports(
        [],
        [
            CameraImportItem(name="A", rtsp_url=PLAIN_URL),
            CameraImportItem(name="B", rtsp_url=PLAIN_URL),  # same stream
        ],
        mode="update",
    )
    assert [r.action for r in rows] == ["create", "skip"]
    assert "within file" in rows[1].message


def test_classify_within_file_duplicate_code() -> None:
    rows = classify_imports(
        [],
        [
            CameraImportItem(camera_code="CAM-X", name="A", rtsp_url=PLAIN_URL),
            CameraImportItem(camera_code="CAM-X", name="B", rtsp_url=SECOND_URL),
        ],
        mode="update",
    )
    assert [r.action for r in rows] == ["create", "skip"]
    assert "camera_code" in rows[1].message


def test_classify_update_stream_belongs_to_other_camera_is_error() -> None:
    from maugood.cameras.rtsp import canonical_stream_id

    existing = [
        ExistingCamera(
            id=1, name="A", camera_code="CAM-001", canon=canonical_stream_id(PLAIN_URL)
        ),
        ExistingCamera(
            id=2, name="B", camera_code="CAM-002", canon=canonical_stream_id(SECOND_URL)
        ),
    ]
    # Row targets CAM-001 by code but supplies CAM-002's stream → conflict.
    rows = classify_imports(
        existing,
        [CameraImportItem(camera_code="CAM-001", name="A", rtsp_url=SECOND_URL)],
        mode="update",
    )
    assert rows[0].action == "error"
    assert "already used by 'B'" in rows[0].message


def test_classify_invalid_capture_config_is_error() -> None:
    rows = classify_imports(
        [],
        [
            CameraImportItem(
                name="A",
                rtsp_url=PLAIN_URL,
                capture_config={"max_faces_per_event": 999},  # out of bounds
            )
        ],
        mode="update",
    )
    assert rows[0].action == "error"
    assert "capture_config" in rows[0].message


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_cameras")
def test_export_round_trips_plaintext_url(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    client.post(
        "/api/cameras",
        json={"name": "Lobby", "location": "HQ", "rtsp_url": PLAIN_URL},
    )
    client.post(
        "/api/cameras",
        json={"name": "Gate", "location": "", "rtsp_url": SECOND_URL},
    )

    resp = client.get("/api/cameras/export")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version"] == 1
    assert body["count"] == 2
    urls = {c["rtsp_url"] for c in body["cameras"]}
    # Operator chose full round-trip — plaintext credentials are present.
    assert PLAIN_URL in urls
    assert SECOND_URL in urls


@pytest.mark.usefixtures("clean_cameras")
def test_export_selected_ids_only(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    a = client.post(
        "/api/cameras",
        json={"name": "Lobby", "location": "", "rtsp_url": PLAIN_URL},
    ).json()
    client.post(
        "/api/cameras",
        json={"name": "Gate", "location": "", "rtsp_url": SECOND_URL},
    )

    resp = client.get(f"/api/cameras/export?ids={a['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["cameras"][0]["name"] == "Lobby"


@pytest.mark.usefixtures("clean_cameras")
def test_export_audit_row_has_no_plaintext(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    from maugood.db import audit_log

    _login(client, admin_user)
    client.post(
        "/api/cameras",
        json={"name": "Lobby", "location": "", "rtsp_url": PLAIN_URL},
    )
    client.get("/api/cameras/export")

    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.after).where(
                audit_log.c.action == "camera.exported"
            )
        ).all()
    assert rows
    for row in rows:
        s = str(row.after)
        assert "rtsp://" not in s
        assert "supersecret" not in s


# ---------------------------------------------------------------------------
# Import — preview + apply
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_cameras")
def test_import_preview_classifies_without_writing(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.post(
        "/api/cameras/import-preview",
        json={
            "cameras": [
                {"name": "Lobby", "rtsp_url": PLAIN_URL},
                {"name": "Missing URL"},
            ],
            "on_existing": "update",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["summary"]["create"] == 1
    assert body["summary"]["error"] == 1
    # Nothing was written.
    assert client.get("/api/cameras").json()["items"] == []


@pytest.mark.usefixtures("clean_cameras")
def test_import_creates_new_cameras(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.post(
        "/api/cameras/import",
        json={
            "cameras": [
                {"name": "Lobby", "location": "HQ", "rtsp_url": PLAIN_URL},
                {"name": "Gate", "rtsp_url": SECOND_URL, "worker_enabled": True},
            ],
            "on_existing": "update",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["created"] == 2
    assert body["errors"] == 0

    items = client.get("/api/cameras").json()["items"]
    assert {i["name"] for i in items} == {"Lobby", "Gate"}
    gate = next(i for i in items if i["name"] == "Gate")
    assert gate["worker_enabled"] is True


@pytest.mark.usefixtures("clean_cameras")
def test_import_updates_existing_by_code(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    created = client.post(
        "/api/cameras",
        json={"name": "Lobby", "location": "Old", "rtsp_url": PLAIN_URL},
    ).json()
    code = created["camera_code"]

    resp = client.post(
        "/api/cameras/import",
        json={
            "cameras": [
                {"camera_code": code, "name": "Lobby Renamed", "location": "New"}
            ],
            "on_existing": "update",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["updated"] == 1

    detail = client.get("/api/cameras").json()["items"][0]
    assert detail["name"] == "Lobby Renamed"
    assert detail["location"] == "New"
    # rtsp_url omitted on the update → host preserved.
    assert detail["rtsp_host"] == "10.0.0.50:8554"


@pytest.mark.usefixtures("clean_cameras")
def test_import_skip_existing_mode_leaves_row_untouched(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    created = client.post(
        "/api/cameras",
        json={"name": "Lobby", "location": "Old", "rtsp_url": PLAIN_URL},
    ).json()
    code = created["camera_code"]

    resp = client.post(
        "/api/cameras/import",
        json={
            "cameras": [
                {"camera_code": code, "name": "Should Not Apply", "location": "Nope"}
            ],
            "on_existing": "skip",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["skipped"] == 1
    assert resp.json()["updated"] == 0

    detail = client.get("/api/cameras").json()["items"][0]
    assert detail["name"] == "Lobby"  # unchanged
    assert detail["location"] == "Old"


@pytest.mark.usefixtures("clean_cameras")
def test_import_skips_duplicate_stream(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    client.post(
        "/api/cameras",
        json={"name": "Lobby", "location": "", "rtsp_url": PLAIN_URL},
    )
    # New row, no code, but same physical stream → skip (duplicate).
    resp = client.post(
        "/api/cameras/import",
        json={
            "cameras": [{"name": "Lobby Dup", "rtsp_url": PLAIN_URL}],
            "on_existing": "update",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["skipped"] == 1
    assert resp.json()["created"] == 0
    assert len(client.get("/api/cameras").json()["items"]) == 1


@pytest.mark.usefixtures("clean_cameras")
def test_export_import_full_round_trip(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    """Export → wipe → import recreates cameras with working credentials."""
    from maugood.db import cameras as cameras_tbl

    _login(client, admin_user)
    client.post(
        "/api/cameras",
        json={"name": "Lobby", "location": "HQ", "rtsp_url": PLAIN_URL},
    )
    client.post(
        "/api/cameras",
        json={"name": "Gate", "location": "", "rtsp_url": SECOND_URL},
    )
    export = client.get("/api/cameras/export").json()

    # Wipe the tenant's cameras directly (admin engine bypasses the API).
    with admin_engine.begin() as conn:
        conn.execute(cameras_tbl.delete())
    assert client.get("/api/cameras").json()["items"] == []

    resp = client.post(
        "/api/cameras/import",
        json={"cameras": export["cameras"], "on_existing": "update"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["created"] == 2

    items = client.get("/api/cameras").json()["items"]
    assert {i["rtsp_host"] for i in items} == {"10.0.0.50:8554", "10.0.0.51"}


# ---------------------------------------------------------------------------
# Role guard
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_cameras")
def test_employee_forbidden_on_export_and_import(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    assert client.get("/api/cameras/export").status_code == 403
    assert (
        client.post(
            "/api/cameras/import",
            json={"cameras": [], "on_existing": "update"},
        ).status_code
        == 403
    )
