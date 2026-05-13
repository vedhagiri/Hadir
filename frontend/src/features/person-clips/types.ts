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
  // Migration 0052 — which detector triggered the clip.
  // 'face' (default, pre-0052), 'body', or 'both'.
  detection_source: ClipDetectionSource;
  // Number of intermediate chunks merged into the final file.
  // 1 for short clips; >1 for long-duration clips.
  chunk_count: number;
  // Migration 0054 — lifecycle status. While 'recording' the card
  // renders a 🔴 LIVE badge and offers MJPEG preview from the
  // camera's live stream (/api/cameras/{id}/live.mjpg).
  recording_status: RecordingStatus;
  created_at: string;
}

// Migration 0052 — clip recording trigger source.
export type ClipDetectionSource = "face" | "body" | "both";

// Migration 0054 / 0055 — clip recording lifecycle status.
//
//   recording  reader is actively writing chunk frames
//   finalizing reader handed off; ClipWorker is encoding the file
//              (multi-minute window for long clips at native res)
//   completed  file on disk, fully encoded
//   failed     encode / write error
//   abandoned  startup janitor swept a stale in-flight row
export type RecordingStatus =
  | "recording"
  | "finalizing"
  | "completed"
  | "failed"
  | "abandoned";

// Filter value for the segmented control on PersonClipsPage. "all"
// omits the ``detection_source`` query param; the others map directly
// to the backend ``?detection_source=`` filter.
export type ClipDetectionSourceFilter =
  | "all"
  | ClipDetectionSource;

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

// Face-match pipeline status filter — matches DB ``matched_status``.
// ``null`` omits the query param (all matched_status values returned).
export type ClipMatchedStatusFilter =
  | null
  | "pending"
  | "processing"
  | "processed"
  | "failed";

// Recording lifecycle filter — matches DB ``recording_status``.
// ``null`` omits the query param (default backend hides
// failed/abandoned regardless).
export type ClipRecordingStatusFilter =
  | null
  | "recording"
  | "finalizing"
  | "completed";

export interface PersonClipFilters {
  camera_id: number | null;
  employee_id: number | null;
  start: string | null;
  end: string | null;
  // Migration 0052: filter by detector source. "all" omits the
  // query param so legacy clips (predating the column) still appear.
  detection_source: ClipDetectionSourceFilter;
  // Click-driven filters from the Face-matching pills and the
  // Summary band. ``null`` = pill/tile not active.
  matched_status: ClipMatchedStatusFilter;
  recording_status: ClipRecordingStatusFilter;
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

export interface TopProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  memory_mb: number;
}

export interface SystemResourceStats {
  // CPU
  cpu_percent_per_core: number[];
  cpu_percent_total: number;
  cpu_count_logical: number;
  cpu_count_physical: number;
  cpu_freq_current_mhz: number | null;
  cpu_freq_max_mhz: number | null;
  load_avg_1m: number | null;
  load_avg_5m: number | null;
  load_avg_15m: number | null;
  // Memory
  memory_total_mb: number;
  memory_used_mb: number;
  memory_available_mb: number;
  memory_percent: number;
  swap_total_mb: number;
  swap_used_mb: number;
  swap_percent: number;
  // GPU
  gpu_available: boolean;
  gpu_percent: number | null;
  gpu_memory_used_mb: number | null;
  gpu_memory_total_mb: number | null;
  // Disk I/O
  disk_read_mb_per_s: number;
  disk_write_mb_per_s: number;
  disk_read_total_mb: number;
  disk_write_total_mb: number;
  // Network
  net_sent_mb_per_s: number;
  net_recv_mb_per_s: number;
  net_sent_total_mb: number;
  net_recv_total_mb: number;
  // Host
  hostname: string;
  platform: string;
  boot_time_iso: string;
  uptime_seconds: number;
  process_count: number;
  // Backend process
  backend_pid: number;
  backend_cpu_percent: number;
  backend_memory_mb: number;
  backend_thread_count: number;
  backend_open_files: number;
  // Top processes + detector lock
  top_cpu_processes: TopProcessInfo[];
  top_memory_processes: TopProcessInfo[];
  detector_lock_contention_pct: number;
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
  // Recording lifecycle (camera → encoded MP4)
  recording_active: number;
  recording_encoding: number;
  recording_completed: number;
  recording_failed: number;
  recording_abandoned: number;
  // Per-UC completed run counts
  uc1_completed: number;
  uc2_completed: number;
  uc3_completed: number;
  avg_uc1_duration_ms: number | null;
  avg_uc2_duration_ms: number | null;
  avg_uc3_duration_ms: number | null;
  // Throughput / activity
  clips_today: number;
  matched_today: number;
  avg_clip_duration_seconds: number | null;
  total_storage_bytes: number;
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

// ── UC Comparison ────────────────────────────────────────────────────────────

export interface UseCaseStatsRow {
  use_case: "uc1" | "uc2" | "uc3";
  label: string;
  mode: string;
  has_data: boolean;
  completed_runs: number;
  failed_runs: number;
  distinct_clips: number;
  avg_total_ms: number | null;
  avg_extract_ms: number | null;
  avg_match_ms: number | null;
  total_faces_detected: number;
  total_crops_saved: number;
  total_unknown_count: number;
  face_crop_row_count: number;
  matched_crop_count: number;
  avg_quality_score: number | null;
  avg_detection_score: number | null;
  avg_match_confidence: number | null;
  match_rate: number | null;
  storage_bytes: number;
}

export interface UseCaseComparisonResponse {
  use_cases: UseCaseStatsRow[];
  fastest: string | null;
  best_quality: string | null;
  most_accurate: string | null;
  most_used: string | null;
  recommendations: string[];
}
