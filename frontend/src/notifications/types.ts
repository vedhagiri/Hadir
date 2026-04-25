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
