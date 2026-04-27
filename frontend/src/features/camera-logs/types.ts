// Wire types for /api/detection-events.

export interface DetectionEvent {
  id: number;
  captured_at: string;
  camera_id: number;
  camera_name: string;
  employee_id: number | null;
  employee_code: string | null;
  employee_name: string | null;
  confidence: number | null;
  track_id: string;
  has_crop: boolean;
  // P28.7 — set when the matcher identified an *inactive* employee.
  // ``employee_id`` stays NULL in that case; the snapshot lives on
  // ``former_match_employee_id`` + the joined snapshot fields.
  former_employee_match?: boolean;
  former_match_employee_id?: number | null;
  former_match_employee_code?: string | null;
  former_match_employee_name?: string | null;
  // Migration 0032: per-row snapshot of which detector + recognition
  // models produced this event and which package versions were
  // running. NULL on rows that pre-date the migration.
  detection_metadata?: DetectionMetadata | null;
}

export interface DetectionMetadata {
  detector_mode: string;
  detector_pack: string;
  recognition_model: string;
  det_size: number;
  min_det_score: number;
  insightface_version?: string;
  onnxruntime_version?: string;
  ultralytics_version?: string;
  match_threshold?: number;
}

export interface DetectionEventListResponse {
  items: DetectionEvent[];
  total: number;
  page: number;
  page_size: number;
}

export interface DetectionEventFilters {
  camera_id: number | null;
  employee_id: number | null;
  identified: boolean | null; // null = both
  start: string | null;
  end: string | null;
  page: number;
  page_size: number;
}
