// Wire types for /api/face-crops — mirror maugood/face_crops/schemas.py.

export interface FaceCropOut {
  id: number;
  camera_id: number;
  camera_name: string;
  person_clip_id: number;
  event_timestamp: string;
  face_index: number;
  quality_score: number;
  width: number;
  height: number;
  created_at: string;
}

export interface FaceCropListResponse {
  items: FaceCropOut[];
  total: number;
  page: number;
  page_size: number;
}

export interface FaceCropStats {
  total_crops: number;
  per_camera: {
    camera_id: number;
    camera_name: string;
    crop_count: number;
  }[];
}

export interface FaceCropFilters {
  camera_id: number | null;
  person_clip_id: number | null;
  page: number;
  page_size: number;
}

export interface ClipsProcessingStatus {
  pending: number;
  processing: number;
  processed: number;
  failed: number;
  total: number;
  is_processing: boolean;
}

export interface ProcessResult {
  total: number;
  processed: number;
  failed: number;
  saved_crops: number;
  error?: string;
}

// --- Event-based grouping types ---

export interface FaceCropInGroup {
  id: number;
  face_index: number;
  quality_score: number;
  width: number;
  height: number;
  created_at: string;
}

export interface ClipGroup {
  person_clip_id: number;
  camera_id: number;
  camera_name: string;
  clip_start: string | null;
  clip_end: string | null;
  duration_seconds: number;
  track_count: number;
  crops: FaceCropInGroup[];
}

export interface FaceCropsByClipResponse {
  groups: ClipGroup[];
  total_groups: number;
  total_crops: number;
}

export interface ByClipFilters {
  camera_id: number | null;
  page: number;
  page_size: number;
}
