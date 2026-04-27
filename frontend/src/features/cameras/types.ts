// Wire types for /api/cameras — mirror hadir/cameras/schemas.py.
// ``rtsp_url`` is outbound-only (POST/PATCH bodies). Responses carry
// ``rtsp_host`` only.

// P28.5b: per-camera capture knob bag. Bounds match the backend
// CaptureConfig Pydantic model (max_faces 1-50, max_duration 5-600,
// quality 0.0-1.0). Defaults from prototype-reference.
export interface CaptureConfig {
  max_faces_per_event: number;
  max_event_duration_sec: number;
  min_face_quality_to_save: number;
  save_full_frames: boolean;
}

// ``min_face_quality_to_save`` is a deprecated runtime no-op (kept on
// the type for back-compat with the migration-0027 JSONB shape; the
// drawer no longer surfaces a slider for it). See
// docs/phases/fix-detector-mode-preflight.md Layer 2.
export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  max_faces_per_event: 10,
  max_event_duration_sec: 60,
  min_face_quality_to_save: 0.0,
  save_full_frames: false,
};

export interface Camera {
  id: number;
  name: string;
  location: string;
  rtsp_host: string;
  // P28.5b: ``enabled`` was split into ``worker_enabled`` (capture
  // pipeline on/off) + ``display_enabled`` (Live Capture surfacing).
  worker_enabled: boolean;
  display_enabled: boolean;
  // Migration 0033 — third operational lever. When false, the worker
  // keeps reading frames + driving live preview but the analyzer
  // skips the expensive detect() call and writes no detection_events.
  detection_enabled: boolean;
  capture_config: CaptureConfig;
  created_at: string;
  last_seen_at: string | null;
  images_captured_24h: number;
  // P28.8 — auto-detected by the worker on first RTSP read.
  detected_resolution_w: number | null;
  detected_resolution_h: number | null;
  detected_fps: number | null;
  detected_codec: string | null;
  detected_at: string | null;
  // Manual fields edited by Admin.
  brand: string | null;
  model: string | null;
  mount_location: string | null;
}

export interface CameraListResponse {
  items: Camera[];
}

export interface CameraCreateInput {
  name: string;
  location: string;
  rtsp_url: string;
  worker_enabled: boolean;
  display_enabled: boolean;
  detection_enabled: boolean;
  capture_config: CaptureConfig;
}

export interface CameraPatchInput {
  name?: string;
  location?: string;
  rtsp_url?: string;
  worker_enabled?: boolean;
  display_enabled?: boolean;
  detection_enabled?: boolean;
  capture_config?: CaptureConfig;
}
