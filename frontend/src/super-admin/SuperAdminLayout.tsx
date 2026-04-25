// Console shell. Distinct from the tenant Layout — a red accent bar
// + a "Privileged Context" sticky header that reads like a warning.
// The visual treatment is intentionally not subtle (P3 red line: this
// is a safety feature, not cosmetic).

import { Outlet, NavLink, useNavigate } from "react-router-dom";

import { useSuperLogout, useSuperMe } from "./SuperAdminProvider";

export function SuperAdminLayout() {
  const { data: me } = useSuperMe();
  const logout = useSuperLogout();
  const navigate = useNavigate();

  if (!me) return null;

  const onLogout = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      // ignore
    }
    navigate("/super-admin/login", { replace: true });
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      {/* Red accent bar at the top of every console page. */}
      <div style={{ height: 6, background: "#c0392b" }} />
      <header
        style={{
          position: "sticky",
          top: 6,
          zIndex: 10,
          background: "var(--bg-elev)",
          borderBottom: "2px solid #c0392b",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div
          style={{
            color: "#c0392b",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          MTS Operator Console
        </div>
        <nav style={{ display: "flex", gap: 14, fontSize: 13 }}>
          <NavLink to="/super-admin/tenants" style={navLinkStyle}>
            Tenants
          </NavLink>
          <NavLink to="/super-admin/provision" style={navLinkStyle}>
            Provision tenant
          </NavLink>
        </nav>
        <div style={{ marginInlineStart: "auto", display: "flex", alignItems: "center", gap: 12, fontSize: 12.5 }}>
          <span style={{ color: "var(--text-secondary)" }}>{me.email}</span>
          <button
            type="button"
            onClick={onLogout}
            disabled={logout.isPending}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {logout.isPending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>
      <main style={{ maxWidth: 1320, margin: "0 auto", padding: "20px" }}>
        <Outlet />
      </main>
    </div>
  );
}

const navLinkStyle = ({ isActive }: { isActive: boolean }) =>
  ({
    color: isActive ? "#c0392b" : "var(--text)",
    textDecoration: "none",
    fontWeight: isActive ? 600 : 500,
    borderBottom: isActive ? "2px solid #c0392b" : "2px solid transparent",
    padding: "4px 0",
  }) as const;
