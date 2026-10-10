// Topbar — breadcrumbs + notifications bell + user menu (identity,
// role switch, profile/settings, sign out with a confirmation dialog).
// Arabic toggle + dark mode + "New request" button still deferred per
// PROJECT_CONTEXT §8; the design references them but pilot scope is
// deliberately narrower. The bell ships in P20.
//
// P7: when the user holds more than one role, the role chip becomes a
// dropdown that calls ``POST /api/auth/switch-role`` and reloads. The
// reload is intentional (the prompt asks for it explicitly) — every
// page that reads ``me.active_role`` re-renders cleanly without
// piecemeal cache invalidation across the dozens of TanStack queries
// scattered through the feature folders.

import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate, NavLink } from "react-router-dom";

import productMark from "../assets/mts_mark.png";
import { useLogout, useSwitchRole } from "../auth/AuthProvider";
import { ModalShell } from "../components/DrawerShell";
import { getSidebar, subscribeSidebar, toggleSidebar } from "../sidebar";
import { SessionCountdown } from "../auth/SessionCountdown";
import { NotificationBell } from "../notifications/NotificationBell";
import type { MeResponse, Role } from "../types";
import { Icon } from "./Icon";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { CRUMBS, CRUMB_TARGETS } from "./nav";
import "./user-menu.css";


function initialsFor(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}

interface Props {
  pageId: string;
  role: Role;
  me: MeResponse;
}

export function Topbar({ pageId, role, me }: Props) {
  const navigate = useNavigate();
  const logout = useLogout();
  const { t } = useTranslation();
  // Detail routes (``employees/123``) reuse the list's trail + "Profile".
  // Managers arrive from My Team (they can't open the Admin/HR list), so
  // their trail runs through "My Team" instead of "Employees".
  const profileTrail =
    role === "Manager" ? CRUMBS["my-team"] : CRUMBS.employees;
  const crumbs =
    CRUMBS[pageId] ??
    (pageId.startsWith("employees/") && profileTrail
      ? [...profileTrail, "Profile"]
      : ["Maugood", pageId]);

  const onLogout = () => {
    logout.mutate(undefined, {
      onSettled: () => navigate("/login", { replace: true }),
    });
  };

  // Per-token translation — the raw English token is the i18n key under
  // ``nav.breadcrumbs``. Missing keys fall through to the raw token so
  // any new CRUMB entry still renders something readable.
  const translateCrumb = (token: string): string => {
    const key = `nav.breadcrumbs.${token}`;
    const out = t(key);
    return out === key ? token : out;
  };

  // Hamburger — the only control that collapses / expands the sidebar
  // rail (the LPA header keeps it at the leading edge; the rail itself
  // carries no toggle). ``aria-pressed`` reflects the collapsed state.
  const sidebarState = useSyncExternalStore(
    subscribeSidebar,
    getSidebar,
    getSidebar,
  );
  const sidebarCollapsed = sidebarState === "collapsed";
  const menuLabel = sidebarCollapsed
    ? t("common.expandSidebar")
    : t("common.collapseSidebar");

  return (
    <div className="topbar">
      <button
        type="button"
        className="topbar-menu-btn"
        onClick={() => {
          // Phones: the sidebar is an off-canvas drawer opened via the
          // ``mobile-nav-open`` class (styles-enhancements.css). Desktop:
          // collapse / expand the rail.
          if (window.matchMedia("(max-width: 900px)").matches) {
            document.querySelector(".app")?.classList.toggle("mobile-nav-open");
          } else {
            toggleSidebar();
          }
        }}
        aria-pressed={sidebarCollapsed}
        aria-label={menuLabel}
        title={menuLabel}
      >
        <Icon name="menu" size={16} />
      </button>
      <div className="crumbs">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          // Clickable when the token resolves to exactly one route and it
          // isn't the current page (last crumb). Otherwise plain text.
          const target = isLast ? undefined : CRUMB_TARGETS[c];
          return (
            <span
              key={`${i}-${c}`}
              className={isLast ? "crumb-current" : ""}
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              {i > 0 && (
                <span className="crumb-sep">
                  <Icon name="chevronRight" size={11} />
                </span>
              )}
              {target ? (
                <button
                  type="button"
                  className="crumb-link"
                  onClick={() => navigate(target)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    color: "inherit",
                    cursor: "pointer",
                    textDecoration: "none",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.textDecoration = "underline";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.textDecoration = "none";
                  }}
                >
                  {translateCrumb(c)}
                </button>
              ) : (
                translateCrumb(c)
              )}
            </span>
          );
        })}
      </div>

      {/* Right-side group: bell, theme/density, language, user menu.
          Role chip + identity + logout are now inside ``UserMenu``. */}
      <div
        style={{
          marginInlineStart: "auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <SessionCountdown />
        <NotificationBell />
        <LanguageSwitcher />
        <UserMenu
          role={role}
          me={me}
          onLogout={onLogout}
          loggingOut={logout.isPending}
        />
      </div>
    </div>
  );
}


// Vertical gap between the trigger button and the dropdown panel.
const MENU_GAP_PX = 8;
// Minimum margin from the viewport edge so the panel never overflows.
const VIEWPORT_MARGIN_PX = 8;
// Panel z-index. Must outrank Daily Attendance's sticky page header
// (zIndex 30) and any other sticky/fixed layer. Picked an order of
// magnitude higher so future stickies have headroom.
const MENU_Z_INDEX = 1000;

function UserMenu({
  role,
  me,
  onLogout,
  loggingOut,
}: {
  role: Role;
  me: MeResponse;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  const { t } = useTranslation();
  const switchRole = useSwitchRole();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Anchor rect drives the floating panel's ``position: fixed`` coords.
  // We snap it on open and re-measure on scroll/resize so the panel
  // tracks the trigger even when a sticky page header pushes content
  // around or the user resizes the viewport.
  const [anchor, setAnchor] = useState<{ top: number; left: number; right: number; width: number; height: number } | null>(null);

  const measure = () => {
    const el = buttonRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({
      top: r.top,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    });
  };

  // First measurement on open. ``useLayoutEffect`` so the portal paints
  // with the correct coords on the same frame — no flash at (0,0).
  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open]);

  // Close on outside click + on Escape; reposition on scroll/resize.
  // The scroll listener is on capture so it fires for ancestor
  // scrollers too (Daily Attendance's body scroll, anything else).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // Click inside the trigger or the portal panel is "inside" — do not close.
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onScrollOrResize = () => measure();
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    // ``capture: true`` so scroll events from inner scroll containers
    // still trigger a re-measure (Daily Attendance's content area
    // scrolls inside ``.main { overflow: hidden }``).
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  const available = me.available_roles ?? [];
  const multi = available.length > 1;

  const onPickRole = async (next: Role) => {
    if (next === role) {
      setOpen(false);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await switchRole.mutateAsync(next);
      // Explicit reload — every page reading ``me.active_role`` re-
      // renders cleanly without piecemeal cache invalidation.
      window.location.reload();
    } catch {
      setError(t("topbar.switchFailed") as string);
      setBusy(false);
    }
  };

  const initials = initialsFor(me.full_name);

  // Resolve the panel's fixed-position coords from the anchor rect.
  // RTL-aware: in ``dir="rtl"`` we align the panel's right edge to
  // the trigger's right edge; in LTR we align right edges too (the
  // original design pinned with ``insetInlineEnd: 0``). Either way
  // the panel is clamped inside the viewport with a small margin.
  const panelStyle = ((): CSSProperties => {
    if (!anchor) {
      // Off-screen placement during the first paint so React doesn't
      // briefly render at (0, 0). The useLayoutEffect immediately
      // updates ``anchor`` to the real coords.
      return { position: "fixed", top: -9999, left: -9999, visibility: "hidden" };
    }
    const top = Math.min(
      anchor.top + anchor.height + MENU_GAP_PX,
      window.innerHeight - VIEWPORT_MARGIN_PX,
    );
    // Anchor the panel by its trailing edge instead of computing ``left``
    // from a guessed width: on the first paint ``panelRef`` isn't attached
    // yet, so a width-based ``left`` let the panel run off the right edge
    // of the viewport. Pinning ``right`` (LTR) / ``left`` (RTL) to the
    // trigger's edge keeps it inside regardless of the rendered width.
    const isRtl = document.documentElement.dir === "rtl";
    const edge: CSSProperties = isRtl
      ? { left: Math.max(VIEWPORT_MARGIN_PX, anchor.left) }
      : { right: Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - anchor.right) };
    return {
      position: "fixed",
      top,
      ...edge,
      zIndex: MENU_Z_INDEX,
      maxWidth: `min(360px, calc(100vw - ${VIEWPORT_MARGIN_PX * 2}px))`,
      maxHeight: `calc(100vh - ${VIEWPORT_MARGIN_PX * 2}px)`,
    };
  })();

  return (
    <div style={{ display: "inline-block" }}>
      <button
        ref={buttonRef}
        type="button"
        className="um-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("topbar.userMenu")}
        title={me.full_name}
      >
        {initials}
      </button>

      {open && createPortal(
        <div ref={panelRef} role="menu" aria-label={t("topbar.userMenu")} className="um-panel" style={panelStyle}>
          {/* Identity: "Signed in as" + role, then avatar · name · email */}
          <div className="um-head">
            <div className="um-head-row">
              <span className="um-eyebrow">{t("topbar.signedInAs", { defaultValue: "Signed in as" })}</span>
              <span className="um-role">
                <span className="um-role-dot" aria-hidden />
                {t(`roles.${role}`, { defaultValue: role })}
              </span>
            </div>
            <div className="um-identity">
              <span className="um-avatar" aria-hidden>{initials}</span>
              <span className="um-identity-text">
                <span className="um-name">{me.full_name}</span>
                <span className="um-email">{me.email}</span>
              </span>
            </div>
          </div>

          {/* Role switcher (only when multiple roles available). */}
          {multi && (
            <div className="um-section">
              <div className="um-section-label">{t("topbar.switchRole")}</div>
              {available.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => void onPickRole(r)}
                  disabled={busy}
                  role="menuitemradio"
                  aria-checked={r === role}
                  className={`um-item${r === role ? " is-current" : ""}`}
                >
                  <Icon name="user" size={14} />
                  <span className="um-item-label">{t(`roles.${r}`, { defaultValue: r })}</span>
                  {r === role && <span className="um-item-meta">{t("topbar.active")}</span>}
                </button>
              ))}
              {error && <div className="um-error">{error}</div>}
            </div>
          )}

          <div className="um-section">
            <NavLink to="/settings" role="menuitem" className="um-item" onClick={() => setOpen(false)}>
              <Icon name="settings" size={14} />
              <span className="um-item-label">{t("topbar.settings")}</span>
              <span className="um-item-chev" aria-hidden><Icon name="chevronRight" size={13} /></span>
            </NavLink>
          </div>

          <div className="um-section">
            <button
              type="button"
              role="menuitem"
              className="um-item is-danger"
              onClick={() => {
                setOpen(false);
                setConfirmOpen(true);
              }}
              disabled={loggingOut}
            >
              <Icon name="logout" size={14} />
              <span className="um-item-label">{t("topbar.logout")}</span>
            </button>
          </div>
        </div>,
        document.body,
      )}

      {confirmOpen && (
        <SignOutDialog
          busy={loggingOut}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={onLogout}
        />
      )}
    </div>
  );
}

/** "Sign out?" confirmation — shown before the session is ended. */
function SignOutDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  // The shared ModalShell deliberately ignores Escape; for this simple
  // yes/no question Escape means "Stay signed in".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return (
    <ModalShell onClose={() => { if (!busy) onCancel(); }}>
      <div className="um-modal-host">
        <div role="alertdialog" aria-modal="true" aria-labelledby="um-signout-title" aria-describedby="um-signout-body" className="modal um-signout">
          <button type="button" className="icon-btn um-signout-x" onClick={onCancel} disabled={busy} aria-label={t("common.close", { defaultValue: "Close" })}>
            <Icon name="x" size={15} />
          </button>
          <img src={productMark} alt="" className="um-signout-mark" />
          <h2 id="um-signout-title" className="um-signout-title">{t("topbar.signOut.title", { defaultValue: "Sign out?" })}</h2>
          <p id="um-signout-body" className="um-signout-body">
            {t("topbar.signOut.body", { defaultValue: "Your session will end on this device. You'll need to sign in again to continue." })}
          </p>
          <div className="um-signout-note">
            <Icon name="info" size={15} />
            <span>{t("topbar.signOut.note", { defaultValue: "Any unsaved changes on the current page will be lost." })}</span>
          </div>
          <div className="um-signout-actions">
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              {t("topbar.signOut.stay", { defaultValue: "Stay signed in" })}
            </button>
            <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
              <Icon name="logout" size={14} />
              {busy ? t("topbar.loggingOut") : t("topbar.signOut.confirm", { defaultValue: "Sign out" })}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// P28.5d: ``RoleChip`` and the standalone ``RoleSwitcher`` were
// folded into ``UserMenu`` above — one dropdown for identity +
// settings + logout + role switching. The pilot's accent-coloured
// nav-badge role chip was visible in the topbar's right cluster
// alongside the name and Logout button; that cluster is gone now.
