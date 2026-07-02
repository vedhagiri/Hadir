// Wire types for the AD Users management surface.
// Mirror the Pydantic shapes in maugood/entra_sync/router.py.

export interface AdUser {
  id: number;
  full_name: string;
  email: string;
  upn: string | null;
  job_title: string | null;
  department: string | null;
  ms_object_id: string | null;
  ad_status: string | null;
  source: string;
  is_active: boolean;
  role_codes: string[];
  last_login_at: string | null;
  login_count: number;
  auth_provider: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export interface AdUserList {
  items: AdUser[];
  total: number;
  enabled: number;
  disabled: number;
}

export interface SyncResult {
  added: number;
  updated: number;
  failed: number;
  errors: string[];
}

export interface EntraGroup {
  id: string;
  name: string;
}

export interface GroupRoleEntry {
  group_id: string;
  group_name: string;
  role_code: string;
}

export interface GroupRoleMap {
  entries: GroupRoleEntry[];
}

export interface LoginActivity {
  user_id: number;
  total_logins: number;
  login_count: number;
  last_login_at: string | null;
  auth_provider: string | null;
  is_active: boolean;
  created_by: string;
  ms_object_id: string | null;
}

export type RoleCode = "Admin" | "HR" | "Manager" | "Employee";
