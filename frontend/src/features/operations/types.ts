// Wire types for /api/operations/* + the camera-metadata PATCH.
// Mirror the Pydantic shapes in backend/hadir/operations/router.py.

export type StageState = "green" | "amber" | "red" | "unknown";
export type WorkerStatus =
  | "starting"
  | "running"
  | "reconnecting"
  | "stopped"
  | "failed";

export interface PipelineStage {
  state: StageState;
  last_activity_at: string | null;
  detail: string;
}

export interface PipelineStages {
  rtsp: PipelineStage;
  detection: PipelineStage;
  matching: PipelineStage;
  attendance: PipelineStage;
}

export interface WorkerMetadata {
  resolution_w: number | null;
  resolution_h: number | null;
  fps: number | null;
  codec: string | null;
  brand: string | null;
  model: string | null;
  mount_location: string | null;
  detected_at: string | null;
}

export interface WorkerStats {
  tenant_id: number;
  camera_id: number;
  camera_name: string;
  status: WorkerStatus;
  started_at: string | null;
  uptime_sec: number;
  stages: PipelineStages;
  fps_reader: number;
  fps_analyzer: number;
  frames_analyzed_60s: number;
  frames_motion_skipped_60s: number;
  faces_saved_60s: number;
  matches_60s: number;
  errors_5min: number;
  recent_errors: string[];
  metadata: WorkerMetadata;
}

export interface WorkersSummary {
  running: number;
  configured: number;
  stages_red_count: number;
  stages_amber_count: number;
  errors_5min_total: number;
  detection_events_last_hour: number;
  faces_saved_last_hour: number;
  successful_matches_last_hour: number;
}

export interface WorkersListResponse {
  workers: WorkerStats[];
  summary: WorkersSummary;
}

export interface RestartResult {
  camera_id: number;
  restarted: boolean;
  status: WorkerStatus;
}

export interface RestartAllResult {
  restarted: number;
  failed: number;
  total: number;
}

export interface CameraErrorsResponse {
  recent_errors: string[];
  audit_log_errors: Array<{
    id: number;
    action: string;
    created_at: string | null;
    after: Record<string, unknown>;
  }>;
}

export interface CameraMetadataPatch {
  brand?: string | null;
  model?: string | null;
  mount_location?: string | null;
}
