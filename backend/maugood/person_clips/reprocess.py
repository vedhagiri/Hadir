"""Background reprocess worker for face matching on saved person clips.

Runs asynchronously so live capture, clip recording, and UI stay
responsive. For each clip: decrypt → sample frames at ~2 fps →
InsightFace detect + matcher.match() → update ``matched_employees``
JSONB column on the ``person_clips`` row.

Two entry points:

* ``process_single_clip(clip_id, scope)`` — standalone function that
  processes one clip and updates the DB synchronously. Called from the
  clip worker in a fire-and-forget daemon thread immediately after a
  new clip is saved.

* ``ReprocessFaceMatchWorker`` — batch worker that processes all (or
  filtered) clips. Triggered manually via the API endpoint.
"""

from __future__ import annotations

import logging
import queue
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import numpy as np
from sqlalchemy import select as sa_select, update as sa_update

from maugood.auth.audit import write_audit
from maugood.config import get_settings
from maugood.db import employees, get_engine, person_clips
from maugood.employees.photos import decrypt_bytes
from maugood.identification.matcher import matcher_cache
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Sample ~2 fps from the clip for face detection.
_FRAMES_PER_SECOND_SAMPLE = 2

# Max number of frames to process from a single clip (safety cap).
_MAX_FRAMES_PER_CLIP = 200


class ReprocessFaceMatchWorker:
    """Background worker that reprocesses saved person clips for face matching.

    One instance per tenant. Started by the endpoint; status dict is
    readable by the status polling endpoint. Thread-safe via a lock on
    ``_status``.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Status is set before the thread starts so the polling endpoint
        # can immediately return "running" rather than "idle".
        self._status: dict[str, Any] = {"status": "idle"}
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        # Queue for cancellation signals.
        self._cmd_queue: queue.Queue[str] = queue.Queue()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_status(self) -> dict[str, Any]:
        """Return a snapshot of the current status dict."""
        with self._lock:
            return dict(self._status)

    def is_running(self) -> bool:
        with self._lock:
            return self._status.get("status") == "running"

    def trigger(
        self,
        scope: TenantScope,
        mode: str = "all",
        actor_user_id: Optional[int] = None,
    ) -> bool:
        """Start reprocessing. Returns False if already running."""
        if self.is_running():
            return False

        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            args=(scope, mode, actor_user_id),
            name=f"face-match-reprocess-{scope.tenant_id}",
            daemon=True,
        )
        self._thread.start()
        return True

    def cancel(self) -> bool:
        """Request cancellation. Returns False if not running."""
        if not self.is_running():
            return False
        self._stop.set()
        self._cmd_queue.put("cancel")
        return True

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _set_status(self, **updates: Any) -> None:
        with self._lock:
            self._status.update(updates)

    def _handle_error(self, msg: str) -> None:
        logger.error("face match reprocess: %s", msg)
        with self._lock:
            errs: list[str] = self._status.get("errors", [])
            errs.append(msg)
            self._status["errors"] = errs
            self._status["failed_count"] = (self._status.get("failed_count", 0)) + 1

    def _sample_frames(
        self, video_path: Path, fps: float
    ) -> tuple[list[np.ndarray], int, float]:
        """Open a decrypted video file and sample frames at ~2 fps.

        Uses OpenCV ``VideoCapture``. Returns ``(frames, sample_interval, actual_fps)``.
        Caps at ``_MAX_FRAMES_PER_CLIP``.
        """
        import cv2  # noqa: PLC0415

        frames: list[np.ndarray] = []
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            cap.release()
            return frames, 1, fps

        actual_fps = max(1.0, cap.get(cv2.CAP_PROP_FPS) or fps)
        sample_interval = max(1, int(round(actual_fps / _FRAMES_PER_SECOND_SAMPLE)))

        frame_idx = 0
        sampled = 0
        while sampled < _MAX_FRAMES_PER_CLIP:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            if frame_idx % sample_interval == 0:
                frames.append(frame)
                sampled += 1
            frame_idx += 1

        cap.release()
        return frames, sample_interval, actual_fps

    def _detect_and_match(
        self, frames: list[np.ndarray], scope: TenantScope
    ) -> tuple[set[int], int | None, int | None]:
        """Run face detection + matching on sampled frames.

        Returns ``(matched_ids, first_detection_sample_idx, last_detection_sample_idx)``.
        """
        from maugood.detection import DetectorConfig, detect as detector_detect  # noqa: PLC0415

        matched_ids: set[int] = set()
        first_idx: int | None = None
        last_idx: int | None = None
        cfg = DetectorConfig()

        for i, frame in enumerate(frames):
            if self._stop.is_set():
                break
            try:
                results = detector_detect(frame, cfg)
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "detect failed on frame: %s", type(exc).__name__
                )
                continue

            found = False
            for det in results:
                emb = det.get("embedding")
                if emb is None:
                    continue
                probe = np.asarray(emb, dtype=np.float32)
                mm = matcher_cache.match(scope, probe)
                if mm is not None and mm.classification == "active":
                    matched_ids.add(mm.employee_id)
                    found = True

            if found:
                if first_idx is None:
                    first_idx = i
                last_idx = i

        return matched_ids, first_idx, last_idx

    def _run(
        self,
        scope: TenantScope,
        mode: str,
        actor_user_id: Optional[int],
    ) -> None:
        """Main reprocess loop, runs on the background thread."""
        from maugood.db import tenant_context  # noqa: PLC0415

        with tenant_context(scope.tenant_schema):
            try:
                self._process(scope, mode, actor_user_id)
            except Exception as exc:  # noqa: BLE001
                self._set_status(
                    status="failed",
                    error=f"unexpected error: {type(exc).__name__}: {exc}",
                    ended_at=datetime.now(timezone.utc).isoformat(),
                )
                self._handle_error(str(exc))

    def _process(
        self,
        scope: TenantScope,
        mode: str,
        actor_user_id: Optional[int],
    ) -> None:
        engine = get_engine()
        settings = get_settings()

        now = datetime.now(timezone.utc).isoformat()
        self._set_status(
            status="running",
            mode=mode,
            total_clips=0,
            processed_clips=0,
            matched_total=0,
            failed_count=0,
            errors=[],
            started_at=now,
            ended_at=None,
        )

        # Load all person clips for the tenant.
        with engine.begin() as conn:
            query = sa_select(
                person_clips.c.id,
                person_clips.c.camera_id,
                person_clips.c.file_path,
                person_clips.c.matched_employees,
                person_clips.c.clip_start,
                person_clips.c.duration_seconds,
                person_clips.c.frame_count,
            ).where(person_clips.c.tenant_id == scope.tenant_id)

            if mode == "skip_existing":
                # Skip clips that already have matched employees.
                query = query.where(
                    person_clips.c.matched_employees == "[]"
                )

            rows = conn.execute(query).all()

        total = len(rows)
        self._set_status(total_clips=total)
        logger.info(
            "face match reprocess starting: tenant=%s mode=%s total_clips=%d",
            scope.tenant_id, mode, total,
        )

        # Audit one row for the whole reprocess run.
        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=actor_user_id,
                action="person_clip.reprocess_started",
                entity_type="person_clip",
                entity_id=None,
                after={
                    "mode": mode,
                    "total_clips": total,
                    "has_existing_data": any(
                        r.matched_employees and r.matched_employees != "[]"
                        for r in rows
                    ),
                },
            )

        if total == 0:
            self._set_status(
                status="completed",
                processed_clips=0,
                matched_total=0,
                ended_at=datetime.now(timezone.utc).isoformat(),
            )
            logger.info(
                "face match reprocess: no clips to process (tenant=%s)",
                scope.tenant_id,
            )
            return

        processed = 0
        matched_total = 0

        for row in rows:
            if self._stop.is_set():
                logger.info(
                    "face match reprocess cancelled: tenant=%s "
                    "processed=%d/%d",
                    scope.tenant_id, processed, total,
                )
                self._set_status(
                    status="cancelled",
                    ended_at=datetime.now(timezone.utc).isoformat(),
                )
                return

            clip_id = int(row.id)
            file_path_str = str(row.file_path or "")
            if not file_path_str or not Path(file_path_str).exists():
                self._handle_error(
                    f"clip {clip_id}: file missing ({file_path_str})"
                )
                processed += 1
                self._set_status(processed_clips=processed)
                continue

            try:
                # Decrypt the clip to a temp file.
                encrypted = Path(file_path_str).read_bytes()
                plain = decrypt_bytes(encrypted)

                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                    tmp.write(plain)
                    tmp_path = Path(tmp.name)

                try:
                    # Detect camera FPS from stored metadata or fallback.
                    camera_fps = 10.0
                    frames, sample_interval, actual_fps = self._sample_frames(
                        tmp_path, camera_fps
                    )

                    if not frames:
                        self._handle_error(
                            f"clip {clip_id}: no frames extracted"
                        )
                        processed += 1
                        self._set_status(processed_clips=processed)
                        continue

                    clip_start: datetime = row.clip_start
                    duration_seconds: float = float(getattr(row, "duration_seconds", 0) or 0)
                    frame_count: int = int(getattr(row, "frame_count", 0) or 0)
                    matching_start_ts = time.time()

                    matched_ids, first_sample_idx, last_sample_idx = (
                        self._detect_and_match(frames, scope)
                    )

                    # Compute person_start/person_end from frame indices.
                    person_start: Optional[datetime] = None
                    person_end: Optional[datetime] = None
                    if (
                        first_sample_idx is not None
                        and last_sample_idx is not None
                        and frame_count > 0
                        and duration_seconds > 0
                    ):
                        time_per_frame = duration_seconds / frame_count
                        first_orig_frame = first_sample_idx * sample_interval
                        last_orig_frame = last_sample_idx * sample_interval
                        from datetime import timedelta  # noqa: PLC0415
                        person_start = clip_start + timedelta(
                            seconds=first_orig_frame * time_per_frame
                        )
                        person_end = clip_start + timedelta(
                            seconds=last_orig_frame * time_per_frame
                        )

                    matching_duration_ms = int(
                        (time.time() - matching_start_ts) * 1000
                    )

                finally:
                    tmp_path.unlink(missing_ok=True)

            except Exception as exc:  # noqa: BLE001
                self._handle_error(
                    f"clip {clip_id}: {type(exc).__name__}: {exc}"
                )
                processed += 1
                self._set_status(processed_clips=processed)
                continue

            # Update the DB row.
            matched_list = sorted(matched_ids)
            try:
                with engine.begin() as conn:
                    conn.execute(
                        sa_update(person_clips)
                        .where(
                            person_clips.c.id == clip_id,
                            person_clips.c.tenant_id == scope.tenant_id,
                        )
                        .values(
                            matched_employees=matched_list,
                            person_start=person_start,
                            person_end=person_end,
                            face_matching_duration_ms=matching_duration_ms,
                            face_matching_progress=100,
                        )
                    )
            except Exception as exc:  # noqa: BLE001
                self._handle_error(
                    f"clip {clip_id}: UPDATE failed: {type(exc).__name__}: "
                    f"{exc}"
                )
                processed += 1
                self._set_status(processed_clips=processed)
                continue

            if matched_list:
                matched_total += len(matched_list)

            processed += 1
            if processed % 10 == 0:
                logger.info(
                    "face match reprocess progress: tenant=%s "
                    "processed=%d/%d matched=%d",
                    scope.tenant_id, processed, total, matched_total,
                )
            self._set_status(
                processed_clips=processed,
                matched_total=matched_total,
            )

        # Mark complete.
        end_ts = datetime.now(timezone.utc).isoformat()
        self._set_status(
            status="completed",
            ended_at=end_ts,
        )

        logger.info(
            "face match reprocess completed: tenant=%s "
            "processed=%d/%d matched=%d errors=%d",
            scope.tenant_id, processed, total, matched_total,
            len(self._status.get("errors", [])),
        )

        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=actor_user_id,
                action="person_clip.reprocess_completed",
                entity_type="person_clip",
                entity_id=None,
                after={
                    "mode": mode,
                    "total_clips": total,
                    "processed_clips": processed,
                    "matched_total": matched_total,
                    "errors": len(self._status.get("errors", [])),
                },
            )


# ---------------------------------------------------------------------------
# Single-clip processor — called from clip_worker.py after each save
# ---------------------------------------------------------------------------


def process_single_clip(clip_id: int, scope: TenantScope) -> None:
    """Process one saved clip for face matching.

    Called from the ``ClipWorker`` in a fire-and-forget daemon thread
    immediately after a new clip is saved. Decrypts the clip, samples
    frames at ~2 fps, runs face detection + matching, and updates the
    ``matched_employees`` + ``matched_status`` columns.

    This is the same detection + matching logic used by the batch
    re-processor (``ReprocessFaceMatchWorker``), but scoped to a single
    clip so the live-recording pipeline never waits on matching.
    """

    from maugood.db import tenant_context  # noqa: PLC0415

    engine = get_engine()
    settings = get_settings()

    with tenant_context(scope.tenant_schema):
        try:
            with engine.begin() as conn:
                row = conn.execute(
                    sa_select(
                        person_clips.c.id,
                        person_clips.c.file_path,
                        person_clips.c.clip_start,
                        person_clips.c.duration_seconds,
                        person_clips.c.frame_count,
                    ).where(
                        person_clips.c.id == clip_id,
                        person_clips.c.tenant_id == scope.tenant_id,
                    )
                ).first()

            if row is None:
                logger.debug(
                    "single-clip match: clip %s not found (tenant=%s)",
                    clip_id, scope.tenant_id,
                )
                return

            file_path_str = str(row.file_path or "")
            if not file_path_str or not Path(file_path_str).exists():
                logger.debug(
                    "single-clip match: clip %s file missing (tenant=%s)",
                    clip_id, scope.tenant_id,
                )
                _update_clip_face_matching(engine, scope, clip_id, matched_status="failed")
                return

            clip_start: datetime = row.clip_start
            duration_seconds: float = float(row.duration_seconds or 0)
            frame_count: int = int(row.frame_count or 0)
            matching_start_ts = time.time()

            # Mark as processing with progress=0.
            _update_clip_face_matching(
                engine, scope, clip_id,
                matched_status="processing",
                progress=0,
            )

            # Decrypt to temp file.
            encrypted = Path(file_path_str).read_bytes()
            plain = decrypt_bytes(encrypted)

            with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                tmp.write(plain)
                tmp_path = Path(tmp.name)

            try:
                camera_fps = 10.0
                frames, sample_interval, actual_fps = _sample_frames_standalone(
                    tmp_path, camera_fps
                )

                if not frames:
                    logger.debug(
                        "single-clip match: no frames extracted from clip %s",
                        clip_id,
                    )
                    _update_clip_face_matching(
                        engine, scope, clip_id, matched_status="failed"
                    )
                    return

                # Update progress to 50 after frame extraction.
                _update_clip_face_matching(
                    engine, scope, clip_id, progress=50
                )

                matched_ids, first_sample_idx, last_sample_idx = (
                    _detect_and_match_standalone(frames, scope)
                )
            finally:
                tmp_path.unlink(missing_ok=True)

            # Compute person_start/person_end from frame indices.
            person_start: Optional[datetime] = None
            person_end: Optional[datetime] = None
            if (
                first_sample_idx is not None
                and last_sample_idx is not None
                and frame_count > 0
                and duration_seconds > 0
            ):
                time_per_frame = duration_seconds / frame_count
                first_orig_frame = first_sample_idx * sample_interval
                last_orig_frame = last_sample_idx * sample_interval
                from datetime import timedelta  # noqa: PLC0415
                person_start = clip_start + timedelta(
                    seconds=first_orig_frame * time_per_frame
                )
                person_end = clip_start + timedelta(
                    seconds=last_orig_frame * time_per_frame
                )

            matching_duration_ms = int(
                (time.time() - matching_start_ts) * 1000
            )

            # Update the DB row.
            matched_list = sorted(matched_ids)
            with engine.begin() as conn:
                conn.execute(
                    sa_update(person_clips)
                    .where(
                        person_clips.c.id == clip_id,
                        person_clips.c.tenant_id == scope.tenant_id,
                    )
                    .values(
                        matched_employees=matched_list,
                        matched_status="processed",
                        person_start=person_start,
                        person_end=person_end,
                        face_matching_duration_ms=matching_duration_ms,
                        face_matching_progress=100,
                    )
                )

            if matched_list:
                logger.info(
                    "single-clip match: clip %s matched %d employee(s) "
                    "(tenant=%s)",
                    clip_id, len(matched_list), scope.tenant_id,
                )
            else:
                logger.debug(
                    "single-clip match: clip %s no matches (tenant=%s)",
                    clip_id, scope.tenant_id,
                )

        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "single-clip match failed: clip=%s tenant=%s reason=%s",
                clip_id, scope.tenant_id, type(exc).__name__,
            )
            try:
                _update_clip_face_matching(engine, scope, clip_id, matched_status="failed")
            except Exception:  # noqa: BLE001
                pass


def _update_clip_face_matching(
    engine,
    scope: TenantScope,
    clip_id: int,
    matched_status: Optional[str] = None,
    progress: Optional[int] = None,
) -> None:
    """Update face-matching columns for a clip."""
    values: dict[str, Any] = {}
    if matched_status is not None:
        values["matched_status"] = matched_status
    if progress is not None:
        values["face_matching_progress"] = progress
    if not values:
        return
    with engine.begin() as conn:
        conn.execute(
            sa_update(person_clips)
            .where(
                person_clips.c.id == clip_id,
                person_clips.c.tenant_id == scope.tenant_id,
            )
            .values(**values)
        )


def _sample_frames_standalone(
    video_path: Path, fps: float
) -> tuple[list[np.ndarray], int, float]:
    """Sample frames at ~2 fps from a decrypted video file.

    Standalone copy of ``ReprocessFaceMatchWorker._sample_frames``
    so the single-clip path doesn't depend on the batch worker.

    Returns ``(frames, sample_interval, actual_fps)``.
    """
    import cv2  # noqa: PLC0415

    frames: list[np.ndarray] = []
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        cap.release()
        return frames, 1, fps

    actual_fps = max(1.0, cap.get(cv2.CAP_PROP_FPS) or fps)
    sample_interval = max(
        1, int(round(actual_fps / _FRAMES_PER_SECOND_SAMPLE))
    )

    frame_idx = 0
    sampled = 0
    while sampled < _MAX_FRAMES_PER_CLIP:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        if frame_idx % sample_interval == 0:
            frames.append(frame)
            sampled += 1
        frame_idx += 1

    cap.release()
    return frames, sample_interval, actual_fps


def _detect_and_match_standalone(
    frames: list[np.ndarray], scope: TenantScope,
) -> tuple[set[int], int | None, int | None]:
    """Run face detection + matching on sampled frames.

    Standalone copy of ``ReprocessFaceMatchWorker._detect_and_match``
    so the single-clip path doesn't depend on the batch worker.

    Returns ``(matched_ids, first_detection_sample_idx, last_detection_sample_idx)``.
    """
    from maugood.detection import DetectorConfig, detect as detector_detect  # noqa: PLC0415

    matched_ids: set[int] = set()
    first_idx: int | None = None
    last_idx: int | None = None
    cfg = DetectorConfig()

    for i, frame in enumerate(frames):
        try:
            results = detector_detect(frame, cfg)
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "detect failed on frame: %s", type(exc).__name__
            )
            continue

        found = False
        for det in results:
            emb = det.get("embedding")
            if emb is None:
                continue
            probe = np.asarray(emb, dtype=np.float32)
            mm = matcher_cache.match(scope, probe)
            if mm is not None and mm.classification == "active":
                matched_ids.add(mm.employee_id)
                found = True

        if found:
            if first_idx is None:
                first_idx = i
            last_idx = i

    return matched_ids, first_idx, last_idx


# Module-level singleton so status persists across requests.
_reprocess_worker = ReprocessFaceMatchWorker()


def get_reprocess_worker() -> ReprocessFaceMatchWorker:
    return _reprocess_worker
