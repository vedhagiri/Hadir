"""Pluggable detector backends (P28.5c).

Ported from ``prototype-reference/backend/detectors.py`` with v1.0
conventions:

* Module-level ``_detect_lock`` serialises detection across cameras
  (CPU-bound; serial is faster than parallel because it doesn't
  thrash L1/L2 caches on a single CPU).
* Both modes (``insightface`` and ``yolo+face``) return the same
  dict shape so the analyzer + tracker + matcher don't care which
  is active. The only adapter line is in ``maugood/capture/analyzer.py``
  where dicts get converted to ``Detection`` dataclasses for the
  rest of the pipeline.
* ``_load_face_app(det_size)`` re-prepares InsightFace when the size
  changes — the load-bearing hot-reload mechanic.
* ``quality_score`` keeps the prototype's tested 0.6 / 0.25 / 0.15
  weights (face area / pose symmetry / det score). The 0.35 default
  threshold downstream depends on these weights.

YOLO model resolution: ``set_yolo_model_dir(Path)`` overrides the
default lookup path. Production deploys point this at
``/data/models/yolov8n.pt`` (a named volume) so the first-use
ultralytics download survives container restarts. Documented in
``docs/deploy-production.md``.
"""

from __future__ import annotations

import collections
import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

import numpy as np


logger = logging.getLogger(__name__)


DetectorMode = Literal["insightface", "yolo+face"]


class TimedLock:
    """``threading.Lock`` with rolling held-time stats for contention reporting.

    P28.8: every ``detect`` call across every camera worker funnels
    through this single lock. Recording how long the lock has been
    held in the last 60 s tells the Super-Admin System page exactly
    how saturated the CPU detector is — useful for sizing capacity
    before adding cameras.

    The ``with`` protocol matches ``threading.Lock`` so caller code
    (``with _detect_lock:``) doesn't change. Held intervals are
    appended to a ``deque(maxlen=600)`` — 600 entries is comfortably
    >> 60 s of work even at unrealistically high call rates.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._held_times: "collections.deque[tuple[float, float]]" = (
            collections.deque(maxlen=600)
        )
        # Per-thread acquire timestamp so re-entrant ``__enter__`` from
        # different threads doesn't trample one another. Mirrors the
        # standard Lock contract (non-recursive — same thread can't
        # acquire twice).
        self._t_acquired_local = threading.local()

    def __enter__(self) -> "TimedLock":
        self._lock.acquire()
        self._t_acquired_local.t = time.time()
        return self

    def __exit__(self, *exc: Any) -> None:  # type: ignore[override]
        t = getattr(self._t_acquired_local, "t", None)
        if t is not None:
            held = time.time() - t
            self._held_times.append((t, held))
        self._lock.release()

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        """Compatibility shim for callers that don't use the context
        manager. The release timestamp is recorded only when ``release``
        is paired with this thread's prior ``acquire``."""

        ok = self._lock.acquire(blocking, timeout)
        if ok:
            self._t_acquired_local.t = time.time()
        return ok

    def release(self) -> None:
        t = getattr(self._t_acquired_local, "t", None)
        if t is not None:
            held = time.time() - t
            self._held_times.append((t, held))
        self._lock.release()

    def contention_pct_60s(self) -> float:
        """Return the percentage of the last 60 s the lock was held.

        Caps at 100. With one detector worker on the box, a value
        above ~80 % suggests the detector is the bottleneck — adding
        more cameras won't help and may make every camera's analyzer
        starve. Below ~50 % the box has headroom.
        """

        cutoff = time.time() - 60
        relevant = [(t, h) for (t, h) in self._held_times if t >= cutoff]
        if not relevant:
            return 0.0
        total_held = sum(h for _, h in relevant)
        return min(100.0, total_held / 60.0 * 100)


# Module-level lock — every ``detect`` call across every camera worker
# serialises through here. On CPU this is faster than parallel calls
# (which thrash L1/L2 cache and slow each other down). Port verbatim
# from the prototype, now with held-time instrumentation (P28.8).
_detect_lock = TimedLock()

_face_app: Any = None
_face_app_det_size: Optional[int] = None
_yolo_model: Any = None
_yolo_model_dir: Path = Path("/data/models")


# Default detector input size. 320×320 is ~2-3× faster than 640×640
# on CPU and still detects faces down to ~30px on a 1080p frame.
DEFAULT_DET_SIZE = 320


@dataclass
class DetectorConfig:
    """Runtime knob bag for ``detect``. Sourced from
    ``tenant_settings.detection_config`` (v1.0 P28.5c).
    """

    mode: DetectorMode = "insightface"
    det_size: int = DEFAULT_DET_SIZE
    min_det_score: float = 0.5
    # Minimum face area in pixels (face_w * face_h). The UI surfaces
    # this as a 1-D dimension that gets squared on the way in.
    min_face_pixels: int = 60 * 60
    # YOLO+face mode only.
    yolo_conf: float = 0.35

    @classmethod
    def from_dict(cls, raw: Optional[dict]) -> "DetectorConfig":
        """Build from the JSONB blob stored in ``tenant_settings``.

        Defensive against missing keys (forward-compat: a future phase
        adding a new knob still loads cleanly with old values) and
        against unknown keys (silently ignored).
        """

        raw = raw or {}
        return cls(
            mode=str(raw.get("mode", cls.mode)),  # type: ignore[arg-type]
            det_size=int(raw.get("det_size", cls.det_size)),
            min_det_score=float(raw.get("min_det_score", cls.min_det_score)),
            min_face_pixels=int(
                raw.get("min_face_pixels", cls.min_face_pixels)
            ),
            yolo_conf=float(raw.get("yolo_conf", cls.yolo_conf)),
        )


def set_yolo_model_dir(d: Path) -> None:
    """Override where ``yolov8n.pt`` is resolved from.

    Production sets this to ``/data/models/`` so the first-use
    download lands on a persistent named volume instead of the
    container's ephemeral writable layer.
    """

    global _yolo_model_dir
    _yolo_model_dir = Path(d)


# --- InsightFace ----------------------------------------------------------


def _load_face_app(det_size: int = DEFAULT_DET_SIZE):  # type: ignore[no-untyped-def]
    """Load (or re-prepare) InsightFace. Re-preps when ``det_size``
    changes — the hot-reload pivot. Caller must hold ``_detect_lock``
    or be on a single-threaded init path.
    """

    global _face_app, _face_app_det_size
    if _face_app is None:
        from insightface.app import FaceAnalysis  # noqa: PLC0415

        logger.info(
            "InsightFace: loading buffalo_l at det_size=%d (CPU)", det_size
        )
        # No allowed_modules → detection AND recognition both load,
        # so ``face.normed_embedding`` is populated for the matcher.
        app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        # ctx_id=-1 = CPU.
        app.prepare(ctx_id=-1, det_size=(det_size, det_size))
        _face_app = app
        _face_app_det_size = det_size
        logger.info("InsightFace ready (det_size=%d)", det_size)
        return _face_app
    if _face_app_det_size != det_size:
        logger.info(
            "InsightFace: re-preparing at det_size=%d (was %d)",
            det_size, _face_app_det_size,
        )
        _face_app.prepare(ctx_id=-1, det_size=(det_size, det_size))
        _face_app_det_size = det_size
    return _face_app


def is_mode_available(mode: DetectorMode) -> bool:
    """Pre-flight check used by the System Settings PUT path.

    Returns True iff the runtime image carries the deps a given
    detector mode needs. ``insightface`` is mandatory and always
    available (the package ships in ``pyproject.toml``); ``yolo+face``
    additionally requires ``ultralytics``, which is optional. An
    operator must not be allowed to save a mode that would crash the
    analyzer thread on every cycle — ``put_detection_config`` calls
    this and returns 400 when the answer is False.
    """

    if mode == "insightface":
        return True
    if mode == "yolo+face":
        if _yolo_model is not None:
            return True
        from importlib.util import find_spec  # noqa: PLC0415

        return find_spec("ultralytics") is not None
    return False


def _load_yolo():  # type: ignore[no-untyped-def]
    """Load (or return cached) Ultralytics YOLOv8n. First-use
    download from ultralytics; thereafter served from the model dir.

    The model file (``yolov8n.pt``) is small (~6 MB) but the
    ultralytics import + load takes a few seconds on first call.
    Port verbatim from the prototype's ``_load_yolo``.
    """

    global _yolo_model
    if _yolo_model is not None:
        return _yolo_model
    from ultralytics import YOLO  # noqa: PLC0415

    candidate = _yolo_model_dir / "yolov8n.pt"
    if candidate.exists():
        logger.info("YOLO: loading from %s", candidate)
        _yolo_model = YOLO(str(candidate))
    else:
        # Ultralytics will download the weights on first use; the
        # default cache is ``~/.cache/Ultralytics`` inside the
        # container. Production deploys should pre-stage the file at
        # ``/data/models/yolov8n.pt`` via ``set_yolo_model_dir`` so
        # it survives image rebuilds.
        logger.info(
            "YOLO: yolov8n.pt not staged at %s — first-use download "
            "from ultralytics; subsequent loads use the cache",
            candidate,
        )
        _yolo_model = YOLO("yolov8n.pt")
    logger.info("YOLO ready")
    return _yolo_model


# --- Helpers --------------------------------------------------------------


def _pose_score_from_landmarks(kps, face_width: int) -> float:
    """Frontal-ness score from 5-point landmarks. 1.0 = perfectly
    frontal, 0.0 = side profile. Compares nose→left-eye and
    nose→right-eye distances; symmetric on a frontal face.

    Returns 0.5 (unknown / middling) when landmarks are missing — a
    detection without kps shouldn't be penalised heavily.
    """

    if kps is None or len(kps) < 3 or face_width <= 0:
        return 0.5
    left_eye, right_eye, nose = kps[0], kps[1], kps[2]
    d_left = float(np.linalg.norm(nose - left_eye))
    d_right = float(np.linalg.norm(nose - right_eye))
    if max(d_left, d_right) == 0:
        return 0.0
    return min(d_left, d_right) / max(d_left, d_right)


def _face_to_dict(face, frame_shape) -> Optional[dict]:  # type: ignore[no-untyped-def]
    """Convert one InsightFace ``Face`` object to our common dict
    shape. Returns None if the bbox clamps to zero pixels.
    """

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


# --- Public detect() ------------------------------------------------------


def detect(frame_bgr, config: DetectorConfig) -> list[dict]:  # type: ignore[no-untyped-def]
    """Run the configured detector. Returns a list of detection
    dicts; the analyzer adapts these to ``Detection`` dataclasses
    downstream.

    Thread-safe: every call funnels through ``_detect_lock`` so two
    camera workers never reach into the model concurrently.
    """

    if config.mode == "yolo+face":
        return _detect_yolo_face(frame_bgr, config)
    return _detect_insightface(frame_bgr, config)


def _detect_insightface(frame_bgr, config: DetectorConfig) -> list[dict]:  # type: ignore[no-untyped-def]
    with _detect_lock:
        app = _load_face_app(config.det_size)
        raw = app.get(frame_bgr)
    out: list[dict] = []
    for f in raw:
        if float(getattr(f, "det_score", 1.0)) < config.min_det_score:
            continue
        d = _face_to_dict(f, frame_bgr.shape)
        if d is None:
            continue
        if d["face_width"] * d["face_height"] < config.min_face_pixels:
            continue
        out.append(d)
    return out


def _detect_yolo_face(frame_bgr, config: DetectorConfig) -> list[dict]:  # type: ignore[no-untyped-def]
    """YOLO finds person boxes; InsightFace runs inside each box.

    For high-traffic / outdoor cameras where most of the frame is
    background, this is faster than full-frame InsightFace at the
    cost of one extra YOLO pass per analyzer cycle. Port verbatim
    from the prototype.
    """

    H, W = frame_bgr.shape[:2]

    with _detect_lock:
        yolo = _load_yolo()
        app = _load_face_app(config.det_size)
        # classes=[0] restricts YOLO to "person".
        result = yolo(
            frame_bgr,
            classes=[0],
            imgsz=480,
            conf=config.yolo_conf,
            verbose=False,
        )[0]

    out: list[dict] = []
    for box in result.boxes:
        bx1, by1, bx2, by2 = [int(v) for v in box.xyxy[0]]
        # Slight padding so we catch faces at the body-box edges.
        pad = 10
        bx1 = max(0, bx1 - pad)
        by1 = max(0, by1 - pad)
        bx2 = min(W, bx2 + pad)
        by2 = min(H, by2 + pad)
        if bx2 <= bx1 or by2 <= by1:
            continue
        crop = frame_bgr[by1:by2, bx1:bx2]
        if getattr(crop, "size", 0) == 0:
            continue
        with _detect_lock:
            faces = app.get(crop)

        for f in faces:
            if float(getattr(f, "det_score", 1.0)) < config.min_det_score:
                continue
            # Face coords are relative to the body-box crop — translate
            # back into frame coordinates.
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
    """Composite quality score. Bigger face + more frontal pose +
    higher detector confidence = higher score. Used to rank faces
    within an event for top-N keep logic (see capture/events.py).

    Weights (face area 60% / pose 25% / det score 15%) are tuned by
    the prototype against real walk-past footage. Re-balance only
    after re-running the threshold tuning study.
    """

    area = max(0, int(face.get("face_width", 0))) * max(
        0, int(face.get("face_height", 0))
    )
    area_norm = min(area / (200 * 200), 1.0)
    return (
        0.6 * area_norm
        + 0.25 * float(face.get("pose_score", 0.5))
        + 0.15 * float(face.get("det_score", 1.0))
    )


# --- Test hook ------------------------------------------------------------


def reset_for_tests() -> None:
    """Wipe cached model state. Called by the test harness so a
    test setting ``mode=yolo+face`` doesn't bleed YOLO state into the
    next test.
    """

    global _face_app, _face_app_det_size, _yolo_model
    _face_app = None
    _face_app_det_size = None
    _yolo_model = None
