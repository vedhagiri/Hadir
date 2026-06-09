// Wire shapes returned by the P28.5a live-capture endpoints. Mirrors
// what ``maugood/live_capture/router.py`` actually emits — keep these
// in sync with the backend Pydantic responses.

// One person bounding box as sent in the WebSocket heartbeat.
export interface PersonBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LiveStats {
  detections_last_10m: number;
  known_count: number;
  unknown_count: number;
  /** P28.5a: alias for ``fps_reader`` so the existing UI keeps working. */
  fps: number;
  fps_reader: number;
  fps_analyzer: number;
  /** Native fps reported by the camera's RTSP stream (CAP_PROP_FPS).
   * Null until the worker connects for the first time. */
  fps_native: number | null;
  motion_skipped: number;
  /** Migration 0054 — live count of people currently in frame.
   * ``max(face_count, yolo_person_count, active_tracks)`` from the
   * worker's most recent analyzer cycle. */
  live_person_count: number;
  status: "online" | "offline";
}

// One detection event delivered over the WebSocket. The backend
// publishes via ``capture/event_bus`` after each new track is
// emitted by the worker. ``employee_id === null`` → unknown face.
export interface LiveEvent {
  type: "detection";
  /**
   * The detection_events row id. Lets the live viewer render the
   * encrypted face crop via /api/detection-events/{event_id}/crop
   * without a follow-up lookup. Null on rows from non-DB-backed
   * publishers (tests, ad-hoc).
   */
  event_id: number | null;
  time: string; // ISO timestamp
  camera_id: number;
  employee_id: number | null;
  employee_name: string | null;
  employee_code: string | null;
  confidence: number | null;
  status: "identified" | "unknown";
  bbox: { x: number; y: number; w: number; h: number };
}

export interface HeartbeatMessage {
  type: "heartbeat";
  server_time: string;
  camera_status: "online" | "offline";
  // P28.5a additions: live worker stats from CaptureManager.get_worker_stats.
  // Each may be null when no worker is running for the (tenant, camera).
  status?: string | null;
  fps_reader?: number | null;
  fps_analyzer?: number | null;
  /** Native fps from RTSP stream. Null until worker first connects. */
  fps_native?: number | null;
  motion_skipped?: number | null;
  // Box overlay additions: person detection boxes baked by the analyzer.
  person_count?: number | null;
  person_boxes?: PersonBox[] | null;
  frame_width?: number | null;
  frame_height?: number | null;
}

export interface StatsMessage {
  type: "stats";
  detections_last_10m: number;
  known_count: number;
  unknown_count: number;
}

export type WsMessage = LiveEvent | HeartbeatMessage | StatsMessage;
