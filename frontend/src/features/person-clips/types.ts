// Wire types for /api/person-clips — mirror maugood/person_clips/schemas.py.

export interface PersonClipOut {
  id: number;
  camera_id: number;
  camera_name: string;
  employee_id: number | null;
  employee_name: string | null;
  track_id: string | null;
  clip_start: string;
  clip_end: string;
  duration_seconds: number;
  filesize_bytes: number;
  frame_count: number;
  person_count: number;
  matched_employees: number[];
  matched_employee_names: string[];
  matched_status: string;
  person_start: string | null;
  person_end: string | null;
  face_matching_duration_ms: number | null;
  face_matching_progress: number;
  // Pipeline metadata (migration 0048+)
  encoding_start_at: string | null;
  encoding_end_at: string | null;
  fps_recorded: number | null;
  resolution_w: number | null;
  resolution_h: number | null;
  created_at: string;
}

export interface PersonClipListResponse {
  items: PersonClipOut[];
  total: number;
  page: number;
  page_size: number;
}

export interface PersonClipStats {
  total_clips: number;
  total_size_bytes: number;
  per_camera: {
    camera_id: number;
    camera_name: string;
    clip_count: number;
    total_bytes: number;
  }[];
  pending_match: number;
  processing_match: number;
  completed_match: number;
  failed_match: number;
}

export interface PersonClipFilters {
  camera_id: number | null;
  employee_id: number | null;
  start: string | null;
  end: string | null;
  page: number;
  page_size: number;
}

export interface ReprocessFaceMatchRequest {
  mode: "all" | "skip_existing";
  use_cases: string[];
}

export interface ReprocessFaceMatchResponse {
  started: boolean;
  message: string;
}

export interface ReprocessFaceMatchStatus {
  status: string;
  mode: string;
  use_cases: string[];
  total_clips: number;
  processed_clips: number;
  matched_total: number;
  failed_count: number;
  errors: string[];
  started_at: string | null;
  ended_at: string | null;
}

export interface ClipProcessingResult {
  id: number;
  person_clip_id: number;
  use_case: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  face_extract_duration_ms: number | null;
  match_duration_ms: number | null;
  face_crop_count: number;
  matched_employees: number[];
  matched_employee_names: string[];
  unknown_count: number;
  match_details: Record<string, unknown>[] | null;
  error: string | null;
  created_at: string;
}

export interface ClipProcessingResultsResponse {
  clip_id: number;
  results: ClipProcessingResult[];
}

export interface WorkerStatus {
  camera_id: number;
  camera_name: string;
  tenant_id: number;
  is_alive: boolean;
  queue_size: number;
}

export interface ClipQueueStats {
  total_workers: number;
  alive_workers: number;
  total_queue_depth: number;
  workers: WorkerStatus[];
}

export interface SystemResourceStats {
  cpu_percent_per_core: number[];
  cpu_percent_total: number;
  memory_total_mb: number;
  memory_used_mb: number;
  memory_percent: number;
  gpu_available: boolean;
  gpu_percent: number | null;
  gpu_memory_used_mb: number | null;
  gpu_memory_total_mb: number | null;
}

export interface StorageStats {
  clips_root: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  clip_files_count: number;
  clip_files_total_mb: number;
}

export interface PipelineStats {
  total_clips: number;
  clips_pending: number;
  clips_processing: number;
  clips_completed: number;
  clips_failed: number;
  uc1_completed: number;
  uc2_completed: number;
  uc3_completed: number;
  avg_uc1_duration_ms: number | null;
  avg_uc2_duration_ms: number | null;
  avg_uc3_duration_ms: number | null;
}

export interface SystemStatsResponse {
  resources: SystemResourceStats;
  storage: StorageStats;
  clip_queue: ClipQueueStats;
  pipeline: PipelineStats;
  reprocess_status: ReprocessFaceMatchStatus;
}

// ── Single-clip reprocess ────────────────────────────────────────────────────

export interface SingleClipReprocessRequest {
  use_cases: string[];
}

export interface SingleClipReprocessResponse {
  started: boolean;
  running: boolean;
  message: string;
}

// ── Face crops ───────────────────────────────────────────────────────────────

export interface FaceCropOut {
  id: number;
  person_clip_id: number;
  camera_id: number;
  use_case: string | null;
  employee_id: number | null;
  employee_name: string | null;
  event_timestamp: string;
  face_index: number;
  quality_score: number;
  detection_score: number;
  width: number;
  height: number;
  created_at: string;
}

export interface FaceCropListResponse {
  clip_id: number;
  use_case_filter: string | null;
  items: FaceCropOut[];
  total: number;
}
