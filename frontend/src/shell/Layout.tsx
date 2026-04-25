// The authenticated shell: sidebar + topbar + scrolling content area with
// the 1320px max-width wrapper from the design system. Route content is
// rendered through <Outlet/>.

import { Outlet, useLocation } from "react-router-dom";

import { useMe } from "../auth/AuthProvider";
import { BrandingProvider } from "../branding/BrandingProvider";
import { primaryRole } from "../types";
import { ImpersonationBanner } from "./ImpersonationBanner";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function Layout() {
  const { data: me } = useMe();
  const location = useLocation();

  // ProtectedRoute guarantees ``me`` exists before we get here; this
  // narrowing keeps the rest of the component honest against TS strict.
  if (!me) return null;

  const role = primaryRole(me.roles);
  // Route path is always ``/<pageId>`` in P4 (no nested routes yet).
  const pageId = location.pathname.replace(/^\//, "") || "dashboard";

  return (
    <div className="app">
      {/* Mounts a <style> tag in document.head with --accent + body
          font-family overrides for the active tenant. Returns null. */}
      <BrandingProvider />
      {me.is_super_admin_impersonation && (
        <ImpersonationBanner superAdminUserId={me.super_admin_user_id ?? null} />
      )}
      <Sidebar role={role} me={me} />
      <div className="main">
        <Topbar pageId={pageId} role={role} me={me} />
        <div className="content">
          <div className="content-wrap">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
