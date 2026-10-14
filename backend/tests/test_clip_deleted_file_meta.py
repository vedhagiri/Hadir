"""Clips whose video file was deleted keep their original name + size (0097).

Coverage:
  * Migration 0097 backfill fills ``deleted_file_name`` /
    ``deleted_filesize_bytes`` / ``file_deleted_reason`` from the
    ``clip_cleanup.auto_deleted_after_processing`` audit row, is
    idempotent, never touches rows without an audit trail, and leaves
    ``audit_log`` untouched.
  * Auto-delete-after-processing stores the originals before nulling.
  * Storage Analytics clean-up (manual + daily) stores the originals,
    keeps ``file_path=NULL`` / ``filesize_bytes=0`` semantics.
  * The person-clips list + detail endpoints expose the new fields;
    stream 410s and single-clip reprocess 409s for a deleted video;
    an unknown / other-tenant id 404s on the detail endpoint.

Run: ``docker compose exec backend pytest tests/test_clip_deleted_file_meta.py -q``
"""

from __future__ import annotations

import importlib.util
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

import pytest
from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.engine import Engine

from maugood.cameras.rtsp import encrypt_url
from maugood.db import (
    audit_log,
    cameras,
    clip_processing_results,
    face_crops,
    get_engine,
    person_clips,
    tenant_context,
    tenant_settings,
)
from maugood.storage_analytics.cleanup import (
    ClipCleanupFilter,
    run_clip_cleanup,
    run_daily_clip_cleanup,
)
from maugood.tenants.scope import TenantScope


TENANT_ID = 1
SCOPE = TenantScope(tenant_id=TENANT_ID)
CAMERA_ID = 9301
AUTO_ACTION = "clip_cleanup.auto_deleted_after_processing"

_MIGRATION = (
    Path(__file__).resolve().parent.parent
    / "alembic"
    / "versions"
    / "0097_clip_deleted_file_meta.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("mig_0097", _MIGRATION)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _login(client, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _seed_camera(admin_engine: Engine) -> None:
    with admin_engine.begin() as conn:
        if conn.execute(
            select(cameras.c.id).where(cameras.c.id == CAMERA_ID)
        ).first() is None:
            conn.execute(
                insert(cameras).values(
                    id=CAMERA_ID,
                    tenant_id=TENANT_ID,
                    name="Deleted Meta Test Camera",
                    location="Lab",
                    rtsp_url_encrypted=encrypt_url("rtsp://t:t@localhost/x"),
                    worker_enabled=False,
                    display_enabled=False,
                )
            )


def _seed_clip(
    admin_engine: Engine,
    tmp_path: Path,
    *,
    size: int = 2048,
    clip_start: datetime | None = None,
    deleted: bool = False,
) -> tuple[int, Path]:
    start = clip_start or (datetime.now(tz=timezone.utc) - timedelta(hours=12))
    fpath = tmp_path / f"{secrets.token_hex(4)}-120838.mp4"
    values: dict = dict(
        tenant_id=TENANT_ID,
        camera_id=CAMERA_ID,
        clip_start=start,
        clip_end=start + timedelta(seconds=30),
        duration_seconds=30.0,
        frame_count=300,
        track_id=f"t-{secrets.token_hex(3)}",
        recording_status="completed",
    )
    if deleted:
        values.update(
            file_path=None,
            filesize_bytes=0,
            clip_file_deleted_at=datetime.now(tz=timezone.utc),
        )
    else:
        fpath.write_bytes(b"\x00" * size)
        values.update(file_path=str(fpath), filesize_bytes=size)
    with admin_engine.begin() as conn:
        cid = conn.execute(
            insert(person_clips).values(**values).returning(person_clips.c.id)
        ).scalar_one()
    return int(cid), fpath


def _clip(admin_engine: Engine, clip_id: int):
    with admin_engine.begin() as conn:
        return conn.execute(
            select(person_clips).where(person_clips.c.id == clip_id)
        ).one()


@pytest.fixture
def clean(admin_engine: Engine) -> Iterator[None]:
    def _wipe() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(face_crops).where(face_crops.c.tenant_id == TENANT_ID)
            )
            conn.execute(
                delete(clip_processing_results).where(
                    clip_processing_results.c.tenant_id == TENANT_ID
                )
            )
            conn.execute(
                delete(person_clips).where(person_clips.c.tenant_id == TENANT_ID)
            )
            conn.execute(delete(cameras).where(cameras.c.id == CAMERA_ID))
            conn.execute(
                delete(audit_log).where(
                    audit_log.c.tenant_id == TENANT_ID,
                    audit_log.c.action.like("clip_cleanup.%"),
                )
            )
            conn.execute(
                update(tenant_settings)
                .where(tenant_settings.c.tenant_id == TENANT_ID)
                .values(auto_delete_clip_after_processing=False)
            )

    _wipe()
    _seed_camera(admin_engine)
    yield
    _wipe()


# ─────────────────────────── migration backfill ──────────────────────


@pytest.mark.usefixtures("clean")
def test_backfill_from_auto_delete_audit_row(
    admin_engine: Engine, tmp_path: Path
) -> None:
    mig = _load_migration()
    with_audit, _ = _seed_clip(admin_engine, tmp_path, deleted=True)
    without_audit, _ = _seed_clip(admin_engine, tmp_path, deleted=True)
    live, live_path = _seed_clip(admin_engine, tmp_path, size=4096)

    with admin_engine.begin() as conn:
        # Older + newer audit rows for the same clip — the newest wins.
        for path, size in (
            ("/clips/14-10-2026/cam/000000-000001.mp4", 1),
            ("/clips/14-10-2026/inaisys-office/123638-123938.mp4", 93858892),
        ):
            conn.execute(
                insert(audit_log).values(
                    tenant_id=TENANT_ID,
                    actor_user_id=None,
                    action=AUTO_ACTION,
                    entity_type="person_clips",
                    entity_id=str(with_audit),
                    after={
                        "clip_id": with_audit,
                        "file_path": path,
                        "filesize_bytes": size,
                    },
                )
            )
        # An audit row for the *live* clip must not touch it (it has no
        # clip_file_deleted_at).
        conn.execute(
            insert(audit_log).values(
                tenant_id=TENANT_ID,
                action=AUTO_ACTION,
                entity_type="person_clips",
                entity_id=str(live),
                after={"clip_id": live, "file_path": "/x/y.mp4",
                       "filesize_bytes": 5},
            )
        )
        audit_before = conn.execute(
            select(func.count()).select_from(audit_log)
        ).scalar_one()

    with admin_engine.begin() as conn:
        assert mig.backfill(conn) == 1
    with admin_engine.begin() as conn:
        # Idempotent: second pass finds nothing left to fill.
        assert mig.backfill(conn) == 0
        assert conn.execute(
            select(func.count()).select_from(audit_log)
        ).scalar_one() == audit_before

    row = _clip(admin_engine, with_audit)
    assert row.deleted_file_name == "123638-123938.mp4"
    assert row.deleted_filesize_bytes == 93858892
    assert row.file_deleted_reason == "auto_after_processing"
    assert row.file_path is None and row.filesize_bytes == 0

    orphan = _clip(admin_engine, without_audit)
    assert orphan.deleted_file_name is None
    assert orphan.deleted_filesize_bytes is None

    untouched = _clip(admin_engine, live)
    assert untouched.deleted_file_name is None
    assert untouched.file_path == str(live_path)


@pytest.mark.usefixtures("clean")
def test_backfill_reason_from_batch_cleanup_audit(
    admin_engine: Engine, tmp_path: Path
) -> None:
    """Batch clean-up audit rows carry no per-clip names, but the reason
    is recovered from the batch row that precedes the soft-clear."""

    mig = _load_migration()
    cid, _ = _seed_clip(admin_engine, tmp_path, deleted=True)
    deleted_at = _clip(admin_engine, cid).clip_file_deleted_at
    with admin_engine.begin() as conn:
        conn.execute(
            insert(audit_log).values(
                tenant_id=TENANT_ID,
                action="clip_cleanup.daily_auto_executed",
                entity_type="person_clips",
                entity_id=str(TENANT_ID),
                after={"deleted_count": 1},
                created_at=deleted_at - timedelta(milliseconds=30),
            )
        )
    with admin_engine.begin() as conn:
        mig.backfill(conn)
    row = _clip(admin_engine, cid)
    assert row.file_deleted_reason == "daily_cleanup"
    assert row.deleted_file_name is None


# ─────────────────────────── delete paths ────────────────────────────


@pytest.mark.usefixtures("clean")
def test_auto_delete_after_processing_stores_originals(
    admin_engine: Engine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from maugood.clip_pipeline import pipeline as pl

    clip_id, fpath = _seed_clip(admin_engine, tmp_path, size=12345)
    with admin_engine.begin() as conn:
        conn.execute(
            update(tenant_settings)
            .where(tenant_settings.c.tenant_id == TENANT_ID)
            .values(auto_delete_clip_after_processing=True)
        )
        conn.execute(
            insert(clip_processing_results).values(
                tenant_id=TENANT_ID,
                person_clip_id=clip_id,
                use_case="uc1",
                status="completed",
            )
        )
    monkeypatch.setattr(pl, "enabled_use_cases_for", lambda _scope: ("uc1",))

    scope = TenantScope(tenant_id=TENANT_ID, tenant_schema="main")
    pl.ClipPipeline._maybe_auto_delete_clip_video(
        None, get_engine(), scope, clip_id  # type: ignore[arg-type]
    )

    row = _clip(admin_engine, clip_id)
    assert row.clip_file_deleted_at is not None
    assert row.file_path is None
    assert row.filesize_bytes == 0
    assert row.deleted_file_name == fpath.name
    assert row.deleted_filesize_bytes == 12345
    assert row.file_deleted_reason == "auto_after_processing"
    assert not fpath.exists()


@pytest.mark.usefixtures("clean")
def test_manual_cleanup_stores_originals(
    admin_engine: Engine, tmp_path: Path
) -> None:
    a, a_path = _seed_clip(admin_engine, tmp_path, size=1000)
    b, b_path = _seed_clip(admin_engine, tmp_path, size=3000)

    with tenant_context("main"):
        with get_engine().begin() as conn:
            result = run_clip_cleanup(
                conn, SCOPE, ClipCleanupFilter(older_than_hours=6)
            )
    # bytes_freed still counts the live sizes exactly once.
    assert result.deleted_count == 2
    assert result.bytes_freed == 4000

    for cid, path, size in ((a, a_path, 1000), (b, b_path, 3000)):
        row = _clip(admin_engine, cid)
        assert row.file_path is None and row.filesize_bytes == 0
        assert row.deleted_file_name == path.name
        assert row.deleted_filesize_bytes == size
        assert row.file_deleted_reason == "cleanup"

    # A second run sees nothing (already-cleared rows are excluded), so
    # nothing is double counted.
    with tenant_context("main"):
        with get_engine().begin() as conn:
            again = run_clip_cleanup(
                conn, SCOPE, ClipCleanupFilter(older_than_hours=6)
            )
    assert again.deleted_count == 0 and again.bytes_freed == 0


@pytest.mark.usefixtures("clean")
def test_daily_cleanup_reason(admin_engine: Engine, tmp_path: Path) -> None:
    yesterday = datetime.now(tz=timezone.utc) - timedelta(days=2)
    cid, path = _seed_clip(admin_engine, tmp_path, size=777, clip_start=yesterday)
    with tenant_context("main"):
        with get_engine().begin() as conn:
            run_daily_clip_cleanup(conn, SCOPE)
    row = _clip(admin_engine, cid)
    assert row.clip_file_deleted_at is not None
    assert row.deleted_file_name == path.name
    assert row.deleted_filesize_bytes == 777
    assert row.file_deleted_reason == "daily_cleanup"


# ─────────────────────────── API ─────────────────────────────────────


@pytest.mark.usefixtures("clean")
def test_api_exposes_deleted_fields(
    client, admin_user: dict, admin_engine: Engine, tmp_path: Path
) -> None:
    cid, fpath = _seed_clip(admin_engine, tmp_path, size=5555)
    live, _ = _seed_clip(admin_engine, tmp_path, size=10)
    with tenant_context("main"):
        with get_engine().begin() as conn:
            conn.execute(
                update(person_clips)
                .where(person_clips.c.id == cid)
                .values(
                    clip_file_deleted_at=datetime.now(tz=timezone.utc),
                    deleted_file_name=fpath.name,
                    deleted_filesize_bytes=5555,
                    file_deleted_reason="auto_after_processing",
                    file_path=None,
                    filesize_bytes=0,
                )
            )

    _login(client, admin_user)
    resp = client.get(f"/api/person-clips?camera_id={CAMERA_ID}")
    assert resp.status_code == 200, resp.text
    by_id = {it["id"]: it for it in resp.json()["items"]}
    item = by_id[cid]
    assert item["file_deleted_at"] is not None
    assert item["deleted_file_name"] == fpath.name
    assert item["deleted_filesize_bytes"] == 5555
    assert item["file_deleted_reason"] == "auto_after_processing"
    assert item["filesize_bytes"] == 0
    # The name the UI shows is the original file name, not "recording-…".
    assert item["clip_name"] == fpath.name
    assert by_id[live]["file_deleted_at"] is None
    assert by_id[live]["deleted_file_name"] is None

    detail = client.get(f"/api/person-clips/{cid}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["deleted_filesize_bytes"] == 5555
    assert detail.json()["clip_name"] == fpath.name

    stream = client.get(f"/api/person-clips/{cid}/stream")
    assert stream.status_code == 410
    assert stream.json()["detail"] == "clip video deleted"

    rep = client.post(
        f"/api/person-clips/{cid}/reprocess", json={"use_cases": ["uc1"]}
    )
    assert rep.status_code == 409

    # Unknown / other-tenant ids 404 (never 403).
    assert client.get("/api/person-clips/987654321").status_code == 404


@pytest.mark.usefixtures("clean")
def test_abandoned_clip_without_file_is_not_named_recording(
    client, admin_user: dict, admin_engine: Engine, tmp_path: Path
) -> None:
    cid, _ = _seed_clip(admin_engine, tmp_path, size=10)
    with admin_engine.begin() as conn:
        conn.execute(
            update(person_clips)
            .where(person_clips.c.id == cid)
            .values(recording_status="abandoned", file_path=None,
                    filesize_bytes=0)
        )
    _login(client, admin_user)
    detail = client.get(f"/api/person-clips/{cid}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["recording_status"] == "abandoned"
    assert body["clip_name"].startswith("clip-")


# ─────────────────── in-flight clips are never acted on ──────────────


def _set_status(admin_engine: Engine, clip_id: int, status: str) -> None:
    with admin_engine.begin() as conn:
        conn.execute(
            update(person_clips)
            .where(person_clips.c.id == clip_id)
            .values(recording_status=status)
        )


@pytest.mark.usefixtures("clean")
def test_bulk_delete_skips_recording_clip(
    client, admin_user: dict, admin_engine: Engine, tmp_path: Path
) -> None:
    done, _ = _seed_clip(admin_engine, tmp_path, size=10)
    live, _ = _seed_clip(admin_engine, tmp_path, size=10)
    _set_status(admin_engine, live, "recording")

    _login(client, admin_user)
    resp = client.post(
        "/api/person-clips/bulk-delete", json={"clip_ids": [done, live]}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted_ids"] == [done]
    assert body["skipped_ids"] == [live]
    with admin_engine.begin() as conn:
        assert conn.execute(
            select(person_clips.c.id).where(person_clips.c.id == live)
        ).first() is not None


@pytest.mark.usefixtures("clean")
def test_identify_submit_skips_recording_and_deleted_clips(
    client,
    admin_user: dict,
    admin_engine: Engine,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    from maugood.clip_pipeline import router as cp_router

    done, _ = _seed_clip(admin_engine, tmp_path, size=10)
    live, _ = _seed_clip(admin_engine, tmp_path, size=10)
    _set_status(admin_engine, live, "recording")
    gone, _ = _seed_clip(admin_engine, tmp_path, deleted=True)

    seen: dict = {}

    def fake_submit_batch(**kw):
        seen["clip_ids"] = kw["clip_ids"]
        return SimpleNamespace(
            batch_id="b-test", total_jobs=1, queued_jobs=1, skipped_jobs=0
        )

    monkeypatch.setattr(cp_router.clip_pipeline, "_started", True, raising=False)
    monkeypatch.setattr(cp_router.clip_pipeline, "submit_batch", fake_submit_batch)

    _login(client, admin_user)
    resp = client.post(
        "/api/clip-pipeline/submit",
        json={"clip_ids": [done, live, gone], "use_cases": ["uc1"]},
    )
    assert resp.status_code == 200, resp.text
    assert seen["clip_ids"] == [done]
    assert resp.json()["skipped_clip_ids"] == [live, gone]

    only_live = client.post(
        "/api/clip-pipeline/submit",
        json={"clip_ids": [live], "use_cases": ["uc1"]},
    )
    assert only_live.status_code == 409
    with admin_engine.begin() as conn:
        conn.execute(
            delete(audit_log).where(
                audit_log.c.tenant_id == TENANT_ID,
                audit_log.c.action == "clip_pipeline.batch_submitted",
            )
        )
