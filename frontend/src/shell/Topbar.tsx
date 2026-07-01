// Topbar — breadcrumbs + role chip + notifications bell + logout.
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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate, NavLink } from "react-router-dom";

import { useLogout, useSwitchRole } from "../auth/AuthProvider";
import { SessionCountdown } from "../auth/SessionCountdown";
import { NotificationBell } from "../notifications/NotificationBell";
import type { MeResponse, Role } from "../types";
import { Icon } from "./Icon";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { CRUMBS, CRUMB_TARGETS } from "./nav";


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
  const crumbs = CRUMBS[pageId] ?? ["Maugood", pageId];

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

  return (
    <div className="topbar">
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
// Approximate panel width used by the initial RTL/LTR clamp before
// the first layout measurement. Matches the ``minWidth`` in the
// rendered panel; small enough that an off-by-a-few-px first paint
// is invisible to the eye.
const MENU_APPROX_WIDTH_PX = 240;

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
    // Read the panel's actual width once it's measured, otherwise use the approx.
    const measuredWidth = panelRef.current?.offsetWidth ?? MENU_APPROX_WIDTH_PX;
    // Right-align with the trigger's right edge by default.
    let left = anchor.right - measuredWidth;
    // Clamp into viewport with the margin.
    if (left < VIEWPORT_MARGIN_PX) left = VIEWPORT_MARGIN_PX;
    if (left + measuredWidth > window.innerWidth - VIEWPORT_MARGIN_PX) {
      left = Math.max(
        VIEWPORT_MARGIN_PX,
        window.innerWidth - VIEWPORT_MARGIN_PX - measuredWidth,
      );
    }
    return {
      position: "fixed",
      top,
      left,
      zIndex: MENU_Z_INDEX,
      background: "var(--bg-elev)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      boxShadow: "var(--shadow-lg)",
      minWidth: MENU_APPROX_WIDTH_PX,
      maxWidth: `min(360px, calc(100vw - ${VIEWPORT_MARGIN_PX * 2}px))`,
      maxHeight: `calc(100vh - ${VIEWPORT_MARGIN_PX * 2}px)`,
      overflowY: "auto",
      padding: 4,
    };
  })();

  return (
    <div style={{ display: "inline-block" }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("topbar.userMenu")}
        title={me.full_name}
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: "1px solid var(--border)",
          background:
            "linear-gradient(135deg, oklch(0.72 0.09 195), oklch(0.55 0.1 230))",
          color: "white",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.02em",
          padding: 0,
        }}
      >
        {initials}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label={t("topbar.userMenu")}
          style={panelStyle}
        >
          {/* Identity header — name, email, active role */}
          <div
            style={{
              padding: "10px 12px 8px",
              borderBottom: "1px solid var(--border)",
              marginBottom: 4,
            }}
          >
            <div
              style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}
            >
              {me.full_name}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-secondary)",
                marginTop: 2,
                wordBreak: "break-all",
              }}
            >
              {me.email}
            </div>
            <div style={{ marginTop: 8 }}>
              <span
                className="nav-badge"
                style={{
                  background: "var(--accent-soft)",
                  color: "var(--accent-text)",
                  border: "1px solid var(--accent-border)",
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 10.5,
                }}
              >
                {role}
              </span>
            </div>
          </div>

          {/* Role switcher (only when multiple roles available). */}
          {multi && (
            <>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: "var(--text-tertiary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  padding: "6px 10px 4px",
                }}
              >
                {t("topbar.switchRole")}
              </div>
              {available.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => void onPickRole(r)}
                  disabled={busy}
                  role="menuitemradio"
                  aria-checked={r === role}
                  style={{
                    width: "100%",
                    textAlign: "start",
                    background:
                      r === role ? "var(--accent-soft)" : "transparent",
                    border: "none",
                    padding: "6px 10px",
                    fontSize: 12.5,
                    color: r === role ? "var(--accent-text)" : "var(--text)",
                    fontWeight: r === role ? 600 : 500,
                    borderRadius: 4,
                    cursor: busy ? "wait" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span>{r}</span>
                  {r === role && (
                    <span
                      style={{
                        marginInlineStart: "auto",
                        fontSize: 10.5,
                        color: "var(--text-tertiary)",
                      }}
                    >
                      {t("topbar.active")}
                    </span>
                  )}
                </button>
              ))}
              {error && (
                <div
                  style={{
                    padding: "4px 10px",
                    color: "var(--danger-text)",
                    fontSize: 11,
                  }}
                >
                  {error}
                </div>
              )}
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  margin: "4px 0",
                }}
              />
            </>
          )}

          {/* Settings + Logout actions. */}
          <NavLink
            to="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "8px 10px",
              borderRadius: 4,
              color: "var(--text)",
              fontSize: 12.5,
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            <Icon name="settings" size={13} />
            {t("topbar.settings")}
          </NavLink>
          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            role="menuitem"
            style={{
              width: "100%",
              textAlign: "start",
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "8px 10px",
              borderRadius: 4,
              border: "none",
              background: "transparent",
              color: "var(--text)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: loggingOut ? "wait" : "pointer",
            }}
          >
            <Icon name="logout" size={13} />
            {loggingOut ? "…" : t("topbar.logout")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

// P28.5d: ``RoleChip`` and the standalone ``RoleSwitcher`` were
// folded into ``UserMenu`` above — one dropdown for identity +
// settings + logout + role switching. The pilot's accent-coloured
// nav-badge role chip was visible in the topbar's right cluster
// alongside the name and Logout button; that cluster is gone now.
