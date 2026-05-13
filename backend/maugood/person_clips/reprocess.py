"""Background reprocess workers for face matching on saved person clips.

Three use-case pipelines, each independently tracked in
``clip_processing_results``:

* **UC1** (``use_case="uc1"``) — ``mode="yolo+face"``: YOLO finds person
  bounding boxes, InsightFace runs inside each box to detect + embed faces.
  Tends to recall persons whose face isn't dominant in the full frame.

* **UC2** (``use_case="uc2"``) — ``mode="insightface"`` with explicit face
  crop storage: InsightFace buffalo_l runs directly on sampled frames for
  both detection and recognition. Crops are saved to ``face_crops`` table.

* **UC3** (``use_case="uc3"``) — ``mode="insightface"`` direct match only:
  Same detector as UC2 but skips crop storage — faster and lighter on disk.
  Default single-clip mode for newly recorded clips.

Entry points:

* ``process_single_clip(clip_id, scope, use_cases)`` — processes one clip
  for the requested use cases synchronously. Called from ``ClipWorker``
  in a fire-and-forget daemon thread after every new clip is saved.

* ``ReprocessFaceMatchWorker`` — batch worker triggered via the API.
  Supports parallel processing via a thread-pool. Status dict is
  readable by the polling endpoint.
"""

from __future__ import annotations

import logging
import queue
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import numpy as np
from sqlalchemy import select as sa_select, update as sa_update, insert as sa_insert

from maugood.auth.audit import write_audit
from maugood.config import get_settings
from maugood.db import employees, get_engine, person_clips, clip_processing_results, face_crops
from maugood.employees.photos import decrypt_bytes, encrypt_bytes
from maugood.identification.matcher import matcher_cache
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Sample ~2 fps from the clip for face detection.
_FRAMES_PER_SECOND_SAMPLE = 2

# Max number of frames to process from a single clip (safety cap).
_MAX_FRAMES_PER_CLIP = 200

# Valid use cases.
ALL_USE_CASES = ("uc1", "uc2", "uc3")
DEFAULT_USE_CASES = ("uc3",)


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

def _sample_frames(
    video_path: Path, fallback_fps: float
) -> tuple[list[np.ndarray], int, float]:
    """Open a decrypted video file and sample frames at ~2 fps.

    Returns ``(frames, sample_interval, actual_fps)``.
    Caps at ``_MAX_FRAMES_PER_CLIP`` frames.
    """
    import cv2  # noqa: PLC0415

    frames: list[np.ndarray] = []
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        cap.release()
        return frames, 1, fallback_fps

    actual_fps = max(1.0, cap.get(cv2.CAP_PROP_FPS) or fallback_fps)
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


def _run_detection(
    frames: list[np.ndarray],
    mode: str,
    stop_event: Optional[threading.Event] = None,
) -> tuple[list[tuple[int, list[dict]]], float]:
    """Run face detection on sampled frames.

    Returns ``([(frame_idx, detections), ...], extract_duration_s)``.
    Stops early if ``stop_event`` is set.
    """
    from maugood.detection import DetectorConfig, detect as detector_detect  # noqa: PLC0415

    cfg = DetectorConfig(mode=mode)
    results: list[tuple[int, list[dict]]] = []
    t0 = time.time()

    for i, frame in enumerate(frames):
        if stop_event is not None and stop_event.is_set():
            break
        try:
            dets = detector_detect(frame, cfg)
            if dets:
                results.append((i, dets))
        except Exception as exc:  # noqa: BLE001
            logger.debug("detect failed on frame %d: %s", i, type(exc).__name__)

    return results, time.time() - t0


def _match_detections(
    frame_results: list[tuple[int, list[dict]]],
    scope: TenantScope,
) -> tuple[dict[tuple[int, int], Optional[int]], set[int], int, list[dict], float]:
    """Run face matching on detection dicts.

    Annotates each detection with an employee match and returns a mapping from
    (frame_idx, det_idx) → employee_id (None = unknown) so callers can
    attribute each face crop to the right person.

    Returns:
        det_employee_map  — {(frame_idx, det_idx): employee_id | None}
        matched_ids       — set of employee IDs that were recognised
        unknown_count     — number of unmatched detected faces
        match_details     — [{employee_id, name, confidence}]
        match_duration_s
    """
    t0 = time.time()
    det_employee_map: dict[tuple[int, int], Optional[int]] = {}
    matched_ids: set[int] = set()
    unknown_count = 0
    seen_employees: dict[int, float] = {}  # employee_id -> best confidence

    for frame_idx, dets in frame_results:
        for det_idx, det in enumerate(dets):
            emb = det.get("embedding")
            if emb is None:
                det_employee_map[(frame_idx, det_idx)] = None
                unknown_count += 1
                continue
            probe = np.asarray(emb, dtype=np.float32)
            mm = matcher_cache.match(scope, probe)
            if mm is not None and mm.classification == "active":
                eid = mm.employee_id
                det_employee_map[(frame_idx, det_idx)] = eid
                matched_ids.add(eid)
                conf = float(getattr(mm, "confidence", 0.0))
                if eid not in seen_employees or conf > seen_employees[eid]:
                    seen_employees[eid] = conf
            else:
                det_employee_map[(frame_idx, det_idx)] = None
                unknown_count += 1

    match_details: list[dict] = [
        {"employee_id": eid, "confidence": round(conf, 4)}
        for eid, conf in seen_employees.items()
    ]
    return det_employee_map, matched_ids, unknown_count, match_details, time.time() - t0


def _save_face_crops_to_db(
    engine,
    scope: TenantScope,
    clip_id: int,
    camera_id: int,
    frames: list["np.ndarray"],
    frame_results: list[tuple[int, list[dict]]],
    clip_start: datetime,
    duration_s: float,
    frame_count: int,
    sample_interval: int,
    use_case: str = "uc2",
    det_employee_map: Optional[dict[tuple[int, int], Optional[int]]] = None,
) -> int:
    """Write face crops from detections to the ``face_crops`` table.

    Crops are extracted from ``frames`` using each detection's ``bbox``
    coordinates and Fernet-encrypted at rest.

    ``det_employee_map`` maps ``(frame_idx, det_idx)`` → ``employee_id | None``
    so each crop row records who was matched (NULL = unknown person).
    Returns the number of crops saved.
    """
    import cv2  # noqa: PLC0415

    from maugood.config import get_settings as _gs  # noqa: PLC0415
    settings = _gs()
    crops_root = Path(settings.face_crops_storage_path)
    saved = 0
    max_crops = settings.face_crops_max_per_clip

    for frame_idx, dets in frame_results:
        if saved >= max_crops:
            break
        # Retrieve the original frame for bbox-based cropping.
        frame = frames[frame_idx] if 0 <= frame_idx < len(frames) else None
        if frame is None:
            continue
        for det_idx, det in enumerate(dets):
            if saved >= max_crops:
                break
            # Extract face region from the frame using the detection bbox.
            bbox = det.get("bbox")
            if bbox is None:
                continue
            x1, y1, x2, y2 = [int(v) for v in bbox]
            H, W = frame.shape[:2]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(W, x2), min(H, y2)
            if x2 <= x1 or y2 <= y1:
                continue
            crop_arr = frame[y1:y2, x1:x2]
            if getattr(crop_arr, "size", 0) == 0:
                continue
            q_score = float(det.get("quality_score", det.get("det_score", 0.0)))
            if q_score < settings.face_crops_min_quality:
                continue
            try:
                ok, buf = cv2.imencode(".jpg", crop_arr)
                if not ok or buf is None:
                    continue
                crop_bytes = bytes(buf)
            except Exception:  # noqa: BLE001
                continue

            # Look up which employee (if any) this detection was matched to.
            emp_id: Optional[int] = None
            if det_employee_map is not None:
                emp_id = det_employee_map.get((frame_idx, det_idx))

            # Determine approximate timestamp for this frame.
            approx_offset = 0.0
            if frame_count > 0 and duration_s > 0:
                orig_frame = frame_idx * sample_interval
                approx_offset = (orig_frame / frame_count) * duration_s
            ts_dt = clip_start + __import__("datetime").timedelta(seconds=approx_offset)
            ts_str = ts_dt.strftime("%Y%m%d_%H%M%S")

            crop_dir = crops_root / f"camera_{camera_id}" / f"event_{ts_str}"
            try:
                crop_dir.mkdir(parents=True, exist_ok=True)
            except OSError:
                continue

            import uuid as _uuid  # noqa: PLC0415
            fname = f"face_{_uuid.uuid4().hex[:12]}.jpg"
            crop_path = crop_dir / fname
            try:
                enc = encrypt_bytes(crop_bytes)
                crop_path.write_bytes(enc)
            except Exception:  # noqa: BLE001
                continue

            h, w = (crop_arr.shape[0], crop_arr.shape[1]) if hasattr(crop_arr, "shape") else (0, 0)
            try:
                with engine.begin() as conn:
                    conn.execute(
                        sa_insert(face_crops).values(
                            tenant_id=scope.tenant_id,
                            camera_id=camera_id,
                            person_clip_id=clip_id,
                            event_timestamp=ts_str,
                            face_index=saved + 1,
                            file_path=str(crop_path),
                            quality_score=q_score,
                            sharpness=0.0,
                            detection_score=q_score,
                            width=w,
                            height=h,
                            use_case=use_case,
                            employee_id=emp_id,
                        )
                    )
            except Exception:  # noqa: BLE001
                crop_path.unlink(missing_ok=True)
                continue

            saved += 1

    return saved


def _upsert_processing_result(
    engine,
    scope: TenantScope,
    clip_id: int,
    use_case: str,
    *,
    status: str,
    started_at: Optional[datetime] = None,
    ended_at: Optional[datetime] = None,
    duration_ms: Optional[int] = None,
    face_extract_duration_ms: Optional[int] = None,
    match_duration_ms: Optional[int] = None,
    face_crop_count: int = 0,
    matched_employees: Optional[list[int]] = None,
    unknown_count: int = 0,
    match_details: Optional[list[dict]] = None,
    error: Optional[str] = None,
) -> None:
    """INSERT or UPDATE a row in clip_processing_results."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert  # noqa: PLC0415

    vals: dict[str, Any] = {
        "tenant_id": scope.tenant_id,
        "person_clip_id": clip_id,
        "use_case": use_case,
        "status": status,
        "started_at": started_at,
        "ended_at": ended_at,
        "duration_ms": duration_ms,
        "face_extract_duration_ms": face_extract_duration_ms,
        "match_duration_ms": match_duration_ms,
        "face_crop_count": face_crop_count,
        "matched_employees": matched_employees or [],
        "unknown_count": unknown_count,
        "match_details": match_details,
        "error": error,
    }
    stmt = pg_insert(clip_processing_results).values(**vals)
    update_vals = {k: v for k, v in vals.items() if k not in ("tenant_id", "person_clip_id", "use_case")}
    stmt = stmt.on_conflict_do_update(
        constraint="uq_cpr_clip_usecase",
        set_=update_vals,
    )
    with engine.begin() as conn:
        conn.execute(stmt)


def _resolve_employee_names(engine, scope: TenantScope, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    with engine.begin() as conn:
        rows = conn.execute(
            sa_select(employees.c.id, employees.c.full_name).where(
                employees.c.id.in_(list(ids)),
                employees.c.tenant_id == scope.tenant_id,
            )
        ).all()
    return {r.id: r.full_name for r in rows}


# ---------------------------------------------------------------------------
# Core per-clip, per-use-case processor
# ---------------------------------------------------------------------------

def _process_clip_for_use_case(
    clip_id: int,
    scope: TenantScope,
    use_case: str,
    *,
    file_path_str: str,
    clip_start: datetime,
    duration_seconds: float,
    frame_count: int,
    camera_id: int,
    stop_event: Optional[threading.Event] = None,
) -> dict[str, Any]:
    """Run one use-case pipeline on a single clip.

    Returns a summary dict with matched_employees, face_crop_count,
    unknown_count, duration_ms, etc.
    """
    engine = get_engine()
    t_total = time.time()

    # Mark as processing.
    _upsert_processing_result(
        engine, scope, clip_id, use_case,
        status="processing",
        started_at=datetime.now(timezone.utc),
    )

    if not file_path_str or not Path(file_path_str).exists():
        _upsert_processing_result(
            engine, scope, clip_id, use_case,
            status="failed",
            error="clip file missing",
        )
        return {"status": "failed", "use_case": use_case, "error": "clip file missing"}

    try:
        encrypted = Path(file_path_str).read_bytes()
        plain = decrypt_bytes(encrypted)
    except Exception as exc:  # noqa: BLE001
        _upsert_processing_result(
            engine, scope, clip_id, use_case,
            status="failed",
            error=f"decrypt failed: {type(exc).__name__}",
        )
        return {"status": "failed", "use_case": use_case}

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        tmp.write(plain)
        tmp_path = Path(tmp.name)

    try:
        frames, sample_interval, actual_fps = _sample_frames(tmp_path, 10.0)
        if not frames:
            _upsert_processing_result(
                engine, scope, clip_id, use_case,
                status="failed",
                error="no frames extracted",
            )
            return {"status": "failed", "use_case": use_case, "error": "no frames"}

        # UC1: yolo+face + crops; UC2/UC3: insightface + crops.
        # All three pipelines save face crops so unknown persons are always
        # visible in the detail drawer regardless of match outcome.
        if use_case == "uc1":
            mode = "yolo+face"
        else:
            mode = "insightface"

        frame_results, extract_s = _run_detection(frames, mode, stop_event)

        # Intermediate update: extraction done, matching starting.
        # The frontend uses face_extract_duration_ms being set (but
        # match_duration_ms still null) to show "now matching" progress.
        _upsert_processing_result(
            engine, scope, clip_id, use_case,
            status="processing",
            started_at=datetime.now(timezone.utc) - __import__("datetime").timedelta(seconds=extract_s),
            face_extract_duration_ms=int(extract_s * 1000),
        )

        # Match first so each crop can be tagged with the matched employee.
        det_employee_map, matched_ids, unknown_count, match_details, match_s = (
            _match_detections(frame_results, scope)
        )

        # Save crops with employee attribution (matched or None for unknown).
        face_crop_count = 0
        if frame_results:
            face_crop_count = _save_face_crops_to_db(
                engine, scope, clip_id, camera_id,
                frames, frame_results,
                clip_start, duration_seconds, frame_count, sample_interval,
                use_case=use_case,
                det_employee_map=det_employee_map,
            )

        # Enrich match_details with employee names.
        name_map = _resolve_employee_names(engine, scope, matched_ids)
        for md in match_details:
            eid = md.get("employee_id")
            if eid and eid in name_map:
                md["name"] = name_map[eid]

        total_ms = int((time.time() - t_total) * 1000)
        matched_list = sorted(matched_ids)

        ended_at = datetime.now(timezone.utc)
        _upsert_processing_result(
            engine, scope, clip_id, use_case,
            status="completed",
            started_at=ended_at - __import__("datetime").timedelta(milliseconds=total_ms),
            ended_at=ended_at,
            duration_ms=total_ms,
            face_extract_duration_ms=int(extract_s * 1000),
            match_duration_ms=int(match_s * 1000),
            face_crop_count=face_crop_count,
            matched_employees=matched_list,
            unknown_count=unknown_count,
            match_details=match_details if match_details else None,
        )

        # Also update the legacy matched_employees on person_clips (UC3 is canonical).
        if use_case == "uc3":
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
                        face_matching_progress=100,
                        face_matching_duration_ms=total_ms,
                    )
                )

        return {
            "status": "completed",
            "use_case": use_case,
            "matched_employees": matched_list,
            "face_crop_count": face_crop_count,
            "unknown_count": unknown_count,
            "duration_ms": total_ms,
        }

    finally:
        tmp_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Single-clip public entry point
# ---------------------------------------------------------------------------

def process_single_clip(
    clip_id: int,
    scope: TenantScope,
    use_cases: tuple[str, ...] = DEFAULT_USE_CASES,
) -> None:
    """Process one saved clip for face matching across the requested use cases.

    Called from ``ClipWorker`` in a fire-and-forget daemon thread immediately
    after a new clip is saved. Runs each use case sequentially (the single-clip
    path is not parallelised — it already runs on a background thread).
    """
    from maugood.db import tenant_context  # noqa: PLC0415

    engine = get_engine()

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
                        person_clips.c.camera_id,
                    ).where(
                        person_clips.c.id == clip_id,
                        person_clips.c.tenant_id == scope.tenant_id,
                    )
                ).first()

            if row is None:
                logger.debug("single-clip match: clip %s not found", clip_id)
                return

            file_path_str = str(row.file_path or "")

            # Mark overall status as processing.
            with engine.begin() as conn:
                conn.execute(
                    sa_update(person_clips)
                    .where(
                        person_clips.c.id == clip_id,
                        person_clips.c.tenant_id == scope.tenant_id,
                    )
                    .values(matched_status="processing", face_matching_progress=0)
                )

            for uc in use_cases:
                if uc not in ALL_USE_CASES:
                    continue
                try:
                    _process_clip_for_use_case(
                        clip_id, scope, uc,
                        file_path_str=file_path_str,
                        clip_start=row.clip_start,
                        duration_seconds=float(row.duration_seconds or 0),
                        frame_count=int(row.frame_count or 0),
                        camera_id=int(row.camera_id),
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "single-clip match uc=%s clip=%s failed: %s",
                        uc, clip_id, type(exc).__name__,
                    )

        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "single-clip match failed: clip=%s tenant=%s reason=%s",
                clip_id, scope.tenant_id, type(exc).__name__,
            )
            try:
                with engine.begin() as conn:
                    conn.execute(
                        sa_update(person_clips)
                        .where(
                            person_clips.c.id == clip_id,
                            person_clips.c.tenant_id == scope.tenant_id,
                        )
                        .values(matched_status="failed")
                    )
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------------
# Batch reprocess worker
# ---------------------------------------------------------------------------

class ReprocessFaceMatchWorker:
    """Background worker that reprocesses saved person clips for face matching.

    Supports all three use cases and parallel processing via a thread pool.
    One instance per process (singleton). Thread-safe via a lock on ``_status``.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status: dict[str, Any] = {"status": "idle"}
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._status)

    def is_running(self) -> bool:
        with self._lock:
            return self._status.get("status") == "running"

    def trigger(
        self,
        scope: TenantScope,
        mode: str = "all",
        use_cases: tuple[str, ...] = DEFAULT_USE_CASES,
        actor_user_id: Optional[int] = None,
    ) -> bool:
        """Start reprocessing. Returns False if already running."""
        if self.is_running():
            return False

        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            args=(scope, mode, use_cases, actor_user_id),
            name=f"face-match-reprocess-{scope.tenant_id}",
            daemon=True,
        )
        self._thread.start()
        return True

    def cancel(self) -> bool:
        if not self.is_running():
            return False
        self._stop.set()
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

    def _run(
        self,
        scope: TenantScope,
        mode: str,
        use_cases: tuple[str, ...],
        actor_user_id: Optional[int],
    ) -> None:
        from maugood.db import tenant_context  # noqa: PLC0415

        with tenant_context(scope.tenant_schema):
            try:
                self._process(scope, mode, use_cases, actor_user_id)
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
        use_cases: tuple[str, ...],
        actor_user_id: Optional[int],
    ) -> None:
        engine = get_engine()
        settings = get_settings()

        now_iso = datetime.now(timezone.utc).isoformat()
        self._set_status(
            status="running",
            mode=mode,
            use_cases=list(use_cases),
            total_clips=0,
            processed_clips=0,
            matched_total=0,
            failed_count=0,
            errors=[],
            started_at=now_iso,
            ended_at=None,
        )

        # Load clips for this tenant.
        with engine.begin() as conn:
            query = sa_select(
                person_clips.c.id,
                person_clips.c.camera_id,
                person_clips.c.file_path,
                person_clips.c.clip_start,
                person_clips.c.duration_seconds,
                person_clips.c.frame_count,
                person_clips.c.matched_employees,
            ).where(person_clips.c.tenant_id == scope.tenant_id)

            if mode == "skip_existing":
                query = query.where(person_clips.c.matched_employees == "[]")

            rows = conn.execute(query).all()

        total = len(rows)
        self._set_status(total_clips=total)
        logger.info(
            "face match reprocess: tenant=%s mode=%s use_cases=%s total=%d",
            scope.tenant_id, mode, use_cases, total,
        )

        with engine.begin() as conn:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=actor_user_id,
                action="person_clip.reprocess_started",
                entity_type="person_clip",
                entity_id=None,
                after={"mode": mode, "use_cases": list(use_cases), "total_clips": total},
            )

        if total == 0:
            self._set_status(
                status="completed",
                processed_clips=0,
                matched_total=0,
                ended_at=datetime.now(timezone.utc).isoformat(),
            )
            return

        processed = 0
        matched_total = 0
        num_workers = max(1, settings.clip_processing_workers)

        def _process_row(row) -> dict[str, Any]:
            """Process all requested use cases for one clip row.

            Wraps in tenant_context because Python 3.11's
            ThreadPoolExecutor does NOT propagate ContextVar changes
            to worker threads — without the explicit wrapper, the
            SQLAlchemy checkout listener would default to the wrong
            schema and foreign-key lookups would fail.
            """
            from maugood.db import tenant_context as _tc  # noqa: PLC0415

            with _tc(scope.tenant_schema):
                if self._stop.is_set():
                    return {"status": "cancelled", "clip_id": row.id}
                clip_id = int(row.id)
                combined: dict[str, Any] = {
                    "clip_id": clip_id, "matched_ids": set(), "errors": []
                }
                for uc in use_cases:
                    if self._stop.is_set():
                        break
                    try:
                        result = _process_clip_for_use_case(
                            clip_id, scope, uc,
                            file_path_str=str(row.file_path or ""),
                            clip_start=row.clip_start,
                            duration_seconds=float(row.duration_seconds or 0),
                            frame_count=int(row.frame_count or 0),
                            camera_id=int(row.camera_id),
                            stop_event=self._stop,
                        )
                        if result.get("status") == "completed":
                            matched = result.get("matched_employees", [])
                            combined["matched_ids"].update(matched)
                        else:
                            combined["errors"].append(f"uc={uc}: {result.get('error', 'failed')}")
                    except Exception as exc:  # noqa: BLE001
                        combined["errors"].append(f"uc={uc}: {type(exc).__name__}")
                return combined

        with ThreadPoolExecutor(max_workers=num_workers) as pool:
            futures = {pool.submit(_process_row, row): row for row in rows}
            for future in as_completed(futures):
                if self._stop.is_set():
                    break
                row = futures[future]
                try:
                    result = future.result()
                except Exception as exc:  # noqa: BLE001
                    self._handle_error(f"clip {row.id}: {type(exc).__name__}: {exc}")
                else:
                    for err in result.get("errors", []):
                        self._handle_error(f"clip {row.id}: {err}")
                    matched_ids: set[int] = result.get("matched_ids", set())
                    if matched_ids:
                        matched_total += len(matched_ids)

                processed += 1
                if processed % 10 == 0:
                    logger.info(
                        "reprocess progress: tenant=%s processed=%d/%d matched=%d",
                        scope.tenant_id, processed, total, matched_total,
                    )
                self._set_status(processed_clips=processed, matched_total=matched_total)

        if self._stop.is_set():
            self._set_status(
                status="cancelled",
                ended_at=datetime.now(timezone.utc).isoformat(),
            )
            return

        end_iso = datetime.now(timezone.utc).isoformat()
        self._set_status(status="completed", ended_at=end_iso)

        logger.info(
            "face match reprocess completed: tenant=%s processed=%d/%d matched=%d errors=%d",
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
                    "use_cases": list(use_cases),
                    "total_clips": total,
                    "processed_clips": processed,
                    "matched_total": matched_total,
                    "errors": len(self._status.get("errors", [])),
                },
            )


# Module-level singleton so status persists across requests.
_reprocess_worker = ReprocessFaceMatchWorker()


def get_reprocess_worker() -> ReprocessFaceMatchWorker:
    return _reprocess_worker


# ---------------------------------------------------------------------------
# Single-clip async reprocess tracker
# ---------------------------------------------------------------------------

# (tenant_id, clip_id) → True while a per-clip reprocess thread is live.
_single_clip_lock = threading.Lock()
_single_clip_running: dict[tuple[int, int], bool] = {}


def trigger_single_clip_reprocess(
    clip_id: int,
    scope: TenantScope,
    use_cases: tuple[str, ...] = DEFAULT_USE_CASES,
    actor_user_id: Optional[int] = None,
) -> bool:
    """Start an async per-clip face-match reprocess.

    Returns False if a reprocess thread for (tenant, clip) is already
    running — the caller should surface this to the operator rather than
    starting a duplicate run. The thread marks itself done via the module-
    level ``_single_clip_running`` dict; the frontend discovers progress by
    polling ``GET /api/person-clips/{id}/processing-results``.
    """
    key = (scope.tenant_id, clip_id)
    with _single_clip_lock:
        if _single_clip_running.get(key):
            return False
        _single_clip_running[key] = True

    def _run() -> None:
        try:
            process_single_clip(clip_id, scope, use_cases)
            if actor_user_id is not None:
                try:
                    engine = get_engine()
                    with engine.begin() as conn:
                        write_audit(
                            conn,
                            tenant_id=scope.tenant_id,
                            actor_user_id=actor_user_id,
                            action="person_clip.single_reprocess_completed",
                            entity_type="person_clip",
                            entity_id=str(clip_id),
                            after={"use_cases": list(use_cases)},
                        )
                except Exception:  # noqa: BLE001
                    pass
        finally:
            with _single_clip_lock:
                _single_clip_running.pop(key, None)

    t = threading.Thread(
        target=_run,
        name=f"clip-reprocess-{scope.tenant_id}-{clip_id}",
        daemon=True,
    )
    t.start()
    return True


def is_single_clip_running(tenant_id: int, clip_id: int) -> bool:
    """Return True while a per-clip reprocess thread is live."""
    with _single_clip_lock:
        return bool(_single_clip_running.get((tenant_id, clip_id)))
