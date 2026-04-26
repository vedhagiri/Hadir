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

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  max_faces_per_event: 10,
  max_event_duration_sec: 60,
  min_face_quality_to_save: 0.35,
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
  capture_config: CaptureConfig;
  created_at: string;
  last_seen_at: string | null;
  images_captured_24h: number;
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
  capture_config: CaptureConfig;
}

export interface CameraPatchInput {
  name?: string;
  location?: string;
  rtsp_url?: string;
  worker_enabled?: boolean;
  display_enabled?: boolean;
  capture_config?: CaptureConfig;
}
