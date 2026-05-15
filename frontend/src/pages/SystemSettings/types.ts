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

// Migration 0059 — live identification toggle. Sent / received on
// /api/system/live-matching as a single ``{enabled: bool}`` payload.
// Default is FALSE since migration 0060 — operators explicitly opt in.
export interface LiveMatchingConfig {
  enabled: boolean;
}

export const LIVE_MATCHING_DEFAULT: LiveMatchingConfig = {
  enabled: false,
};
