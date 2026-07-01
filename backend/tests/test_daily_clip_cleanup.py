"""Tests for automatic daily clip cleanup (migration 0090).

Distinct from the age-based retention sweep and the
auto-delete-after-processing toggle: this reclaims the raw video of
every clip created *before today* (tenant-local) once per day at a
configured time — processed or not.

Coverage:
  * ``run_daily_clip_cleanup`` clears before-today clips, keeps today's.
  * Config GET default (disabled, 00:00) + PATCH round-trip + audit.
  * PATCH resets ``last_run_on`` on a time change.
  * Invalid time (422) + HR forbidden (403).
  * Scan: not due before the time, due after, once-per-day idempotency.

Run: ``docker compose exec backend pytest tests/test_daily_clip_cleanup.py -q``
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

import pytest
from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine

from maugood.cameras.rtsp import encrypt_url
from maugood.db import (
    audit_log,
    cameras,
    get_engine,
    person_clips,
    tenant_settings,
)
from maugood.storage_analytics.cleanup import (
    get_daily_cleanup_config,
    run_daily_clip_cleanup,
)
from maugood.storage_analytics.daily_cleanup import run_daily_cleanup_scan
from maugood.tenants.scope import TenantScope

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
    with admin_engine.begin() as conn:
        existing = conn.execute(
            select(cameras.c.id).where(cameras.c.id == camera_id)
        ).first()
        if existing is None:
            conn.execute(
                insert(cameras).values(
                    id=camera_id,
                    tenant_id=TENANT_ID,
                    name=f"Daily Cleanup Camera {camera_id}",
                    location="Lab",
                    rtsp_url_encrypted=encrypt_url(
                        "rtsp://test:test@localhost/daily"
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
) -> tuple[int, Path]:
    fpath = tmp_path / f"{secrets.token_hex(6)}.avi"
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


def _set_daily_cfg(
    admin_engine: Engine,
    *,
    enabled: bool,
    cleanup_time: str = "00:00",
    last_run_on=None,
    timezone_name: str = "UTC",
) -> None:
    """Upsert the tenant's daily-cleanup config (+ pin the timezone)."""

    values = {
        "clip_daily_cleanup_enabled": enabled,
        "clip_daily_cleanup_time": cleanup_time,
        "clip_daily_cleanup_last_run_on": last_run_on,
        "timezone": timezone_name,
    }
    with admin_engine.begin() as conn:
        existing = conn.execute(
            select(tenant_settings.c.tenant_id).where(
                tenant_settings.c.tenant_id == TENANT_ID
            )
        ).first()
        if existing is None:
            conn.execute(
                insert(tenant_settings).values(tenant_id=TENANT_ID, **values)
            )
        else:
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == TENANT_ID)
                .values(**values)
            )


@pytest.fixture
def clean_daily(admin_engine: Engine) -> Iterator[None]:
    def _wipe() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(person_clips).where(
                    person_clips.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                delete(cameras).where(
                    cameras.c.tenant_id == TENANT_ID,
                    cameras.c.name.like("Daily Cleanup Camera%"),
                )
            )
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == TENANT_ID)
                .values(
                    clip_daily_cleanup_enabled=False,
                    clip_daily_cleanup_time="00:00",
                    clip_daily_cleanup_last_run_on=None,
                    timezone="Asia/Muscat",
                )
            )
            conn.execute(
                delete(audit_log).where(
                    audit_log.c.tenant_id == TENANT_ID,
                    audit_log.c.action.like("clip_cleanup.%"),
                )
            )

    _wipe()
    yield
    _wipe()


# ───────────────────── core cleanup logic ─────────────────────────────


@pytest.mark.usefixtures("clean_daily")
class TestRunDailyCleanup:
    def test_clears_before_today_keeps_today(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        _set_daily_cfg(admin_engine, enabled=True, timezone_name="UTC")
        cam = _seed_camera(admin_engine, 9301)
        now = datetime(2026, 7, 2, 6, 0, tzinfo=timezone.utc)

        # Yesterday (before local midnight today) → should be cleared.
        y_id, y_path = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        )
        # Today, a few hours ago → should be kept.
        t_id, t_path = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=datetime(2026, 7, 2, 2, 0, tzinfo=timezone.utc),
        )

        with get_engine().begin() as conn:
            result = run_daily_clip_cleanup(conn, SCOPE, now=now)

        assert result.deleted_count == 1
        assert not y_path.exists()
        assert t_path.exists()

        with admin_engine.begin() as conn:
            rows = {
                int(r.id): r.file_path
                for r in conn.execute(
                    select(person_clips.c.id, person_clips.c.file_path).where(
                        person_clips.c.id.in_([y_id, t_id])
                    )
                ).all()
            }
        assert rows[y_id] is None
        assert rows[t_id] is not None

    def test_writes_audit_row(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        _set_daily_cfg(admin_engine, enabled=True, timezone_name="UTC")
        cam = _seed_camera(admin_engine, 9302)
        now = datetime(2026, 7, 2, 6, 0, tzinfo=timezone.utc)
        _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        )

        with get_engine().begin() as conn:
            run_daily_clip_cleanup(conn, SCOPE, now=now)

        with admin_engine.begin() as conn:
            audit = conn.execute(
                select(audit_log.c.action, audit_log.c.after)
                .where(
                    audit_log.c.tenant_id == TENANT_ID,
                    audit_log.c.action == "clip_cleanup.daily_auto_executed",
                )
                .order_by(audit_log.c.id.desc())
                .limit(1)
            ).one()
        assert audit.after["deleted_count"] == 1
        assert audit.after["filter"]["mode"] == "daily_auto"
        assert audit.after["filter"]["before_local_date"] == "2026-07-02"


# ───────────────────── config endpoints ───────────────────────────────


@pytest.mark.usefixtures("clean_daily")
class TestDailyCleanupSetting:
    def test_get_default(self, client, admin_user) -> None:
        _login(client, admin_user)
        resp = client.get("/api/storage-analytics/daily-cleanup")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["enabled"] is False
        assert body["cleanup_time"] == "00:00"
        assert body["last_run_on"] is None

    def test_patch_round_trip_and_audit(
        self, client, admin_user, admin_engine: Engine
    ) -> None:
        _login(client, admin_user)
        resp = client.patch(
            "/api/storage-analytics/daily-cleanup",
            json={"enabled": True, "cleanup_time": "02:30"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["enabled"] is True
        assert resp.json()["cleanup_time"] == "02:30"

        resp = client.get("/api/storage-analytics/daily-cleanup")
        assert resp.json()["enabled"] is True
        assert resp.json()["cleanup_time"] == "02:30"

        with admin_engine.begin() as conn:
            audit = conn.execute(
                select(audit_log.c.after)
                .where(
                    audit_log.c.tenant_id == TENANT_ID,
                    audit_log.c.action == "clip_cleanup.daily_setting_updated",
                )
                .order_by(audit_log.c.id.desc())
                .limit(1)
            ).one()
        assert audit.after["enabled"] is True
        assert audit.after["cleanup_time"] == "02:30"

    def test_patch_time_change_resets_last_run(
        self, client, admin_user, admin_engine: Engine
    ) -> None:
        _login(client, admin_user)
        # Enable + pretend it already ran today.
        _set_daily_cfg(
            admin_engine,
            enabled=True,
            cleanup_time="02:00",
            last_run_on=datetime(2026, 7, 2).date(),
        )
        resp = client.patch(
            "/api/storage-analytics/daily-cleanup",
            json={"enabled": True, "cleanup_time": "05:00"},
        )
        assert resp.status_code == 200
        with admin_engine.begin() as conn:
            last = conn.execute(
                select(
                    tenant_settings.c.clip_daily_cleanup_last_run_on
                ).where(tenant_settings.c.tenant_id == TENANT_ID)
            ).scalar_one()
        assert last is None  # time changed → guard cleared

    def test_invalid_time_rejected(self, client, admin_user) -> None:
        _login(client, admin_user)
        for bad in ("25:00", "12:99", "abc", "2:5", "24:00"):
            resp = client.patch(
                "/api/storage-analytics/daily-cleanup",
                json={"enabled": True, "cleanup_time": bad},
            )
            assert resp.status_code == 422, f"{bad!r} -> {resp.status_code}"

    def test_hr_forbidden(self, client, hr_user) -> None:
        _login(client, hr_user)
        resp = client.get("/api/storage-analytics/daily-cleanup")
        assert resp.status_code == 403


# ───────────────────── scan (scheduler entrypoint) ────────────────────


@pytest.mark.usefixtures("clean_daily")
class TestDailyCleanupScan:
    def test_not_due_before_time(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        _set_daily_cfg(
            admin_engine, enabled=True, cleanup_time="05:00",
            timezone_name="UTC",
        )
        cam = _seed_camera(admin_engine, 9401)
        _, y_path = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        )
        # 04:00 UTC < 05:00 configured → not due.
        run_daily_cleanup_scan(now=datetime(2026, 7, 2, 4, 0, tzinfo=timezone.utc))
        assert y_path.exists()

        with admin_engine.begin() as conn:
            last = conn.execute(
                select(
                    tenant_settings.c.clip_daily_cleanup_last_run_on
                ).where(tenant_settings.c.tenant_id == TENANT_ID)
            ).scalar_one()
        assert last is None

    def test_due_runs_once_per_day(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        _set_daily_cfg(
            admin_engine, enabled=True, cleanup_time="05:00",
            timezone_name="UTC",
        )
        cam = _seed_camera(admin_engine, 9402)
        _, y_path = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        )

        # 06:00 UTC ≥ 05:00 → due.
        run_daily_cleanup_scan(now=datetime(2026, 7, 2, 6, 0, tzinfo=timezone.utc))
        assert not y_path.exists()

        with admin_engine.begin() as conn:
            last = conn.execute(
                select(
                    tenant_settings.c.clip_daily_cleanup_last_run_on
                ).where(tenant_settings.c.tenant_id == TENANT_ID)
            ).scalar_one()
        assert last == datetime(2026, 7, 2).date()

        # A clip seeded after the run (still "yesterday") must NOT be
        # cleared by a second scan the same local day.
        _, y2_path = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=datetime(2026, 7, 1, 11, 0, tzinfo=timezone.utc),
        )
        run_daily_cleanup_scan(now=datetime(2026, 7, 2, 7, 0, tzinfo=timezone.utc))
        assert y2_path.exists()

    def test_disabled_tenant_is_noop(
        self, admin_engine: Engine, tmp_path: Path
    ) -> None:
        _set_daily_cfg(admin_engine, enabled=False, timezone_name="UTC")
        cam = _seed_camera(admin_engine, 9403)
        _, y_path = _seed_clip(
            admin_engine, tmp_path, camera_id=cam,
            clip_start=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        )
        run_daily_cleanup_scan(now=datetime(2026, 7, 2, 6, 0, tzinfo=timezone.utc))
        assert y_path.exists()
