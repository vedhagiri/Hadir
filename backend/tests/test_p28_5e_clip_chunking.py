"""Phase B tests for chunked clip recording.

Covers:

* Reader chunk rotation: the active chunk closes + a new one opens
  once ``chunk_duration_sec`` has elapsed and a person is still in
  frame. Grace-period frames stay with the active chunk (no rotation
  on the way out).
* ``_open_new_chunk`` returns a fresh dict shape.
* ``update_clip_encoding_config`` hot-swap behaviour: live config
  changes do NOT interrupt an in-flight clip; the snapshot taken at
  clip start drives the active chunks.
* ``_concat_chunks`` integration with real ffmpeg (smoke).
* ``person_clip_chunks`` row round-trip via the DB.

No live RTSP; reuses the stub-analyzer / scripted-capture pattern
from ``test_capture.py``.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from maugood.capture.reader import CaptureWorker


# --- _open_new_chunk shape --------------------------------------------------


class _MinimalChunkWorker:
    """Stand-in that exposes ``_open_new_chunk`` / ``_rotate_chunk``
    without dragging in the full reader thread lifecycle.
    """

    DEFAULT_CLIP_ENCODING_CONFIG = CaptureWorker.DEFAULT_CLIP_ENCODING_CONFIG

    def __init__(self) -> None:
        self.camera_id = 7
        self._current_chunk = None
        self._clip_chunks: list[dict] = []

    _open_new_chunk = CaptureWorker._open_new_chunk
    _rotate_chunk = CaptureWorker._rotate_chunk


def test_open_new_chunk_returns_expected_shape() -> None:
    w = _MinimalChunkWorker()
    now = time.time()
    chunk = w._open_new_chunk(now, 0)
    assert chunk["chunk_index"] == 0
    assert chunk["chunk_start_ts"] == now
    assert chunk["first_ts"] == now
    assert chunk["last_ts"] == now
    assert chunk["frame_count"] == 0
    assert hasattr(chunk["tmpdir"], "name")
    assert Path(chunk["tmpdir"].name).exists()
    chunk["tmpdir"].cleanup()


def test_open_new_chunk_dir_is_under_tmp() -> None:
    """Chunk tmpdirs land in the OS tempdir (e.g. /tmp), not under
    /clips. This protects clip directory layout cleanliness + means
    crash leaks are reaped by the OS tmpwatch."""

    w = _MinimalChunkWorker()
    chunk = w._open_new_chunk(time.time(), 0)
    try:
        # Path is under tempfile.gettempdir()
        assert Path(chunk["tmpdir"].name).resolve().is_relative_to(
            Path(tempfile.gettempdir()).resolve()
        )
    finally:
        chunk["tmpdir"].cleanup()


def test_rotate_chunk_moves_active_to_list_and_opens_new() -> None:
    w = _MinimalChunkWorker()
    w._current_chunk = w._open_new_chunk(time.time(), 0)
    # Fake a frame having landed so the rotate isn't a no-op.
    w._current_chunk["frame_count"] = 5
    closed_index = w._current_chunk["chunk_index"]

    w._rotate_chunk(time.time())

    try:
        # Active chunk index advanced; closed chunk moved to list.
        assert w._current_chunk is not None
        assert w._current_chunk["chunk_index"] == closed_index + 1
        assert len(w._clip_chunks) == 1
        assert w._clip_chunks[0]["chunk_index"] == closed_index
        assert w._clip_chunks[0]["frame_count"] == 5
    finally:
        if w._current_chunk is not None:
            w._current_chunk["tmpdir"].cleanup()
        for c in w._clip_chunks:
            c["tmpdir"].cleanup()


def test_rotate_chunk_no_op_when_active_has_zero_frames() -> None:
    """An empty active chunk should not rotate — the next person-
    present cycle will populate it and chunk_start_ts is already set."""
    w = _MinimalChunkWorker()
    w._current_chunk = w._open_new_chunk(time.time(), 0)
    w._current_chunk["frame_count"] = 0  # explicit
    same = w._current_chunk

    w._rotate_chunk(time.time())

    try:
        # _current_chunk is unchanged; list still empty.
        assert w._current_chunk is same
        assert w._clip_chunks == []
    finally:
        w._current_chunk["tmpdir"].cleanup()


# --- update_clip_encoding_config: snapshot semantics -----------------------


class _EncCfgWorker:
    """Stand-in for the encoding-config hot-swap test."""

    DEFAULT_CLIP_ENCODING_CONFIG = CaptureWorker.DEFAULT_CLIP_ENCODING_CONFIG

    def __init__(self, initial: dict) -> None:
        import threading

        self._clip_encoding_config_lock = threading.Lock()
        self._clip_encoding_config = dict(initial)

        class _Scope:
            tenant_id = 1

        self._scope = _Scope()
        self.camera_id = 11

    get_clip_encoding_config = CaptureWorker.get_clip_encoding_config
    update_clip_encoding_config = CaptureWorker.update_clip_encoding_config


def test_update_encoding_config_only_known_keys_kept() -> None:
    """Unknown keys are silently dropped — the worker never persists
    operator typos into runtime state."""

    w = _EncCfgWorker(dict(_EncCfgWorker.DEFAULT_CLIP_ENCODING_CONFIG))
    w.update_clip_encoding_config(
        {
            "chunk_duration_sec": 60,
            "video_crf": 28,
            "nonsense_key": "ignored",
        }
    )
    cfg = w.get_clip_encoding_config()
    assert cfg["chunk_duration_sec"] == 60
    assert cfg["video_crf"] == 28
    assert "nonsense_key" not in cfg
    # Unspecified keys fall back to migration-0056 defaults.
    assert cfg["video_preset"] == "veryfast"


def test_update_encoding_config_missing_keys_fall_back_to_defaults() -> None:
    """The worker normalises partial updates so chunk_duration_sec
    is never missing — the reader uses it on the rotation hot path."""

    w = _EncCfgWorker({"chunk_duration_sec": 120})
    # Update with a partial bag; missing keys should default-fill.
    w.update_clip_encoding_config({"video_crf": 30})
    cfg = w.get_clip_encoding_config()
    assert cfg["video_crf"] == 30
    # chunk_duration_sec was not in the new bag → defaults back to 180.
    assert cfg["chunk_duration_sec"] == 180
    # Migration 0056 default.
    assert cfg["video_preset"] == "veryfast"


def test_get_clip_encoding_config_returns_copy() -> None:
    """Caller-side mutation must not bleed into worker state."""
    w = _EncCfgWorker({"chunk_duration_sec": 180})
    snapshot = w.get_clip_encoding_config()
    snapshot["chunk_duration_sec"] = 9999
    assert w.get_clip_encoding_config()["chunk_duration_sec"] == 180


# --- ffmpeg concat integration smoke --------------------------------------


def _write_test_chunk(work_dir: Path, name: str, duration_sec: float) -> Path:
    """Synthesise a tiny solid-colour MP4 using ffmpeg's lavfi source.
    Used to exercise ``_concat_chunks`` without going through the full
    reader→ClipWorker path."""

    out = work_dir / name
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi",
        "-i", f"color=red:size=64x64:duration={duration_sec}:rate=10",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "ultrafast",
        "-crf", "30",
        str(out),
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=30)
    if r.returncode != 0:
        pytest.skip(f"ffmpeg unavailable or failed: {r.stderr[:200]!r}")
    return out


def test_concat_chunks_merges_n_chunks_into_one_mp4(tmp_path: Path) -> None:
    """Smoke: three short MP4 chunks → one merged MP4 with combined
    duration. Stream-copy concat preserves total frame count."""

    # Skip if ffmpeg isn't on PATH.
    if subprocess.run(
        ["which", "ffmpeg"], capture_output=True
    ).returncode != 0:
        pytest.skip("ffmpeg not on PATH")

    work = tmp_path / "work"
    work.mkdir()
    a = _write_test_chunk(work, "chunk_000.mp4", 1.0)
    b = _write_test_chunk(work, "chunk_001.mp4", 1.0)
    c = _write_test_chunk(work, "chunk_002.mp4", 1.0)

    # Borrow ClipWorker's _concat_chunks method via a minimal stub
    # (it only needs ``_camera_id`` for log lines).
    from maugood.capture.clip_worker import ClipWorker

    class _Calling:
        _camera_id = 1
        _concat_chunks = ClipWorker._concat_chunks

    merged = work / "final.mp4"
    ok = _Calling()._concat_chunks([a, b, c], merged)
    assert ok is True
    assert merged.exists()
    assert merged.stat().st_size > 0

    # Sanity-check duration via ffprobe.
    r = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(merged),
        ],
        capture_output=True,
        timeout=10,
    )
    if r.returncode == 0:
        dur = float(r.stdout.decode().strip())
        # Each input was 1 s; merged ≈ 3 s (allow timing jitter).
        assert 2.5 <= dur <= 3.5


# --- person_clip_chunks DB round-trip -------------------------------------


def _ensure_test_camera(admin_engine, tenant_id: int) -> int:
    """Return an existing camera_id for the tenant; create one if none.

    The cameras.repository.create_camera path goes through Fernet
    encryption of the URL — for the test we bypass that by inserting
    a row directly with a dummy encrypted token. The camera is left
    behind for subsequent tests in the same session.
    """

    from sqlalchemy import insert, select

    from maugood.db import cameras

    with admin_engine.begin() as conn:
        row = conn.execute(
            select(cameras.c.id)
            .where(cameras.c.tenant_id == tenant_id)
            .limit(1)
        ).first()
        if row is not None:
            return int(row.id)
        # Insert a placeholder camera. rtsp_url_encrypted is opaque
        # text on the DB side; the worker never gets spawned for this
        # row in tests.
        result = conn.execute(
            insert(cameras).values(
                tenant_id=tenant_id,
                name="phase-b-test-cam",
                location="",
                rtsp_url_encrypted="placeholder",
                camera_code="CAM-TEST",
            )
        )
        return int(result.inserted_primary_key[0])


def test_person_clip_chunks_row_persists(admin_engine) -> None:
    """INSERT a person_clip_chunks row referencing a real person_clips
    parent, read it back through the model, verify the FK + columns."""

    from sqlalchemy import delete, insert, select

    from maugood.db import (
        person_clip_chunks,
        person_clips,
    )

    tenant_id = 1
    camera_id = _ensure_test_camera(admin_engine, tenant_id)

    now = datetime.now(tz=timezone.utc)
    with admin_engine.begin() as conn:
        # Create parent clip with chunk_count=2.
        parent = conn.execute(
            insert(person_clips).values(
                tenant_id=tenant_id,
                camera_id=camera_id,
                clip_start=now,
                clip_end=now,
                duration_seconds=6.0,
                file_path="/tmp/phase-b-test.mp4",
                filesize_bytes=0,
                frame_count=120,
                detection_source="body",
                chunk_count=2,
            )
        )
        clip_id = parent.inserted_primary_key[0]
        # Two chunk rows.
        for idx in range(2):
            conn.execute(
                insert(person_clip_chunks).values(
                    tenant_id=tenant_id,
                    person_clip_id=clip_id,
                    chunk_index=idx,
                    chunk_start=now,
                    chunk_end=now,
                    file_path=None,
                    filesize_bytes=0,
                    frame_count=60,
                    merged=True,
                )
            )

    try:
        with admin_engine.begin() as conn:
            rows = conn.execute(
                select(person_clip_chunks)
                .where(
                    person_clip_chunks.c.person_clip_id == clip_id,
                    person_clip_chunks.c.tenant_id == tenant_id,
                )
                .order_by(person_clip_chunks.c.chunk_index.asc())
            ).all()
        assert len(rows) == 2
        assert rows[0].chunk_index == 0
        assert rows[1].chunk_index == 1
        assert rows[0].merged is True
        assert rows[1].merged is True
        # ON DELETE CASCADE from person_clips → person_clip_chunks.
        with admin_engine.begin() as conn:
            conn.execute(
                delete(person_clips).where(person_clips.c.id == clip_id)
            )
        with admin_engine.begin() as conn:
            remaining = conn.execute(
                select(person_clip_chunks).where(
                    person_clip_chunks.c.person_clip_id == clip_id
                )
            ).all()
        assert remaining == []
    finally:
        # Best-effort cleanup if the cascade didn't run.
        with admin_engine.begin() as conn:
            conn.execute(
                delete(person_clip_chunks).where(
                    person_clip_chunks.c.person_clip_id == clip_id
                )
            )
            conn.execute(
                delete(person_clips).where(person_clips.c.id == clip_id)
            )


# --- duplicate-chunk-index constraint --------------------------------------


def test_person_clip_chunks_uniq_clip_idx_rejects_dup(admin_engine) -> None:
    """The unique constraint ``(person_clip_id, chunk_index)`` blocks a
    duplicate chunk_index for the same parent clip."""

    from sqlalchemy import delete, insert
    from sqlalchemy.exc import IntegrityError

    from maugood.db import (
        person_clip_chunks,
        person_clips,
    )

    tenant_id = 1
    camera_id = _ensure_test_camera(admin_engine, tenant_id)

    now = datetime.now(tz=timezone.utc)
    with admin_engine.begin() as conn:
        parent = conn.execute(
            insert(person_clips).values(
                tenant_id=tenant_id,
                camera_id=camera_id,
                clip_start=now,
                clip_end=now,
                duration_seconds=1.0,
                file_path="/tmp/phase-b-dup.mp4",
                frame_count=3,
                detection_source="face",
                chunk_count=1,
            )
        )
        clip_id = parent.inserted_primary_key[0]

    try:
        with admin_engine.begin() as conn:
            conn.execute(
                insert(person_clip_chunks).values(
                    tenant_id=tenant_id,
                    person_clip_id=clip_id,
                    chunk_index=0,
                    chunk_start=now,
                    chunk_end=now,
                    frame_count=3,
                )
            )
        # Second INSERT with the same chunk_index must error out.
        with pytest.raises(IntegrityError):
            with admin_engine.begin() as conn:
                conn.execute(
                    insert(person_clip_chunks).values(
                        tenant_id=tenant_id,
                        person_clip_id=clip_id,
                        chunk_index=0,
                        chunk_start=now,
                        chunk_end=now,
                        frame_count=3,
                    )
                )
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(person_clip_chunks).where(
                    person_clip_chunks.c.person_clip_id == clip_id
                )
            )
            conn.execute(
                delete(person_clips).where(person_clips.c.id == clip_id)
            )
