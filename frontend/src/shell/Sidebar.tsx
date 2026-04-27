// Role-aware sidebar.
// Structure matches frontend/src/design/shell.jsx — brand header, scrolling
// nav list with section labels + items + badges, footer with the logged-in
// user's identity. The design's role switcher in the footer is deferred
// to v1.0 (PROJECT_CONTEXT §8) — we render a static identity card in its
// place and put the logout button in the topbar.

import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";

import { useInboxSummary } from "../requests/hooks";
import {
  getSidebar,
  subscribeSidebar,
  toggleSidebar,
  type SidebarState,
} from "../sidebar";
import type { Role } from "../types";
import { Icon } from "./Icon";
import { NAV } from "./nav";


function useSidebarState(): SidebarState {
  return useSyncExternalStore(subscribeSidebar, getSidebar, getSidebar);
}

// Map English section labels (the design source) to i18n keys under
// nav.sections. Anything not in the map falls back to its English
// label — that keeps the sidebar functional even if a future NAV
// section name slips in without a matching key.
const SECTION_KEY: Record<string, string> = {
  Overview: "overview",
  Operations: "operations",
  Attendance: "attendance",
  Workflow: "workflow",
  System: "system",
  People: "people",
  Team: "team",
  Personal: "personal",
  Me: "me",
};

interface Props {
  role: Role;
}

export function Sidebar({ role }: Props) {
  const { t } = useTranslation();
  const items = NAV[role];
  const sidebarState = useSidebarState();
  const collapsed = sidebarState === "collapsed";
  // Only Manager / HR / Admin have an Approvals link; Employees don't,
  // so we skip the inbox query for them.
  const approvalsRoles = role === "Admin" || role === "HR" || role === "Manager";
  const inbox = useInboxSummary();
  const inboxBadge = approvalsRoles && inbox.data
    ? inbox.data.pending_count > 0
      ? String(inbox.data.pending_count)
      : null
    : null;
  const inboxBreached =
    approvalsRoles && (inbox.data?.breached_count ?? 0) > 0;
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">ح</div>
        <div className="brand-name">Hadir</div>
        {/* P28.5d: collapse/expand toggle in the top-right of the
            brand row, replacing the version chip. ">" when expanded
            (clicking collapses); "<" when collapsed (clicking
            expands). Tooltip + aria-label carry the action verb so
            screen readers and hover users get the same affordance. */}
        <button
          type="button"
          className="sidebar-toggle"
          onClick={toggleSidebar}
          aria-pressed={collapsed}
          aria-label={
            collapsed
              ? t("common.expandSidebar")
              : t("common.collapseSidebar")
          }
          title={
            collapsed
              ? t("common.expandSidebar")
              : t("common.collapseSidebar")
          }
        >
          <Icon name={collapsed ? "chevronLeft" : "chevronRight"} size={12} />
        </button>
      </div>

      {/* Search is decorative in P4 — real search lands with employees (P6). */}
      <div
        className="topbar-search sidebar-search"
        style={{ width: "100%", margin: "0 0 6px" }}
      >
        <Icon name="search" size={13} />
        <input placeholder={t("common.search")} />
        <span className="kbd">⌘K</span>
      </div>

      {items.map((it, i) => {
        if ("section" in it) {
          const key = SECTION_KEY[it.section];
          const label = key ? t(`nav.sections.${key}`) : it.section;
          return (
            <div
              key={`s-${i}`}
              className="nav-label"
              style={{ marginTop: i === 0 ? 8 : 12 }}
            >
              {label}
            </div>
          );
        }
        // P15: live badge for the Approvals item (counts "pending my
        // decision"). Falls back to the static design-archive value
        // for everything else.
        const liveBadge = it.id === "approvals" ? inboxBadge : null;
        const badge = liveBadge ?? it.badge ?? null;
        const breached = it.id === "approvals" && inboxBreached;
        // Translate the nav item via its id; fall back to the design
        // label if the i18n key is missing (defensive — the lint test
        // catches any new id without a key).
        const navKey = `nav.items.${it.id}`;
        const translated = t(navKey);
        const label = translated === navKey ? it.label : translated;
        return (
          <NavLink
            key={it.id}
            to={`/${it.id}`}
            className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            // P28.5d: when the sidebar is collapsed the label is
            // hidden via CSS — surface it as a native tooltip so the
            // user can still tell what each icon does on hover.
            title={collapsed ? label : undefined}
          >
            <Icon name={it.icon} size={14} />
            <span className="nav-label-text">{label}</span>
            {badge && (
              <span
                className="nav-badge"
                style={
                  breached
                    ? {
                        background: "var(--danger-bg)",
                        color: "var(--danger-text)",
                      }
                    : undefined
                }
              >
                {badge}
              </span>
            )}
          </NavLink>
        );
      })}

      {/* P28.5d: user identity + Settings + Logout moved to a Topbar
          dropdown (``UserMenu`` in shell/Topbar.tsx). The sidebar
          footer is gone — clearer hierarchy, matches the design
          archive's intent of putting per-session controls on the
          top bar rather than nested in the navigation. */}
    </aside>
  );
}
