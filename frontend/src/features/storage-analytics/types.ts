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
