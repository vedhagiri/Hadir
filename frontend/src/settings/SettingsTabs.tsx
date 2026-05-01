// Shared sub-nav for the Settings hub. Each settings page renders this
// at the top so the operator can hop between Branding, Authentication,
// and Custom Fields without going back to the sidebar.

import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";

import { useMe } from "../auth/AuthProvider";

const TABS = [
  { to: "/settings/workspace", key: "workspace" },
  { to: "/settings/branding", key: "branding" },
  { to: "/settings/authentication", key: "authentication" },
  { to: "/settings/divisions", key: "divisions" },
  { to: "/settings/departments", key: "departments" },
  { to: "/settings/sections", key: "sections" },
  { to: "/settings/custom-fields", key: "customFields" },
  { to: "/settings/reason-categories", key: "reasonCategories" },
  { to: "/settings/email", key: "email" },
  { to: "/settings/schedules", key: "schedules" },
  { to: "/settings/erp-export", key: "erpExport" },
  { to: "/settings/notifications", key: "notifications" },
  { to: "/settings/display", key: "display" },
] as const;

// HR sees the org-structure tabs only — the rest are operator/admin
// surfaces (branding, OIDC, email/Graph creds, schedules, ERP, etc.)
// that should stay behind the Admin role.
const HR_TABS: ReadonlyArray<(typeof TABS)[number]["key"]> = [
  "divisions",
  "departments",
  "sections",
];

export function SettingsTabs() {
  const { t } = useTranslation();
  const me = useMe();
  const role = me.data?.active_role ?? null;
  const visibleTabs =
    role === "Admin"
      ? TABS
      : TABS.filter((tab) => HR_TABS.includes(tab.key));
  return (
    <nav
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--border)",
        marginBottom: 8,
      }}
      aria-label={t("nav.items.settings")}
    >
      {visibleTabs.map((tab) => (
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
          {t(`settings.tabs.${tab.key}`)}
        </NavLink>
      ))}
    </nav>
  );
}
