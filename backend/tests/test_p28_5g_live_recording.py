"""Phase D — live-recording lifecycle (migration 0054).

Covers:

* ``recording_status`` round-trips on a person_clips row + the CHECK
  constraint rejects unknown values.
* GET list orders live clips first (pin-to-top).
* GET list filter by recording_status.
* DELETE /api/person-clips/{id} returns 409 on a 'recording' row.
* bulk_delete_clips silently skips 'recording' rows.
* CaptureManager._sweep_abandoned_recordings flips 'recording' rows
  to 'abandoned' on startup.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from maugood.db import cameras, person_clips
from maugood.person_clips.repository import bulk_delete_clips, list_clips
from maugood.tenants.scope import TenantScope


TENANT_ID = 1


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _ensure_test_camera(admin_engine, tenant_id: int) -> int:
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(cameras.c.id)
            .where(cameras.c.tenant_id == tenant_id)
            .limit(1)
        ).first()
        if row is not None:
            return int(row.id)
        result = conn.execute(
            insert(cameras).values(
                tenant_id=tenant_id,
                name="phase-d-test-cam",
                location="",
                rtsp_url_encrypted="placeholder",
                camera_code="CAM-TEST-D",
            )
        )
        return int(result.inserted_primary_key[0])


def _make_clip(
    admin_engine: Engine,
    *,
    camera_id: int,
    recording_status: str = "completed",
    file_path: str | None = "/tmp/phase-d-test.mp4",
) -> int:
    now = datetime.now(tz=timezone.utc)
    with admin_engine.begin() as conn:
        result = conn.execute(
            insert(person_clips).values(
                tenant_id=TENANT_ID,
                camera_id=camera_id,
                clip_start=now,
                clip_end=now,
                duration_seconds=1.0,
                file_path=file_path,
                frame_count=3,
                detection_source="body",
                chunk_count=1,
                recording_status=recording_status,
            )
        )
        return int(result.inserted_primary_key[0])


def _cleanup_clip(admin_engine: Engine, clip_id: int) -> None:
    with admin_engine.begin() as conn:
        conn.execute(delete(person_clips).where(person_clips.c.id == clip_id))


# --- Migration round-trip ---------------------------------------------------


def test_recording_status_round_trips(admin_engine: Engine) -> None:
    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    clip_id = _make_clip(
        admin_engine,
        camera_id=camera_id,
        recording_status="recording",
        file_path=None,
    )
    try:
        with admin_engine.begin() as conn:
            row = conn.execute(
                select(person_clips.c.recording_status)
                .where(person_clips.c.id == clip_id)
            ).first()
        assert row is not None
        assert row.recording_status == "recording"
    finally:
        _cleanup_clip(admin_engine, clip_id)


def test_recording_status_check_rejects_unknown(
    admin_engine: Engine,
) -> None:
    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    now = datetime.now(tz=timezone.utc)
    with pytest.raises(IntegrityError):
        with admin_engine.begin() as conn:
            conn.execute(
                insert(person_clips).values(
                    tenant_id=TENANT_ID,
                    camera_id=camera_id,
                    clip_start=now,
                    clip_end=now,
                    duration_seconds=0.0,
                    frame_count=0,
                    detection_source="body",
                    chunk_count=1,
                    recording_status="garbage_value",
                )
            )


# --- Ordering: live pinned to top ------------------------------------------


def test_list_clips_pins_live_to_top(admin_engine: Engine) -> None:
    """A clip with recording_status='recording' sorts before a newer
    'completed' clip — operators don't have to scroll for the LIVE
    entry."""
    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    older_live_id = _make_clip(
        admin_engine,
        camera_id=camera_id,
        recording_status="recording",
        file_path=None,
    )
    newer_completed_id = _make_clip(
        admin_engine,
        camera_id=camera_id,
        recording_status="completed",
    )
    try:
        scope = TenantScope(tenant_id=TENANT_ID)
        with admin_engine.begin() as conn:
            rows, _total = list_clips(
                conn, scope, page=1, page_size=50,
            )
        ids_in_order = [r.id for r in rows]
        # Both rows present, and the live one comes first.
        assert older_live_id in ids_in_order
        assert newer_completed_id in ids_in_order
        assert ids_in_order.index(older_live_id) < ids_in_order.index(
            newer_completed_id
        )
    finally:
        _cleanup_clip(admin_engine, older_live_id)
        _cleanup_clip(admin_engine, newer_completed_id)


# --- Filter by recording_status --------------------------------------------


def test_list_clips_filter_recording_status(admin_engine: Engine) -> None:
    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    live_id = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="recording",
        file_path=None,
    )
    done_id = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="completed",
    )
    try:
        scope = TenantScope(tenant_id=TENANT_ID)
        with admin_engine.begin() as conn:
            recording_rows, _ = list_clips(
                conn, scope, page=1, page_size=50,
                recording_status="recording",
            )
            completed_rows, _ = list_clips(
                conn, scope, page=1, page_size=50,
                recording_status="completed",
            )
        live_ids = {r.id for r in recording_rows}
        done_ids = {r.id for r in completed_rows}
        assert live_id in live_ids
        assert live_id not in done_ids
        assert done_id in done_ids
        assert done_id not in live_ids
    finally:
        _cleanup_clip(admin_engine, live_id)
        _cleanup_clip(admin_engine, done_id)


# --- Default list hides abandoned / failed rows -----------------------------


def test_default_list_hides_abandoned_and_failed(admin_engine: Engine) -> None:
    """The default list view (no recording_status filter) excludes
    'abandoned' and 'failed' rows — they're failure states with no
    playable file, and clicking them 410s. Stays accessible via an
    explicit filter for ops debugging.
    """
    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    abandoned_id = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="abandoned",
        file_path=None,
    )
    failed_id = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="failed",
        file_path=None,
    )
    completed_id = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="completed",
    )
    try:
        scope = TenantScope(tenant_id=TENANT_ID)
        with admin_engine.begin() as conn:
            default_rows, _ = list_clips(
                conn, scope, page=1, page_size=200,
            )
            abandoned_rows, _ = list_clips(
                conn, scope, page=1, page_size=200,
                recording_status="abandoned",
            )
        default_ids = {r.id for r in default_rows}
        # Default view drops both failure rows.
        assert abandoned_id not in default_ids
        assert failed_id not in default_ids
        # Default view still shows the completed row.
        assert completed_id in default_ids
        # Explicit filter retrieves the abandoned row.
        assert abandoned_id in {r.id for r in abandoned_rows}
    finally:
        _cleanup_clip(admin_engine, abandoned_id)
        _cleanup_clip(admin_engine, failed_id)
        _cleanup_clip(admin_engine, completed_id)


# --- DELETE refusal on recording rows --------------------------------------


def test_delete_recording_row_returns_409(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
) -> None:
    _login(client, admin_user)
    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    clip_id = _make_clip(
        admin_engine,
        camera_id=camera_id,
        recording_status="recording",
        file_path=None,
    )
    try:
        resp = client.delete(f"/api/person-clips/{clip_id}")
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert detail["field"] == "recording_status"
        # Row must still be present, unmodified.
        with admin_engine.begin() as conn:
            row = conn.execute(
                select(person_clips.c.recording_status)
                .where(person_clips.c.id == clip_id)
            ).first()
        assert row is not None
        assert row.recording_status == "recording"
    finally:
        _cleanup_clip(admin_engine, clip_id)


def test_delete_completed_row_succeeds(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
) -> None:
    _login(client, admin_user)
    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    clip_id = _make_clip(
        admin_engine,
        camera_id=camera_id,
        recording_status="completed",
    )
    try:
        resp = client.delete(f"/api/person-clips/{clip_id}")
        # 204 No Content on success.
        assert resp.status_code == 204, resp.text
        with admin_engine.begin() as conn:
            row = conn.execute(
                select(person_clips.c.id).where(person_clips.c.id == clip_id)
            ).first()
        assert row is None
    finally:
        # Defensive cleanup if delete failed silently.
        _cleanup_clip(admin_engine, clip_id)


# --- bulk_delete_clips skips recording rows --------------------------------


def test_bulk_delete_skips_recording_rows(admin_engine: Engine) -> None:
    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    live_id = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="recording",
        file_path=None,
    )
    done_id = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="completed",
    )
    try:
        scope = TenantScope(tenant_id=TENANT_ID)
        with admin_engine.begin() as conn:
            deleted_rows = bulk_delete_clips(conn, scope, [live_id, done_id])
        deleted_ids = {r.id for r in deleted_rows}
        assert done_id in deleted_ids
        assert live_id not in deleted_ids
        # The recording row must still be intact.
        with admin_engine.begin() as conn:
            still = conn.execute(
                select(person_clips.c.id)
                .where(person_clips.c.id == live_id)
            ).first()
        assert still is not None
    finally:
        _cleanup_clip(admin_engine, live_id)
        _cleanup_clip(admin_engine, done_id)


# --- Startup janitor: sweep abandoned --------------------------------------


def test_sweep_abandoned_recordings(admin_engine: Engine) -> None:
    """``_sweep_abandoned_recordings`` flips lingering 'recording'
    rows to 'abandoned' on startup."""
    from maugood.capture.manager import capture_manager

    camera_id = _ensure_test_camera(admin_engine, TENANT_ID)
    clip_a = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="recording",
        file_path=None,
    )
    clip_b = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="recording",
        file_path=None,
    )
    clip_done = _make_clip(
        admin_engine, camera_id=camera_id, recording_status="completed",
    )
    try:
        swept = capture_manager._sweep_abandoned_recordings(
            tenant_id=TENANT_ID, schema=None
        )
        # At least the two we just inserted.
        assert swept >= 2

        with admin_engine.begin() as conn:
            statuses = {
                r.id: r.recording_status
                for r in conn.execute(
                    select(
                        person_clips.c.id, person_clips.c.recording_status
                    ).where(
                        person_clips.c.id.in_([clip_a, clip_b, clip_done])
                    )
                ).all()
            }
        assert statuses[clip_a] == "abandoned"
        assert statuses[clip_b] == "abandoned"
        # Completed row untouched.
        assert statuses[clip_done] == "completed"
    finally:
        _cleanup_clip(admin_engine, clip_a)
        _cleanup_clip(admin_engine, clip_b)
        _cleanup_clip(admin_engine, clip_done)
