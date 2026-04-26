"""Detection module (P28.5c).

Ported from ``prototype-reference/backend/detectors.py``. Two detector
modes (``insightface`` and ``yolo+face``) share a common dict shape so
the analyzer + matcher don't care which is active.

Public surface:

* ``DetectorConfig`` — the runtime knob bag (mode, det_size,
  thresholds). Driven by ``tenant_settings.detection_config``.
* ``detect(frame_bgr, config) -> list[DetectionDict]`` — the
  detection entry point. Both modes return the same dict shape.
* ``quality_score(face_dict) -> float`` — composite quality used to
  rank detections within an event (face area + pose + det score).
* ``set_yolo_model_dir(Path)`` — override where ``yolov8n.pt`` is
  resolved from. Production points it at ``/data/models/yolov8n.pt``.
"""

from hadir.detection.detectors import (
    DEFAULT_DET_SIZE,
    DetectorConfig,
    DetectorMode,
    detect,
    quality_score,
    set_yolo_model_dir,
)

__all__ = [
    "DEFAULT_DET_SIZE",
    "DetectorConfig",
    "DetectorMode",
    "detect",
    "quality_score",
    "set_yolo_model_dir",
]
