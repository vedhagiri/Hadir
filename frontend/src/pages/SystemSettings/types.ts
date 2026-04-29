// Wire types for /api/system/{detection,tracker}-config — mirror
// maugood/system/router.py's Pydantic models.

export type DetectorMode = "insightface" | "yolo+face";

export interface DetectionConfig {
  mode: DetectorMode;
  det_size: number;
  min_det_score: number;
  min_face_pixels: number;
  yolo_conf: number;
  show_body_boxes: boolean;
}

export interface TrackerConfig {
  iou_threshold: number;
  timeout_sec: number;
  max_duration_sec: number;
}

export const DETECTION_DEFAULTS: DetectionConfig = {
  mode: "insightface",
  det_size: 320,
  min_det_score: 0.5,
  min_face_pixels: 3600,
  yolo_conf: 0.35,
  show_body_boxes: false,
};

export const TRACKER_DEFAULTS: TrackerConfig = {
  iou_threshold: 0.3,
  timeout_sec: 2.0,
  max_duration_sec: 60.0,
};

export const DET_SIZE_OPTIONS: number[] = [160, 224, 320, 480, 640];
