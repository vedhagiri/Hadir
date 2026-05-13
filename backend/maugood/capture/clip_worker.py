"""Dedicated thread for offloading clip video encoding + writing.

Each ``CaptureWorker`` owns one ``ClipWorker``. The reader thread
collects frames when a person is present, then submits the collected
data to a thread-safe queue as soon as the person leaves the frame.
The clip worker thread drains the queue, assembles the video via
ffmpeg, encrypts it, writes to disk, and INSERTs a ``person_clips``
row — all without blocking the reader.

Why ffmpeg?
    OpenCV's ``VideoWriter`` with ``mp4v`` fourcc produces MP4 files
    that are missing the ``moov`` atom on many systems, making them
    unplayable in browsers. ffmpeg with ``libx264`` always produces
    proper H.264 MP4s with correct metadata.

Storage structure (Phase A, migration 0052)::

    /clips/
        {DD-MM-YYYY}/
            {slugified_camera_name}/
                {start_HHMMSS}-{end_HHMMSS}.mp4

Example::

    /clips/12-05-2026/front-lobby/130200-130512.mp4

The camera name slug is lowercase, with any character outside
``[a-z0-9_-]`` rewritten to ``-`` and repeated/leading/trailing
dashes collapsed. Empty slugs fall back to ``camera-{id}``.

Two cameras whose names slugify to the same value share a directory
— filenames are unique by timestamp so there is no collision in
practice.

Legacy clips written before migration 0052 keep their original path
strings (the ``file_path`` column is plain text, never rewritten).
The stream/thumbnail endpoints serve both layouts from the absolute
path stored on the row.
"""

from __future__ import annotations

import logging
import queue
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy.engine import Engine

from maugood.employees.photos import encrypt_bytes
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Minimum frames required for a valid clip. Fewer than this and the
# video would be too short to decode meaningfully in a browser.
_MIN_CLIP_FRAMES = 3


def slugify_camera_name(name: str, camera_id: int) -> str:
    """Return a filesystem-safe slug derived from ``name``.

    Rules (Phase A path format):
      * Lowercased
      * Any character outside ``[a-z0-9_-]`` replaced with ``-``
      * Repeated dashes collapsed
      * Leading/trailing dashes stripped
      * Empty result falls back to ``camera-{camera_id}``

    Two cameras whose names happen to slugify to the same value will
    share a directory — that is acceptable because clip filenames are
    unique by timestamp. The fallback only fires for genuinely empty
    inputs (whitespace-only / non-ASCII names that strip to nothing).
    """

    import re  # noqa: PLC0415

    if not isinstance(name, str):
        name = str(name or "")
    lowered = name.strip().lower()
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", lowered)
    collapsed = re.sub(r"-{2,}", "-", cleaned).strip("-")
    if not collapsed:
        return f"camera-{int(camera_id)}"
    return collapsed


class ClipWorker:
    """Dedicated thread for finalizing person clips asynchronously.

    Usage::

        worker = ClipWorker(engine=..., scope=..., camera_id=1, ...)
        worker.start()
        worker.submit_clip({"frames": [...], "start_ts": ...})
        ...
        worker.stop()
    """

    def __init__(
        self,
        *,
        engine: Engine,
        scope: TenantScope,
        camera_id: int,
        camera_name: str,
    ) -> None:
        self._engine = engine
        self._scope = scope
        self._camera_id = camera_id
        self._camera_name = camera_name

        # Bounded queue prevents OOM if the worker falls behind.
        self._queue: queue.Queue = queue.Queue(maxsize=16)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name=f"clipwk-{self._camera_id}",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=timeout)
        self._thread = None

    def is_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def queue_size(self) -> int:
        """Return the number of clips waiting in the queue."""
        return self._queue.qsize()

    # ------------------------------------------------------------------
    # Public: submit a clip for finalization
    # ------------------------------------------------------------------

    def submit_clip(self, clip_data: dict) -> bool:
        """Submit clip data for finalization.

        Non-blocking. Returns ``True`` if the data was queued, or
        ``False`` if the queue was full (the clip is dropped and a
        warning is logged).
        """

        try:
            self._queue.put_nowait(clip_data)
            return True
        except queue.Full:
            logger.warning(
                "clip worker queue full (camera=%s) — dropping clip",
                self._camera_id,
            )
            return False

    # ------------------------------------------------------------------
    # Internal: worker thread
    # ------------------------------------------------------------------

    def _run(self) -> None:
        from maugood.db import tenant_context  # noqa: PLC0415

        with tenant_context(self._scope.tenant_schema):
            while not self._stop.is_set():
                try:
                    clip_data = self._queue.get(timeout=1.0)
                except queue.Empty:
                    continue
                try:
                    self._finalize_clip(clip_data)
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        "clip finalization failed: camera=%s reason=%s",
                        self._camera_id,
                        type(exc).__name__,
                    )

    # ------------------------------------------------------------------
    # Encoding defaults (Phase B). Used when the reader's snapshot is
    # missing a key — defence in depth on top of the JSONB
    # server_default + the worker's own DEFAULT_CLIP_ENCODING_CONFIG.
    # ------------------------------------------------------------------
    # Migration 0056 — defaults bumped to veryfast / CRF 26 for ~1.5×
    # faster encoding at slightly higher compression. The tenant
    # config overrides these for any real clip; this only fires for
    # the legacy INSERT-at-finalize fallback path where no snapshot
    # was provided.
    _DEFAULT_CRF = 26
    _DEFAULT_PRESET = "veryfast"

    # Cap on concurrent chunk encodes per clip. ffmpeg is a subprocess
    # so the GIL is irrelevant; the cap is about CPU + I/O. 4 is a
    # safe number on a 4+ core box without thrashing L1/L2 cache.
    # Long clips (e.g. 10 chunks) get ~min(10, 4) = 4× parallelism.
    _MAX_PARALLEL_CHUNKS = 4

    def _finalize_clip(self, clip_data: dict) -> None:
        """Encode every chunk into an H.264 MP4, optionally concat-merge
        into a single final file, Fernet-encrypt it, persist to disk,
        and INSERT one ``person_clips`` row plus one
        ``person_clip_chunks`` row per chunk.

        Phase B contract: ``clip_data["chunks"]`` is a list of dicts,
        each owning its own ``TemporaryDirectory`` of JPEG frames. The
        method calls ``.cleanup()`` on every chunk tmpdir + the
        work-dir in its finally block so disk space is always freed.

        Single-chunk clips take the fast path (no concat); multi-chunk
        clips run ``ffmpeg -f concat -c copy`` to stitch — no re-encode,
        seconds-fast even for hour-long clips.
        """

        import sqlalchemy as sa  # noqa: PLC0415
        from maugood.config import get_settings as _gs  # noqa: PLC0415
        from maugood.db import person_clip_chunks as _pcc  # noqa: PLC0415
        from maugood.db import person_clips as _pc  # noqa: PLC0415

        settings = _gs()
        if not settings.clip_save_enabled:
            return

        # Phase B: chunks list is the new contract.
        chunks: list[dict] = clip_data.get("chunks") or []
        frame_count = int(clip_data.get("frame_count", 0))
        first_ts = float(clip_data.get("first_ts", 0.0))
        last_ts = float(clip_data.get("last_ts", 0.0))
        camera_fps = float(clip_data.get("fps", 25.0))
        person_count = int(clip_data.get("person_count", 0))
        matched_employees: list[int] = clip_data.get("matched_employees", [])
        resolution_w: Optional[int] = clip_data.get("resolution_w")
        resolution_h: Optional[int] = clip_data.get("resolution_h")
        # Migration 0052 / 0053 — which detector triggered the clip.
        # Default falls back to 'body' (migration 0053 server_default)
        # if the reader's clip_data dict is missing the key.
        detection_source_raw = clip_data.get("detection_source", "body")
        detection_source = (
            detection_source_raw
            if detection_source_raw in ("face", "body", "both")
            else "body"
        )
        # Migration 0054 — id of the row INSERTed at clip start with
        # recording_status='recording'. When present we UPDATE that
        # row; when absent (start INSERT failed), we INSERT a fresh
        # one as the legacy path.
        existing_clip_id_raw = clip_data.get("clip_id")
        existing_clip_id: Optional[int] = (
            int(existing_clip_id_raw)
            if existing_clip_id_raw is not None
            else None
        )
        # Phase B — encoding snapshot taken at clip start.
        encoding_cfg: dict = dict(clip_data.get("encoding_config") or {})
        crf = int(encoding_cfg.get("video_crf", self._DEFAULT_CRF))
        preset = str(encoding_cfg.get("video_preset", self._DEFAULT_PRESET))
        max_height_raw = encoding_cfg.get("resolution_max_height")
        max_height = int(max_height_raw) if max_height_raw else None
        keep_chunks_after_merge = bool(
            encoding_cfg.get("keep_chunks_after_merge", False)
        )

        # Working directory holds intermediate chunk MP4s and (for
        # multi-chunk clips) the concat-merge output. Stays in /tmp
        # by default — no plaintext video lands under /clips/ until
        # encryption.
        work_dir_obj = tempfile.TemporaryDirectory(prefix="maugood_clipwork_")
        work_dir = Path(work_dir_obj.name)

        try:
            if not chunks or frame_count < _MIN_CLIP_FRAMES:
                logger.debug(
                    "clip too short (%d frames, %d chunks) skipping: camera=%s",
                    frame_count, len(chunks), self._camera_id,
                )
                # Migration 0054 — reader normally deletes the
                # placeholder row in this case, but if a clip_id
                # arrived here we still want to clean it up so the
                # UI doesn't carry a ghost 🔴 LIVE entry.
                self._mark_recording_failed(existing_clip_id)
                return

            # Compute the clip's overall actual FPS from wall-clock
            # timestamps. Every chunk is encoded at this same FPS so
            # ``ffmpeg -c copy`` concat produces a clean stream — chunks
            # otherwise have slightly different per-chunk FPS values
            # which break -c copy timing.
            duration = last_ts - first_ts
            if duration > 0.5 and frame_count >= 2:
                actual_fps = frame_count / duration
                actual_fps = max(0.5, min(actual_fps, 120.0))
            else:
                actual_fps = camera_fps

            clip_start_dt = datetime.fromtimestamp(first_ts, tz=timezone.utc)
            clip_end_dt = datetime.fromtimestamp(last_ts, tz=timezone.utc)

            # --- Storage layout (Phase A path format, unchanged) ----------
            # /clips/{DD-MM-YYYY}/{camera-slug}/{HHMMSS}-{HHMMSS}.mp4
            date_str = clip_start_dt.strftime("%d-%m-%Y")
            start_hms = clip_start_dt.strftime("%H%M%S")
            end_hms = clip_end_dt.strftime("%H%M%S")
            filename = f"{start_hms}-{end_hms}.mp4"

            camera_slug = slugify_camera_name(
                self._camera_name, self._camera_id
            )
            clip_dir = (
                Path(settings.clip_storage_root)
                / date_str
                / camera_slug
            )
            file_path = clip_dir / filename
            thumb_path = file_path.with_suffix(".thumb.jpg")

            # If the operator opted in to keep chunks on disk, they
            # land in a sibling subdirectory named for the clip's time
            # window. The subdir is empty when keep_chunks_after_merge
            # is false (default) — no path leak in that case.
            chunk_dir = clip_dir / f"_chunks_{start_hms}-{end_hms}"

            encoding_start_at = datetime.now(timezone.utc)

            # ---- Per-chunk encode pass ----------------------------------
            # Migration 0056 — chunks encode in parallel via a small
            # ThreadPoolExecutor. ffmpeg is a subprocess so the GIL
            # is a non-issue; concurrency lets a multi-chunk clip
            # finalise in ~max(chunk_time) instead of
            # ~sum(chunk_time). Cap concurrency at ``_MAX_PARALLEL_CHUNKS``
            # so a giant clip can't saturate the box with N ffmpegs
            # competing for cache + I/O.
            encodable_chunks: list[dict] = []
            for c in chunks:
                idx = int(c["chunk_index"])
                tmpdir_obj = c["tmpdir"]
                chunk_first_ts = float(c["first_ts"])
                chunk_last_ts = float(c["last_ts"])
                chunk_frames = int(c["frame_count"])
                if chunk_frames < 1:
                    continue
                encodable_chunks.append({
                    "chunk_index": idx,
                    "tmpdir_obj": tmpdir_obj,
                    "first_ts": chunk_first_ts,
                    "last_ts": chunk_last_ts,
                    "frame_count": chunk_frames,
                    "out_mp4": work_dir / f"chunk_{idx:03d}.mp4",
                })

            chunk_records: list[dict] = []
            chunk_outputs: list[Path] = []
            if encodable_chunks:
                ok_all = self._encode_chunks_parallel(
                    encodable_chunks,
                    fps=actual_fps,
                    crf=crf,
                    preset=preset,
                    max_height=max_height,
                )
                if not ok_all:
                    logger.warning(
                        "clip chunk encode failed: camera=%s "
                        "chunks=%d",
                        self._camera_id, len(encodable_chunks),
                    )
                    self._mark_recording_failed(existing_clip_id)
                    return
                for c in encodable_chunks:
                    chunk_records.append(
                        {
                            "chunk_index": c["chunk_index"],
                            "first_ts": c["first_ts"],
                            "last_ts": c["last_ts"],
                            "frame_count": c["frame_count"],
                            "intermediate_path": c["out_mp4"],
                        }
                    )
                    chunk_outputs.append(c["out_mp4"])

            if not chunk_outputs:
                logger.warning(
                    "clip had no encodable chunks: camera=%s", self._camera_id
                )
                self._mark_recording_failed(existing_clip_id)
                return

            # ---- Merge step ----------------------------------------------
            try:
                clip_dir.mkdir(parents=True, exist_ok=True)
                if len(chunk_outputs) == 1:
                    # Single-chunk fast path — no concat. Read directly.
                    plain_bytes = chunk_outputs[0].read_bytes()
                else:
                    # Multi-chunk: ffmpeg -f concat -c copy. Stream-copy
                    # is O(seconds) even for hour-long clips because
                    # there's no re-encoding.
                    merged = work_dir / "final.mp4"
                    if not self._concat_chunks(chunk_outputs, merged):
                        self._mark_recording_failed(existing_clip_id)
                        return
                    plain_bytes = merged.read_bytes()

                if not plain_bytes:
                    logger.warning(
                        "clip output empty: camera=%s", self._camera_id
                    )
                    self._mark_recording_failed(existing_clip_id)
                    return

                encoding_end_at = datetime.now(timezone.utc)

                encrypted = encrypt_bytes(plain_bytes)
                file_path.write_bytes(encrypted)

                # Thumbnail: first frame of chunk 0 (already on disk).
                first_chunk_tmpdir = Path(chunks[0]["tmpdir"].name)
                thumb_srcs = sorted(first_chunk_tmpdir.glob("frame_*.jpg"))
                if thumb_srcs:
                    thumb_encrypted = encrypt_bytes(
                        thumb_srcs[0].read_bytes()
                    )
                    thumb_path.write_bytes(thumb_encrypted)

                filesize = file_path.stat().st_size
                logger.info(
                    "clip saved: camera=%s frames=%d fps=%.2f "
                    "duration=%.1fs chunks=%d size=%d path=%s",
                    self._camera_id,
                    frame_count, actual_fps, duration,
                    len(chunk_outputs), filesize, file_path,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "clip write failed: camera=%s reason=%s",
                    self._camera_id, type(exc).__name__,
                )
                file_path.unlink(missing_ok=True)
                thumb_path.unlink(missing_ok=True)
                self._mark_recording_failed(existing_clip_id)
                return

            # ---- Optionally persist chunks alongside the final clip ------
            # Each kept chunk is Fernet-encrypted; identical security
            # posture to the final file. When keep_chunks_after_merge
            # is False (default) chunks stay in /tmp (work_dir) and
            # vanish when work_dir_obj.cleanup() runs.
            if keep_chunks_after_merge:
                try:
                    chunk_dir.mkdir(parents=True, exist_ok=True)
                    for rec in chunk_records:
                        kept = chunk_dir / rec["intermediate_path"].name
                        enc = encrypt_bytes(
                            rec["intermediate_path"].read_bytes()
                        )
                        kept.write_bytes(enc)
                        rec["persistent_path"] = kept
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "chunk persist failed: camera=%s reason=%s",
                        self._camera_id, type(exc).__name__,
                    )
                    # Continue — the merged final file is still good.

            # ---- DB write: UPDATE if recording row exists, else INSERT ----
            # Migration 0054 — when the reader INSERTed a placeholder
            # at clip start (recording_status='recording'), we UPDATE
            # that same row so its primary key is stable for the
            # frontend (no flicker between "live" id N and "completed"
            # id M). Fallback INSERT is the legacy path for clips that
            # started before the placeholder INSERT landed (or where
            # the placeholder INSERT failed).
            clip_id: Optional[int] = None
            try:
                with self._engine.begin() as conn:
                    final_values = dict(
                        clip_start=clip_start_dt,
                        clip_end=clip_end_dt,
                        duration_seconds=duration,
                        file_path=str(file_path),
                        filesize_bytes=filesize,
                        frame_count=frame_count,
                        person_count=person_count,
                        matched_employees=matched_employees,
                        encoding_start_at=encoding_start_at,
                        encoding_end_at=encoding_end_at,
                        fps_recorded=round(actual_fps, 2),
                        resolution_w=int(resolution_w) if resolution_w else None,
                        resolution_h=int(resolution_h) if resolution_h else None,
                        detection_source=detection_source,
                        chunk_count=len(chunk_records),
                        recording_status="completed",
                    )
                    if existing_clip_id is not None:
                        upd = conn.execute(
                            sa.update(_pc)
                            .where(
                                _pc.c.id == existing_clip_id,
                                _pc.c.tenant_id == self._scope.tenant_id,
                                # Defensive: only flip a row whose
                                # state still belongs to this clip's
                                # lifecycle. ``recording`` covers the
                                # case where the reader's pre-handoff
                                # 'finalizing' flip failed (best-
                                # effort) and the row is still
                                # 'recording'. ``finalizing`` is the
                                # normal post-handoff state. We
                                # explicitly DO NOT match 'completed'
                                # or 'failed' so a double-finalize
                                # can't clobber a row.
                                _pc.c.recording_status.in_(
                                    ("recording", "finalizing")
                                ),
                            )
                            .values(**final_values)
                        )
                        if upd.rowcount == 0:
                            # Placeholder row vanished or was already
                            # finalized somewhere else — fall back to
                            # an INSERT so the clip still lands.
                            logger.warning(
                                "clip placeholder row missing: "
                                "camera=%s clip_id=%s — fresh INSERT",
                                self._camera_id, existing_clip_id,
                            )
                            existing_clip_id = None
                        else:
                            clip_id = existing_clip_id

                    if existing_clip_id is None:
                        result = conn.execute(
                            sa.insert(_pc).values(
                                tenant_id=self._scope.tenant_id,
                                camera_id=self._camera_id,
                                employee_id=None,
                                track_id=None,
                                detection_event_id=None,
                                **final_values,
                            )
                        )
                        clip_id = (  # type: ignore[arg-type]
                            result.inserted_primary_key[0]
                            if result.inserted_primary_key
                            else None
                        )

                    # Per-chunk rows. ``merged=True`` indicates the
                    # chunk has been rolled into the final file —
                    # consumers should fetch the final, not the chunk.
                    if clip_id is not None:
                        for rec in chunk_records:
                            persistent = rec.get("persistent_path")
                            conn.execute(
                                sa.insert(_pcc).values(
                                    tenant_id=self._scope.tenant_id,
                                    person_clip_id=clip_id,
                                    chunk_index=int(rec["chunk_index"]),
                                    chunk_start=datetime.fromtimestamp(
                                        rec["first_ts"], tz=timezone.utc
                                    ),
                                    chunk_end=datetime.fromtimestamp(
                                        rec["last_ts"], tz=timezone.utc
                                    ),
                                    file_path=(
                                        str(persistent) if persistent else None
                                    ),
                                    filesize_bytes=(
                                        persistent.stat().st_size
                                        if persistent and persistent.exists()
                                        else 0
                                    ),
                                    frame_count=int(rec["frame_count"]),
                                    merged=True,
                                )
                            )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "clip INSERT failed: camera=%s reason=%s",
                    self._camera_id, type(exc).__name__,
                )

            # Migration 0058 — face-matching is now an explicit
            # operator action. ClipWorker writes the encoded MP4 and
            # leaves ``matched_status='pending'`` on the row; no
            # face-match daemon thread fires. The operator triggers
            # UC1+UC2 from the clip card's right-click "Process" menu
            # OR from the detail drawer's Reprocess button. Both go
            # through ``POST /api/person-clips/{id}/reprocess``.
            #
            # Rationale: many clips on body-source cameras have no
            # faces to match (back-of-head, occlusion). Auto-running
            # face-match on every clip burns CPU on guaranteed
            # no-result work. Operator-triggered keeps the matching
            # CPU spent only on clips the operator actually cares
            # about identifying.
            #
            # ``detection_source`` is still persisted on the row
            # (used by the UI to surface which detector triggered
            # the clip).

        finally:
            # Always free temp disk space, regardless of success/failure.
            try:
                work_dir_obj.cleanup()
            except Exception:  # noqa: BLE001
                pass
            for c in chunks:
                tmpdir_obj = c.get("tmpdir")
                if tmpdir_obj is not None:
                    try:
                        tmpdir_obj.cleanup()
                    except Exception:  # noqa: BLE001
                        pass

    def _mark_recording_failed(self, clip_id: Optional[int]) -> None:
        """Flip a placeholder ``recording`` row to ``failed`` (migration
        0054). Best-effort: errors are logged but never raised.

        Called from the early-return paths in ``_finalize_clip`` so a
        clip whose encode / concat / write failed transitions out of
        'recording' rather than lingering until the next startup
        janitor sweep.
        """

        if clip_id is None:
            return

        import sqlalchemy as sa  # noqa: PLC0415

        from maugood.db import person_clips as _pc  # noqa: PLC0415

        try:
            with self._engine.begin() as conn:
                conn.execute(
                    sa.update(_pc)
                    .where(
                        _pc.c.id == int(clip_id),
                        _pc.c.tenant_id == self._scope.tenant_id,
                        # Migration 0055 — accept either pre-state.
                        # 'recording' covers a finalizing-flip that
                        # failed; 'finalizing' is the normal path.
                        _pc.c.recording_status.in_(
                            ("recording", "finalizing")
                        ),
                    )
                    .values(recording_status="failed")
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "recording-row failed-flip failed: camera=%s "
                "clip_id=%s reason=%s",
                self._camera_id, clip_id, type(exc).__name__,
            )

    def _encode_chunks_parallel(
        self,
        encodable_chunks: list[dict],
        *,
        fps: float,
        crf: int,
        preset: str,
        max_height: Optional[int],
    ) -> bool:
        """Encode N chunks concurrently via a ThreadPoolExecutor.

        ffmpeg is a subprocess (no GIL), so multiple chunks can encode
        truly in parallel. Concurrency is capped at
        ``_MAX_PARALLEL_CHUNKS`` so a long clip with many chunks
        doesn't saturate the box with ffmpegs competing for L1/L2
        cache + disk I/O. With 4× parallelism on a multi-core machine,
        a 10-chunk (~30 min) clip finalises in roughly
        ``ceil(10/4) × max(chunk_time)`` instead of
        ``10 × chunk_time``.

        Returns True if every chunk encoded successfully; False on
        any failure (caller marks the row as ``failed``).
        """

        from concurrent.futures import ThreadPoolExecutor, as_completed  # noqa: PLC0415

        if not encodable_chunks:
            return True

        max_workers = min(
            self._MAX_PARALLEL_CHUNKS, len(encodable_chunks)
        )
        # Single-chunk fast path skips the pool entirely — no thread
        # spawn overhead for the most common case (clips ≤ 3 min).
        if max_workers <= 1:
            c = encodable_chunks[0]
            return self._encode_chunk_to_file(
                tmpdir_path=c["tmpdir_obj"].name,
                out_path=c["out_mp4"],
                fps=fps,
                crf=crf,
                preset=preset,
                max_height=max_height,
            )

        ok_all = True
        with ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix=f"clipenc-{self._camera_id}",
        ) as pool:
            futures = {
                pool.submit(
                    self._encode_chunk_to_file,
                    tmpdir_path=c["tmpdir_obj"].name,
                    out_path=c["out_mp4"],
                    fps=fps,
                    crf=crf,
                    preset=preset,
                    max_height=max_height,
                ): c["chunk_index"]
                for c in encodable_chunks
            }
            for fut in as_completed(futures):
                idx = futures[fut]
                try:
                    ok = fut.result()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "clip chunk encode raised: camera=%s "
                        "chunk_index=%d reason=%s",
                        self._camera_id, idx, type(exc).__name__,
                    )
                    ok = False
                if not ok:
                    ok_all = False
        return ok_all

    def _encode_chunk_to_file(
        self,
        *,
        tmpdir_path: str,
        out_path: Path,
        fps: float,
        crf: int,
        preset: str,
        max_height: Optional[int],
    ) -> bool:
        """Encode one chunk's frames into an H.264 MP4 at ``out_path``.

        Frames are at ``tmpdir_path/frame_NNN.jpg``. CRF + preset come
        from the tenant encoding snapshot; ``max_height`` (if set)
        triggers a ``-vf scale=-2:N`` downscale that keeps width even
        for libx264.

        All chunks within one clip are encoded with identical params
        so a subsequent ``ffmpeg -c copy`` concat produces clean
        playback (different fps / pix_fmt would break stream-copy).
        """

        cmd: list[str] = [
            "ffmpeg", "-y",
            "-framerate", f"{fps:.6f}",
            "-pattern_type", "glob",
            "-i", "*.jpg",
        ]
        if max_height is not None and max_height > 0:
            # scale=-2:H downscales to height H, width auto-rounded
            # to an even number (required by yuv420p).
            cmd.extend(["-vf", f"scale=-2:{int(max_height)}"])
        cmd.extend([
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", preset,
            "-crf", str(crf),
            "-movflags", "+faststart",
            str(out_path),
        ])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                cwd=tmpdir_path,
                timeout=300,  # 5 min — per-chunk cap; clip total can be much longer
            )
        except subprocess.TimeoutExpired:
            logger.warning(
                "ffmpeg chunk encode timeout: camera=%s out=%s",
                self._camera_id, out_path.name,
            )
            return False

        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")[:500]
            logger.warning(
                "ffmpeg chunk failed: camera=%s out=%s rc=%d stderr=%s",
                self._camera_id, out_path.name, result.returncode, stderr,
            )
            return False

        if not out_path.exists() or out_path.stat().st_size == 0:
            logger.warning(
                "ffmpeg chunk output empty: camera=%s out=%s",
                self._camera_id, out_path.name,
            )
            return False

        return True

    def _concat_chunks(
        self,
        chunk_paths: list[Path],
        merged: Path,
    ) -> bool:
        """Stream-copy concat N chunks into one MP4 via ffmpeg.

        Uses the concat demuxer (``-f concat -c copy``) so the merge
        is O(seconds) even for very long clips — no re-encoding. Every
        chunk must share codec + pix_fmt + fps + resolution, which is
        guaranteed by ``_encode_chunk_to_file`` reusing the same args.
        """

        # Write the concat input list. -safe 0 lets us use absolute
        # paths; ffmpeg refuses them by default.
        list_path = merged.parent / "concat.txt"
        list_path.write_text(
            "".join(f"file '{p.resolve()}'\n" for p in chunk_paths),
            encoding="utf-8",
        )

        cmd = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(list_path),
            "-c", "copy",
            "-movflags", "+faststart",
            str(merged),
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                timeout=600,  # 10 min — concat is fast but long clips have many chunks
            )
        except subprocess.TimeoutExpired:
            logger.warning(
                "ffmpeg concat timeout: camera=%s chunks=%d",
                self._camera_id, len(chunk_paths),
            )
            return False

        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")[:500]
            logger.warning(
                "ffmpeg concat failed: camera=%s chunks=%d rc=%d stderr=%s",
                self._camera_id, len(chunk_paths), result.returncode, stderr,
            )
            return False

        if not merged.exists() or merged.stat().st_size == 0:
            logger.warning(
                "ffmpeg concat output empty: camera=%s", self._camera_id
            )
            return False

        return True


def _trigger_face_match(clip_id: int, scope: "TenantScope") -> None:
    """Launch a fire-and-forget daemon thread to process face matching
    for a single clip. Never blocks the caller — errors are logged at
    WARNING, never raised.
    """

    def _run() -> None:
        try:
            from maugood.person_clips.reprocess import (  # noqa: PLC0415
                process_single_clip,
            )
            process_single_clip(clip_id, scope)
        except Exception:  # noqa: BLE001
            logger.warning(
                "face-match trigger failed: clip=%s camera=%s",
                clip_id, scope.tenant_id,
                exc_info=True,
            )

    t = threading.Thread(
        target=_run,
        name=f"facematch-{clip_id}",
        daemon=True,
    )
    t.start()
