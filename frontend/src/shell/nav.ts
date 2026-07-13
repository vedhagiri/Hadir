// Navigation structure — literal port of the NAV and CRUMBS constants
// from frontend/src/design/shell.jsx. Do NOT edit the labels, icons, or
// ordering without updating the design reference; this is the source of
// visual truth for the sidebar and breadcrumbs.

import type { Role } from "../types";
import type { IconName } from "./Icon";

export type NavItem =
  | { section: string }
  | {
      id: string;
      label: string;
      icon: IconName;
      badge?: string;
    };

export const NAV: Record<Role, NavItem[]> = {
  Admin: [
    { section: "Overview" },
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { section: "Operations" },
    { id: "cameras", label: "Cameras", icon: "camera" },
    // Worker monitoring retired — its per-camera view moved into
    // Pipeline Monitor's "Cameras" tab.
    { id: "pipeline-monitor", label: "Pipeline Monitor", icon: "activity" },
    { id: "employees", label: "Employees", icon: "users" },
    { id: "users", label: "Users", icon: "user" },
    { id: "photo-approvals", label: "Photo approvals", icon: "shield" },
    { id: "bulk-photo-upload", label: "Bulk Photo Upload", icon: "camera" },
    { id: "policies", label: "Shift Policies", icon: "clock" },
    { id: "leave-policy", label: "Leave & Calendar", icon: "calendar" },
    { section: "Attendance" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    { id: "camera-logs", label: "Camera Logs", icon: "camera" },
    { id: "unidentified-faces", label: "Unidentified Faces", icon: "user" },
    { id: "person-clips", label: "Person Clips", icon: "videocam" },
    { id: "clip-logs", label: "Clip Logs", icon: "clipboard" },
    { id: "clip-analytics", label: "Clip Analytics", icon: "fileText" },
    { id: "pipeline-analytics", label: "Pipeline Analytics", icon: "activity" },
    { id: "storage-analytics", label: "Storage Analytics", icon: "database" },
    // { id: "face-crops", label: "Face Crops", icon: "user" },
    { section: "Workflow" },
    { id: "approvals", label: "Approvals", icon: "inbox" },
    { id: "reports", label: "Reports", icon: "fileText" },
    { id: "former-employees", label: "Former employees seen", icon: "shield" },
    { id: "employee-report", label: "Employee report", icon: "user" },
    // { id: "mgr-assign", label: "Manager assignments", icon: "users" },
    { section: "System" },
    { id: "system", label: "System & Infra", icon: "activity" },
    { id: "system-settings", label: "Detection & Tracker", icon: "settings" },
    { id: "audit", label: "Audit Log", icon: "shield" },
    { id: "settings", label: "Settings", icon: "settings" },
    // TEMP-DIAGNOSTIC-2026-05-20 — Frame Diagnostics tab.
    { id: "frame-diagnostics", label: "Frame Diagnostics", icon: "activity" },
    { section: "Help" },
    { id: "pipeline", label: "How it works", icon: "sparkles" },
    { id: "api-docs", label: "API Reference", icon: "fileText" },
  ],
  HR: [
    { section: "Overview" },
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { section: "People" },
    { id: "employees", label: "Employees", icon: "users" },
    { id: "photo-approvals", label: "Photo approvals", icon: "shield" },
    { id: "employee-report", label: "Employee report", icon: "user" },
    { section: "Workflow" },
    { id: "approvals", label: "Approvals", icon: "inbox" },
    { id: "policies", label: "Shift Policies", icon: "clock" },
    { id: "leave-policy", label: "Leave & Calendar", icon: "calendar" },
    { id: "reports", label: "Reports", icon: "fileText" },
    { id: "former-employees", label: "Former employees seen", icon: "shield" },
    { section: "Attendance" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    // { id: "camera-logs", label: "Camera Logs", icon: "camera" },
    // { id: "unidentified-faces", label: "Unidentified Faces", icon: "user" },
    // { id: "person-clips", label: "Person Clips", icon: "videocam" },
    // { id: "clip-analytics", label: "Clip Analytics", icon: "fileText" },
    // { id: "mgr-assign", label: "Manager assignments", icon: "users" },
    { section: "Me" },
    { id: "my-attendance", label: "My Attendance", icon: "calendar" },
        { id: "my-profile", label: "Profile & Photo", icon: "user" },

    { section: "System" },
    { id: "settings", label: "Settings", icon: "settings" },
    { section: "Help" },
    { id: "pipeline", label: "How it works", icon: "sparkles" },
  ],
  Manager: [
    { section: "Team" },
    { id: "dashboard", label: "Team Today", icon: "home" },
    { id: "team-attendance", label: "Team Attendance", icon: "users" },
    { id: "calendar", label: "Team Calendar", icon: "calendar" },
    { id: "my-team", label: "My Team", icon: "users" },
    { id: "approvals", label: "Approvals", icon: "inbox" },
    { section: "Me" },
    { id: "my-attendance", label: "My Attendance", icon: "calendar" },
    { id: "my-profile", label: "Profile & Photo", icon: "user" },

  ],
  Employee: [
    { section: "Me" },
    { id: "dashboard", label: "Today", icon: "home" },
    { id: "my-attendance", label: "Attendance", icon: "calendar" },
    { id: "calendar", label: "Calendar view", icon: "calendar" },
    { id: "my-requests", label: "Requests", icon: "clipboard" },
    { id: "my-profile", label: "Profile & Photo", icon: "user" },
  ],
};

export const CRUMBS: Record<string, string[]> = {
  dashboard: ["Maugood", "Dashboard"],
  cameras: ["Maugood", "Cameras"],
  employees: ["Maugood", "People", "Employees"],
  users: ["Maugood", "People", "Users"],
  policies: ["Maugood", "Configuration", "Shift Policies"],
  approvals: ["Maugood", "Workflow", "Approvals"],
  reports: ["Maugood", "Reports"],
  "former-employees": ["Maugood", "Reports", "Former employees seen"],
  "pipeline-monitor": ["Maugood", "Operations", "Pipeline Monitor"],
  audit: ["Maugood", "System", "Audit Log"],
  settings: ["Maugood", "System", "Settings"],
  "my-attendance": ["Maugood", "Me", "Attendance"],
  "team-attendance": ["Maugood", "Team", "Attendance"],
  "my-team": ["Maugood", "Team", "My Team"],
  "my-requests": ["Maugood", "Me", "Requests"],
  "my-profile": ["Maugood", "Me", "Profile"],
  calendar: ["Maugood", "Attendance", "Calendar"],
  "employee-report": ["Maugood", "Reports", "Employee report"],
  "leave-policy": ["Maugood", "Configuration", "Leave & Calendar"],
  "daily-attendance": ["Maugood", "Attendance", "Daily"],
  "camera-logs": ["Maugood", "Attendance", "Camera logs"],
  "unidentified-faces": ["Maugood", "Attendance", "Unidentified Faces"],
  "person-clips": ["Maugood", "Attendance", "Person Clips"],
  "clip-logs": ["Maugood", "Attendance", "Clip Logs"],
  "clip-analytics": ["Maugood", "Attendance", "Clip Analytics"],
  "storage-analytics": ["Maugood", "Attendance", "Storage Analytics"],
  "face-crops": ["Maugood", "Attendance", "Face Crops"],
  "mgr-assign": ["Maugood", "People", "Manager assignments"],
  "photo-approvals": ["Maugood", "People", "Photo approvals"],
  "bulk-photo-upload": ["Maugood", "People", "Bulk Photo Upload"],
  pipeline: ["Maugood", "How it works"],
  system: ["Maugood", "System", "Infrastructure"],
  "system-settings": ["Maugood", "System", "Detection & Tracker"],
  "api-docs": ["Maugood", "Developers", "API Reference"],
  // TEMP-DIAGNOSTIC-2026-05-20
  "frame-diagnostics": ["Maugood", "System", "Frame Diagnostics"],
};

// Breadcrumb → route targets. A crumb token becomes clickable when it
// resolves to exactly one page. We map the *last* token of each CRUMBS
// entry to that page's route (`/${id}`, matching App.tsx). Tokens that
// are the last token of more than one page (e.g. "Attendance", shared by
// my-attendance + team-attendance) are dropped so a crumb never links to
// a surprising destination — those stay plain-text section labels. The
// root "Maugood" crumb always goes home.
export const CRUMB_TARGETS: Record<string, string> = (() => {
  const owners: Record<string, string[]> = {};
  for (const [id, tokens] of Object.entries(CRUMBS)) {
    const last = tokens[tokens.length - 1];
    if (!last) continue;
    (owners[last] ??= []).push(id);
  }
  const out: Record<string, string> = { Maugood: "/dashboard" };
  for (const [token, ids] of Object.entries(owners)) {
    const only = ids.length === 1 ? ids[0] : undefined;
    if (only) out[token] = `/${only}`;
  }
  return out;
})();

// The union of every route id across all roles — used by App.tsx so each
// id has a placeholder page registered, even when the current role's
// sidebar hides it.
export const ALL_PAGE_IDS: readonly string[] = Array.from(
  new Set(
    (Object.values(NAV) as NavItem[][])
      .flat()
      .filter((item): item is Extract<NavItem, { id: string }> => "id" in item)
      .map((item) => item.id),
  ),
);
