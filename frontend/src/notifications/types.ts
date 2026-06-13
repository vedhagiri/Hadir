// Wire types for /api/notifications + /api/notification-preferences.

export type NotificationCategory =
  | "approval_assigned"
  | "approval_decided"
  | "overtime_flagged"
  | "camera_unreachable"
  | "report_ready"
  | "admin_override";

export const ALL_CATEGORIES: NotificationCategory[] = [
  "approval_assigned",
  "approval_decided",
  "overtime_flagged",
  "camera_unreachable",
  "report_ready",
  "admin_override",
];

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  approval_assigned: "Approval assigned to me",
  approval_decided: "My request decided",
  overtime_flagged: "Overtime flagged",
  camera_unreachable: "Camera unreachable",
  report_ready: "Report ready",
  admin_override: "Admin override",
};

export interface NotificationItem {
  id: number;
  category: NotificationCategory;
  subject: string;
  body: string;
  link_url: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface NotificationListResponse {
  items: NotificationItem[];
  unread_count: number;
}

export interface NotificationPreference {
  category: NotificationCategory;
  in_app: boolean;
  email: boolean;
}

export interface PreferenceListResponse {
  items: NotificationPreference[];
}

// --- Attendance status emails (0080) ---------------------------------------
// Tenant-wide Admin toggles + read-only delivery log. Recipients are
// employees (by their employee email), so these are not per-user
// preference rows — a separate config bag on tenant_settings.

export type AttendanceEmailStatus = "present" | "late" | "absent";

export interface AttendanceEmailConfig {
  present: boolean;
  late: boolean;
  absent: boolean;
}

export interface AttendanceEmailConfigOut extends AttendanceEmailConfig {
  cancelled_queue_rows: number;
}

export interface AttendanceEmailLogItem {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string;
  date: string;
  status: AttendanceEmailStatus;
  recipient_kind: "employee" | "manager";
  recipient_email: string | null;
  subject: string | null;
  attempts: number;
  sent_at: string | null;
  failed_at: string | null;
  skipped_at: string | null;
  last_error: string | null;
  created_at: string | null;
}

export interface AttendanceEmailLogResponse {
  items: AttendanceEmailLogItem[];
  total: number;
  page: number;
  page_size: number;
}
