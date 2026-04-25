// Topbar — breadcrumbs + role chip + logout.
// No Arabic toggle, no dark-mode toggle, no notifications bell, no "New
// request" primary button. All deferred per PROJECT_CONTEXT §8; the
// design references them but pilot scope is deliberately narrower.
//
// P7: when the user holds more than one role, the role chip becomes a
// dropdown that calls ``POST /api/auth/switch-role`` and reloads. The
// reload is intentional (the prompt asks for it explicitly) — every
// page that reads ``me.active_role`` re-renders cleanly without
// piecemeal cache invalidation across the dozens of TanStack queries
// scattered through the feature folders.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useLogout, useSwitchRole } from "../auth/AuthProvider";
import type { MeResponse, Role } from "../types";
import { Icon } from "./Icon";
import { CRUMBS } from "./nav";

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

      {/* Right-side group: role chip / dropdown, name, logout. */}
      <div
        style={{
          marginInlineStart: "auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <RoleChip role={role} me={me} />
        <span
          style={{
            fontSize: 12.5,
            color: "var(--text-secondary)",
            fontWeight: 500,
          }}
          title={me.email}
        >
          {me.full_name}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onLogout}
          disabled={logout.isPending}
          aria-label="Log out"
        >
          <Icon name="logout" size={12} />
          {logout.isPending ? "…" : "Log out"}
        </button>
      </div>
    </div>
  );
}

function RoleChip({ role, me }: { role: Role; me: MeResponse }) {
  const available = me.available_roles ?? [];
  const multi = available.length > 1;

  // Single-role users get the static badge — same look as the pilot.
  if (!multi) {
    return (
      <span className="nav-badge" title={`Signed in as ${role}`}>
        {role}
      </span>
    );
  }
  return <RoleSwitcher role={role} available={available} />;
}

function RoleSwitcher({
  role,
  available,
}: {
  role: Role;
  available: Role[];
}) {
  const switchRole = useSwitchRole();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click — small detail but the dropdown is
  // otherwise sticky.
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
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const onPick = async (next: Role) => {
    if (next === role) {
      setOpen(false);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await switchRole.mutateAsync(next);
      // The prompt asks for an explicit page reload — it ensures the
      // navigation, page content, and any in-flight TanStack queries
      // all re-render against the new active role consistently.
      window.location.reload();
    } catch {
      setError("Switch failed.");
      setBusy(false);
    }
  };

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Active role: ${role} (click to switch)`}
        className="nav-badge"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          background: "var(--accent-soft)",
          color: "var(--accent-text)",
          border: "1px solid var(--accent-border)",
          padding: "2px 8px 2px 10px",
          borderRadius: 999,
        }}
      >
        <span>{role}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Switch role"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineEnd: 0,
            zIndex: 20,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-lg)",
            listStyle: "none",
            padding: 4,
            margin: 0,
            minWidth: 160,
          }}
        >
          {available.map((r) => (
            <li key={r}>
              <button
                type="button"
                onClick={() => void onPick(r)}
                disabled={busy}
                role="option"
                aria-selected={r === role}
                style={{
                  width: "100%",
                  textAlign: "start",
                  background: r === role ? "var(--accent-soft)" : "transparent",
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
                    active
                  </span>
                )}
              </button>
            </li>
          ))}
          {error && (
            <li
              style={{
                padding: "6px 10px",
                color: "var(--danger-text)",
                fontSize: 11.5,
              }}
            >
              {error}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
