// Wire types for /api/policies and /api/policy-assignments.

export type PolicyType = "Fixed" | "Flex" | "Ramadan" | "Custom";
export type ScopeType = "tenant" | "department" | "employee";

export interface PolicyConfig {
  // Fixed
  start?: string; // "HH:MM"
  end?: string;
  grace_minutes?: number;
  // Flex
  in_window_start?: string;
  in_window_end?: string;
  out_window_start?: string;
  out_window_end?: string;
  // Common
  required_hours?: number;
}

export interface PolicyResponse {
  id: number;
  tenant_id: number;
  name: string;
  type: PolicyType;
  config: PolicyConfig;
  active_from: string; // ISO date
  active_until: string | null;
}

export interface PolicyCreateInput {
  name: string;
  type: PolicyType;
  config: PolicyConfig;
  active_from: string;
  active_until?: string | null;
}

export interface PolicyPatchInput {
  name?: string;
  config?: PolicyConfig;
  active_from?: string;
  active_until?: string | null;
}

export interface AssignmentResponse {
  id: number;
  tenant_id: number;
  policy_id: number;
  scope_type: ScopeType;
  scope_id: number | null;
  active_from: string;
  active_until: string | null;
}

export interface AssignmentCreateInput {
  policy_id: number;
  scope_type: ScopeType;
  scope_id?: number | null;
  active_from: string;
  active_until?: string | null;
}
