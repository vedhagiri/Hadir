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
    { id: "cameras", label: "Cameras", icon: "camera", badge: "8" },
    { id: "employees", label: "Employees", icon: "users", badge: "106" },
    { id: "enrollment", label: "Enrollment", icon: "upload" },
    { id: "policies", label: "Shift Policies", icon: "clock" },
    { id: "leave-policy", label: "Leave & Calendar", icon: "calendar" },
    { section: "Attendance" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    { id: "camera-logs", label: "Camera Logs", icon: "camera" },
    { id: "pipeline", label: "How it works", icon: "sparkles" },
    { section: "Workflow" },
    { id: "approvals", label: "Approvals", icon: "inbox", badge: "4" },
    { id: "reports", label: "Reports", icon: "fileText" },
    { id: "employee-report", label: "Employee report", icon: "user" },
    { id: "mgr-assign", label: "Manager assignments", icon: "users" },
    { id: "audit", label: "Audit Log", icon: "shield" },
    { section: "System" },
    { id: "system", label: "System & Infra", icon: "activity" },
    { id: "system-settings", label: "Detection & Tracker", icon: "settings" },
    { id: "api-docs", label: "API Reference", icon: "fileText" },
    { id: "settings", label: "Settings & custom fields", icon: "settings" },
  ],
  HR: [
    { section: "Overview" },
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { section: "People" },
    { id: "employees", label: "Employees", icon: "users", badge: "106" },
    { id: "enrollment", label: "Enrollment", icon: "upload" },
    { id: "employee-report", label: "Employee report", icon: "user" },
    { section: "Workflow" },
    { id: "approvals", label: "Approvals", icon: "inbox", badge: "4" },
    { id: "policies", label: "Shift Policies", icon: "clock" },
    { id: "leave-policy", label: "Leave & Calendar", icon: "calendar" },
    { id: "reports", label: "Reports", icon: "fileText" },
    { section: "Attendance" },
    { id: "daily-attendance", label: "Daily Attendance", icon: "fileText" },
    { id: "camera-logs", label: "Camera Logs", icon: "camera" },
    { id: "mgr-assign", label: "Manager assignments", icon: "users" },
    { id: "pipeline", label: "How it works", icon: "sparkles" },
    { id: "api-docs", label: "API Reference", icon: "fileText" },
    { section: "System" },
    { id: "settings", label: "Settings & custom fields", icon: "settings" },
    { section: "Personal" },
    { id: "my-attendance", label: "My Attendance", icon: "calendar" },
  ],
  Manager: [
    { section: "Team" },
    { id: "dashboard", label: "Team Today", icon: "home" },
    { id: "team-attendance", label: "Team Attendance", icon: "users" },
    { id: "calendar", label: "Team Calendar", icon: "calendar" },
    { id: "approvals", label: "Approvals", icon: "inbox", badge: "2" },
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
  dashboard: ["Hadir", "Dashboard"],
  live: ["Hadir", "Live Capture"],
  cameras: ["Hadir", "Cameras"],
  employees: ["Hadir", "People", "Employees"],
  enrollment: ["Hadir", "People", "Enrollment"],
  policies: ["Hadir", "Configuration", "Shift Policies"],
  approvals: ["Hadir", "Workflow", "Approvals"],
  reports: ["Hadir", "Reports"],
  audit: ["Hadir", "System", "Audit Log"],
  settings: ["Hadir", "System", "Settings"],
  "my-attendance": ["Hadir", "Me", "Attendance"],
  "team-attendance": ["Hadir", "Team", "Attendance"],
  "my-requests": ["Hadir", "Me", "Requests"],
  "my-profile": ["Hadir", "Me", "Profile"],
  calendar: ["Hadir", "Attendance", "Calendar"],
  "employee-report": ["Hadir", "Reports", "Employee report"],
  "leave-policy": ["Hadir", "Configuration", "Leave & Calendar"],
  "daily-attendance": ["Hadir", "Attendance", "Daily"],
  "camera-logs": ["Hadir", "Attendance", "Camera logs"],
  "mgr-assign": ["Hadir", "People", "Manager assignments"],
  pipeline: ["Hadir", "How it works"],
  system: ["Hadir", "System", "Infrastructure"],
  "system-settings": ["Hadir", "System", "Detection & Tracker"],
  "api-docs": ["Hadir", "Developers", "API Reference"],
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
