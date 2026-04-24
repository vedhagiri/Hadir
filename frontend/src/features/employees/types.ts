// Wire types for /api/employees.* — the backend serialises these directly
// from the Pydantic schemas in hadir/employees/schemas.py.

export interface Department {
  id: number;
  code: string;
  name: string;
}

export type EmployeeStatus = "active" | "inactive";
export type PhotoAngle = "front" | "left" | "right" | "other";

export interface Employee {
  id: number;
  employee_code: string;
  full_name: string;
  email: string | null;
  department: Department;
  status: EmployeeStatus;
  photo_count: number;
  created_at: string;
}

export interface EmployeeListResponse {
  items: Employee[];
  total: number;
  page: number;
  page_size: number;
}

export interface Photo {
  id: number;
  employee_id: number;
  angle: PhotoAngle;
}

export interface PhotoListResponse {
  items: Photo[];
}

export interface ImportError {
  row: number;
  message: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  errors: ImportError[];
}

export interface PhotoIngestAccepted {
  filename: string;
  employee_code: string;
  angle: PhotoAngle;
  photo_id: number;
}

export interface PhotoIngestRejected {
  filename: string;
  reason: string;
}

export interface PhotoIngestResult {
  accepted: PhotoIngestAccepted[];
  rejected: PhotoIngestRejected[];
}
