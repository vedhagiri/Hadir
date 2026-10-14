// Wire types for /api/audit-log (read-only).

export type AuditCategory = "security" | "people" | "attendance" | "devices" | "storage" | "reports" | "settings" | "other";
export type AuditSeverity = "info" | "warning" | "high";
export type AuditKind = "security" | "failures" | "changes" | "system";

export interface AuditEntry {
  id: number;
  created_at: string;
  actor_user_id: number | null;
  actor_email: string | null;
  actor_name: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  category: string;
  severity: string;
  is_routine: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface AuditListResponse {
  items: AuditEntry[];
  total: number;
  page: number;
  page_size: number;
  distinct_actions: string[];
  distinct_entity_types: string[];
}

export interface AuditSummary {
  total: number;
  security: number;
  failures: number;
  changes: number;
  system: number;
  routine_hidden: number;
  by_category: Record<string, number>;
}

export interface AuditActor {
  id: number;
  email: string;
  full_name: string;
  events: number;
}

export interface AuditActorsResponse {
  items: AuditActor[];
  system_events: number;
}

/** Server-side filter set (everything except paging). */
export interface AuditQuery {
  q: string;
  q_action: string[];
  categories: string[];
  actor: string; // "" | "system" | "<user id>"
  start: string | null;
  end: string | null;
  hide_routine: boolean;
  kind: AuditKind | null;
}
