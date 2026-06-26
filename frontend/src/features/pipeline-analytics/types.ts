// Wire types for the Pipeline Analytics tab (mirrors
// maugood/pipeline_analytics response shapes).

export type UseCase = "uc1" | "uc2";

export interface PipelineSummaryRow {
  use_case: UseCase;
  count: number;
  avg_total_ms: number | null;
  min_total_ms: number | null;
  max_total_ms: number | null;
  p95_total_ms: number | null;
  avg_queue_ms: number | null;
  p95_queue_ms: number | null;
  avg_load_ms: number | null;
  p95_load_ms: number | null;
  avg_decode_ms: number | null;
  p95_decode_ms: number | null;
  avg_extract_ms: number | null;
  p95_extract_ms: number | null;
  avg_lockwait_ms: number | null;
  p95_lockwait_ms: number | null;
  avg_detect_ms: number | null;
  p95_detect_ms: number | null;
  avg_crop_ms: number | null;
  p95_crop_ms: number | null;
  avg_match_ms: number | null;
  p95_match_ms: number | null;
  avg_cpu_percent: number | null;
  avg_memory_mb: number | null;
  max_memory_mb: number | null;
  avg_face_crops: number | null;
  total_face_crops: number;
  avg_frames_sampled: number | null;
  avg_frames_skipped: number | null;
  avg_frames_detected: number | null;
  avg_faces_detected: number | null;
  // min_* and p95 for non-total stages exist server-side but aren't all
  // surfaced here; add as needed.
  [key: string]: number | string | null;
}

export interface PipelineSummaryResponse {
  use_cases: PipelineSummaryRow[];
}

export interface PipelineClipRow {
  clip_id: number;
  use_case: UseCase;
  camera_id: number | null;
  camera_name: string | null;
  status: string;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  queue_wait_ms: number | null;
  clip_load_ms: number | null;
  frame_decode_ms: number | null;
  duration_ms: number | null;
  face_extract_duration_ms: number | null;
  detect_lock_wait_ms: number | null;
  detect_compute_ms: number | null;
  face_crop_ms: number | null;
  match_duration_ms: number | null;
  frames_sampled: number | null;
  frames_motion_skipped: number | null;
  frames_detected: number | null;
  faces_detected: number | null;
  face_crop_count: number;
  cpu_percent: number | null;
  memory_mb: number | null;
  fps: number | null;
  frame_count: number;
  duration_seconds: number | null;
  filesize_bytes: number;
  error: string | null;
}

export interface PipelineClipsResponse {
  items: PipelineClipRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface PipelineFilters {
  useCase: UseCase | null;
  status: string; // "completed" | "failed" | "processing" | "pending" | "all"
  start: string | null; // YYYY-MM-DD (inclusive day, local tz)
  end: string | null; // YYYY-MM-DD (inclusive day, local tz)
}
