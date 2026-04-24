"""Face detection + recognition wrapper.

P8 loaded InsightFace ``buffalo_l`` with detection only. P9 flips the
recognition module on so each detected face comes back with a
512-float-32 L2-normalised embedding — the matcher consumes these to
find the best-matching enrolled employee.

We hide InsightFace behind an ``Analyzer`` protocol so tests can swap
in a ``StubAnalyzer`` without dragging in the 250 MB model.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Optional, Protocol

import numpy as np

from hadir.capture.tracker import Bbox

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

    def embed_crop(self, crop_bgr) -> Optional[np.ndarray]:  # type: ignore[no-untyped-def]
        """Compute an embedding for a single face crop (already cropped).

        Used by the enrollment path — we read an encrypted reference
        photo, decrypt, decode, pass the whole image in, and take the
        first returned embedding. Returns ``None`` if no face is
        detected in the crop.
        """


# --- Production InsightFace analyzer ---------------------------------------

_insightface_lock = threading.Lock()
_insightface_app = None  # lazy, shared across workers + enrollment


def _get_insightface_app():  # type: ignore[no-untyped-def]
    """Build (or return the cached) ``FaceAnalysis`` instance.

    Detection **and** recognition — we drop the P8 ``allowed_modules``
    restriction so ``face.normed_embedding`` is populated on every hit.
    Model files download once to ``/root/.insightface`` (a named volume)
    so restarts don't pay the 250 MB cost.
    """

    global _insightface_app
    with _insightface_lock:
        if _insightface_app is not None:
            return _insightface_app

        # Lazy import so environments without the wheel (tests that stub
        # the analyzer) don't trigger the model download.
        from insightface.app import FaceAnalysis  # noqa: PLC0415

        app = FaceAnalysis(
            name="buffalo_l",
            # No allowed_modules → detection + recognition both loaded.
            providers=["CPUExecutionProvider"],
        )
        # det_size: 640x640 is InsightFace's standard; ctx_id=-1 = CPU.
        app.prepare(ctx_id=-1, det_size=(640, 640))
        _insightface_app = app
        logger.info("InsightFace buffalo_l detection+recognition ready (CPU)")
        return app


class InsightFaceAnalyzer:
    """Thin wrapper around ``insightface.app.FaceAnalysis``."""

    def detect(self, frame_bgr) -> list[Detection]:  # type: ignore[no-untyped-def]
        app = _get_insightface_app()
        faces = app.get(frame_bgr)
        out: list[Detection] = []
        for f in faces:
            x1, y1, x2, y2 = f.bbox.astype(int).tolist()
            x = max(0, x1)
            y = max(0, y1)
            w = max(0, x2 - x1)
            h = max(0, y2 - y1)
            # ``normed_embedding`` is produced by the recognition head and
            # is already L2-normalised to unit length. Fall back to None
            # defensively in case a future InsightFace version changes the
            # attribute layout.
            emb = getattr(f, "normed_embedding", None)
            if emb is not None:
                emb = np.asarray(emb, dtype=np.float32)
            out.append(
                Detection(
                    bbox=Bbox(x=x, y=y, w=w, h=h),
                    det_score=float(f.det_score),
                    embedding=emb,
                )
            )
        return out

    def embed_crop(self, crop_bgr) -> Optional[np.ndarray]:  # type: ignore[no-untyped-def]
        faces = self.detect(crop_bgr)
        # Take the most confident face in the crop. Reference photos are
        # framed on a single person so this is robust in practice.
        if not faces:
            return None
        faces = sorted(faces, key=lambda f: f.det_score, reverse=True)
        return faces[0].embedding


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
