"""Face detection + recognition wrapper.

P8 loaded InsightFace ``buffalo_l`` with detection only. P9 flips the
recognition module on so each detected face comes back with a
512-float-32 L2-normalised embedding — the matcher consumes these to
find the best-matching enrolled employee.

P28.5c: the analyzer now reads a ``DetectorConfig`` (mode +
``det_size`` + thresholds) sourced from
``tenant_settings.detection_config`` and delegates to the
``maugood.detection.detectors`` module that ships both
``insightface`` and ``yolo+face`` backends. The analyzer holds a
config snapshot that the worker hot-swaps via ``update_config`` —
``det_size`` change re-prepares InsightFace; ``mode`` change is
picked up on the next ``detect`` call.

We hide all of this behind the ``Analyzer`` protocol so tests can
swap in a ``StubAnalyzer`` without dragging in the 250 MB model.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Optional, Protocol

import numpy as np

from maugood.capture.tracker import Bbox
from maugood.detection import DetectorConfig
from maugood.detection import detect as detector_detect
from maugood.detection import detect_and_count as detector_detect_and_count
from maugood.detection import detect_persons as detector_detect_persons
from maugood.detection import quality_score as detector_quality_score

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Detection:
    """Single detected face."""

    bbox: Bbox
    det_score: float
    # L2-normalised 512-float-32 embedding from buffalo_l recognition.
    # Optional because tests + the on-demand preview don't need it.
    embedding: Optional[np.ndarray] = None


class Analyzer(Protocol):
    """What the capture worker needs from a detector + recognizer.

    ``detect`` must be thread-safe (workers call it from their own
    threads). The real InsightFace detector is safe after ``prepare()``.
    """

    def detect(self, frame_bgr) -> list[Detection]:  # type: ignore[no-untyped-def]
        ...

    def detect_and_count(  # type: ignore[no-untyped-def]
        self, frame_bgr
    ) -> "tuple[list[Detection], int]":
        """Run face detection and YOLO person-body detection in one pass.

        Returns ``(detections, person_count)`` where ``person_count``
        uses YOLO body detection regardless of the configured face-
        detection mode. Persons with their back to the camera produce a
        non-zero count even when InsightFace finds no face.

        This is the primary entry point for ``_analyzer_loop`` —
        replaces the old separate ``detect`` + ``detect_persons`` calls
        so YOLO never runs twice in the same cycle.
        """
        ...

    def detect_persons(self, frame_bgr) -> int:  # type: ignore[no-untyped-def]
        """Return the number of persons detected in the frame.

        Kept for backward compatibility. The main analyzer loop now uses
        ``detect_and_count`` instead to avoid running YOLO twice.
        """

    def embed_crop(self, crop_bgr) -> Optional[np.ndarray]:  # type: ignore[no-untyped-def]
        """Compute an embedding for a single face crop (already cropped).

        Used by the enrollment path — we read an encrypted reference
        photo, decrypt, decode, pass the whole image in, and take the
        first returned embedding. Returns ``None`` if no face is
        detected in the crop.
        """

    def update_config(self, config: DetectorConfig) -> None:  # type: ignore[no-untyped-def]
        """Hot-swap the detector knob bag. P28.5c — wired from the
        worker's reconcile loop. ``det_size`` change re-preps
        InsightFace; ``mode`` change activates on the next call.
        Stub analyzers can no-op."""


# --- Production analyzer (delegates to maugood.detection) -------------------


class InsightFaceAnalyzer:
    """Thin wrapper around ``maugood.detection.detect``.

    The class name is historical — pre-P28.5c this directly drove
    InsightFace. Post-P28.5c it routes through ``maugood.detection``,
    which dispatches on ``config.mode`` between ``insightface`` and
    ``yolo+face``. Both modes return the same dict shape; the
    ``Detection`` dataclass adaptation lives here.
    """

    def __init__(self, config: Optional[DetectorConfig] = None) -> None:
        self._lock = threading.Lock()
        self._config = config or DetectorConfig()

    def update_config(self, config: DetectorConfig) -> None:
        """Replace the runtime config snapshot. The next ``detect``
        call uses the new mode + det_size; ``maugood.detection``
        handles InsightFace re-prep when ``det_size`` changes."""

        with self._lock:
            self._config = config

    def _snapshot_config(self) -> DetectorConfig:
        with self._lock:
            return self._config

    def detect_persons(self, frame_bgr) -> int:  # type: ignore[no-untyped-def]
        """Return YOLO person count (kept for backward compat)."""
        cfg = self._snapshot_config()
        return detector_detect_persons(frame_bgr, cfg)

    def detect_and_count(  # type: ignore[no-untyped-def]
        self, frame_bgr
    ) -> "tuple[list[Detection], int]":
        """Face detection + YOLO person count in one pass.

        In ``yolo+face`` mode YOLO runs once and contributes both the
        person boxes (for face crops) and the raw person count (for the
        clip gate). In ``insightface`` mode InsightFace runs for face
        crops and YOLO runs separately for the person count — adding
        ~20-40 ms but ensuring clips keep recording even when faces are
        not visible (seated employees, back-to-camera, partial occlusion).
        """
        cfg = self._snapshot_config()
        raw_faces, person_count = detector_detect_and_count(frame_bgr, cfg)
        detections: list[Detection] = []
        for d in raw_faces:
            x1, y1, x2, y2 = d["bbox"]
            detections.append(
                Detection(
                    bbox=Bbox(
                        x=int(x1), y=int(y1),
                        w=max(0, int(x2 - x1)),
                        h=max(0, int(y2 - y1)),
                    ),
                    det_score=float(d.get("det_score", 1.0)),
                    embedding=d.get("embedding"),
                )
            )
        return detections, person_count

    def detect(self, frame_bgr) -> list[Detection]:  # type: ignore[no-untyped-def]
        cfg = self._snapshot_config()
        raw = detector_detect(frame_bgr, cfg)
        out: list[Detection] = []
        for d in raw:
            x1, y1, x2, y2 = d["bbox"]
            out.append(
                Detection(
                    bbox=Bbox(
                        x=int(x1), y=int(y1),
                        w=max(0, int(x2 - x1)),
                        h=max(0, int(y2 - y1)),
                    ),
                    det_score=float(d.get("det_score", 1.0)),
                    embedding=d.get("embedding"),
                )
            )
        return out

    def embed_crop(self, crop_bgr) -> Optional[np.ndarray]:  # type: ignore[no-untyped-def]
        cfg = self._snapshot_config()
        # Embedding extraction is always InsightFace-driven, regardless
        # of the configured ``mode`` for live capture — enrollment
        # photos are pre-framed single-person crops, so we don't need
        # the YOLO body box.
        emb_cfg = DetectorConfig(
            mode="insightface",
            det_size=cfg.det_size,
            min_det_score=cfg.min_det_score,
            min_face_pixels=cfg.min_face_pixels,
            yolo_conf=cfg.yolo_conf,
        )
        raw = detector_detect(crop_bgr, emb_cfg)
        if not raw:
            return None
        # Take the most confident face in the crop.
        raw = sorted(
            raw, key=lambda d: float(d.get("det_score", 0.0)), reverse=True
        )
        emb = raw[0].get("embedding")
        if emb is None:
            return None
        return np.asarray(emb, dtype=np.float32)


# Re-export the prototype's quality_score so callers don't need to
# import from two places.
quality_score = detector_quality_score


# --- Test-stub hook --------------------------------------------------------

_analyzer_factory: Optional[callable] = None  # type: ignore[type-arg]


def set_analyzer_factory(factory) -> None:  # type: ignore[no-untyped-def]
    """Override the default analyzer factory. Intended for tests."""

    global _analyzer_factory
    _analyzer_factory = factory


def clear_analyzer_factory() -> None:
    global _analyzer_factory
    _analyzer_factory = None


def get_analyzer() -> Analyzer:
    """Return the active analyzer (stub if set, otherwise InsightFace)."""

    if _analyzer_factory is not None:
        return _analyzer_factory()
    return InsightFaceAnalyzer()
