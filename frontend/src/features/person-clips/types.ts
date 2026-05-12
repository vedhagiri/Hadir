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
}

export interface ReprocessFaceMatchResponse {
  started: boolean;
  message: string;
}

export interface ReprocessFaceMatchStatus {
  status: string;
  mode: string;
  total_clips: number;
  processed_clips: number;
  matched_total: number;
  failed_count: number;
  errors: string[];
  started_at: string | null;
  ended_at: string | null;
}
