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
    *,
    use_case: str = "",
) -> tuple[list[tuple[int, list[dict]]], float]:
    """Run face detection on sampled frames.

    Returns ``([(frame_idx, detections), ...], extract_duration_s)``.
    Stops early if ``stop_event`` is set.

    Per-UC tuning:

    * **UC1** (``yolo+face``) — recall-first. YOLO at imgsz=960,
      face-pad 40, min_face 30², min_det 0.35. Catches small/distant
      persons the live-capture 480-px path drops.
    * **UC2** (``insightface``) — quality-first, mirrors the reference
      InsightFace+SCRFD crop pipeline at
      ``Face_Recogination/files (3)/``. det_size=640, min_face 60²,
      min_det 0.45. The save layer adds the composite quality scorer
      + best-per-track selection.
    * **UC3** (``insightface``) — canonical match, permissive recall.
      Defaults except a loosened min_face / min_det so it never
      under-finds vs UC2.
    """
    from maugood.detection import DetectorConfig, detect as detector_detect  # noqa: PLC0415

    if mode == "yolo+face":
        cfg = DetectorConfig(
            mode=mode,
            yolo_imgsz=960,
            yolo_face_pad=40,
            yolo_conf=0.25,
            min_face_pixels=30 * 30,
            min_det_score=0.35,
        )
    elif use_case == "uc2":
        # Reference parity for UC2: SCRFD at 640×640 input, 60-px
        # face minimum, 0.45 detection threshold. The composite
        # quality scorer downstream is the actual quality gate;
        # this just gives it good candidates to score.
        cfg = DetectorConfig(
            mode=mode,
            det_size=640,
            min_face_pixels=60 * 60,
            min_det_score=0.45,
        )
    else:
        # UC3 + any other future insightface caller — recall-first.
        cfg = DetectorConfig(
            mode=mode,
            min_face_pixels=30 * 30,
            min_det_score=0.35,
        )

    results: list[tuple[int, list[dict]]] = []
    t0 = time.time()

    # Diagnostics so an operator running UC1 with "no faces found"
    # can see at a glance whether YOLO failed (zero detections across
    # every frame) or InsightFace failed (YOLO found persons but
    # zero faces inside any box).
    total_dets = 0
    frames_with_any = 0

    for i, frame in enumerate(frames):
        if stop_event is not None and stop_event.is_set():
            break
        try:
            dets = detector_detect(frame, cfg)
            if dets:
                results.append((i, dets))
                total_dets += len(dets)
                frames_with_any += 1
        except Exception as exc:  # noqa: BLE001
            logger.debug("detect failed on frame %d: %s", i, type(exc).__name__)

    logger.info(
        "reprocess detect: mode=%s frames=%d frames_with_faces=%d "
        "total_faces=%d imgsz=%s pad=%s min_face_pixels=%s",
        mode, len(frames), frames_with_any, total_dets,
        getattr(cfg, "yolo_imgsz", "n/a"),
        getattr(cfg, "yolo_face_pad", "n/a"),
        cfg.min_face_pixels,
    )

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


# ---------------------------------------------------------------------------
# UC2 — reference-parity quality scorer + best-per-track save
# ---------------------------------------------------------------------------
#
# These helpers port the working pipeline from
# ``Face_Recogination/files (3)/`` (quality.py + saver.py + tracker.py)
# verbatim in behaviour. The reference produces noticeably better crops
# than UC2's old per-frame save path; this is what closes the gap.
#
# Composite quality (0-100) is a weighted sum of four cheap signals:
#   blur  (W=0.35) — Laplacian variance on the face ROI
#   size  (W=0.25) — min face dimension normalised against 180px ref
#   pose  (W=0.25) — yaw + nose-centering from 5-pt landmarks
#   conf  (W=0.15) — SCRFD detection score
#
# Track-aware save: IoU-greedy associate detections into face tracks
# across frames, keep one BEST frame per track (highest composite
# quality), drop tracks whose best frame falls below MIN_QUALITY or
# MIN_POSE. This is what stops UC2 from saving 30 mediocre crops of
# the same person; we save one good one per person instead.


# Weights mirror the reference's quality.py.
_UC2_W_BLUR = 0.35
_UC2_W_SIZE = 0.25
_UC2_W_POSE = 0.25
_UC2_W_CONF = 0.15

# Laplacian-variance normalisation band.
_UC2_BLUR_MIN = 20.0
_UC2_BLUR_MAX = 400.0

# Size score saturates at this face short-side (px).
_UC2_SIZE_GOOD = 180
_UC2_SIZE_MIN = 60

# Gates applied to the composite + pose sub-score before save.
_UC2_MIN_QUALITY = 55.0
_UC2_MIN_POSE = 50.0

# Asymmetric padding around the SCRFD bbox before the crop is cut.
# Bottom is intentionally heavier so the chin + a strip of neck are
# captured — the reference found that crops cropped tight to the
# bbox were visually weaker for human review.
_UC2_PAD_LEFT = 0.28
_UC2_PAD_RIGHT = 0.28
_UC2_PAD_TOP = 0.30
_UC2_PAD_BOTTOM = 0.55

# Final save dimensions + encoding.
_UC2_CROP_SIZE = 320  # square output via LANCZOS4
_UC2_JPEG_QUALITY = 95

# IoU threshold for track association (matches reference's 0.35).
_UC2_TRACK_IOU = 0.35
# Per-frame match — at our 2-3 fps sampling, the same person typically
# moves ≤30% bbox between samples; 0.35 catches them. Above this they
# spawn a new track (different person OR re-entering frame).


def _uc2_blur_score(roi: np.ndarray) -> float:
    """Laplacian variance → 0-100 sharpness score."""
    import cv2  # noqa: PLC0415

    if roi is None or roi.size == 0:
        return 0.0
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    lap = cv2.Laplacian(gray, cv2.CV_64F).var()
    s = (lap - _UC2_BLUR_MIN) / (_UC2_BLUR_MAX - _UC2_BLUR_MIN)
    return float(np.clip(s * 100.0, 0.0, 100.0))


def _uc2_size_score(face_w: int, face_h: int) -> float:
    """Larger face → higher score. Uses the SHORT side so narrow boxes
    don't game the metric."""
    short = min(int(face_w), int(face_h))
    s = (short - _UC2_SIZE_MIN) / (_UC2_SIZE_GOOD - _UC2_SIZE_MIN)
    return float(np.clip(s * 100.0, 0.0, 100.0))


def _uc2_pose_score(kps: Optional[np.ndarray]) -> float:
    """Yaw + nose-centering frontality score (port of reference).
    100 = perfect frontal, 0 = full profile.

    The reference's key insight: on a profile face SCRFD places the
    occluded eye near the visible one, so symmetry-ratio reads ~1.0
    (false 'frontal'). Eye-span / face-height *collapses* on a
    profile, so it's the reliable signal."""
    if kps is None or len(kps) < 5:
        return 50.0
    arr = np.asarray(kps, dtype=np.float32).reshape(-1, 2)
    if arr.shape != (5, 2):
        return 50.0
    le, re, nose, ml, mr = arr[0], arr[1], arr[2], arr[3], arr[4]
    eye_cx = (le[0] + re[0]) / 2.0
    eye_cy = (le[1] + re[1]) / 2.0
    mouth_cy = (ml[1] + mr[1]) / 2.0
    face_v = abs(mouth_cy - eye_cy) + 1e-6
    eye_x_span = float(re[0] - le[0])
    yaw = float(np.clip(eye_x_span / face_v * 120.0, 0.0, 100.0))
    eye_x_half = max(eye_x_span / 2.0, 1.0)
    nose_h_ratio = abs(nose[0] - eye_cx) / eye_x_half
    center = float(np.clip((1.0 - nose_h_ratio * 0.6) * 100.0, 0.0, 100.0))
    return yaw * 0.7 + center * 0.3


def _uc2_composite_quality(
    frame_bgr: np.ndarray, det: dict
) -> tuple[float, dict]:
    """Return ``(total_0_100, sub_scores)`` for one detection."""
    bbox = det.get("bbox")
    if bbox is None:
        return 0.0, {}
    x1, y1, x2, y2 = (int(v) for v in bbox)
    H, W = frame_bgr.shape[:2]
    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(W, x2)
    y2 = min(H, y2)
    if x2 <= x1 or y2 <= y1:
        return 0.0, {}
    roi = frame_bgr[y1:y2, x1:x2]
    s_blur = _uc2_blur_score(roi)
    s_size = _uc2_size_score(x2 - x1, y2 - y1)
    s_pose = _uc2_pose_score(det.get("kps"))
    s_conf = float(det.get("det_score", 0.0)) * 100.0
    total = (
        _UC2_W_BLUR * s_blur
        + _UC2_W_SIZE * s_size
        + _UC2_W_POSE * s_pose
        + _UC2_W_CONF * s_conf
    )
    return round(total, 2), {
        "blur": round(s_blur, 1),
        "size": round(s_size, 1),
        "pose": round(s_pose, 1),
        "conf": round(s_conf, 1),
    }


def _uc2_iou(a: tuple, b: tuple) -> float:
    """IoU between two (x1, y1, x2, y2) tuples."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = float(iw * ih)
    aa = max(0, (ax2 - ax1)) * max(0, (ay2 - ay1))
    bb = max(0, (bx2 - bx1)) * max(0, (by2 - by1))
    union = float(aa + bb - inter)
    if union <= 0:
        return 0.0
    return inter / union


def _uc2_associate_into_tracks(
    frame_results: list[tuple[int, list[dict]]],
) -> dict[int, list[tuple[int, int]]]:
    """Greedy IoU association of detections across frames into tracks.

    Returns ``{track_id: [(frame_idx, det_idx), ...]}``. Walks frames
    in order; for each detection in the current frame, picks the
    best-IoU match against any track whose latest bbox satisfies
    ``IoU >= _UC2_TRACK_IOU``. Unmatched detections spawn new tracks.

    This is offline (operates on already-sampled frames) so there's
    no max-lost ageing; gaps between sample frames are handled by
    the IoU threshold alone.
    """
    next_id = 1
    tracks: dict[int, list[tuple[int, int]]] = {}
    last_bbox: dict[int, tuple[int, int, int, int]] = {}

    for frame_idx, dets in frame_results:
        # Greedy: each track claims its single best detection in this
        # frame; once claimed, that detection can't be reused.
        claimed: set[int] = set()
        # Score all (track, det) IoU pairs above threshold.
        pairs: list[tuple[float, int, int]] = []
        for tid, last in last_bbox.items():
            for di, det in enumerate(dets):
                bbox = det.get("bbox")
                if bbox is None:
                    continue
                iou = _uc2_iou(tuple(bbox), last)
                if iou >= _UC2_TRACK_IOU:
                    pairs.append((iou, tid, di))
        pairs.sort(key=lambda p: -p[0])
        used_dets: set[int] = set()
        used_tracks: set[int] = set()
        for iou, tid, di in pairs:
            if tid in used_tracks or di in used_dets:
                continue
            tracks[tid].append((frame_idx, di))
            bbox = dets[di].get("bbox")
            if bbox is not None:
                last_bbox[tid] = tuple(int(v) for v in bbox)  # type: ignore[assignment]
            used_tracks.add(tid)
            used_dets.add(di)
            claimed.add(di)

        # Spawn new tracks for unmatched detections.
        for di, det in enumerate(dets):
            if di in claimed:
                continue
            bbox = det.get("bbox")
            if bbox is None:
                continue
            tid = next_id
            next_id += 1
            tracks[tid] = [(frame_idx, di)]
            last_bbox[tid] = tuple(int(v) for v in bbox)  # type: ignore[assignment]

    return tracks


def _uc2_extract_padded_crop(
    frame_bgr: np.ndarray, bbox: tuple
) -> Optional[np.ndarray]:
    """Asymmetric-pad + clamp + return the BGR crop. Mirrors reference
    ``saver._extract_crop`` (28/28/30/55 LRTB ratios)."""
    fh, fw = frame_bgr.shape[:2]
    x1, y1, x2, y2 = (int(v) for v in bbox)
    bw = x2 - x1
    bh = y2 - y1
    if bw < 4 or bh < 4:
        return None
    pad_l = int(bw * _UC2_PAD_LEFT)
    pad_r = int(bw * _UC2_PAD_RIGHT)
    pad_t = int(bh * _UC2_PAD_TOP)
    pad_b = int(bh * _UC2_PAD_BOTTOM)
    cx1 = max(0, x1 - pad_l)
    cy1 = max(0, y1 - pad_t)
    cx2 = min(fw, x2 + pad_r)
    cy2 = min(fh, y2 + pad_b)
    crop = frame_bgr[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return None
    return crop.copy()


def _save_face_crops_uc2_best_per_track(
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
    det_employee_map: Optional[dict[tuple[int, int], Optional[int]]] = None,
) -> int:
    """UC2's reference-parity save path.

    Returns ``saved_count``. Side effects: writes Fernet-encrypted
    320×320 LANCZOS4 JPEGs to ``/face_crops/...`` and inserts one
    ``face_crops`` row per saved track.
    """
    import cv2  # noqa: PLC0415

    if not frame_results:
        return 0

    # 1. Compute composite quality for every detection (cheap — pure
    #    numpy + one Laplacian per face).
    qualities: dict[tuple[int, int], tuple[float, dict]] = {}
    for frame_idx, dets in frame_results:
        frame = frames[frame_idx] if 0 <= frame_idx < len(frames) else None
        if frame is None:
            continue
        for det_idx, det in enumerate(dets):
            qualities[(frame_idx, det_idx)] = _uc2_composite_quality(frame, det)

    # 2. Associate detections into face tracks via greedy IoU.
    tracks = _uc2_associate_into_tracks(frame_results)
    logger.info(
        "uc2 save: %d tracks across %d frames (avg %.1f faces/track)",
        len(tracks),
        len(frame_results),
        sum(len(v) for v in tracks.values()) / max(1, len(tracks)),
    )

    # 3. For each track, pick the single highest-composite-quality
    #    detection. Then apply pose + quality gates.
    saved = 0
    for track_id, members in tracks.items():
        if not members:
            continue
        best_key: Optional[tuple[int, int]] = None
        best_q: float = -1.0
        best_subs: dict = {}
        for key in members:
            q, subs = qualities.get(key, (0.0, {}))
            if q > best_q:
                best_q = q
                best_key = key
                best_subs = subs

        if best_key is None:
            continue
        if best_q < _UC2_MIN_QUALITY:
            continue
        if best_subs.get("pose", 0.0) < _UC2_MIN_POSE:
            continue

        frame_idx, det_idx = best_key
        frame = frames[frame_idx] if 0 <= frame_idx < len(frames) else None
        if frame is None:
            continue
        det = frame_results[
            next(i for i, (fi, _) in enumerate(frame_results) if fi == frame_idx)
        ][1][det_idx]
        bbox = det.get("bbox")
        if bbox is None:
            continue

        crop = _uc2_extract_padded_crop(frame, bbox)
        if crop is None:
            continue

        # Resize to fixed 320×320 via LANCZOS4 (reference uses the same
        # combo). This is what makes the saved JPEG actually look like
        # a portrait instead of an upscaled thumbnail.
        try:
            out = cv2.resize(
                crop, (_UC2_CROP_SIZE, _UC2_CROP_SIZE),
                interpolation=cv2.INTER_LANCZOS4,
            )
            ok, buf = cv2.imencode(
                ".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), _UC2_JPEG_QUALITY]
            )
            if not ok or buf is None:
                continue
            crop_bytes = bytes(buf)
        except Exception:  # noqa: BLE001
            continue

        # Approximate frame timestamp for the event_timestamp column.
        approx_offset = 0.0
        if frame_count > 0 and duration_s > 0:
            orig_frame = frame_idx * sample_interval
            approx_offset = (orig_frame / frame_count) * duration_s
        ts_dt = clip_start + __import__("datetime").timedelta(seconds=approx_offset)
        ts_str = ts_dt.strftime("%Y%m%d_%H%M%S")

        # Look up matched employee (None for unknowns).
        emp_id: Optional[int] = None
        if det_employee_map is not None:
            emp_id = det_employee_map.get(best_key)

        # Storage path mirrors _save_face_crops_to_db.
        from maugood.config import get_settings as _gs  # noqa: PLC0415
        settings = _gs()
        crops_root = Path(settings.face_crops_storage_path)
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

        # INSERT row. ``quality_score`` carries the composite (0-100,
        # divided by 100 to fit the 0-1 column contract);
        # ``detection_score`` carries the raw SCRFD det_score so the
        # detail drawer can still surface both.
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
                        quality_score=best_q / 100.0,
                        sharpness=best_subs.get("blur", 0.0) / 100.0,
                        detection_score=float(det.get("det_score", 0.0)),
                        width=_UC2_CROP_SIZE,
                        height=_UC2_CROP_SIZE,
                        use_case="uc2",
                        employee_id=emp_id,
                    )
                )
        except Exception:  # noqa: BLE001
            crop_path.unlink(missing_ok=True)
            continue

        logger.info(
            "uc2 saved: track=%d composite=%.1f blur=%.0f size=%.0f "
            "pose=%.0f conf=%.0f emp_id=%s",
            track_id, best_q,
            best_subs.get("blur", 0.0),
            best_subs.get("size", 0.0),
            best_subs.get("pose", 0.0),
            best_subs.get("conf", 0.0),
            emp_id,
        )
        saved += 1

    return saved


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
    max_crops_override: Optional[int] = None,
    return_index: bool = False,
) -> "int | tuple[int, dict[tuple[int, int], int]]":
    """Write face crops from detections to the ``face_crops`` table.

    Crops are extracted from ``frames`` using each detection's ``bbox``
    coordinates, padded with surrounding context, upscaled to a usable
    minimum size, and Fernet-encrypted at rest.

    ``det_employee_map`` maps ``(frame_idx, det_idx)`` → ``employee_id | None``
    so each crop row records who was matched (NULL = unknown person).
    Passing ``det_employee_map=None`` means "save the crops now, the
    match step hasn't run yet" — every crop row lands with
    ``employee_id=NULL`` and the matcher can backfill the column later.

    ``max_crops_override`` overrides ``settings.face_crops_max_per_clip``.
    UC1 reprocess uses a higher cap (currently 30) because the 5-default
    is sized for the live-capture path; reprocess wants to retain all
    available evidence for the detail drawer.

    Returns the number of crops saved.
    """
    import cv2  # noqa: PLC0415

    from maugood.config import get_settings as _gs  # noqa: PLC0415
    settings = _gs()
    crops_root = Path(settings.face_crops_storage_path)
    saved = 0
    max_crops = (
        max_crops_override
        if max_crops_override is not None
        else settings.face_crops_max_per_clip
    )
    # When ``return_index=True`` the caller (UC1 backfill path) wants
    # to know which face_crops.id was created for each (frame, det)
    # pair so it can UPDATE the employee_id after the match runs.
    save_index: dict[tuple[int, int], int] = {}

    # Visual-context padding around the raw face bbox before save. The
    # bbox itself is what InsightFace returned — typically chin-to-
    # forehead, ear-to-ear. With no padding the saved crop looks like
    # a tight mug-shot and visual review is hard. 30% pad each side
    # gives the reviewer enough hair/shoulders to confirm identity.
    PAD_RATIO = 0.30
    # Minimum saved-crop dimension. Faces detected at low resolution
    # (small/distant) get bicubic-upscaled to this size so the saved
    # JPEG is reviewable. Embeddings have already been computed at the
    # native resolution — upscaling here is for HUMANS only.
    MIN_SAVE_DIM = 200

    for frame_idx, dets in frame_results:
        if saved >= max_crops:
            break
        # Retrieve the original frame for bbox-based cropping.
        frame = frames[frame_idx] if 0 <= frame_idx < len(frames) else None
        if frame is None:
            continue
        H, W = frame.shape[:2]
        for det_idx, det in enumerate(dets):
            if saved >= max_crops:
                break
            # Extract face region from the frame using the detection bbox.
            bbox = det.get("bbox")
            if bbox is None:
                continue
            x1, y1, x2, y2 = [int(v) for v in bbox]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(W, x2), min(H, y2)
            if x2 <= x1 or y2 <= y1:
                continue
            # Expand bbox with visual-context padding.
            bw = x2 - x1
            bh = y2 - y1
            pad_x = int(bw * PAD_RATIO)
            pad_y = int(bh * PAD_RATIO)
            cx1 = max(0, x1 - pad_x)
            cy1 = max(0, y1 - pad_y)
            cx2 = min(W, x2 + pad_x)
            cy2 = min(H, y2 + pad_y)
            crop_arr = frame[cy1:cy2, cx1:cx2]
            if getattr(crop_arr, "size", 0) == 0:
                continue
            # Upscale small crops so the saved JPEG is human-reviewable.
            ch, cw = crop_arr.shape[:2]
            short_side = min(ch, cw)
            if short_side < MIN_SAVE_DIM and short_side > 0:
                scale = MIN_SAVE_DIM / short_side
                new_w = int(round(cw * scale))
                new_h = int(round(ch * scale))
                crop_arr = cv2.resize(
                    crop_arr, (new_w, new_h), interpolation=cv2.INTER_CUBIC
                )
            q_score = float(det.get("quality_score", det.get("det_score", 0.0)))
            if q_score < settings.face_crops_min_quality:
                continue
            try:
                ok, buf = cv2.imencode(
                    ".jpg", crop_arr, [int(cv2.IMWRITE_JPEG_QUALITY), 92]
                )
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
                    result = conn.execute(
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
                        ).returning(face_crops.c.id)
                    )
                    inserted_id = int(result.scalar_one())
            except Exception:  # noqa: BLE001
                crop_path.unlink(missing_ok=True)
                continue

            save_index[(frame_idx, det_idx)] = inserted_id
            saved += 1

    if return_index:
        return saved, save_index
    return saved


def _backfill_crop_matches(
    engine,
    scope: TenantScope,
    save_index: dict[tuple[int, int], int],
    det_employee_map: dict[tuple[int, int], Optional[int]],
) -> None:
    """UPDATE ``face_crops.employee_id`` for the rows saved before the
    match step ran. UC1's save-first ordering means every crop landed
    with ``employee_id=NULL``; the matcher then produced
    ``det_employee_map``, and this helper threads the match back onto
    the persisted rows. Rows without a match (employee_id=None) are
    left alone — they already carry NULL.
    """
    updates: list[tuple[int, int]] = []
    for key, crop_id in save_index.items():
        emp_id = det_employee_map.get(key)
        if emp_id is None:
            continue
        updates.append((crop_id, emp_id))

    if not updates:
        return

    with engine.begin() as conn:
        for crop_id, emp_id in updates:
            conn.execute(
                sa_update(face_crops)
                .where(
                    face_crops.c.id == crop_id,
                    face_crops.c.tenant_id == scope.tenant_id,
                )
                .values(employee_id=emp_id)
            )


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

        frame_results, extract_s = _run_detection(
            frames, mode, stop_event, use_case=use_case
        )

        # Intermediate update: extraction done, matching starting.
        # The frontend uses face_extract_duration_ms being set (but
        # match_duration_ms still null) to show "now matching" progress.
        _upsert_processing_result(
            engine, scope, clip_id, use_case,
            status="processing",
            started_at=datetime.now(timezone.utc) - __import__("datetime").timedelta(seconds=extract_s),
            face_extract_duration_ms=int(extract_s * 1000),
        )

        # UC1's job is to give the operator every face we found, with
        # or without a successful match. Save crops FIRST so a matcher
        # crash never strands the evidence; the rows initially carry
        # employee_id=NULL and we backfill the matched ones after the
        # match step runs. UC2 / UC3 keep the original "match-then-save"
        # order so the live-capture single-pass shape is unchanged.
        #
        # UC1 also gets a larger ``max_crops_override`` (30 vs the
        # 5-default) because reprocess wants the full evidence trail —
        # the live-capture path's 5-cap was sized for the realtime
        # write rate, not for the offline reprocess.
        face_crop_count = 0
        match_index: Optional[dict[tuple[int, int], int]] = None
        if use_case == "uc1" and frame_results:
            face_crop_count, match_index = _save_face_crops_to_db(
                engine, scope, clip_id, camera_id,
                frames, frame_results,
                clip_start, duration_seconds, frame_count, sample_interval,
                use_case=use_case,
                det_employee_map=None,
                max_crops_override=30,
                return_index=True,
            )

        # Match first so each crop can be tagged with the matched employee.
        det_employee_map, matched_ids, unknown_count, match_details, match_s = (
            _match_detections(frame_results, scope)
        )

        if use_case == "uc1" and match_index is not None and frame_results:
            # Backfill the just-saved crop rows with their match result.
            _backfill_crop_matches(engine, scope, match_index, det_employee_map)
        elif use_case == "uc2" and frame_results:
            # UC2 = reference-parity pipeline: composite quality
            # scoring + IoU track association + one best frame per
            # track at 320×320 LANCZOS4 with asymmetric padding.
            # Produces noticeably better crops than the old per-frame
            # save path. See ``_save_face_crops_uc2_best_per_track``.
            face_crop_count = _save_face_crops_uc2_best_per_track(
                engine, scope, clip_id, camera_id,
                frames, frame_results,
                clip_start, duration_seconds, frame_count, sample_interval,
                det_employee_map=det_employee_map,
            )
        elif frame_results:
            # UC3 unchanged — save after match with employee_id baked
            # into the INSERT, raw bbox crop + 30% pad + 200-px upscale.
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
