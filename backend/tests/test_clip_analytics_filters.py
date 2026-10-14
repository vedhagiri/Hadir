"""Clip Analytics list filters + face summary (read-only GET additions).

Coverage for ``GET /api/person-clips``:
  * ``video=on_disk|deleted`` narrows by the video-file state.
  * ``processing_state=waiting`` returns completed clips no use case has
    finished yet (saved / queued / processing).
  * ``match_result=unknown|no_faces`` split the "processed, nobody
    matched" set by whether faces were found.
  * Another tenant's clips never appear (tenant isolation).

Run: ``docker compose exec backend pytest tests/test_clip_analytics_filters.py -q``
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Iterator

import pytest
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from maugood.cameras.rtsp import encrypt_url
from maugood.db import cameras, clip_processing_results, person_clips

TENANT_ID = 1
CAMERA_ID = 9311


def _login(client, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


@pytest.fixture
def clean(admin_engine: Engine) -> Iterator[None]:
    def _wipe() -> None:
        with admin_engine.begin() as conn:
            ids = select(person_clips.c.id).where(
                person_clips.c.camera_id == CAMERA_ID
            )
            conn.execute(
                delete(clip_processing_results).where(
                    clip_processing_results.c.person_clip_id.in_(ids)
                )
            )
            conn.execute(
                delete(person_clips).where(person_clips.c.camera_id == CAMERA_ID)
            )
            conn.execute(delete(cameras).where(cameras.c.id == CAMERA_ID))

    _wipe()
    with admin_engine.begin() as conn:
        conn.execute(
            insert(cameras).values(
                id=CAMERA_ID,
                tenant_id=TENANT_ID,
                name="Clip Analytics Filter Camera",
                location="Lab",
                rtsp_url_encrypted=encrypt_url("rtsp://t:t@localhost/x"),
                worker_enabled=False,
                display_enabled=False,
            )
        )
    yield
    _wipe()


def _clip(
    admin_engine: Engine,
    *,
    deleted: bool = False,
    matched: list[int] | None = None,
    results: list[tuple[str, str, int, int]] = (),  # (uc, status, faces, unknown)
) -> int:
    start = datetime.now(tz=timezone.utc) - timedelta(hours=2)
    values: dict = dict(
        tenant_id=TENANT_ID,
        camera_id=CAMERA_ID,
        clip_start=start,
        clip_end=start + timedelta(seconds=30),
        duration_seconds=30.0,
        frame_count=300,
        track_id=f"t-{secrets.token_hex(3)}",
        recording_status="completed",
        matched_employees=matched or [],
    )
    if deleted:
        values.update(
            file_path=None,
            filesize_bytes=0,
            clip_file_deleted_at=datetime.now(tz=timezone.utc),
        )
    else:
        values.update(file_path="/tmp/does-not-matter.mp4", filesize_bytes=1024)
    with admin_engine.begin() as conn:
        cid = int(
            conn.execute(
                insert(person_clips).values(**values).returning(person_clips.c.id)
            ).scalar_one()
        )
        for uc, status, faces, unknown in results:
            conn.execute(
                insert(clip_processing_results).values(
                    tenant_id=TENANT_ID,
                    person_clip_id=cid,
                    use_case=uc,
                    status=status,
                    face_crop_count=faces,
                    unknown_count=unknown,
                    matched_employees=matched or [],
                )
            )
    return cid


def _ids(client, qs: str) -> set[int]:
    resp = client.get(f"/api/person-clips?camera_id={CAMERA_ID}&{qs}")
    assert resp.status_code == 200, resp.text
    return {int(c["id"]) for c in resp.json()["items"]}


@pytest.mark.usefixtures("clean")
def test_video_waiting_and_result_filters(
    client, admin_user: dict, admin_engine: Engine
) -> None:
    on_disk_saved = _clip(admin_engine)
    queued = _clip(admin_engine, results=[("uc1", "pending", 0, 0)])
    matched = _clip(
        admin_engine, matched=[1], results=[("uc1", "completed", 2, 1)]
    )
    unknown = _clip(
        admin_engine, deleted=True, results=[("uc1", "completed", 2, 2)]
    )
    no_faces = _clip(admin_engine, results=[("uc1", "completed", 0, 0)])

    _login(client, admin_user)

    assert _ids(client, "video=deleted") == {unknown}
    assert _ids(client, "video=on_disk") == {
        on_disk_saved, queued, matched, no_faces,
    }
    assert _ids(
        client, "recording_status=completed&processing_state=waiting"
    ) == {on_disk_saved, queued}
    assert _ids(client, "match_result=unknown") == {unknown}
    assert _ids(client, "match_result=no_faces") == {no_faces}
    assert _ids(client, "match_result=matched") == {matched}

    bad = client.get("/api/person-clips?video=gone")
    assert bad.status_code == 422


@pytest.mark.usefixtures("clean")
def test_filters_stay_tenant_scoped(
    client, admin_user: dict, admin_engine: Engine
) -> None:
    """A clip row belonging to another tenant id never matches, even
    when it would satisfy the filter."""

    mine = _clip(admin_engine, deleted=True)
    _login(client, admin_user)
    resp = client.get("/api/person-clips?video=deleted&page_size=200")
    assert resp.status_code == 200
    returned = resp.json()["items"]
    assert mine in {int(c["id"]) for c in returned}
    with admin_engine.begin() as conn:
        tenants_seen = {
            int(r.tenant_id)
            for r in conn.execute(
                select(person_clips.c.tenant_id).where(
                    person_clips.c.id.in_([int(c["id"]) for c in returned])
                )
            )
        }
    assert tenants_seen == {TENANT_ID}
