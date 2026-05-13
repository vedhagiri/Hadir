"""Background face crop extraction from saved person clips.

Uses InsightFace (via ``maugood.detection``) for face detection, alignment,
and quality scoring. Runs on a daemon thread triggered manually by the user.

Improvements over v1:
  * Per-frame IoU tracking within each clip — selects the single best
    frame per tracked face instead of saving every detection
  * Higher detection threshold (0.45) to reject non-face objects
  * Proper crop padding with neck capture (matching prototype reference)
  * Edge-completeness check — rejects partial faces at frame boundaries
  * Better quality scoring — blur + size + pose + confidence with
    calibrated weights
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np
import sqlalchemy as sa
from sqlalchemy.engine import Engine

from maugood.config import get_settings
from maugood.db import face_crops as _fc
from maugood.db import person_clips as _pc
from maugood.db import tenant_context
from maugood.detection import DetectorConfig, detect
from maugood.detection.detectors import _load_face_app, _detect_lock
from maugood.employees.photos import decrypt_bytes, encrypt_bytes
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# --- Thresholds & weights (from prototype reference) ------------------------
_DET_CONFIDENCE_MIN = 0.45
_MIN_FACE_SIZE = 60
_DEDUP_IOU = 0.5
_MIN_POSE_SCORE = 0.4
_MAX_CROP_DIM = 400
_EDGE_MARGIN_PCT = 8

W_BLUR = 0.35
W_SIZE = 0.25
W_POSE = 0.25
W_CONF = 0.15

_BLUR_LAPLACIAN_MIN = 20.0
_BLUR_LAPLACIAN_MAX = 400.0
_SIZE_REF_GOOD = 180
_SIZE_REF_MIN = _MIN_FACE_SIZE
_QUALITY_IMPROVEMENT_MARGIN = 5

# Crop padding fractions (from prototype reference)
_PAD_LEFT = 0.28
_PAD_RIGHT = 0.28
_PAD_TOP = 0.30
_PAD_BOTTOM = 0.55

# --- Per-clip tracker -------------------------------------------------------


@dataclass
class _BestFrame:
    """Best-quality frame for a single tracked face within one clip."""
    frame_bgr: np.ndarray
    bbox: tuple[float, float, float, float]
    quality: float
    sub_scores: dict
    frame_idx: int
    det_score: float
    landmarks: Optional[np.ndarray]
    crop_bgr: Optional[np.ndarray] = None


@dataclass
class _TrackState:
    """One tracked face across frames within a clip."""
    track_id: int
    bbox: tuple[float, float, float, float]
    det_score: float
    landmarks: np.ndarray
    lost_frames: int = 0
    best: Optional[_BestFrame] = None


def _bbox_iou(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    a_area = (a[2] - a[0]) * (a[3] - a[1])
    b_area = (b[2] - b[0]) * (b[3] - b[1])
    union = a_area + b_area - inter
    if union <= 0:
        return 0.0
    return inter / union


def _match_dets_to_tracks(
    dets: list[dict],
    tracks: dict[int, _TrackState],
    iou_thresh: float = 0.35,
) -> tuple[dict[int, int], list[int], list[int]]:
    """Greedy IoU matching. Returns (track_id→det_idx, unmatched_track_ids, unmatched_det_idxs)."""
    if not dets:
        return {}, list(tracks.keys()), []
    if not tracks:
        return {}, [], list(range(len(dets)))

    track_ids = list(tracks.keys())
    track_bboxes = [tracks[tid].bbox for tid in track_ids]
    det_bboxes = [(d["bbox"][0], d["bbox"][1], d["bbox"][2], d["bbox"][3]) for d in dets]

    matched: dict[int, int] = {}
    unmatched_tracks = set(track_ids)
    unmatched_dets = set(range(len(dets)))

    for tid, tbox in zip(track_ids, track_bboxes):
        best_iou = iou_thresh
        best_di = -1
        for di, dbox in enumerate(det_bboxes):
            if di not in unmatched_dets:
                continue
            iou = _bbox_iou(tbox, dbox)
            if iou > best_iou:
                best_iou = iou
                best_di = di
        if best_di >= 0:
            matched[tid] = best_di
            unmatched_tracks.discard(tid)
            unmatched_dets.discard(best_di)

    return matched, list(unmatched_tracks), list(unmatched_dets)


# --- Quality scoring (from prototype reference) ------------------------------


def _blur_score(roi: np.ndarray) -> float:
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    lap = cv2.Laplacian(gray, cv2.CV_64F).var()
    score = (lap - _BLUR_LAPLACIAN_MIN) / (_BLUR_LAPLACIAN_MAX - _BLUR_LAPLACIAN_MIN)
    return float(np.clip(score * 100, 0, 100))


def _size_score(face_w: int, face_h: int) -> float:
    min_dim = min(face_w, face_h)
    score = (min_dim - _SIZE_REF_MIN) / (_SIZE_REF_GOOD - _SIZE_REF_MIN)
    return float(np.clip(score * 100, 0, 100))


def _pose_score(landmarks: np.ndarray) -> float:
    if landmarks is None or landmarks.shape != (5, 2):
        return 50.0
    le = landmarks[0]
    re = landmarks[1]
    nose = landmarks[2]
    ml = landmarks[3]
    mr = landmarks[4]

    eye_cx = (le[0] + re[0]) / 2
    eye_cy = (le[1] + re[1]) / 2
    mouth_cy = (ml[1] + mr[1]) / 2
    face_v = abs(mouth_cy - eye_cy) + 1e-6

    eye_x_span = re[0] - le[0]
    yaw_score = float(np.clip(eye_x_span / face_v * 120.0, 0.0, 100.0))

    eye_x_half = max(eye_x_span / 2.0, 1.0)
    nose_h_ratio = abs(nose[0] - eye_cx) / eye_x_half
    center_score = float(np.clip((1.0 - nose_h_ratio * 0.6) * 100.0, 0.0, 100.0))

    return yaw_score * 0.7 + center_score * 0.3


def _compute_crop_quality(
    frame_bgr: np.ndarray,
    bbox: tuple[float, float, float, float],
    landmarks: np.ndarray,
    det_confidence: float,
) -> tuple[float, dict]:
    x1, y1, x2, y2 = map(int, bbox)
    fh, fw = frame_bgr.shape[:2]
    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(fw, x2)
    y2 = min(fh, y2)

    face_roi = frame_bgr[y1:y2, x1:x2]
    if face_roi.size == 0:
        return 0.0, {}

    face_w = x2 - x1
    face_h = y2 - y1

    s_blur = _blur_score(face_roi)
    s_size = _size_score(face_w, face_h)
    s_pose = _pose_score(landmarks)
    s_conf = float(det_confidence) * 100.0

    total = (W_BLUR * s_blur + W_SIZE * s_size + W_POSE * s_pose + W_CONF * s_conf)

    return round(total, 2), {
        "blur": round(s_blur, 1),
        "size": round(s_size, 1),
        "pose": round(s_pose, 1),
        "conf": round(s_conf, 1),
    }


# --- Crop extraction ---------------------------------------------------------


def _extract_crop(frame_bgr: np.ndarray, bbox: np.ndarray) -> Optional[np.ndarray]:
    """Extract padded face crop with neck capture (from prototype)."""
    fh, fw = frame_bgr.shape[:2]
    x1, y1, x2, y2 = bbox.astype(int)
    bw = x2 - x1
    bh = y2 - y1

    if bw < 4 or bh < 4:
        return None

    pad_l = int(bw * _PAD_LEFT)
    pad_r = int(bw * _PAD_RIGHT)
    pad_t = int(bh * _PAD_TOP)
    pad_b = int(bh * _PAD_BOTTOM)

    cx1 = max(0, x1 - pad_l)
    cy1 = max(0, y1 - pad_t)
    cx2 = min(fw, x2 + pad_r)
    cy2 = min(fh, y2 + pad_b)

    crop = frame_bgr[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return None
    return crop.copy()


def _get_aligned_face(frame_bgr: np.ndarray, det: dict) -> Optional[np.ndarray]:
    """Extract aligned face using InsightFace's similarity transform."""
    try:
        kps = det.get("landmarks")
        if kps is None:
            return None
        from insightface.utils.face_align import norm_crop  # noqa: PLC0415
        warped = norm_crop(frame_bgr, kps)
        if warped is not None and warped.size > 0:
            return warped
        return None
    except Exception:
        logger.debug("face_crop.align_failed", exc_info=True)
        return None


def _resize_if_needed(img: np.ndarray, max_dim: int) -> np.ndarray:
    h, w = img.shape[:2]
    if max(h, w) <= max_dim:
        return img
    scale = max_dim / float(max(h, w))
    new_w = int(w * scale)
    new_h = int(h * scale)
    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)


def _is_face_complete(
    bbox: tuple[float, float, float, float],
    frame_hw: tuple[int, int],
    edge_margin_pct: float = _EDGE_MARGIN_PCT,
) -> bool:
    """Reject faces too close to the frame edge (partial faces)."""
    fh, fw = frame_hw
    x1, y1, x2, y2 = bbox
    margin_x = fw * edge_margin_pct / 100.0
    margin_y = fh * edge_margin_pct / 100.0
    if x1 < margin_x:
        return False
    if x2 > fw - margin_x:
        return False
    if y1 < margin_y:
        return False
    return True


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


# --- Per-clip processing ----------------------------------------------------


def _do_extract(
    engine: Engine,
    scope: TenantScope,
    camera_id: int,
    person_clip_id: int,
    event_timestamp: str,
    encrypted_file_path: str,
) -> int:
    """Extract face crops from a single clip using InsightFace + tracking.

    Process:
      1. Decrypt clip → temp file → OpenCV
      2. Sample frames at ~1 fps
      3. Each frame: detect → quality → IoU-track → update best-per-track
      4. After all frames: save the best crop per track (with alignment)
    """
    settings = get_settings()
    if not settings.clip_save_enabled:
        return 0

    clip_path = Path(encrypted_file_path)
    if not clip_path.exists():
        logger.warning(
            "face_crop.clip_missing clip=%s camera=%s path=%s",
            person_clip_id, camera_id, encrypted_file_path,
        )
        return 0

    try:
        encrypted = clip_path.read_bytes()
        plain = decrypt_bytes(encrypted)
    except Exception as exc:
        logger.warning(
            "face_crop.decrypt_failed clip=%s camera=%s reason=%s",
            person_clip_id, camera_id, type(exc).__name__,
        )
        return 0

    tmp_path: Optional[str] = None
    crops_saved = 0
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(plain)
            tmp_path = f.name

        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            logger.warning(
                "face_crop.cannot_open clip=%s camera=%s",
                person_clip_id, camera_id,
            )
            return 0

        try:
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv2.CAP_PROP_FPS)
            if fps <= 0:
                fps = 10.0
            sample_gap = max(1, int(round(fps)))

            logger.info(
                "face_crop.processing clip=%s camera=%s frames=%d fps=%.1f sample_gap=%d",
                person_clip_id, camera_id, total_frames, fps, sample_gap,
            )

            det_config = DetectorConfig(
                mode="insightface",
                min_det_score=_DET_CONFIDENCE_MIN,
                min_face_pixels=_MIN_FACE_SIZE * _MIN_FACE_SIZE,
            )

            tracks: dict[int, _TrackState] = {}
            next_track_id = 1
            frame_idx = 0
            sample_count = 0

            while True:
                ret, frame = cap.read()
                if not ret or frame is None:
                    break

                if frame_idx % sample_gap == 0:
                    sample_count += 1
                    detections = detect(frame, det_config)

                    filtered = []
                    for det in detections:
                        x1, y1, x2, y2 = det["bbox"]
                        fw = int(x2 - x1)
                        fh = int(y2 - y1)

                        if fw < _MIN_FACE_SIZE or fh < _MIN_FACE_SIZE:
                            continue

                        pose = det.get("pose_score", 0.0)
                        if pose < _MIN_POSE_SCORE:
                            continue

                        if not _is_face_complete(det["bbox"], frame.shape[:2]):
                            continue

                        quality, sub = _compute_crop_quality(
                            frame, det["bbox"],
                            det.get("landmarks"),
                            det["det_score"],
                        )
                        if quality < settings.face_crops_min_quality * 100:
                            continue

                        filtered.append({
                            "bbox": det["bbox"],
                            "det_score": det["det_score"],
                            "landmarks": det.get("landmarks"),
                            "quality": quality,
                            "sub_scores": sub,
                            "frame_idx": frame_idx,
                        })

                    matched, lost_tids, unmatched_dis = _match_dets_to_tracks(
                        filtered, tracks,
                    )

                    for tid in lost_tids:
                        del tracks[tid]

                    for tid, di in matched.items():
                        d = filtered[di]
                        t = tracks[tid]
                        t.bbox = d["bbox"]
                        t.det_score = d["det_score"]
                        t.landmarks = d.get("landmarks")
                        t.lost_frames = 0

                        bf = t.best
                        if bf is None or d["quality"] >= bf.quality + _QUALITY_IMPROVEMENT_MARGIN:
                            t.best = _BestFrame(
                                frame_bgr=frame.copy(),
                                bbox=d["bbox"],
                                quality=d["quality"],
                                sub_scores=d["sub_scores"],
                                frame_idx=d["frame_idx"],
                                det_score=d["det_score"],
                                landmarks=d.get("landmarks"),
                            )

                    for di in unmatched_dis:
                        d = filtered[di]
                        tid = next_track_id
                        next_track_id += 1
                        track = _TrackState(
                            track_id=tid,
                            bbox=d["bbox"],
                            det_score=d["det_score"],
                            landmarks=d.get("landmarks"),
                        )
                        track.best = _BestFrame(
                            frame_bgr=frame.copy(),
                            bbox=d["bbox"],
                            quality=d["quality"],
                            sub_scores=d["sub_scores"],
                            frame_idx=d["frame_idx"],
                            det_score=d["det_score"],
                            landmarks=d.get("landmarks"),
                        )
                        tracks[tid] = track

                frame_idx += 1
                if frame_idx >= total_frames:
                    break

            logger.info(
                "face_crop.detection clip=%s camera=%s samples=%d tracks=%d",
                person_clip_id, camera_id, sample_count, len(tracks),
            )

            if not tracks or all(t.best is None for t in tracks.values()):
                logger.info(
                    "face_crop.no_faces clip=%s camera=%s",
                    person_clip_id, camera_id,
                )
                return 0

            candidates = []
            for tid, track in tracks.items():
                if track.best is None:
                    continue
                padded = _extract_crop(track.best.frame_bgr, np.array(track.best.bbox))
                if padded is None:
                    continue

                aligned = _get_aligned_face(track.best.frame_bgr, {
                    "bbox": track.best.bbox,
                    "landmarks": track.best.landmarks,
                })

                candidates.append((
                    track.best.bbox,
                    track.best.det_score,
                    padded,
                    aligned,
                    track.best.quality,
                    track.best.sub_scores,
                    track.best.frame_idx,
                    tid,
                ))

            candidates.sort(key=lambda c: c[4], reverse=True)

            selected = []
            for bbox, det_score, padded, aligned, quality, sub, frame_idx, tid in candidates:
                is_dup = False
                for s_bbox, _, _, _, _, _, _, _ in selected:
                    if _bbox_iou(bbox, s_bbox) > _DEDUP_IOU:
                        is_dup = True
                        break
                if not is_dup:
                    selected.append((bbox, det_score, padded, aligned, quality, sub, frame_idx, tid))
                    if len(selected) >= settings.face_crops_max_per_clip:
                        break

            logger.info(
                "face_crop.selected clip=%s camera=%s selected=%d best_q=%.4f",
                person_clip_id, camera_id, len(selected),
                selected[0][4] if selected else 0,
            )

            event_dir = (
                Path(settings.face_crops_storage_path)
                / f"camera_{camera_id}"
                / f"event_{event_timestamp}"
            )
            _ensure_dir(event_dir)

            with engine.begin() as conn:
                conn.execute(
                    sa.delete(_fc).where(
                        _fc.c.person_clip_id == person_clip_id,
                        _fc.c.tenant_id == scope.tenant_id,
                    )
                )

                for face_idx, (
                    bbox, det_score, padded, aligned, quality, sub, frame_idx, tid,
                ) in enumerate(selected, start=1):
                    save_img = aligned if aligned is not None else padded
                    save_img = _resize_if_needed(save_img, _MAX_CROP_DIM)

                    ok, buf = cv2.imencode(".jpg", save_img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                    if not ok:
                        continue
                    jpg_bytes = bytes(buf.tobytes())
                    encrypted = encrypt_bytes(jpg_bytes)

                    face_path = event_dir / f"face_{face_idx:03d}.jpg"
                    face_path.write_bytes(encrypted)

                    h, w = save_img.shape[:2]
                    conn.execute(
                        sa.insert(_fc).values(
                            tenant_id=scope.tenant_id,
                            camera_id=camera_id,
                            person_clip_id=person_clip_id,
                            event_timestamp=event_timestamp,
                            face_index=face_idx,
                            file_path=str(face_path),
                            quality_score=round(quality / 100.0, 4),
                            sharpness=round(sub.get("blur", 0), 2),
                            detection_score=round(det_score, 4),
                            width=w,
                            height=h,
                        )
                    )
                    crops_saved += 1

            logger.info(
                "face_crop.saved clip=%s camera=%s crops=%d",
                person_clip_id, camera_id, crops_saved,
            )

        finally:
            cap.release()

    except Exception as exc:
        logger.error(
            "face_crop.extract_failed clip=%s camera=%s reason=%s",
            person_clip_id, camera_id, type(exc).__name__,
        )
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return crops_saved


def extract_from_clip(
    engine: Engine,
    scope: TenantScope,
    camera_id: int,
    person_clip_id: int,
    event_timestamp: str,
    encrypted_file_path: str,
) -> int:
    """Extract face crops from a single clip using InsightFace."""
    with tenant_context(scope.tenant_schema):
        return _do_extract(
            engine, scope, camera_id, person_clip_id,
            event_timestamp, encrypted_file_path,
        )


# ---------------------------------------------------------------------------
# Batch processing
# ---------------------------------------------------------------------------

_processing_lock = threading.Lock()
_processing_active = False


def is_processing() -> bool:
    return _processing_active


def _mark_clip_status(
    engine: Engine, scope: TenantScope, clip_id: int, status: str
) -> None:
    with engine.begin() as conn:
        conn.execute(
            sa.update(_pc)
            .where(_pc.c.id == clip_id, _pc.c.tenant_id == scope.tenant_id)
            .values(face_crops_status=status)
        )


def process_all_pending(
    engine: Engine,
    scope: TenantScope,
    *,
    camera_id: Optional[int] = None,
    reprocess: bool = False,
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> dict:
    global _processing_active

    with _processing_lock:
        if _processing_active:
            return {"error": "processing already in progress"}
        _processing_active = True

    with tenant_context(scope.tenant_schema):
        try:
            return _do_batch(
                engine, scope, camera_id=camera_id,
                reprocess=reprocess,
                progress_callback=progress_callback,
            )
        finally:
            _processing_active = False


def _do_batch(
    engine: Engine,
    scope: TenantScope,
    *,
    camera_id: Optional[int],
    reprocess: bool,
    progress_callback: Optional[Callable[[int, int, int], None]],
) -> dict:
    settings = get_settings()
    if not settings.clip_save_enabled:
        return {"total": 0, "processed": 0, "failed": 0, "saved_crops": 0}

    # BUG-056 — reset any rows stuck at ``processing`` from a previous
    # crashed run. Without this, a failed _do_extract that also
    # couldn't mark the row 'failed' (rare, but possible) would leave
    # the UI thinking the batch is still running. ``processing`` is a
    # transient state owned by a single in-flight thread, and we
    # already hold the module-level ``_processing_lock`` here, so
    # anything still flagged ``processing`` is necessarily stale.
    with engine.begin() as conn:
        stale = conn.execute(
            sa.update(_pc)
            .where(
                _pc.c.tenant_id == scope.tenant_id,
                _pc.c.face_crops_status == "processing",
            )
            .values(face_crops_status="failed")
        )
        if stale.rowcount and stale.rowcount > 0:
            logger.info(
                "face_crop.batch.stale_reset tenant=%s rows=%d",
                scope.tenant_id, stale.rowcount,
            )

    with engine.begin() as conn:
        q = (
            sa.select(_pc)
            .where(_pc.c.tenant_id == scope.tenant_id)
            .where(_pc.c.file_path.isnot(None))
        )
        if not reprocess:
            q = q.where(
                _pc.c.face_crops_status.in_(["pending", "failed"])
            )
        if camera_id is not None:
            q = q.where(_pc.c.camera_id == camera_id)
        q = q.order_by(_pc.c.created_at.asc())

        rows = conn.execute(q).all()

    total = len(rows)
    if total == 0:
        logger.info("face_crop.batch.no_clips tenant=%s", scope.tenant_id)
        return {"total": 0, "processed": 0, "failed": 0, "saved_crops": 0}

    logger.info(
        "face_crop.batch.starting tenant=%s clips=%d reprocess=%s camera=%s",
        scope.tenant_id, total, reprocess, camera_id,
    )

    processed = 0
    failed = 0
    saved_crops = 0

    for idx, row in enumerate(rows):
        if progress_callback:
            progress_callback(idx + 1, total, row.id)

        try:
            _mark_clip_status(engine, scope, row.id, "processing")

            clip_path = row.file_path
            if not clip_path:
                _mark_clip_status(engine, scope, row.id, "failed")
                failed += 1
                logger.warning(
                    "face_crop.batch.no_path clip=%s", row.id,
                )
                continue

            camera_id_val = row.camera_id
            start_dt = row.clip_start
            ts = start_dt.strftime("%Y-%m-%d_%H-%M-%S") if hasattr(start_dt, 'strftime') else str(start_dt)

            num_saved = _do_extract(
                engine, scope, camera_id_val, row.id, ts, clip_path,
            )

            _mark_clip_status(engine, scope, row.id, "processed")
            processed += 1
            saved_crops += num_saved

            logger.info(
                "face_crop.batch.processed clip=%s camera=%s crops=%d (%d/%d)",
                row.id, camera_id_val, num_saved, idx + 1, total,
            )

        except Exception as exc:
            logger.error(
                "face_crop.batch.failed clip=%s reason=%s",
                row.id, type(exc).__name__,
            )
            try:
                _mark_clip_status(engine, scope, row.id, "failed")
            except Exception:
                pass
            failed += 1

        if idx < total - 1:
            time.sleep(0.1)

    logger.info(
        "face_crop.batch.completed tenant=%s processed=%d failed=%d crops=%d",
        scope.tenant_id, processed, failed, saved_crops,
    )

    return {
        "total": total,
        "processed": processed,
        "failed": failed,
        "saved_crops": saved_crops,
    }


def get_clips_processing_status(
    engine: Engine, scope: TenantScope,
) -> dict:
    with engine.begin() as conn:
        rows = conn.execute(
            sa.select(
                _pc.c.face_crops_status,
                sa.func.count(_pc.c.id).label("cnt"),
            )
            .where(_pc.c.tenant_id == scope.tenant_id)
            .group_by(_pc.c.face_crops_status)
        ).all()

    counts = {r.face_crops_status: int(r.cnt) for r in rows}
    return {
        "pending": counts.get("pending", 0),
        "processing": counts.get("processing", 0),
        "processed": counts.get("processed", 0),
        "failed": counts.get("failed", 0),
        "total": sum(counts.values()),
        "is_processing": is_processing(),
    }
