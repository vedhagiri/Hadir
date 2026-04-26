"""Detection event emission: crop → encrypt → DB insert.

Called by the capture worker whenever the tracker returns a ``is_new=True``
match. The crop is Fernet-encrypted at rest (same key as P6 employee
photos) and written under
``/data/faces/captures/{tenant_id}/{camera_id}/{YYYY-MM-DD}/{uuid}.jpg``.

**Durability contract** (PROJECT_CONTEXT §12 + pilot-plan P8): the on-disk
write happens first, then the DB row is inserted; both complete before
the worker processes the next detection. The DB row's ``face_crop_path``
is therefore always backed by a real file at commit time. If the process
crashes between write and insert we lose an unreferenced file (acceptable
pilot trade-off); crashes between successful insert and the next
detection are safe — the inserted event survives and the worker resumes.
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
    """Crop the frame to the bbox and JPEG-encode the result."""

    import cv2  # noqa: PLC0415 — keep optional at import time

    h_frame, w_frame = frame_bgr.shape[:2]
    x1 = max(0, int(bbox.x))
    y1 = max(0, int(bbox.y))
    x2 = min(w_frame, int(bbox.x + bbox.w))
    y2 = min(h_frame, int(bbox.y + bbox.h))
    if x2 <= x1 or y2 <= y1:
        return None
    crop = frame_bgr[y1:y2, x1:x2]
    ok, buf = cv2.imencode(".jpg", crop)
    if not ok:
        return None
    return bytes(buf.tobytes())


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

    * ``min_face_quality_to_save`` — skip if ``quality_score(bbox,
      det_score)`` falls below the threshold. The single-face-per-
      event architecture means a low-quality detection doesn't
      become an event at all (rather than the multi-face semantics
      where a row exists but the crop is omitted).
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
    min_quality = float(config.get("min_face_quality_to_save", 0.0))
    save_full = bool(config.get("save_full_frames", False))

    # Apply the quality threshold BEFORE doing any disk or DB work —
    # cheap to compute and avoids both the JPEG encode and the
    # capture-tree mkdir for low-quality detections.
    score = quality_score(bbox, det_score)
    if score < min_quality:
        logger.debug(
            "crop skipped (quality %.2f < %.2f): camera_id=%s track=%s",
            score, min_quality, camera_id, track_id,
        )
        return None

    jpeg = _encode_jpeg(frame_bgr, bbox)
    if jpeg is None:
        logger.debug(
            "crop skipped (invalid bbox): camera_id=%s track=%s", camera_id, track_id
        )
        return None

    directory = captures_dir(scope.tenant_id, camera_id, now=captured_at)
    directory.mkdir(parents=True, exist_ok=True)
    file_path = directory / f"{uuid.uuid4().hex}.jpg"
    file_path.write_bytes(encrypt_bytes(jpeg))

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
    confidence: Optional[float] = None
    if embedding is not None and embedding.size > 0:
        try:
            encrypted_embedding = encrypt_embedding(embedding)
        except (RuntimeError, ValueError) as exc:
            logger.debug("skipping embedding encryption: %s", exc)
        if pre_matched is not None:
            employee_id, confidence = pre_matched
        else:
            match = matcher_cache.match(scope, embedding)
            if match is not None:
                employee_id = match.employee_id
                confidence = match.score

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
