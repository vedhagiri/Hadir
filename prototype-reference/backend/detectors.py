"""
detectors.py — pluggable detector backends.

Two modes:
  "insightface"   Full-frame face detection + embedding (default, recommended
                  for identification work).
  "yolo+face"     YOLO person detection, then InsightFace inside each body
                  box. Useful when scenes have many non-person regions where
                  we want to skip face detection.

Both modes return the same dict structure so capture.py doesn't care which
is active:
  [
    {
      "bbox": (x1, y1, x2, y2),     # int, clamped to frame
      "det_score": float,
      "embedding": np.ndarray(512,) or None,    # normalized, dtype=float32
      "face_width": int,
      "face_height": int,
      "pose_score": float,          # 0..1, higher = more frontal
    },
    ...
  ]

Thread safety: detectors share a lock so multiple camera workers don't
trample each other when calling the model. This matches the design we
used in the multi-camera face-attendance project.
"""

import threading
import numpy as np
from dataclasses import dataclass
from typing import Literal, Optional

# Module-level lock — all detection calls serialized across cameras.
# On CPU this is faster than parallel calls (which just thrash L1/L2).
_detect_lock = threading.Lock()

_face_app = None     # InsightFace app
_face_app_det_size = None  # tracks what size the current instance was prepared with
_yolo_model = None   # Ultralytics YOLO

DetectorMode = Literal["insightface", "yolo+face"]

# Default detector input size. 320x320 is ~2-3x faster than 640x640 on CPU and
# still detects faces down to ~30px. For 720p/1080p streams with faces filling
# a reasonable portion of the frame this is plenty.
DEFAULT_DET_SIZE = 320


def _load_face_app(det_size: int = DEFAULT_DET_SIZE):
    """Load or re-prepare InsightFace. Re-prep if det_size changed."""
    global _face_app, _face_app_det_size
    if _face_app is None:
        from insightface.app import FaceAnalysis
        print(f"[detectors] loading InsightFace (buffalo_l) at det_size={det_size}...")
        _face_app = FaceAnalysis(name="buffalo_l",
                                 providers=["CPUExecutionProvider"])
        _face_app.prepare(ctx_id=0, det_size=(det_size, det_size))
        _face_app_det_size = det_size
        print("[detectors] InsightFace ready.")
    elif _face_app_det_size != det_size:
        print(f"[detectors] re-preparing InsightFace at det_size={det_size}...")
        _face_app.prepare(ctx_id=0, det_size=(det_size, det_size))
        _face_app_det_size = det_size
    return _face_app


def _load_yolo():
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO
        print("[detectors] loading YOLO (yolov8n)...")
        _yolo_model = YOLO("yolov8n.pt")
        print("[detectors] YOLO ready.")
    return _yolo_model


def _pose_score_from_landmarks(kps, face_width: int) -> float:
    """
    Rough frontal-ness score from 5-point landmarks.
    Returns 0..1 where 1 = perfectly frontal, 0 = side/profile.

    Logic: compare distance from nose (kps[2]) to each eye (kps[0], kps[1]).
    On a frontal face these distances are similar. On a profile, one is
    much smaller than the other.
    """
    if kps is None or len(kps) < 3 or face_width <= 0:
        return 0.5  # unknown — assume middling
    left_eye, right_eye, nose = kps[0], kps[1], kps[2]
    d_left = np.linalg.norm(nose - left_eye)
    d_right = np.linalg.norm(nose - right_eye)
    if max(d_left, d_right) == 0:
        return 0.0
    symmetry = min(d_left, d_right) / max(d_left, d_right)  # 0..1
    return float(symmetry)


def _face_to_dict(face, frame_shape) -> Optional[dict]:
    """Convert an InsightFace face object to our common dict format."""
    H, W = frame_shape[:2]
    x1, y1, x2, y2 = [int(v) for v in face.bbox]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(W, x2), min(H, y2)
    if x2 <= x1 or y2 <= y1:
        return None
    fw, fh = x2 - x1, y2 - y1
    pose = _pose_score_from_landmarks(getattr(face, "kps", None), fw)
    emb = getattr(face, "normed_embedding", None)
    if emb is not None:
        emb = np.asarray(emb, dtype=np.float32)
    return {
        "bbox": (x1, y1, x2, y2),
        "det_score": float(getattr(face, "det_score", 1.0)),
        "embedding": emb,
        "face_width": fw,
        "face_height": fh,
        "pose_score": pose,
    }


@dataclass
class DetectorConfig:
    mode: DetectorMode = "insightface"
    min_det_score: float = 0.5
    min_face_pixels: int = 60 * 60
    # Detector input size. Lower = faster but misses very small faces.
    det_size: int = DEFAULT_DET_SIZE
    # YOLO+face mode only
    yolo_conf: float = 0.35


def detect(frame, config: DetectorConfig) -> list[dict]:
    """Run the currently configured detector. Returns list of face dicts."""
    if config.mode == "yolo+face":
        return _detect_yolo_face(frame, config)
    return _detect_insightface(frame, config)


def _detect_insightface(frame, config: DetectorConfig) -> list[dict]:
    app = _load_face_app(config.det_size)
    with _detect_lock:
        raw = app.get(frame)
    out = []
    for f in raw:
        if float(getattr(f, "det_score", 1.0)) < config.min_det_score:
            continue
        d = _face_to_dict(f, frame.shape)
        if d is None:
            continue
        if d["face_width"] * d["face_height"] < config.min_face_pixels:
            continue
        out.append(d)
    return out


def _detect_yolo_face(frame, config: DetectorConfig) -> list[dict]:
    """Find person boxes with YOLO, then run InsightFace inside each box."""
    yolo = _load_yolo()
    app = _load_face_app(config.det_size)
    H, W = frame.shape[:2]

    with _detect_lock:
        # classes=[0] restricts YOLO to 'person'
        result = yolo(frame, classes=[0], imgsz=480,
                      conf=config.yolo_conf, verbose=False)[0]

    out = []
    for box in result.boxes:
        bx1, by1, bx2, by2 = [int(v) for v in box.xyxy[0]]
        # Slight padding so we catch faces near box edges
        pad = 10
        bx1 = max(0, bx1 - pad); by1 = max(0, by1 - pad)
        bx2 = min(W, bx2 + pad); by2 = min(H, by2 + pad)
        if bx2 <= bx1 or by2 <= by1:
            continue
        crop = frame[by1:by2, bx1:bx2]

        with _detect_lock:
            faces = app.get(crop)

        for f in faces:
            if float(getattr(f, "det_score", 1.0)) < config.min_det_score:
                continue
            # Face coords are relative to crop — add back offset
            fx1, fy1, fx2, fy2 = [int(v) for v in f.bbox]
            abs_bbox = (bx1 + fx1, by1 + fy1, bx1 + fx2, by1 + fy2)
            fw = abs_bbox[2] - abs_bbox[0]
            fh = abs_bbox[3] - abs_bbox[1]
            if fw <= 0 or fh <= 0 or fw * fh < config.min_face_pixels:
                continue
            kps = getattr(f, "kps", None)
            if kps is not None:
                kps = kps + np.array([bx1, by1], dtype=np.float32)
            emb = getattr(f, "normed_embedding", None)
            if emb is not None:
                emb = np.asarray(emb, dtype=np.float32)
            out.append({
                "bbox": abs_bbox,
                "det_score": float(f.det_score),
                "embedding": emb,
                "face_width": fw,
                "face_height": fh,
                "pose_score": _pose_score_from_landmarks(kps, fw),
            })
    return out


def quality_score(face: dict) -> float:
    """
    Composite score used to rank faces within an event.
    Bigger face + frontal pose + high detector confidence = higher score.

    Face area dominates because a 200x200 face has far more information
    than a 60x60 face regardless of other factors. Pose and det_score
    are tiebreakers.
    """
    area = face["face_width"] * face["face_height"]
    # Normalize area to roughly 0..1 around typical face sizes
    area_norm = min(area / (200 * 200), 1.0)
    return (
        0.6 * area_norm +
        0.25 * face["pose_score"] +
        0.15 * face["det_score"]
    )