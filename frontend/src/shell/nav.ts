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
    { id: "live", label: "Live Capture", icon: "camera", badge: "LIVE" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { section: "Operations" },
    { id: "cameras", label: "Cameras", icon: "camera" },
    { id: "operations/workers", label: "Worker monitoring", icon: "activity" },
    { id: "employees", label: "Employees", icon: "users" },
    { id: "policies", label: "Shift Policies", icon: "clock" },
    { id: "leave-policy", label: "Leave & Calendar", icon: "calendar" },
    { section: "Attendance" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    { id: "camera-logs", label: "Camera Logs", icon: "camera" },
    { section: "Workflow" },
    { id: "approvals", label: "Approvals", icon: "inbox" },
    { id: "reports", label: "Reports", icon: "fileText" },
    { id: "former-employees", label: "Former employees seen", icon: "shield" },
    { id: "employee-report", label: "Employee report", icon: "user" },
    { id: "mgr-assign", label: "Manager assignments", icon: "users" },
    { section: "System" },
    { id: "system", label: "System & Infra", icon: "activity" },
    { id: "system-settings", label: "Detection & Tracker", icon: "settings" },
    { id: "audit", label: "Audit Log", icon: "shield" },
    { id: "settings", label: "Settings", icon: "settings" },
    { section: "Help" },
    { id: "pipeline", label: "How it works", icon: "sparkles" },
    { id: "api-docs", label: "API Reference", icon: "fileText" },
    { section: "Personal" },
    { id: "my-attendance", label: "My Attendance", icon: "calendar" },
    { id: "my-requests", label: "My Requests", icon: "clipboard" },
  ],
  HR: [
    { section: "Overview" },
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { section: "People" },
    { id: "employees", label: "Employees", icon: "users" },
    { id: "employee-report", label: "Employee report", icon: "user" },
    { section: "Workflow" },
    { id: "approvals", label: "Approvals", icon: "inbox" },
    { id: "policies", label: "Shift Policies", icon: "clock" },
    { id: "leave-policy", label: "Leave & Calendar", icon: "calendar" },
    { id: "reports", label: "Reports", icon: "fileText" },
    { id: "former-employees", label: "Former employees seen", icon: "shield" },
    { section: "Attendance" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    { id: "camera-logs", label: "Camera Logs", icon: "camera" },
    { id: "mgr-assign", label: "Manager assignments", icon: "users" },
    { section: "System" },
    { id: "settings", label: "Settings", icon: "settings" },
    { section: "Help" },
    { id: "pipeline", label: "How it works", icon: "sparkles" },
    { id: "api-docs", label: "API Reference", icon: "fileText" },
    { section: "Personal" },
    { id: "my-attendance", label: "My Attendance", icon: "calendar" },
  ],
  Manager: [
    { section: "Team" },
    { id: "dashboard", label: "Team Today", icon: "home" },
    { id: "team-attendance", label: "Team Attendance", icon: "users" },
    { id: "calendar", label: "Team Calendar", icon: "calendar" },
    { id: "approvals", label: "Approvals", icon: "inbox" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    { section: "Personal" },
    { id: "my-attendance", label: "My Attendance", icon: "calendar" },
    { id: "my-requests", label: "My Requests", icon: "clipboard" },
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
  live: ["Maugood", "Live Capture"],
  cameras: ["Maugood", "Cameras"],
  employees: ["Maugood", "People", "Employees"],
  policies: ["Maugood", "Configuration", "Shift Policies"],
  approvals: ["Maugood", "Workflow", "Approvals"],
  reports: ["Maugood", "Reports"],
  "former-employees": ["Maugood", "Reports", "Former employees seen"],
  "operations/workers": ["Maugood", "Operations", "Worker monitoring"],
  audit: ["Maugood", "System", "Audit Log"],
  settings: ["Maugood", "System", "Settings"],
  "my-attendance": ["Maugood", "Me", "Attendance"],
  "team-attendance": ["Maugood", "Team", "Attendance"],
  "my-requests": ["Maugood", "Me", "Requests"],
  "my-profile": ["Maugood", "Me", "Profile"],
  calendar: ["Maugood", "Attendance", "Calendar"],
  "employee-report": ["Maugood", "Reports", "Employee report"],
  "leave-policy": ["Maugood", "Configuration", "Leave & Calendar"],
  "daily-attendance": ["Maugood", "Attendance", "Daily"],
  "camera-logs": ["Maugood", "Attendance", "Camera logs"],
  "mgr-assign": ["Maugood", "People", "Manager assignments"],
  pipeline: ["Maugood", "How it works"],
  system: ["Maugood", "System", "Infrastructure"],
  "system-settings": ["Maugood", "System", "Detection & Tracker"],
  "api-docs": ["Maugood", "Developers", "API Reference"],
};

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
