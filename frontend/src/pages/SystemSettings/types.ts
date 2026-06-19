// Wire types for /api/system/{detection,tracker,clip-encoding}-config —
// mirror maugood/system/router.py's Pydantic models.

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

// Phase C — clip encoding knobs (migration 0052).
export type X264Preset =
  | "ultrafast" | "superfast" | "veryfast" | "faster"
  | "fast" | "medium" | "slow" | "slower" | "veryslow";

export interface ClipEncodingConfig {
  chunk_duration_sec: number;
  video_crf: number;
  video_preset: X264Preset;
  resolution_max_height: number | null;
  keep_chunks_after_merge: boolean;
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

export const CLIP_ENCODING_DEFAULTS: ClipEncodingConfig = {
  chunk_duration_sec: 180,
  video_crf: 23,
  video_preset: "fast",
  resolution_max_height: null,
  keep_chunks_after_merge: false,
};

export const DET_SIZE_OPTIONS: number[] = [160, 224, 320, 480, 640];

// Curated x264 presets — fastest → slowest. Operators rarely need
// the extremes; the dropdown still surfaces the full set.
export const X264_PRESETS: readonly X264Preset[] = [
  "ultrafast", "superfast", "veryfast", "faster",
  "fast", "medium", "slow", "slower", "veryslow",
] as const;

// Allowed downscale heights. ``null`` keeps native resolution. The
// limited set mirrors the backend Pydantic enum: chunks at different
// resolutions cannot be ``ffmpeg -c copy`` concat-merged.
export const RESOLUTION_OPTIONS: readonly (number | null)[] = [
  null, 480, 720, 1080,
] as const;

// Clip processing use cases — manual reprocessors that run against saved
// clips. Sent / received on /api/system/clip-pipeline-config as a single
// ``{use_cases: string[]}`` payload (subset of uc1/uc2, may be empty).
export type ClipUseCase = "uc1" | "uc2";

export interface ClipPipelineConfig {
  use_cases: ClipUseCase[];
}

export const CLIP_USE_CASES: readonly ClipUseCase[] = ["uc1", "uc2"] as const;

export const CLIP_PIPELINE_DEFAULT: ClipPipelineConfig = {
  use_cases: [],
};

// RTSP reconnect config (migration 0085). Stored canonically as
// ``interval_seconds``; the UI presents value + unit (sec/min/hour) and
// converts. ``enabled=false`` → the worker makes no reconnect attempts.
export interface ReconnectConfig {
  enabled: boolean;
  interval_seconds: number;
}

export const RECONNECT_DEFAULTS: ReconnectConfig = {
  enabled: true,
  interval_seconds: 30,
};

// Server bounds (mirror maugood/system/router.py): 5 s … 24 h.
export const RECONNECT_INTERVAL_MIN_S = 5;
export const RECONNECT_INTERVAL_MAX_S = 86_400;

export type ReconnectUnit = "seconds" | "minutes" | "hours";

export const RECONNECT_UNIT_SECONDS: Record<ReconnectUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

// Split a canonical seconds value into the largest whole unit that
// divides it evenly, so 300 → {5, "minutes"} and 3600 → {1, "hours"}.
export function secondsToValueUnit(
  total: number,
): { value: number; unit: ReconnectUnit } {
  if (total > 0 && total % 3600 === 0) return { value: total / 3600, unit: "hours" };
  if (total > 0 && total % 60 === 0) return { value: total / 60, unit: "minutes" };
  return { value: total, unit: "seconds" };
}
