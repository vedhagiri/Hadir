// Wire types for /api/requests, /api/request-reason-categories,
// and the attachment endpoints.

export type RequestType = "exception" | "leave";
export type Decision = "approve" | "reject";
export type RequestStatus =
  | "submitted"
  | "manager_approved"
  | "manager_rejected"
  | "hr_approved"
  | "hr_rejected"
  | "admin_approved"
  | "admin_rejected"
  | "cancelled";

export const TERMINAL_STATUSES: ReadonlyArray<RequestStatus> = [
  "manager_rejected",
  "hr_approved",
  "hr_rejected",
  "admin_approved",
  "admin_rejected",
  "cancelled",
];

export interface RequestEmployee {
  id: number;
  employee_code: string;
  full_name: string;
}

export interface RequestRecord {
  id: number;
  tenant_id: number;
  type: RequestType;
  employee: RequestEmployee;
  reason_category: string;
  reason_text: string;
  target_date_start: string;
  target_date_end: string | null;
  leave_type_id: number | null;
  leave_type_code: string | null;
  leave_type_name: string | null;
  status: RequestStatus;
  manager_user_id: number | null;
  manager_decision_at: string | null;
  manager_comment: string | null;
  hr_user_id: number | null;
  hr_decision_at: string | null;
  hr_comment: string | null;
  admin_user_id: number | null;
  admin_decision_at: string | null;
  admin_comment: string | null;
  submitted_at: string;
  created_at: string;
}

export interface RequestCreateInput {
  type: RequestType;
  reason_category: string;
  reason_text?: string;
  target_date_start: string;
  target_date_end?: string | null;
  leave_type_id?: number | null;
}

export interface ReasonCategory {
  id: number;
  tenant_id: number;
  request_type: RequestType;
  code: string;
  name: string;
  display_order: number;
  active: boolean;
}

export interface ReasonCategoryCreateInput {
  request_type: RequestType;
  code: string;
  name: string;
}

export interface ReasonCategoryPatchInput {
  name?: string;
  display_order?: number;
  active?: boolean;
}

export interface AttachmentRecord {
  id: number;
  request_id: number;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: string;
}

export interface AttachmentConfig {
  max_mb: number;
  accepted_mime_types: string[];
}
