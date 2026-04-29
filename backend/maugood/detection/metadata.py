"""Per-event detector + recognition model metadata.

Captures, at the point ``emit_detection_event`` writes a row, *which*
models produced the embedding and *which* package versions were running.
Stored on ``detection_events.detection_metadata`` (JSONB, migration
0032).

The shape is intentionally small + flat so a future v1.x extension
(e.g. pose_score once kps land on ``Detection``) can add fields
without breaking existing readers. Numeric fields stay numeric;
string fields stay strings; no nested objects.

Why per row, not per worker boot
--------------------------------

The DetectorConfig changes when the operator edits ``System Settings →
Detection`` (mode, det_size, min_det_score). The ``CaptureWorker``
hot-reloads via ``analyzer.update_config`` rather than restart. So a
single worker can produce events with two different configs in the
same minute. Per-row capture is the only way to record the truth at
event time; a per-worker snapshot would be wrong after the first
hot-reload.

Package versions don't change at runtime — they're frozen at image
build. Reading them per call is cheap (importlib.metadata caches) and
keeps the helper a single function.
"""

from __future__ import annotations

import logging
from importlib.metadata import PackageNotFoundError, version as _pkg_version
from typing import Any, Optional

from maugood.detection.detectors import DetectorConfig

logger = logging.getLogger(__name__)


# The ``buffalo_l`` model pack we ship is fixed by ``maugood.detection.detectors``
# (and the InsightFace volume mount). If a future phase swaps the pack,
# update both places.
_DETECTOR_PACK = "buffalo_l"
# The recognition head inside ``buffalo_l`` that produces the
# 512-float-32 embedding the matcher uses. Fixed by the model pack.
_RECOGNITION_MODEL = "w600k_r50"


def _safe_version(pkg: str) -> Optional[str]:
    try:
        return _pkg_version(pkg)
    except PackageNotFoundError:
        return None


def current_metadata(
    config: DetectorConfig, *, match_threshold: Optional[float] = None
) -> dict[str, Any]:
    """Return the metadata dict for an event captured under ``config``.

    ``match_threshold`` is the matcher's hard threshold at the time of
    the event — included so a future re-tune is auditable (a row's
    employee_id is None either because no embedding cleared the
    threshold, or because the threshold itself was tighter than today's
    setting).
    """

    out: dict[str, Any] = {
        "detector_mode": config.mode,
        "detector_pack": _DETECTOR_PACK,
        "recognition_model": _RECOGNITION_MODEL,
        "det_size": int(config.det_size),
        "min_det_score": float(config.min_det_score),
    }
    insightface_v = _safe_version("insightface")
    if insightface_v is not None:
        out["insightface_version"] = insightface_v
    onnxruntime_v = _safe_version("onnxruntime")
    if onnxruntime_v is not None:
        out["onnxruntime_version"] = onnxruntime_v
    if config.mode == "yolo+face":
        ultralytics_v = _safe_version("ultralytics")
        if ultralytics_v is not None:
            out["ultralytics_version"] = ultralytics_v
    if match_threshold is not None:
        out["match_threshold"] = float(match_threshold)
    return out
