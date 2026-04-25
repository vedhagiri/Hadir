// Shared sub-nav for the Settings hub. Each settings page renders this
// at the top so the operator can hop between Branding, Authentication,
// and Custom Fields without going back to the sidebar.

import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/settings/branding", label: "Branding" },
  { to: "/settings/authentication", label: "Authentication" },
  { to: "/settings/custom-fields", label: "Custom fields" },
  { to: "/settings/reason-categories", label: "Request reasons" },
  { to: "/settings/email", label: "Email" },
  { to: "/settings/schedules", label: "Schedules" },
  { to: "/settings/erp-export", label: "ERP export" },
  { to: "/settings/notifications", label: "Notifications" },
] as const;

export function SettingsTabs() {
  return (
    <nav
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--border)",
        marginBottom: 8,
      }}
      aria-label="Settings sections"
    >
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          style={({ isActive }) => ({
            padding: "8px 12px",
            fontSize: 13,
            color: isActive ? "var(--text)" : "var(--text-secondary)",
            borderBottom: isActive
              ? "2px solid var(--accent)"
              : "2px solid transparent",
            textDecoration: "none",
            fontWeight: isActive ? 600 : 400,
            marginBottom: -1,
          })}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
