// Wire types for /api/storage-analytics — mirrors maugood/storage_analytics/schemas.py.

export interface StorageOverview {
  total_clips: number;
  total_bytes: number;
  total_face_crops: number;
  matched_face_crops: number;
  unmatched_face_crops: number;
  pending_clips: number;
  processing_clips: number;
  completed_clips: number;
  failed_clips: number;
  recording_clips: number;
  avg_clip_duration_sec: number | null;
}

export interface CameraStorageRow {
  camera_id: number;
  camera_name: string;
  clip_count: number;
  total_bytes: number;
  matched_crops: number;
  unmatched_crops: number;
  avg_clip_duration_sec: number | null;
}

export interface DailyStorageRow {
  date: string; // YYYY-MM-DD
  clip_count: number;
  total_bytes: number;
  new_crops: number;
  matched_crops: number;
}

export interface StorageAnalyticsResponse {
  overview: StorageOverview;
  by_camera: CameraStorageRow[];
  daily: DailyStorageRow[];
  days_window: number;
  camera_id_filter: number | null;
}

export type DaysWindow = 7 | 14 | 30 | 90 | 365;

// ── Clip cleanup (migration 0069) ──────────────────────────────────────────

export type ClipCleanupMode = "hours" | "days" | "range";

export interface ClipCleanupFilter {
  older_than_hours?: number;
  older_than_days?: number;
  start_date?: string; // YYYY-MM-DD
  end_date?: string; // YYYY-MM-DD
  camera_id?: number;
}

export interface CleanupCameraImpact {
  camera_id: number;
  camera_name: string;
  clip_count: number;
  total_bytes: number;
}

export interface ClipCleanupPreviewResponse {
  clip_count: number;
  total_bytes: number;
  oldest_clip_at: string | null;
  newest_clip_at: string | null;
  by_camera: CleanupCameraImpact[];
  capped: boolean;
  cap: number;
}

export interface ClipCleanupRunResponse {
  deleted_count: number;
  bytes_freed: number;
  files_unlinked: number;
  files_missing: number;
  files_failed: number;
  has_more: boolean;
}

export interface ClipRetentionSetting {
  clip_retention_days: number | null;
}
