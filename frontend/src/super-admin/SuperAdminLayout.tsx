// Console shell. Distinct from the tenant Layout — a red accent bar
// + a sticky "Operator Console" header that reads like a warning.
// The visual treatment is intentionally not subtle (P3 red line: this
// is a safety feature, not cosmetic). Red accent tokens: ./sa.css.

import { Outlet, NavLink, useNavigate } from "react-router-dom";

import { useSuperLogout, useSuperMe } from "./SuperAdminProvider";

import "./sa.css";

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
    <div className="sa-shell">
      {/* Red accent bar at the top of every console page. */}
      <div className="sa-bar" aria-hidden />
      <header className="sa-topbar">
        <div className="sa-brand">
          <span className="sa-brand-dot" aria-hidden />
          MTS Operator Console
        </div>
        <nav className="sa-nav" aria-label="Console">
          <NavLink to="/super-admin/tenants" className="sa-nav-link">
            Tenants
          </NavLink>
          <NavLink to="/super-admin/provision" className="sa-nav-link">
            Provision tenant
          </NavLink>
          <NavLink to="/super-admin/system" className="sa-nav-link">
            System
          </NavLink>
        </nav>
        <div className="sa-topbar-end">
          <span className="sa-topbar-email">{me.email}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onLogout} disabled={logout.isPending}>
            {logout.isPending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>
      <main className="sa-main">
        <Outlet />
      </main>
    </div>
  );
}
