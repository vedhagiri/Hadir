// Shared TypeScript types for the Hadir frontend.

export type Role = "Admin" | "HR" | "Manager" | "Employee";

export interface MeResponse {
  id: number;
  email: string;
  full_name: string;
  roles: Role[];
  departments: number[];
  // P3: backend sets these when the request is served by a Super-Admin
  // synthetic user under "Access as" impersonation. The tenant shell
  // mounts the red impersonation banner whenever this is true.
  is_super_admin_impersonation?: boolean;
  super_admin_user_id?: number | null;
}

// Used by the shell to decide which NAV to render when a user holds more
// than one role. Pilot rule (PROJECT_CONTEXT §8): use the highest role
// only; a full role switcher ships in v1.0.
const ROLE_PRIORITY: Record<Role, number> = {
  Admin: 4,
  HR: 3,
  Manager: 2,
  Employee: 1,
};

export function primaryRole(roles: Role[]): Role {
  let best: Role = "Employee";
  let bestRank = 0;
  for (const r of roles) {
    const rank = ROLE_PRIORITY[r] ?? 0;
    if (rank > bestRank) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}
