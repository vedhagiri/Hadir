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

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, NavLink } from "react-router-dom";

import { useLogout, useSwitchRole } from "../auth/AuthProvider";
import { NotificationBell } from "../notifications/NotificationBell";
import type { MeResponse, Role } from "../types";
import { DisplaySwitcher } from "./DisplaySwitcher";
import { Icon } from "./Icon";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { CRUMBS } from "./nav";


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
  const crumbs = CRUMBS[pageId] ?? ["Hadir", pageId];

  const onLogout = () => {
    logout.mutate(undefined, {
      onSettled: () => navigate("/login", { replace: true }),
    });
  };

  return (
    <div className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span
            key={`${i}-${c}`}
            className={i === crumbs.length - 1 ? "crumb-current" : ""}
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            {i > 0 && (
              <span className="crumb-sep">
                <Icon name="chevronRight" size={11} />
              </span>
            )}
            {c}
          </span>
        ))}
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
        <NotificationBell />
        <DisplaySwitcher />
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click + on Escape; restore focus to the trigger
  // so keyboard users land where they started.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
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

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "inline-block" }}
    >
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

      {open && (
        <div
          role="menu"
          aria-label={t("topbar.userMenu")}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            insetInlineEnd: 0,
            zIndex: 30,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            minWidth: 240,
            padding: 4,
          }}
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
        </div>
      )}
    </div>
  );
}

// P28.5d: ``RoleChip`` and the standalone ``RoleSwitcher`` were
// folded into ``UserMenu`` above — one dropdown for identity +
// settings + logout + role switching. The pilot's accent-coloured
// nav-badge role chip was visible in the topbar's right cluster
// alongside the name and Logout button; that cluster is gone now.
