"""Detection event emission: crop → encrypt → DB insert.

Called by the capture worker whenever the tracker returns a ``is_new=True``
match. The crop is Fernet-encrypted at rest (same key as P6 employee
photos) and written under
``/data/faces/captures/{tenant_id}/{camera_id}/{YYYY-MM-DD}/{uuid}.jpg``.

**Durability contract / capture invariants** (PROJECT_CONTEXT §12 +
pilot-plan P8 + post-P28.5b orphan-row hardening):

1. **Empty/invalid crop guard first**. If the bbox clamps to zero pixels OR
   the crop array is empty (``crop.size == 0``) OR the JPEG encode
   returns False, return None. No file write, no DB INSERT. (The pre-
   P28.5b absolute quality gate has been removed — see "Layer 2" in
   ``docs/phases/fix-detector-mode-preflight.md`` for why.)
2. *(reserved — was the empty-crop guard pre-fix, now combined into 1.)*
3. **File write before DB INSERT, with explicit verification**. After
   ``write_bytes`` returns we explicitly call ``file_path.exists()``
   and ``stat().st_size > 0``. If either fails the function logs at
   ERROR and returns None — **never INSERT a row that points at a
   missing file**. The whole-tree write_bytes call is wrapped in a
   try/except so a permission/disk error logs cleanly.
4. **Path identity**. The path passed to ``write_bytes`` and the path
   stored in ``detection_events.face_crop_path`` are the same Python
   object — no re-stringification, no helper that could rebuild a
   different path. If the writer and the recorder disagreed once,
   nothing else in the system would catch it.

If the process crashes between successful write and successful INSERT,
we leak an unreferenced file on disk (acceptable trade-off — orphan
files are detectable by a sweep). The reverse — a row pointing at no
file — used to silently happen pre-P28.5b-hardening and produced a
batch of 251 orphan rows in the dev DB; the cleanup script
``backend/scripts/cleanup_orphan_detection_events.py`` sets their
``face_crop_path`` to NULL so the API can 404 them cleanly.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
from sqlalchemy import func, insert, update
from sqlalchemy.engine import Engine

from hadir.capture.directory import employee_directory
from hadir.capture.event_bus import DetectionEvent, event_bus
from hadir.config import get_settings
from hadir.db import camera_health_snapshots, cameras, detection_events
from hadir.employees.photos import encrypt_bytes
from hadir.identification.embeddings import encrypt_embedding
from hadir.identification.matcher import matcher_cache
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


def captures_dir(tenant_id: int, camera_id: int, *, now: Optional[datetime] = None) -> Path:
    """Return the date-partitioned directory for a camera's capture crops."""

    now = now or datetime.now(tz=timezone.utc)
    settings = get_settings()
    return (
        Path(settings.faces_storage_path)
        / "captures"
        / str(tenant_id)
        / str(camera_id)
        / now.strftime("%Y-%m-%d")
    )


def _encode_jpeg(frame_bgr, bbox) -> Optional[bytes]:  # type: ignore[no-untyped-def]
    """Crop the frame to the bbox and JPEG-encode the result.

    Returns None if any guard fails: bbox clamps to zero, crop array
    is empty, or cv2 returns False. Callers MUST treat None as "skip
    everything" — no DB INSERT, no file write.
    """

    import cv2  # noqa: PLC0415 — keep optional at import time

    h_frame, w_frame = frame_bgr.shape[:2]
    x1 = max(0, int(bbox.x))
    y1 = max(0, int(bbox.y))
    x2 = min(w_frame, int(bbox.x + bbox.w))
    y2 = min(h_frame, int(bbox.y + bbox.h))
    if x2 <= x1 or y2 <= y1:
        return None
    crop = frame_bgr[y1:y2, x1:x2]
    # Defensive guard mirroring prototype-reference/backend/capture.py
    # line 411: a numpy crop with size==0 is JPEG-encodable to a 2-byte
    # buffer ("\\xff\\xd8") which still passes ``cv2.imencode`` ok
    # check on some OpenCV builds. Refuse to write that.
    if getattr(crop, "size", 0) == 0:
        return None
    ok, buf = cv2.imencode(".jpg", crop)
    if not ok:
        return None
    data = bytes(buf.tobytes())
    if len(data) == 0:
        return None
    return data


def _encode_jpeg_full(frame_bgr) -> Optional[bytes]:  # type: ignore[no-untyped-def]
    """JPEG-encode the full frame (used when ``save_full_frames=True``)."""

    import cv2  # noqa: PLC0415

    ok, buf = cv2.imencode(".jpg", frame_bgr)
    if not ok:
        return None
    return bytes(buf.tobytes())


def quality_score(bbox, det_score: float) -> float:
    """Composite quality score for a detection. Higher = keep.

    Bigger face + higher detector confidence → higher score. The
    prototype's formula additionally weighs frontal pose
    (kps-derived symmetry); v1.0's Detection dataclass doesn't carry
    landmarks today, so the simplified formula uses face area + det
    score only with re-balanced weights:

        0.75 × area_norm + 0.25 × det_score

    where ``area_norm`` is ``min(face_w*face_h / 200², 1.0)`` so a
    200px-wide face saturates the area term.

    Note: with this formula the prototype's tested 0.35 threshold
    behaves slightly differently than on the original (which was
    pose-aware). On a reasonable walk-past 0.35 cleanly separates
    sharp side-profile snapshots (skip) from frontal frames (keep);
    re-tuning may be warranted once landmarks land in Detection
    (tracked under "future work" in P28.5b's phase doc).
    """

    area = max(0, int(bbox.w)) * max(0, int(bbox.h))
    area_norm = min(area / (200 * 200), 1.0)
    return 0.75 * area_norm + 0.25 * float(det_score)


def emit_detection_event(
    engine: Engine,
    scope: TenantScope,
    *,
    camera_id: int,
    frame_bgr,  # type: ignore[no-untyped-def]
    bbox,
    det_score: float = 1.0,
    track_id: str,
    embedding: Optional[np.ndarray] = None,
    captured_at: Optional[datetime] = None,
    pre_matched: Optional[tuple[int, float]] = None,
    annotated_frame_bgr=None,  # type: ignore[no-untyped-def]
    capture_config: Optional[dict] = None,
    detector_config=None,  # type: ignore[no-untyped-def]
) -> Optional[int]:
    """Write the encrypted crop + insert the event row. Returns the new id,
    or ``None`` if the row was skipped (low quality below threshold or
    invalid bbox).

    ``frame_bgr`` is an OpenCV BGR numpy array (from ``cv2.VideoCapture.read``).
    ``bbox`` is a ``tracker.Bbox`` whose fields are JSON-serialisable.
    ``embedding`` (optional) is the detection's L2-normalised vector from
    InsightFace recognition; when provided we Fernet-encrypt + persist it
    and run the matcher to backfill ``employee_id`` + ``confidence`` on
    the same INSERT. The matcher threshold is hard — below threshold,
    ``employee_id`` stays NULL (pilot-plan red line).

    ``pre_matched`` (P28.5): when the caller has already run the matcher
    for this detection (the live-capture per-frame annotation path
    needs the result for box labels), pass ``(employee_id, score)``
    here to skip the duplicate ``matcher_cache.match`` call.

    P28.5b knobs (read from ``capture_config``):

    * ``min_face_quality_to_save`` — *deprecated, no-op*. Kept on the
      ``cameras.capture_config`` JSONB for backward compat with
      migration 0027; ignored at runtime since the post-fix-detector-
      mode-preflight cleanup. Detector-level filtering already happens
      via ``min_det_score`` + ``min_face_pixels`` upstream; the
      absolute post-detection threshold rejected legitimate distant
      faces. See docs/phases/fix-detector-mode-preflight.md Layer 2.
    * ``save_full_frames`` — when ``True``, also save the full
      annotated frame (passed via ``annotated_frame_bgr``) at a
      sibling ``_full.jpg`` path. Debug aid; increases disk usage
      roughly by the ratio of full-frame size to face-crop size.
    * ``max_faces_per_event`` — stored on the camera row and
      surfaced via ``capture_config`` here, but the v1.0 single-
      face-per-event architecture caps the effective value at 1.
      Multi-face accumulation lands in a follow-up phase.
    """

    captured_at = captured_at or datetime.now(tz=timezone.utc)
    config = capture_config or {}
    save_full = bool(config.get("save_full_frames", False))

    # Detection-level filtering (``min_det_score`` + ``min_face_pixels``)
    # already happened in the analyzer's ``detect`` call. The post-detection
    # quality gate that pre-P28.5b rejected on
    # ``quality_score < min_face_quality_to_save`` is gone — it's an
    # absolute threshold of a *non-pose-aware* formula and was rejecting
    # legitimate distant-but-valid faces (e.g. an ~80×80 crop at
    # det_score 0.7 scores ~0.30, below the 0.35 default). The prototype
    # (prototype-reference/backend/capture.py::_handle_face) computes the
    # same score but uses it only to *rank* faces within a multi-face-per-
    # event row — never to reject. v1.0 is single-face-per-event today;
    # the ranking is moot, and the rejection was just dropping captures.
    # See docs/phases/fix-detector-mode-preflight.md "Layer 2".
    jpeg = _encode_jpeg(frame_bgr, bbox)
    if jpeg is None:
        logger.debug(
            "crop skipped (invalid bbox or empty crop): camera_id=%s track=%s",
            camera_id, track_id,
        )
        return None

    # Build the on-disk path. ``file_path`` is computed once and used
    # for both the write target AND the DB INSERT — invariant 4.
    directory = captures_dir(scope.tenant_id, camera_id, now=captured_at)
    file_path = directory / f"{uuid.uuid4().hex}.jpg"

    # File write before DB INSERT. Wrap mkdir + write_bytes in
    # try/except so a permission/disk error returns None cleanly
    # rather than tunneling up through the worker as an
    # uncaught exception (which would also abort the row, but
    # without a clean log line for the operator).
    try:
        directory.mkdir(parents=True, exist_ok=True)
        encrypted = encrypt_bytes(jpeg)
        file_path.write_bytes(encrypted)
    except OSError as exc:
        # Disk full, permission denied, read-only mount.
        logger.error(
            "crop write FAILED — skipping INSERT: camera_id=%s track=%s "
            "path=%s reason=%s",
            camera_id, track_id, file_path, type(exc).__name__,
        )
        return None
    except RuntimeError as exc:
        # Fernet missing / malformed key. Same red line — no INSERT.
        logger.error(
            "crop encrypt FAILED — skipping INSERT: camera_id=%s track=%s "
            "reason=%s",
            camera_id, track_id, type(exc).__name__,
        )
        return None

    # Post-write verification (invariant 3). The cheap
    # ``write_bytes`` doesn't return a status; an OS-level corner
    # case (volume disappeared between mkdir and write, anti-virus
    # quarantining the new file, etc.) could mean the file isn't
    # actually there even though no exception fired. Verify
    # explicitly before we let the INSERT proceed.
    try:
        if not file_path.exists() or file_path.stat().st_size == 0:
            logger.error(
                "crop write VERIFICATION failed — skipping INSERT: "
                "camera_id=%s track=%s path=%s exists=%s",
                camera_id, track_id, file_path, file_path.exists(),
            )
            return None
    except OSError as exc:
        logger.error(
            "crop write stat() failed — skipping INSERT: camera_id=%s "
            "path=%s reason=%s",
            camera_id, file_path, type(exc).__name__,
        )
        return None

    # P28.5b: ``save_full_frames=True`` also persists the full
    # annotated frame at a sibling path. Same encrypted-at-rest
    # contract as the face crop. The DB row only knows about the
    # face crop path; the full-frame path is stored next to it on
    # disk (``…_full.jpg``).
    if save_full and annotated_frame_bgr is not None:
        full_jpeg = _encode_jpeg_full(annotated_frame_bgr)
        if full_jpeg is not None:
            full_path = file_path.with_name(file_path.stem + "_full.jpg")
            try:
                full_path.write_bytes(encrypt_bytes(full_jpeg))
            except OSError as exc:
                # Full-frame save is a debug aid — never sink the
                # event write because it failed.
                logger.debug(
                    "full-frame save failed: camera_id=%s reason=%s",
                    camera_id,
                    type(exc).__name__,
                )

    encrypted_embedding: Optional[bytes] = None
    employee_id: Optional[int] = None
    former_match_employee_id: Optional[int] = None
    former_employee_match = False
    confidence: Optional[float] = None
    if embedding is not None and embedding.size > 0:
        try:
            encrypted_embedding = encrypt_embedding(embedding)
        except (RuntimeError, ValueError) as exc:
            logger.debug("skipping embedding encryption: %s", exc)
        if pre_matched is not None:
            # ``pre_matched`` from the live-capture annotation path
            # (P28.5) is a plain (id, score) tuple — by definition the
            # active path that already classified successfully.
            employee_id, confidence = pre_matched
        else:
            match = matcher_cache.match(scope, embedding)
            if match is not None:
                confidence = match.score
                # P28.7: branch on the lifecycle classification.
                if match.classification == "active":
                    employee_id = match.employee_id
                elif match.classification == "inactive":
                    former_match_employee_id = match.employee_id
                    former_employee_match = True
                    # Single INFO line per former-employee detection so
                    # operators can see them in the audit trail without
                    # crawling DEBUG output.
                    logger.info(
                        "former employee detected: code=%s name=%s confidence=%.2f",
                        match.employee_code or "?",
                        match.full_name or "?",
                        match.score,
                    )
                # else classification == "future" — neither column set,
                # treat as Unknown (per the locked decision).

    # Build the per-row metadata snapshot. The DetectorConfig may have
    # changed since the worker booted (System Settings hot-reload), so
    # we capture it at emit time. ``detector_config=None`` (tests, ad-
    # hoc callers) leaves the column NULL — the API renders "—".
    detection_metadata: Optional[dict] = None
    if detector_config is not None:
        try:
            from hadir.config import get_settings  # noqa: PLC0415
            from hadir.detection.metadata import current_metadata  # noqa: PLC0415

            detection_metadata = current_metadata(
                detector_config,
                match_threshold=get_settings().match_threshold,
            )
        except Exception as exc:  # noqa: BLE001
            # Metadata is auditing flair; never sink an event write
            # because the version probe failed.
            logger.debug(
                "metadata snapshot failed: %s", type(exc).__name__
            )

    with engine.begin() as conn:
        new_id = conn.execute(
            insert(detection_events)
            .values(
                tenant_id=scope.tenant_id,
                camera_id=camera_id,
                captured_at=captured_at,
                bbox={"x": bbox.x, "y": bbox.y, "w": bbox.w, "h": bbox.h},
                face_crop_path=str(file_path),
                embedding=encrypted_embedding,
                employee_id=employee_id,
                confidence=confidence,
                track_id=track_id,
                former_employee_match=former_employee_match,
                former_match_employee_id=former_match_employee_id,
                detection_metadata=detection_metadata,
            )
            .returning(detection_events.c.id)
        ).scalar_one()

    # P26: Prometheus counter — labelled by ``identified``
    # (whether the matcher pinned an employee_id). Only the
    # opaque tenant_id + the boolean go into labels — no PII.
    from hadir.metrics import observe_detection_event  # noqa: PLC0415

    observe_detection_event(
        scope.tenant_id, identified=employee_id is not None
    )

    # P28.5: fan out to live-capture WebSocket subscribers. The
    # ``event_bus`` publish is non-blocking — full subscriber queues
    # drop their oldest event rather than stall the capture loop.
    name_label: Optional[str] = None
    code_label: Optional[str] = None
    if employee_id is not None:
        resolved = employee_directory.label_for(scope, employee_id)
        if resolved is not None:
            name_label, code_label = resolved
    event_bus.publish(
        DetectionEvent(
            tenant_id=scope.tenant_id,
            camera_id=camera_id,
            captured_at=captured_at.timestamp(),
            employee_id=employee_id,
            employee_code=code_label,
            employee_name=name_label,
            confidence=confidence,
            bbox={"x": bbox.x, "y": bbox.y, "w": bbox.w, "h": bbox.h},
        )
    )

    return int(new_id)


def write_health_snapshot(
    engine: Engine,
    scope: TenantScope,
    *,
    camera_id: int,
    frames_last_minute: int,
    reachable: bool,
    note: Optional[str] = None,
    captured_at: Optional[datetime] = None,
) -> None:
    """One row per minute per camera. Consumed by the System page (P11)."""

    captured_at = captured_at or datetime.now(tz=timezone.utc)
    with engine.begin() as conn:
        conn.execute(
            insert(camera_health_snapshots).values(
                tenant_id=scope.tenant_id,
                camera_id=camera_id,
                captured_at=captured_at,
                frames_last_minute=frames_last_minute,
                reachable=reachable,
                note=note,
            )
        )

    # P26: reachability gauge. Updated on the same per-minute
    # tick as the snapshot insert so a Prometheus scrape always
    # reflects the freshest health-check result.
    from hadir.metrics import set_camera_reachable  # noqa: PLC0415

    set_camera_reachable(scope.tenant_id, camera_id, reachable=reachable)


def bump_camera_last_seen(engine: Engine, scope: TenantScope, camera_id: int) -> None:
    """Update ``cameras.last_seen_at`` so the list UI reflects liveness."""

    with engine.begin() as conn:
        conn.execute(
            update(cameras)
            .where(
                cameras.c.id == camera_id,
                cameras.c.tenant_id == scope.tenant_id,
            )
            .values(last_seen_at=func.now())
        )
