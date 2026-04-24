// Topbar — breadcrumbs + role badge + logout.
// No Arabic toggle, no dark-mode toggle, no notifications bell, no "New
// request" primary button. All deferred per PROJECT_CONTEXT §8; the
// design references them but pilot scope is deliberately narrower.

import { useNavigate } from "react-router-dom";

import { useLogout } from "../auth/AuthProvider";
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

      {/* Right-side group: role badge, name, logout button. */}
      <div
        style={{
          marginInlineStart: "auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span className="nav-badge" title={`Signed in as ${role}`}>
          {role}
        </span>
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
