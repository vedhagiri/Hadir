// Role-aware sidebar.
// Structure matches frontend/src/design/shell.jsx — brand header, scrolling
// nav list with section labels + items + badges, footer with the product
// identity. The rail format follows the BankStatementIQ (LPA) sidebar:
//
//   * the collapse control is the hamburger in the Topbar, not a button
//     in the brand row;
//   * each section heading folds its links away (chevron), remembered
//     per section in localStorage via ``sidebar/index.ts``;
//   * collapsed = a 64 px icon rail with hairline dividers between
//     sections, a styled tooltip per row, and the footer's build details
//     behind an info icon.
//
// Styling for all of that lives in ``shell/sidebar-rail.css``; the design
// CSS under ``styles/`` is untouched.

import { useState, useSyncExternalStore } from "react";
import type { FocusEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { NavLink } from "react-router-dom";

import productLogo from "../assets/mts_logo.png";
import productMark from "../assets/mts_mark.png";
import maugoodAiLogo from "../assets/maugoodai_logo.png";
import { useMe } from "../auth/AuthProvider";
import { APP_RELEASED_ON, APP_VERSION_FULL } from "../config";
import { SPRING } from "../motion/tokens";
import { useInboxSummary } from "../requests/hooks";
import {
  getSidebar,
  getSidebarGroups,
  subscribeSidebar,
  toggleSidebarGroup,
  type SidebarGroups,
  type SidebarState,
} from "../sidebar";
import type { Role } from "../types";
import { Icon } from "./Icon";
import { HIDE_PERSON_CLIPS } from "../config";
import { NAV, type NavItem } from "./nav";
import "./sidebar-rail.css";


function useSidebarState(): SidebarState {
  return useSyncExternalStore(subscribeSidebar, getSidebar, getSidebar);
}

function useSidebarGroups(): SidebarGroups {
  return useSyncExternalStore(
    subscribeSidebar,
    getSidebarGroups,
    getSidebarGroups,
  );
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

type NavLeaf = Exclude<NavItem, { section: string }>;

interface NavGroup {
  /** English section label from nav.ts — doubles as the storage key. */
  section: string | null;
  items: NavLeaf[];
}

/** Fold the flat NAV list into one group per section heading. */
function groupNav(items: NavItem[]): NavGroup[] {
  const groups: NavGroup[] = [];
  let current: NavGroup | null = null;
  for (const it of items) {
    if ("section" in it) {
      current = { section: it.section, items: [] };
      groups.push(current);
      continue;
    }
    if (current === null) {
      current = { section: null, items: [] };
      groups.push(current);
    }
    current.items.push(it);
  }
  return groups.filter((g) => g.items.length > 0);
}

interface Props {
  role: Role;
}

export function Sidebar({ role }: Props) {
  const { t } = useTranslation();
  // Apply env-driven hides before the role's nav reaches the renderer.
  // ``HIDE_PERSON_CLIPS`` from ``VITE_HIDE_PERSON_CLIPS`` strips the
  // Person Clips entry without touching the route or the design's NAV
  // source-of-truth.
  const items = NAV[role].filter((it) => {
    if ("section" in it) return true;
    if (HIDE_PERSON_CLIPS && it.id === "person-clips") return false;
    return true;
  });
  const groups = groupNav(items);
  const sidebarState = useSidebarState();
  const collapsed = sidebarState === "collapsed";
  const openGroups = useSidebarGroups();

  // Tooltip for the collapsed rail, replacing the native ``title``
  // (unstyled, and it waits about a second). One shared fixed element
  // positioned from the hovered row's rect — anything positioned inside
  // a row is clipped by the sidebar's overflow.
  const [tip, setTip] = useState<{ label: string; top: number } | null>(
    null,
  );
  const showTip = (
    ev: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>,
    label: string,
  ) => {
    if (!collapsed) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    setTip({ label, top: rect.top + rect.height / 2 });
  };
  const hideTip = () => setTip(null);

  // Brand row reads ``tenant_name`` from /api/auth/me — the value the
  // operator's setup wizard wrote into ``public.tenants.name``. We
  // fall back to the product name ("Maugood") when empty so a fresh
  // install (migration 0001 seeds an empty string) still renders a
  // sensible brand instead of a blank.
  const me = useMe();
  const brandName = (me.data?.tenant_name?.trim() || "Maugood");
  // When the operator uploaded a tenant logo through Settings →
  // Branding, the brand row shows it instead of the static product
  // mark. The ``?v=…`` cache-buster comes from the row's updated_at
  // timestamp so a fresh upload pulls a fresh image even when the
  // browser ignored Cache-Control: no-store.
  const tenantLogoSrc = me.data?.has_brand_logo
    ? `/api/branding/logo?v=${encodeURIComponent(
        me.data.brand_logo_version ?? "",
      )}`
    : null;
  // Wide lockup on the open sidebar, square mark on the 64 px rail —
  // the same brand at two sizes, as the LPA rail does. A tenant upload
  // is used in both states (it is whatever shape the operator chose).
  const brandLogoSrc =
    tenantLogoSrc ?? (collapsed ? productMark : productLogo);
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

  const sectionLabel = (section: string): string => {
    const key = SECTION_KEY[section];
    return key ? t(`nav.sections.${key}`) : section;
  };

  const renderItem = (it: NavLeaf) => {
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
        aria-label={collapsed ? label : undefined}
        onMouseEnter={(ev) => showTip(ev, label)}
        onMouseLeave={hideTip}
        onFocus={(ev) => showTip(ev, label)}
        onBlur={hideTip}
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
  };

  // Build attribution + version, in the LPA footer format: product
  // logo, vendor mark + name, Version, Released on (when the build
  // knows it), © line.
  // Rendered in two places: the expanded footer, and the collapsed
  // rail's info popover.
  const releasedOn = APP_RELEASED_ON
    ? new Date(APP_RELEASED_ON).toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      })
    : null;
  const buildDetails = (
    <>
      {/* Product logo — Maugood's own mark leads the footer; the vendor
          credit sits on the © line below. */}
      <img
        src={maugoodAiLogo}
        alt="MaugoodAI — CCTV-Based AI Attendance System"
        style={{ width: "100%", maxWidth: 170, height: "auto", display: "block", margin: "0 auto 6px" }}
      />
      <a
        href="https://mts-om.com/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text)",
        }}
      >
        <img
          src={productMark}
          alt=""
          aria-hidden
          style={{ height: 14, width: "auto", display: "block" }}
        />
        <span>Muscat Tech Solutions</span>
      </a>
      <div style={{ marginTop: 3, fontSize: 12, color: "var(--text-secondary)" }}>
        Version {APP_VERSION_FULL}
      </div>
      {releasedOn && (
        <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-tertiary)" }}>
          Released on {releasedOn}
        </div>
      )}
      <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-tertiary)" }}>
        © {new Date().getFullYear()} Powered by MTS
      </div>
    </>
  );

  return (
    <aside className="sidebar">
      {/* Brand row — logo only, centred, sharing the topbar's height so
          the two meet on one baseline (see sidebar-rail.css). The tenant
          name is not rendered here; it stays as the image's alt text.
          The hamburger in the Topbar is the only toggle. */}
      <div className="sidebar-brand">
        <img
          src={brandLogoSrc}
          alt={brandName}
          className="brand-logo"
          style={{
            width: 28,
            height: 28,
            objectFit: "contain",
            flexShrink: 0,
          }}
        />
      </div>

      {/* Scrollable nav block — flex:1 grabs the remaining height,
          overflow-y:auto lets long nav lists (e.g. Settings tabs)
          scroll inside the sidebar without clipping the bottom items. */}
      <nav
        className="sidebar-nav"
        aria-label={t("nav.ariaLabel", { defaultValue: "Sidebar navigation" })}
        onScroll={hideTip}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {groups.map((g, gi) => {
          const key = g.section ?? `__ungrouped-${gi}`;
          // The first section (Overview) is a plain heading in the LPA
          // rail; every later section folds. Absent from the map means
          // open, so only an explicit collapse is remembered.
          const foldable = g.section !== null && gi > 0;
          const open = !foldable || openGroups[key] !== false;
          return (
            <div key={key} className="nav-section">
              {g.section !== null && (
                foldable ? (
                  <button
                    type="button"
                    className="nav-group-toggle"
                    onClick={() => toggleSidebarGroup(key)}
                    aria-expanded={open}
                  >
                    <span>{sectionLabel(g.section)}</span>
                    <Icon
                      name="chevronDown"
                      size={12}
                      className="nav-group-chevron"
                    />
                  </button>
                ) : (
                  <div className="nav-label">{sectionLabel(g.section)}</div>
                )
              )}
              <div className="nav-group-panel" data-open={open}>
                <div>{g.items.map(renderItem)}</div>
              </div>
            </div>
          );
        })}
      </nav>

      {/* Expanded footer. Hidden entirely when collapsed (CSS) — the
          same details move behind the info icon below. */}
      <div
        className="sidebar-footer"
        style={{
          textAlign: "center",
          lineHeight: 1.4,
          padding: "12px 12px 14px",
          borderTop: "1px solid var(--border)",
          // The .sidebar container has ``padding: 12px 10px`` (see
          // styles.css). Negative margins on the footer break out of
          // that padding so the rule spans edge-to-edge.
          marginInline: "-10px",
          marginBottom: "-12px",
        }}
      >
        {buildDetails}
      </div>

      {/* Collapsed rail: the same build details behind an info icon,
          shown on hover / focus. A 64 px column has no room for four
          lines of text, but the version is what people come to the
          footer for, so it stays reachable. */}
      <div className="sidebar-info">
        <button
          type="button"
          className="sidebar-info-btn"
          aria-label={t("common.buildInfo")}
          tabIndex={collapsed ? 0 : -1}
        >
          <Icon name="info" size={18} />
        </button>
        <div className="sidebar-info-pop" role="tooltip">
          {buildDetails}
        </div>
      </div>

      {/* Collapsed-rail label — one element for the whole rail, moved
          to the hovered row. See ``tip`` above for why it is fixed. */}
      {tip && (
        <div className="sidebar-tip" role="tooltip" style={{ top: tip.top }}>
          {tip.label}
        </div>
      )}
    </aside>
  );
}
