"""Face detection wrapper.

Pilot uses InsightFace ``buffalo_l`` with only the detection module
loaded — embeddings wait for P9. The model files auto-download to
``~/.insightface/models`` on first use; docker-compose mounts a named
volume there so the download is a one-time cost across container
restarts.

We hide InsightFace behind an ``Analyzer`` protocol so tests can swap
in a ``StubAnalyzer`` without dragging in the 250 MB model.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Optional, Protocol

from hadir.capture.tracker import Bbox

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Detection:
    """Single detected face."""

    bbox: Bbox
    det_score: float


class Analyzer(Protocol):
    """What the capture worker needs from a detector.

    ``detect`` must be thread-safe (workers call it from their own
    threads). The real InsightFace detector is safe after ``prepare()``.
    """

    def detect(self, frame_bgr) -> list[Detection]:  # type: ignore[no-untyped-def]
        ...


# --- Production InsightFace analyzer ---------------------------------------

_insightface_lock = threading.Lock()
_insightface_app = None  # lazy, shared across workers


def _get_insightface_app():  # type: ignore[no-untyped-def]
    """Build (or return the cached) ``FaceAnalysis`` instance.

    Detection only — we pass ``allowed_modules=['detection']`` so the
    recognition (embedding) model never loads. P9 will reconfigure this
    to include recognition.
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
            allowed_modules=["detection"],
            providers=["CPUExecutionProvider"],
        )
        # det_size: 640x640 is InsightFace's standard; adequate for LAN
        # cameras at 720p–1080p. ctx_id=-1 forces CPU.
        app.prepare(ctx_id=-1, det_size=(640, 640))
        _insightface_app = app
        logger.info("InsightFace buffalo_l detection ready (CPU)")
        return app


class InsightFaceAnalyzer:
    """Thin wrapper around ``insightface.app.FaceAnalysis``."""

    def detect(self, frame_bgr) -> list[Detection]:  # type: ignore[no-untyped-def]
        app = _get_insightface_app()
        faces = app.get(frame_bgr)
        out: list[Detection] = []
        for f in faces:
            # ``bbox`` is a numpy array [x1, y1, x2, y2] in image coords.
            x1, y1, x2, y2 = f.bbox.astype(int).tolist()
            x = max(0, x1)
            y = max(0, y1)
            w = max(0, x2 - x1)
            h = max(0, y2 - y1)
            out.append(Detection(bbox=Bbox(x=x, y=y, w=w, h=h), det_score=float(f.det_score)))
        return out


# --- Test-stub hook --------------------------------------------------------
# The capture manager consults ``get_analyzer()`` when spawning a worker.
# Pytest replaces the factory with a stub so the suite never loads
# InsightFace.

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
