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
    { section: "Insights" },
    { id: "insights", label: "Attendance overview", icon: "activity" },
    { id: "insights/departments", label: "Department insights", icon: "users" },
    { id: "insights/people", label: "Employee insights", icon: "user" },
    { section: "Attendance" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    { id: "approvals", label: "Approvals", icon: "inbox" },
    { section: "Reports" },
    { id: "reports", label: "Reports", icon: "fileText" },
    { id: "employee-report", label: "Employee report", icon: "user" },
    { id: "former-employees", label: "Former employees seen", icon: "shield" },
    { section: "People" },
    { id: "employees", label: "Employees", icon: "users" },
    { id: "users", label: "AD Users", icon: "user" },
    { id: "photo-approvals", label: "Photo approvals", icon: "shield" },
    { id: "bulk-photo-upload", label: "Bulk Photo Upload", icon: "camera" },
    // { id: "mgr-assign", label: "Manager assignments", icon: "users" },
    { section: "Policies" },
    { id: "policies", label: "Shift Policies", icon: "clock" },
    { id: "leave-policy", label: "Leave & Calendar", icon: "calendar" },
    // Cameras and attendance terminals are the two sources of "person
    // seen" events, so they sit together.
    { section: "Cameras & Devices" },
    { id: "cameras", label: "Cameras", icon: "camera" },
    { id: "devices", label: "Devices", icon: "shield" },
    // What the cameras captured — reviewed by people, not machines.
    { section: "Capture review" },
    { id: "camera-logs", label: "Camera Logs", icon: "camera" },
    { id: "unidentified-faces", label: "Unidentified Faces", icon: "user" },
    { id: "person-clips", label: "Person Clips", icon: "videocam" },
    { id: "clip-logs", label: "Clip Logs", icon: "clipboard" },
    { id: "clip-analytics", label: "Clip Analytics", icon: "fileText" },
    // { id: "face-crops", label: "Face Crops", icon: "user" },
    // Health of the pipeline + host. Worker monitoring retired — its
    // per-camera view lives in Pipeline Monitor's "Cameras" tab.
    { section: "Monitoring" },
    { id: "pipeline-monitor", label: "Pipeline Monitor", icon: "activity" },
    { id: "pipeline-analytics", label: "Pipeline Analytics", icon: "activity" },
    { id: "storage-analytics", label: "Storage Analytics", icon: "database" },
    { id: "system", label: "System & Infra", icon: "activity" },
    // TEMP-DIAGNOSTIC-2026-05-20 — Frame Diagnostics tab.
    { id: "frame-diagnostics", label: "Frame Diagnostics", icon: "activity" },
    { section: "Administration" },
    { id: "settings", label: "Settings", icon: "settings" },
    { id: "system-settings", label: "Detection & Tracker", icon: "settings" },
    { id: "audit", label: "Audit Log", icon: "shield" },
    { section: "Help" },
    { id: "pipeline", label: "How it works", icon: "sparkles" },
    { id: "api-docs", label: "API Reference", icon: "fileText" },
  ],
  HR: [
    { section: "Overview" },
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { section: "Insights" },
    { id: "insights", label: "Attendance overview", icon: "activity" },
    { id: "insights/departments", label: "Department insights", icon: "users" },
    { id: "insights/people", label: "Employee insights", icon: "user" },
    { section: "Attendance" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    { id: "approvals", label: "Approvals", icon: "inbox" },
    { section: "Reports" },
    { id: "reports", label: "Reports", icon: "fileText" },
    { id: "employee-report", label: "Employee report", icon: "user" },
    { id: "former-employees", label: "Former employees seen", icon: "shield" },
    { section: "People" },
    { id: "employees", label: "Employees", icon: "users" },
    { id: "photo-approvals", label: "Photo approvals", icon: "shield" },
    { section: "Policies" },
    { id: "policies", label: "Shift Policies", icon: "clock" },
    { id: "leave-policy", label: "Leave & Calendar", icon: "calendar" },
    { section: "Me" },
    { id: "my-attendance", label: "My Attendance", icon: "calendar" },
    { id: "my-profile", label: "Profile & Photo", icon: "user" },
    { section: "Administration" },
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
    { section: "Insights" },
    { id: "insights", label: "Attendance overview", icon: "activity" },
    { id: "insights/departments", label: "Department insights", icon: "users" },
    { id: "insights/people", label: "Employee insights", icon: "user" },
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
  cameras: ["Maugood", "Cameras & Devices", "Cameras"],
  devices: ["Maugood", "Cameras & Devices", "Devices"],
  employees: ["Maugood", "People", "Employees"],
  users: ["Maugood", "People", "AD Users"],
  policies: ["Maugood", "Policies", "Shift Policies"],
  approvals: ["Maugood", "Attendance", "Approvals"],
  reports: ["Maugood", "Reports"],
  insights: ["Maugood", "Insights", "Attendance overview"],
  "insights/departments": ["Maugood", "Insights", "Department insights"],
  "insights/people": ["Maugood", "Insights", "Employee insights"],
  "former-employees": ["Maugood", "Reports", "Former employees seen"],
  "pipeline-monitor": ["Maugood", "Monitoring", "Pipeline Monitor"],
  audit: ["Maugood", "Administration", "Audit Log"],
  settings: ["Maugood", "Administration", "Settings"],
  "settings/workspace": ["Maugood", "Settings", "Workspace"],
  "settings/branding": ["Maugood", "Settings", "Branding"],
  "settings/authentication": ["Maugood", "Settings", "Authentication"],
  "settings/email": ["Maugood", "Settings", "Email"],
  "settings/schedules": ["Maugood", "Settings", "Schedules"],
  "settings/erp-export": ["Maugood", "Settings", "ERP export"],
  "settings/divisions": ["Maugood", "Settings", "Divisions"],
  "settings/departments": ["Maugood", "Settings", "Departments"],
  "settings/sections": ["Maugood", "Settings", "Sections"],
  "settings/custom-fields": ["Maugood", "Settings", "Custom fields"],
  "settings/reason-categories": ["Maugood", "Settings", "Request reasons"],
  "settings/notifications": ["Maugood", "Settings", "Notifications"],
  "settings/display": ["Maugood", "Settings", "Display"],
  "my-attendance": ["Maugood", "Me", "Attendance"],
  "team-attendance": ["Maugood", "Team", "Attendance"],
  "my-team": ["Maugood", "Team", "My Team"],
  "my-requests": ["Maugood", "Me", "Requests"],
  "my-profile": ["Maugood", "Me", "Profile"],
  calendar: ["Maugood", "Attendance", "Calendar"],
  "employee-report": ["Maugood", "Reports", "Employee report"],
  "leave-policy": ["Maugood", "Policies", "Leave & Calendar"],
  "daily-attendance": ["Maugood", "Attendance", "Daily"],
  "camera-logs": ["Maugood", "Capture review", "Camera logs"],
  "unidentified-faces": ["Maugood", "Capture review", "Unidentified Faces"],
  "person-clips": ["Maugood", "Capture review", "Person Clips"],
  "clip-logs": ["Maugood", "Capture review", "Clip Logs"],
  "clip-analytics": ["Maugood", "Capture review", "Clip Analytics"],
  "storage-analytics": ["Maugood", "Monitoring", "Storage Analytics"],
  "face-crops": ["Maugood", "Capture review", "Face Crops"],
  "mgr-assign": ["Maugood", "People", "Manager assignments"],
  "photo-approvals": ["Maugood", "People", "Photo approvals"],
  "bulk-photo-upload": ["Maugood", "People", "Bulk Photo Upload"],
  pipeline: ["Maugood", "How it works"],
  system: ["Maugood", "Monitoring", "Infrastructure"],
  "system-settings": ["Maugood", "Administration", "Detection & Tracker"],
  "api-docs": ["Maugood", "Developers", "API Reference"],
  // TEMP-DIAGNOSTIC-2026-05-20
  "frame-diagnostics": ["Maugood", "Monitoring", "Frame Diagnostics"],
  "pipeline-analytics": ["Maugood", "Monitoring", "Pipeline Analytics"],
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
