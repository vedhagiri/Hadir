// Wire types for /api/audit-log.

export interface AuditEntry {
  id: number;
  created_at: string;
  actor_user_id: number | null;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
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

export interface AuditFilters {
  actor_user_id: number | null;
  action: string | null;
  entity_type: string | null;
  start: string | null;
  end: string | null;
  page: number;
  page_size: number;
}
