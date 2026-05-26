// Wire types for /api/unidentified-faces — mirror maugood/unidentified_faces/router.py.

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
}

export interface UnidentifiedFacesResponse {
  clusters: FaceClusterOut[];
  total_clusters: number;
  page: number;
  page_size: number;
  total_unidentified_events: number;
  events_with_embedding: number;
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
