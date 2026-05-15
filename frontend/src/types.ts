// Shared TypeScript types for the Maugood frontend.

export type Role = "Admin" | "HR" | "Manager" | "Employee";

export interface MeResponse {
  id: number;
  email: string;
  full_name: string;
  // P7: ``roles`` is the **active** role only — the same value as
  // ``active_role``, kept here for backwards compat with code that
  // still iterates ``me.roles``. ``available_roles`` is the full set
  // the user holds; the topbar dropdown reads it to render the
  // switcher when the user has more than one.
  roles: Role[];
  available_roles: Role[];
  active_role: Role;
  departments: number[];
  // P3: backend sets these when the request is served by a Super-Admin
  // synthetic user under "Access as" impersonation. The tenant shell
  // mounts the red impersonation banner whenever this is true.
  is_super_admin_impersonation?: boolean;
  super_admin_user_id?: number | null;
  // P21: explicit user-chosen UI language. ``null`` means
  // "follow Accept-Language" — the browser drives.
  preferred_language?: "en" | "ar" | null;
  // P22: theme + density preferences. ``null`` on theme = follow
  // OS via prefers-color-scheme; ``null`` on density = comfortable
  // (the design's default).
  preferred_theme?: "system" | "light" | "dark" | null;
  preferred_density?: "compact" | "comfortable" | null;
  // Display name of the active tenant (``public.tenants.name``).
  // Empty string on a fresh install before the operator's setup
  // wizard runs; the sidebar falls back to "Maugood" in that case.
  tenant_name?: string;
  // True when an operator-uploaded logo exists in
  // ``tenant_branding.logo_path``. The sidebar uses it to decide
  // between ``/api/branding/logo`` and the static product mark.
  has_brand_logo?: boolean;
  // ISO timestamp from ``tenant_branding.updated_at``. Used as a
  // ``?v=…`` cache-buster on ``/api/branding/logo`` so browsers
  // refetch after a fresh upload.
  brand_logo_version?: string | null;
  // Sliding-expiry surface. Every authenticated request bumps
  // ``session_expires_at`` server-side; the SessionExpiryWatcher
  // reads it to schedule the "about to expire" warning modal.
  session_expires_at?: string | null;
  session_idle_minutes?: number;
  // Immutable creation time of the session row — surfaced so the UI
  // can show "Signed in at HH:MM" alongside the countdown.
  session_started_at?: string | null;
  // Server's view of "now" at the moment the response was built.
  // The auth provider computes a clock-skew offset against the local
  // clock so the SessionCountdown / SessionExpiryWatcher render the
  // remaining time exactly as the backend sees it (no drift on
  // throttled/backgrounded tabs).
  server_time?: string | null;
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
