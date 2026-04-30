// Wire types for /api/employees.* — the backend serialises these directly
// from the Pydantic schemas in maugood/employees/schemas.py.

export interface Department {
  id: number;
  code: string;
  name: string;
}

// P29 (#3) — finest-grained tier of the org hierarchy. Sections
// nest inside a department; the same code can appear under
// different departments (OPS/QA + ENG/QA are distinct).
export interface SectionRef {
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
  // P29 (#3): null when the employee isn't assigned to a section
  // (sections are optional; not every tenant uses them).
  section?: SectionRef | null;
  status: EmployeeStatus;
  photo_count: number;
  created_at: string;
  // P28.7 fields. All optional / nullable — pre-P28.7 rows have NULL.
  designation?: string | null;
  phone?: string | null;
  reports_to_user_id?: number | null;
  reports_to_full_name?: string | null;
  joining_date?: string | null;
  relieving_date?: string | null;
  deactivated_at?: string | null;
  deactivation_reason?: string | null;
  // Role codes from the linked platform user (joined by email).
  // Empty list = no platform login OR login with no roles assigned.
  role_codes?: string[];
}

export interface EmployeeListResponse {
  items: Employee[];
  total: number;
  page: number;
  page_size: number;
}

// P28.7 — payload for POST + PATCH. Every field optional on PATCH; on
// POST the backend requires employee_code + full_name + department_*.
export interface EmployeeWritePayload {
  employee_code?: string;
  full_name?: string;
  email?: string | null;
  department_id?: number | null;
  department_code?: string | null;
  // P29 (#3): null clears the assignment; field omitted leaves
  // it as-is (PATCH semantics).
  section_id?: number | null;
  status?: EmployeeStatus;
  designation?: string | null;
  phone?: string | null;
  reports_to_user_id?: number | null;
  joining_date?: string | null;
  relieving_date?: string | null;
  deactivation_reason?: string | null;
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

// P28.7 delete-request workflow.

export type DeleteRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "admin_override"
  | "cancelled";

export interface DeleteRequest {
  id: number;
  employee_id: number;
  employee_code: string;
  employee_full_name: string;
  requested_by: number | null;
  requested_by_full_name: string | null;
  reason: string;
  status: DeleteRequestStatus;
  hr_decided_by: number | null;
  hr_decided_at: string | null;
  hr_comment: string | null;
  admin_override_by: number | null;
  admin_override_at: string | null;
  admin_override_comment: string | null;
  created_at: string;
}

export interface DeleteRequestListResponse {
  items: DeleteRequest[];
}
