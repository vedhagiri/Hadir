"""Tests for the Storage Analytics clip-video cleanup surface (0069).

The cleanup operates by **soft-clearing** ``person_clips`` rows: the
on-disk file is unlinked, ``file_path``/``filesize_bytes`` are reset,
and ``clip_file_deleted_at`` records when the reclaim happened. The
row stays so ``face_crops``/``clip_processing_results`` FKs survive.

Coverage:
  * Filter-mode validation (hours / days / range / errors).
  * Preview aggregates count, bytes, oldest/newest, by-camera.
  * Run soft-clears (row stays, file_path=NULL, filesize_bytes=0,
    clip_file_deleted_at set, disk file gone).
  * ``face_crops`` is untouched by cleanup.
  * Already-cleared rows are excluded by subsequent preview/run.
  * camera_id filter scopes the operation.
  * has_more pagination loops correctly.
  * Admin-only gate (HR 403).
  * Audit row is written.
  * Retention setting GET + PATCH round-trips.
  * P25 retention sweep honours ``clip_retention_days``.

Run: ``docker compose exec backend pytest tests/test_storage_analytics_cleanup.py -q``
"""

from __future__ import annotations

import secrets
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

import pytest
from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine

from maugood.cameras.rtsp import encrypt_url
from maugood.db import (
    audit_log,
    cameras,
    face_crops,
    person_clips,
    tenant_settings,
)
from maugood.retention.sweep import run_retention_sweep
from maugood.storage_analytics.cleanup import (
    CleanupFilterError,
    ClipCleanupFilter,
    preview_clip_cleanup,
    resolve_cutoff,
    run_clip_cleanup,
)
from maugood.tenants.scope import TenantScope
from zoneinfo import ZoneInfo


TENANT_ID = 1
SCOPE = TenantScope(tenant_id=TENANT_ID)


# ───────────────────────── helpers ────────────────────────────────────


def _login(client, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _seed_camera(admin_engine: Engine, camera_id: int) -> int:
    """Create a camera row (or no-op if one already exists)."""

    with admin_engine.begin() as conn:
        existing = conn.execute(
            select(cameras.c.id).where(cameras.c.id == camera_id)
        ).first()
        if existing is None:
            conn.execute(
                insert(cameras).values(
                    id=camera_id,
                    tenant_id=TENANT_ID,
                    name=f"Cleanup Test Camera {camera_id}",
                    location="Lab",
                    rtsp_url_encrypted=encrypt_url(
                        "rtsp://test:test@localhost/cleanup"
                    ),
                    worker_enabled=False,
                    display_enabled=False,
                )
            )
    return camera_id


def _seed_clip(
    admin_engine: Engine,
    tmp_path: Path,
    *,
    camera_id: int,
    clip_start: datetime,
    bytes_on_disk: int = 1024,
    write_file: bool = True,
) -> tuple[int, Path]:
    """Insert a person_clips row and (optionally) write a real file.

    Returns ``(clip_id, file_path_on_disk)``.
    """

    fpath = (
        tmp_path
        / f"{secrets.token_hex(6)}.avi"
    )
    if write_file:
        fpath.write_bytes(b"\x00" * bytes_on_disk)
    with admin_engine.begin() as conn:
        clip_id = conn.execute(
            insert(person_clips)
            .values(
                tenant_id=TENANT_ID,
                camera_id=camera_id,
                clip_start=clip_start,
                clip_end=clip_start + timedelta(seconds=5),
                duration_seconds=5.0,
                file_path=str(fpath),
                filesize_bytes=bytes_on_disk,
                frame_count=125,
                track_id=f"track-{secrets.token_hex(3)}",
            )
            .returning(person_clips.c.id)
        ).scalar_one()
    return (int(clip_id), fpath)


@pytest.fixture
def clean_clips(admin_engine: Engine) -> Iterator[None]:
    """Wipe person_clips + face_crops + the test cameras before/after."""

    def _wipe() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(face_crops).where(face_crops.c.tenant_id == TENANT_ID)
            )
            conn.execute(
                delete(person_clips).where(person_clips.c.tenant_id == TENANT_ID)
            )
            conn.execute(
                delete(cameras).where(
                    cameras.c.tenant_id == TENANT_ID,
                    cameras.c.name.like("Cleanup Test Camera%"),
                )
            )
            # Reset the tenant's clip_retention_days so retention-sweep
            # tests don't leak setting state across tests.
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == TENANT_ID)
                .values(clip_retention_days=None)
            )

    _wipe()
    yield
    _wipe()


@pytest.fixture
def clean_cleanup_audit(admin_engine: Engine) -> Iterator[None]:
    """Drop any clip_cleanup.* audit rows produced during the test."""

    yield
    with admin_engine.begin() as conn:
        conn.execute(
            delete(audit_log).where(
                audit_log.c.tenant_id == TENANT_ID,
                audit_log.c.action.like("clip_cleanup.%"),
            )
        )


# ───────────────────── filter resolution ──────────────────────────────


class TestFilterResolution:
    def test_hours_mode_returns_cutoff(self) -> None:
        tz = ZoneInfo("UTC")
        now = datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc)
        start, end = resolve_cutoff(
            ClipCleanupFilter(older_than_hours=6), tz=tz, now=now
        )
        assert end == datetime(2026, 5, 29, 6, 0, tzinfo=timezone.utc)
        # start is the 1970 sentinel
        assert start.year == 1970

    def test_days_mode_returns_cutoff(self) -> None:
        tz = ZoneInfo("UTC")
        now = datetime(2026, 5, 29, 12, 0, tzinfo=timezone.utc)
        _, end = resolve_cutoff(
            ClipCleanupFilter(older_than_days=7), tz=tz, now=now
        )
        assert end == datetime(2026, 5, 22, 12, 0, tzinfo=timezone.utc)

    def test_range_mode_returns_local_bounds(self) -> None:
        tz = ZoneInfo("Asia/Muscat")  # UTC+4
        start, end = resolve_cutoff(
            ClipCleanupFilter(
                start_date=date(2026, 5, 1),
                end_date=date(2026, 5, 7),
            ),
            tz=tz,
        )
        # 2026-05-01 00:00 Muscat == 2026-04-30 20:00 UTC
        assert start == datetime(2026, 4, 30, 20, 0, tzinfo=timezone.utc)
        # 2026-05-07 23:59:59.999999 Muscat → 2026-05-07 19:59:59.999999 UTC
        assert end.year == 2026 and end.month == 5 and end.day == 7
        assert end.tzinfo == timezone.utc

    def test_no_mode_raises(self) -> None:
        with pytest.raises(CleanupFilterError):
            resolve_cutoff(ClipCleanupFilter(), tz=ZoneInfo("UTC"))

    def test_multiple_modes_raises(self) -> None:
        with pytest.raises(CleanupFilterError):
            resolve_cutoff(
                ClipCleanupFilter(older_than_hours=6, older_than_days=1),
                tz=ZoneInfo("UTC"),
            )

    def test_inverted_range_raises(self) -> None:
        with pytest.raises(CleanupFilterError):
            resolve_cutoff(
                ClipCleanupFilter(
                    start_date=date(2026, 5, 7),
                    end_date=date(2026, 5, 1),
                ),
                tz=ZoneInfo("UTC"),
            )

    def test_hours_out_of_bounds_raises(self) -> None:
        with pytest.raises(CleanupFilterError):
            resolve_cutoff(
                ClipCleanupFilter(older_than_hours=99999),
                tz=ZoneInfo("UTC"),
            )


# ───────────────────── preview + run mechanics ────────────────────────


@pytest.mark.usefixtures("clean_clips", "clean_cleanup_audit")
class TestCleanupMechanics:
    def test_preview_aggregates_counts(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9001)
        now = datetime.now(tz=timezone.utc)
        _seed_clip(admin_engine, tmp_path, camera_id=cam,
                   clip_start=now - timedelta(hours=12), bytes_on_disk=1024)
        _seed_clip(admin_engine, tmp_path, camera_id=cam,
                   clip_start=now - timedelta(hours=10), bytes_on_disk=2048)
        # One recent clip that should be excluded by older_than_hours=6
        _seed_clip(admin_engine, tmp_path, camera_id=cam,
                   clip_start=now - timedelta(hours=1), bytes_on_disk=4096)

        from maugood.db import get_engine
        with get_engine().begin() as conn:
            preview = preview_clip_cleanup(
                conn, SCOPE, ClipCleanupFilter(older_than_hours=6)
            )
        assert preview.clip_count == 2
        assert preview.total_bytes == 1024 + 2048
        assert preview.oldest_clip_at is not None
        assert preview.newest_clip_at is not None
        assert len(preview.by_camera) == 1
        assert preview.by_camera[0].camera_id == cam
        assert preview.by_camera[0].clip_count == 2

    def test_run_soft_clears_and_unlinks(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9002)
        now = datetime.now(tz=timezone.utc)
        clip_id, fpath = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=now - timedelta(hours=12), bytes_on_disk=1024,
        )
        assert fpath.exists()

        from maugood.db import get_engine
        with get_engine().begin() as conn:
            result = run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6),
                actor_user_id=None,
            )
        assert result.deleted_count == 1
        assert result.bytes_freed == 1024
        assert result.files_unlinked == 1
        assert not result.has_more

        # The disk file is gone.
        assert not fpath.exists()

        # The row stays, with the cleared accounting columns set.
        with admin_engine.begin() as conn:
            row = conn.execute(
                select(
                    person_clips.c.file_path,
                    person_clips.c.filesize_bytes,
                    person_clips.c.clip_file_deleted_at,
                ).where(person_clips.c.id == clip_id)
            ).one()
        assert row.file_path is None
        assert row.filesize_bytes == 0
        assert row.clip_file_deleted_at is not None

    def test_run_writes_audit_row(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9003)
        now = datetime.now(tz=timezone.utc)
        _seed_clip(admin_engine, tmp_path, camera_id=cam,
                   clip_start=now - timedelta(hours=12))

        from maugood.db import get_engine
        with get_engine().begin() as conn:
            run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6),
                actor_user_id=None,
            )

        with admin_engine.begin() as conn:
            audit = conn.execute(
                select(audit_log.c.action, audit_log.c.after).where(
                    audit_log.c.tenant_id == TENANT_ID,
                    audit_log.c.action == "clip_cleanup.executed",
                ).order_by(audit_log.c.id.desc()).limit(1)
            ).one()
        assert audit.action == "clip_cleanup.executed"
        assert audit.after["deleted_count"] == 1
        assert audit.after["filter"]["mode"] == "hours"
        assert audit.after["filter"]["older_than_hours"] == 6

    def test_face_crops_survive_cleanup(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9004)
        now = datetime.now(tz=timezone.utc)
        clip_id, _ = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=now - timedelta(hours=12),
        )

        # Insert one face_crops row pointing at the clip.
        with admin_engine.begin() as conn:
            crop_id = conn.execute(
                insert(face_crops).values(
                    tenant_id=TENANT_ID,
                    camera_id=cam,
                    person_clip_id=clip_id,
                    event_timestamp=now.isoformat(),
                    face_index=1,
                    file_path=str(tmp_path / "crop.jpg"),
                    quality_score=0.5,
                ).returning(face_crops.c.id)
            ).scalar_one()

        from maugood.db import get_engine
        with get_engine().begin() as conn:
            run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6),
                actor_user_id=None,
            )

        # The face_crops row is still there and still points at the clip.
        with admin_engine.begin() as conn:
            crop = conn.execute(
                select(face_crops.c.id, face_crops.c.person_clip_id).where(
                    face_crops.c.id == crop_id
                )
            ).one()
        assert crop.person_clip_id == clip_id

    def test_already_cleared_clips_excluded(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9005)
        now = datetime.now(tz=timezone.utc)
        _seed_clip(admin_engine, tmp_path, camera_id=cam,
                   clip_start=now - timedelta(hours=12))

        from maugood.db import get_engine
        with get_engine().begin() as conn:
            first = run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6),
                actor_user_id=None,
            )
        assert first.deleted_count == 1

        # A second call against the same filter is a no-op.
        with get_engine().begin() as conn:
            second = run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6),
                actor_user_id=None,
            )
        assert second.deleted_count == 0
        assert second.bytes_freed == 0
        assert not second.has_more

    def test_camera_filter_scopes_run(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam_a = _seed_camera(admin_engine, 9006)
        cam_b = _seed_camera(admin_engine, 9007)
        now = datetime.now(tz=timezone.utc)
        _seed_clip(admin_engine, tmp_path, camera_id=cam_a,
                   clip_start=now - timedelta(hours=12))
        _seed_clip(admin_engine, tmp_path, camera_id=cam_b,
                   clip_start=now - timedelta(hours=12))

        from maugood.db import get_engine
        with get_engine().begin() as conn:
            result = run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6, camera_id=cam_a),
                actor_user_id=None,
            )
        assert result.deleted_count == 1

        # Cam B's clip is untouched.
        with admin_engine.begin() as conn:
            rows = conn.execute(
                select(person_clips.c.camera_id, person_clips.c.file_path).where(
                    person_clips.c.tenant_id == TENANT_ID,
                )
            ).fetchall()
        by_cam = {int(r.camera_id): r.file_path for r in rows}
        assert by_cam[cam_a] is None
        assert by_cam[cam_b] is not None

    def test_has_more_pagination(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9008)
        now = datetime.now(tz=timezone.utc)
        for i in range(3):
            _seed_clip(admin_engine, tmp_path, camera_id=cam,
                       clip_start=now - timedelta(hours=12, minutes=i))

        from maugood.db import get_engine
        # First call with cap=2 → has_more=True
        with get_engine().begin() as conn:
            first = run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6),
                cap=2,
                actor_user_id=None,
            )
        assert first.deleted_count == 2
        assert first.has_more is True

        # Second call with cap=2 → finishes
        with get_engine().begin() as conn:
            second = run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6),
                cap=2,
                actor_user_id=None,
            )
        assert second.deleted_count == 1
        assert second.has_more is False

    def test_missing_disk_file_still_clears_row(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9009)
        now = datetime.now(tz=timezone.utc)
        clip_id, fpath = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=now - timedelta(hours=12),
            write_file=False,  # row points at a file that doesn't exist
        )
        assert not fpath.exists()

        from maugood.db import get_engine
        with get_engine().begin() as conn:
            result = run_clip_cleanup(
                conn, SCOPE,
                ClipCleanupFilter(older_than_hours=6),
                actor_user_id=None,
            )
        assert result.deleted_count == 1
        assert result.files_missing == 1
        assert result.files_unlinked == 0

        with admin_engine.begin() as conn:
            row = conn.execute(
                select(person_clips.c.clip_file_deleted_at).where(
                    person_clips.c.id == clip_id
                )
            ).one()
        assert row.clip_file_deleted_at is not None


# ───────────────────── HTTP surface ─────────────────────────────────


@pytest.mark.usefixtures("clean_clips", "clean_cleanup_audit")
class TestCleanupEndpoints:
    def test_admin_can_preview(
        self, client, admin_user, admin_engine: Engine, tmp_path: Path
    ) -> None:
        _login(client, admin_user)
        cam = _seed_camera(admin_engine, 9101)
        now = datetime.now(tz=timezone.utc)
        _seed_clip(admin_engine, tmp_path, camera_id=cam,
                   clip_start=now - timedelta(hours=12), bytes_on_disk=4096)

        resp = client.post(
            "/api/storage-analytics/clip-cleanup/preview",
            json={"older_than_hours": 6},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["clip_count"] == 1
        assert body["total_bytes"] == 4096
        assert body["cap"] > 0
        assert len(body["by_camera"]) == 1

    def test_hr_forbidden_from_cleanup(
        self, client, hr_user, admin_engine: Engine, tmp_path: Path
    ) -> None:
        _login(client, hr_user)
        resp = client.post(
            "/api/storage-analytics/clip-cleanup/preview",
            json={"older_than_hours": 6},
        )
        assert resp.status_code == 403, resp.text

    def test_invalid_filter_returns_400(self, client, admin_user) -> None:
        _login(client, admin_user)
        # No mode set.
        resp = client.post(
            "/api/storage-analytics/clip-cleanup/preview", json={}
        )
        assert resp.status_code == 422  # pydantic validator

        # Multiple modes.
        resp = client.post(
            "/api/storage-analytics/clip-cleanup/preview",
            json={"older_than_hours": 6, "older_than_days": 1},
        )
        assert resp.status_code == 422

    def test_run_endpoint_round_trip(
        self, client, admin_user, admin_engine: Engine, tmp_path: Path
    ) -> None:
        _login(client, admin_user)
        cam = _seed_camera(admin_engine, 9102)
        now = datetime.now(tz=timezone.utc)
        _seed_clip(admin_engine, tmp_path, camera_id=cam,
                   clip_start=now - timedelta(days=8), bytes_on_disk=2048)

        resp = client.post(
            "/api/storage-analytics/clip-cleanup",
            json={"older_than_days": 7},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["deleted_count"] == 1
        assert body["bytes_freed"] == 2048
        assert body["has_more"] is False


# ─────────────────── retention setting endpoints ─────────────────────


@pytest.mark.usefixtures("clean_clips", "clean_cleanup_audit")
class TestRetentionSetting:
    def test_get_default_is_null(self, client, admin_user) -> None:
        _login(client, admin_user)
        resp = client.get("/api/storage-analytics/clip-retention")
        assert resp.status_code == 200
        assert resp.json()["clip_retention_days"] is None

    def test_patch_round_trip(
        self, client, admin_user, admin_engine: Engine
    ) -> None:
        _login(client, admin_user)
        resp = client.patch(
            "/api/storage-analytics/clip-retention",
            json={"clip_retention_days": 30},
        )
        assert resp.status_code == 200
        assert resp.json()["clip_retention_days"] == 30

        # And the GET reflects it.
        resp = client.get("/api/storage-analytics/clip-retention")
        assert resp.json()["clip_retention_days"] == 30

        # Disable.
        resp = client.patch(
            "/api/storage-analytics/clip-retention",
            json={"clip_retention_days": None},
        )
        assert resp.status_code == 200
        assert resp.json()["clip_retention_days"] is None

    def test_hr_forbidden(self, client, hr_user) -> None:
        _login(client, hr_user)
        resp = client.get("/api/storage-analytics/clip-retention")
        assert resp.status_code == 403

    def test_out_of_range_rejected(self, client, admin_user) -> None:
        _login(client, admin_user)
        resp = client.patch(
            "/api/storage-analytics/clip-retention",
            json={"clip_retention_days": 0},
        )
        assert resp.status_code == 422
        resp = client.patch(
            "/api/storage-analytics/clip-retention",
            json={"clip_retention_days": 99999},
        )
        assert resp.status_code == 422


# ───────────────────── P25 retention sweep ───────────────────────────


@pytest.mark.usefixtures("clean_clips", "clean_cleanup_audit")
class TestRetentionSweepIntegration:
    def test_sweep_no_op_when_setting_is_null(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9201)
        now = datetime.now(tz=timezone.utc)
        clip_id, _ = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=now - timedelta(days=100),
        )

        # No clip_retention_days set ⇒ retention sweep leaves clips
        # alone.
        run_retention_sweep()

        with admin_engine.begin() as conn:
            row = conn.execute(
                select(person_clips.c.file_path).where(
                    person_clips.c.id == clip_id
                )
            ).one()
        assert row.file_path is not None

    def test_sweep_clears_old_clips_when_enabled(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        cam = _seed_camera(admin_engine, 9202)
        now = datetime.now(tz=timezone.utc)
        old_id, _ = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=now - timedelta(days=45),
        )
        recent_id, _ = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=now - timedelta(days=5),
        )

        # Enable auto-cleanup at 30 days.
        with admin_engine.begin() as conn:
            existing = conn.execute(
                select(tenant_settings.c.tenant_id).where(
                    tenant_settings.c.tenant_id == TENANT_ID
                )
            ).first()
            if existing is None:
                conn.execute(
                    insert(tenant_settings).values(
                        tenant_id=TENANT_ID, clip_retention_days=30
                    )
                )
            else:
                conn.execute(
                    update(tenant_settings)
                    .where(tenant_settings.c.tenant_id == TENANT_ID)
                    .values(clip_retention_days=30)
                )

        run_retention_sweep()

        with admin_engine.begin() as conn:
            rows = {
                int(r.id): r
                for r in conn.execute(
                    select(
                        person_clips.c.id,
                        person_clips.c.file_path,
                        person_clips.c.clip_file_deleted_at,
                    ).where(
                        person_clips.c.tenant_id == TENANT_ID,
                        person_clips.c.id.in_([old_id, recent_id]),
                    )
                ).all()
            }
        assert rows[old_id].file_path is None
        assert rows[old_id].clip_file_deleted_at is not None
        assert rows[recent_id].file_path is not None
        assert rows[recent_id].clip_file_deleted_at is None
