// Wire types for the Super-Admin console (v1.0 P3). Mirrors the
// Pydantic responses in ``hadir/super_admin/router.py``.

export interface SuperAdminMe {
  id: number;
  email: string;
  full_name: string;
  impersonated_tenant_id: number | null;
}

export interface TenantSummary {
  id: number;
  name: string;
  schema_name: string;
  status: "active" | "suspended";
  created_at: string;
  admin_count: number;
  employee_count: number;
}

export interface AdminUser {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
}

export interface SuperAdminAuditEntry {
  id: number;
  super_admin_user_id: number;
  action: string;
  entity_type: string;
  entity_id: string | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

export interface TenantDetail extends TenantSummary {
  admin_users: AdminUser[];
  recent_super_admin_audit: SuperAdminAuditEntry[];
}

export interface ProvisionInput {
  slug: string;
  name: string;
  admin_email: string;
  admin_full_name?: string;
  admin_password: string;
}

export interface ProvisionResponse {
  tenant_id: number;
  schema_name: string;
  name: string;
  admin_user_id: number;
  admin_email: string;
}

export interface AccessAsResponse {
  tenant_id: number;
  tenant_schema: string;
  tenant_name: string;
}
