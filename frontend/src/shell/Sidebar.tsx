// Role-aware sidebar.
// Structure matches frontend/src/design/shell.jsx — brand header, scrolling
// nav list with section labels + items + badges, footer with the logged-in
// user's identity. The design's role switcher in the footer is deferred
// to v1.0 (PROJECT_CONTEXT §8) — we render a static identity card in its
// place and put the logout button in the topbar.

import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { NavLink } from "react-router-dom";

import omranLogo from "../assets/omran_logo.png";
import { APP_VERSION_FULL } from "../config";
import { SPRING } from "../motion/tokens";
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
  Help: "help",
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
        <img
          src={omranLogo}
          alt="Omran"
          className="brand-logo"
          style={{
            width: 28,
            height: 28,
            objectFit: "contain",
            flexShrink: 0,
          }}
        />
        <div className="brand-name">Omran</div>
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

      {/* Scrollable nav block — flex:1 grabs the remaining height,
          overflow-y:auto lets long nav lists (e.g. Settings tabs)
          scroll inside the sidebar without clipping the bottom items. */}
      <div
        className="sidebar-nav"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
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
        // Approvals (P15) is the only nav item with a live count — it
        // signals pending work. Cameras / Employees count badges were
        // pulled because operators read them as decoration rather than
        // signal. The static ``it.badge`` from ``nav.ts`` still drives
        // tags like "LIVE" on Live Capture.
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
            className={({ isActive }) =>
              `nav-item${isActive ? " active" : ""}`
            }
            // P28.5d: when the sidebar is collapsed the label is
            // hidden via CSS — surface it as a native tooltip so the
            // user can still tell what each icon does on hover.
            title={collapsed ? label : undefined}
            style={{ position: "relative" }}
          >
            {({ isActive }) => (
              <>
                {/* Active indicator — Framer's ``layoutId`` makes the
                    bar slide between items rather than disappearing
                    + reappearing. The single shared id is what does
                    the magic. Always plays even with reduced motion
                    (short, spatial cue — see useReducedMotion). */}
                {isActive && (
                  <motion.span
                    layoutId="sidebar-active-indicator"
                    aria-hidden
                    style={{
                      position: "absolute",
                      insetInlineStart: 0,
                      top: 4,
                      bottom: 4,
                      width: 3,
                      background: "var(--accent)",
                      borderRadius: "0 2px 2px 0",
                    }}
                    transition={SPRING.gentle}
                  />
                )}
                <Icon name={it.icon} size={17} />
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
              </>
            )}
          </NavLink>
        );
      })}

      </div>
      {/* P28.5d: user identity + Settings + Logout moved to a Topbar
          dropdown (``UserMenu`` in shell/Topbar.tsx). The sidebar
          footer is gone — clearer hierarchy, matches the design
          archive's intent of putting per-session controls on the
          top bar rather than nested in the navigation. */}
      <div
        className="sidebar-footer"
        style={{
          fontSize: 11,
          color: "var(--muted)",
          textAlign: "center",
          lineHeight: 1.4,
        }}
      >
        {/* "Made with ♥ in Oman" tagline + flag. Hidden when the
            sidebar is collapsed via .nav-label-text (the same hide
            class the rest of the footer uses). */}
        <div
          className="nav-label-text"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            marginBottom: 4,
            fontSize: 10.5,
            color: "var(--text-tertiary)",
          }}
        >
          <span aria-hidden style={{ fontSize: 24, lineHeight: 1 }}>
            🇴🇲
          </span>
          <span>Made with ♥ in Oman</span>
        </div>
        <div className="nav-label-text">
          Powered by{" "}
          <span style={{ fontWeight: 600 }}>Muscat Tech Solutions</span>
        </div>
        <div style={{ marginTop: 2, opacity: 0.8 }}>
          <span className="nav-label-text">Maugood </span>
          v{APP_VERSION_FULL}
        </div>
      </div>
    </aside>
  );
}
