// Wire types for /api/unidentified-faces — mirror maugood/unidentified_faces/router.py.

export type EventQuality = "high" | "medium" | "low" | "unknown";
export type EventFaceType = "front" | "side" | "partial" | "unknown";

export interface FaceClusterOut {
  cluster_id: string;
  representative_event_id: number;
  event_ids: number[];
  crop_event_ids: number[];
  count: number;
  first_seen: string;
  last_seen: string;
  camera_ids: number[];
  camera_names: string[];
  avg_similarity: number;
  // Parallel to ``event_ids`` (same length + order). Drives in-drawer
  // filter chips (similarity / quality / pose).
  event_similarities: number[];
  event_qualities: EventQuality[];
  event_face_types: EventFaceType[];
}

export interface UnidentifiedFacesResponse {
  clusters: FaceClusterOut[];
  total_clusters: number;
  page: number;
  page_size: number;
  total_unidentified_events: number;
  events_with_embedding: number;
  events_without_embedding: number;
  capped: boolean;
}

export interface UnidentifiedEventOut {
  id: number;
  captured_at: string;
  camera_id: number;
  camera_name: string;
  has_crop: boolean;
}

export interface UnidentifiedEventsResponse {
  items: UnidentifiedEventOut[];
  total: number;
}

export interface UnidentifiedFacesFilters {
  start: string | null;
  end: string | null;
  camera_id: number | null;
  min_count: number;
  threshold: number;
  page: number;
  page_size: number;
}

export interface RawFaceEventOut {
  id: number;
  captured_at: string;
  camera_id: number;
  camera_name: string;
  has_crop: boolean;
  has_embedding: boolean;
}

export interface RawUnidentifiedFilters {
  start: string | null;
  end: string | null;
  camera_id: number | null;
  has_embedding: boolean | null;
  page: number;
  page_size: number;
}

export interface RawUnidentifiedResponse {
  items: RawFaceEventOut[];
  total: number;
  page: number;
  page_size: number;
  events_without_embedding: number;
}

export interface PhotoAssignment {
  event_id: number;
  angle: "front" | "left" | "right" | "other";
}

export interface MapToEmployeeBody {
  employee_id: number;
  event_ids: number[];
  photo_assignments: PhotoAssignment[];
}

export interface MapToEmployeeResponse {
  mapped_events: number;
  photos_created: number;
  photo_ids: number[];
}

// ── Mapped Employees (sub-tabs) ─────────────────────────────────────

export interface MappedFaceEventOut {
  id: number;
  captured_at: string;
  camera_id: number;
  camera_name: string;
  has_crop: boolean;
  employee_id: number;
  employee_name: string | null;
  employee_code: string | null;
  confidence: number | null;
}

export interface MappedFacesResponse {
  items: MappedFaceEventOut[];
  total: number;
  page: number;
  page_size: number;
}

export interface MappedEmployeeGroupOut {
  employee_id: number;
  employee_name: string | null;
  employee_code: string | null;
  count: number;
  first_seen: string;
  last_seen: string;
  camera_ids: number[];
  camera_names: string[];
  sample_event_ids: number[];
  avg_confidence: number | null;
}

export interface MappedEmployeesResponse {
  items: MappedEmployeeGroupOut[];
  total: number;
  page: number;
  page_size: number;
  total_events: number;
  total_employees: number;
}

export interface MappedFacesFilters {
  start: string | null;
  end: string | null;
  camera_id: number | null;
  employee_id: number | null;
  page: number;
  page_size: number;
}

export interface MappedClustersFilters {
  start: string | null;
  end: string | null;
  camera_id: number | null;
  page: number;
  page_size: number;
}
