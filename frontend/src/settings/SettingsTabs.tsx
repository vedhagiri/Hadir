// Settings hub shell: a grouped vertical sub-nav on the inline-start
// side and the active settings page beside it (the Stripe / GitHub /
// Linear pattern). Mounted once as a layout route around every
// ``/settings/*`` route in App.tsx, so individual pages render only
// their own header + cards.
//
// Groups: Workspace · Access · Delivery · Data · Personal. Role
// filtering hides items (and empty groups) a role can't open; the
// route guards in App.tsx remain the real gate. Below 1000 px the nav
// folds into a horizontally scrollable strip above the page.

import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router-dom";

import { useMe } from "../auth/AuthProvider";
import { Icon, type IconName } from "../shell/Icon";

import "./settings.css";

type TabKey =
  | "workspace"
  | "branding"
  | "authentication"
  | "divisions"
  | "departments"
  | "sections"
  | "customFields"
  | "reasonCategories"
  | "email"
  | "schedules"
  | "erpExport"
  | "notifications"
  | "display";

interface Tab {
  to: string;
  key: TabKey;
  icon: IconName;
  hint: string;
}

interface TabGroup {
  key: "workspace" | "access" | "delivery" | "data" | "personal";
  tabs: readonly Tab[];
}

const GROUPS: readonly TabGroup[] = [
  {
    key: "workspace",
    tabs: [
      { to: "/settings/workspace", key: "workspace", icon: "globe", hint: "Timezone, date & weekend" },
      { to: "/settings/branding", key: "branding", icon: "sparkles", hint: "Logo, colour & font" },
    ],
  },
  {
    key: "access",
    tabs: [{ to: "/settings/authentication", key: "authentication", icon: "shield", hint: "Microsoft & Google sign-in" }],
  },
  {
    key: "delivery",
    tabs: [
      { to: "/settings/email", key: "email", icon: "mail", hint: "SMTP / Microsoft Graph" },
      { to: "/settings/schedules", key: "schedules", icon: "clock", hint: "Recurring report emails" },
      { to: "/settings/erp-export", key: "erpExport", icon: "database", hint: "File drop for payroll" },
    ],
  },
  {
    key: "data",
    tabs: [
      { to: "/settings/divisions", key: "divisions", icon: "home", hint: "Top-level org units" },
      { to: "/settings/departments", key: "departments", icon: "users", hint: "Teams & managers" },
      { to: "/settings/sections", key: "sections", icon: "clipboard", hint: "Sub-units of departments" },
      { to: "/settings/custom-fields", key: "customFields", icon: "edit", hint: "Extra employee fields" },
      { to: "/settings/reason-categories", key: "reasonCategories", icon: "inbox", hint: "Leave & exception reasons" },
    ],
  },
  {
    key: "personal",
    tabs: [
      { to: "/settings/notifications", key: "notifications", icon: "bell", hint: "What you get alerted about" },
      { to: "/settings/display", key: "display", icon: "sun", hint: "Theme & density" },
    ],
  },
] as const;

// HR sees the org-structure tabs only — the rest are operator/admin
// surfaces (branding, OIDC, email/Graph creds, schedules, ERP, etc.)
// that should stay behind the Admin role.
const HR_TABS: ReadonlyArray<TabKey> = [
  "divisions",
  "departments",
  "sections",
  // BUG-050 — HR can also tweak their per-user preferences here.
  "notifications",
  "display",
];

// BUG-050 — Manager + Employee only get the per-user preference tabs.
const PER_USER_TABS: ReadonlyArray<TabKey> = ["notifications", "display"];

const GROUP_DEFAULTS: Record<TabGroup["key"], string> = {
  workspace: "Workspace",
  access: "Access",
  delivery: "Delivery",
  data: "Organisation data",
  personal: "Personal",
};

function SettingsNav() {
  const { t } = useTranslation();
  const me = useMe();
  const role = me.data?.active_role ?? null;
  const allowed = (key: TabKey) =>
    role === "Admin" ? true : role === "HR" ? HR_TABS.includes(key) : PER_USER_TABS.includes(key);

  const groups = GROUPS.map((g) => ({ ...g, tabs: g.tabs.filter((tab) => allowed(tab.key)) })).filter(
    (g) => g.tabs.length > 0,
  );

  return (
    <nav className="st-nav" aria-label={t("nav.items.settings")}>
      <div className="st-nav-head">
        <span className="st-nav-head-icon" aria-hidden>
          <Icon name="settings" size={16} />
        </span>
        <span className="st-nav-title">{t("nav.items.settings")}</span>
      </div>
      {groups.map((g) => {
        const label = t(`settings.groups.${g.key}`, { defaultValue: GROUP_DEFAULTS[g.key] });
        return (
          <div key={g.key} className="st-nav-group" role="group" aria-label={label}>
            <div className="st-nav-group-label" aria-hidden>
              {label}
            </div>
            {g.tabs.map((tab) => (
              <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `st-nav-item${isActive ? " active" : ""}`}>
                <span className="st-nav-icon" aria-hidden>
                  <Icon name={tab.icon} size={15} />
                </span>
                <span className="st-nav-text">
                  <span className="st-nav-label">{t(`settings.tabs.${tab.key}`)}</span>
                  <span className="st-nav-hint">
                    {t(`settings.hints.${tab.key}`, { defaultValue: tab.hint })}
                  </span>
                </span>
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}

/** Layout route for every ``/settings/*`` page. */
export function SettingsShell() {
  return (
    <div className="st-shell">
      <SettingsNav />
      <div className="st-main">
        <Outlet />
      </div>
    </div>
  );
}
