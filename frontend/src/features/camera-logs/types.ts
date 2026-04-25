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
