// The authenticated shell: sidebar + topbar + scrolling content area with
// the 1320px max-width wrapper from the design system. Route content is
// rendered through <Outlet/>.

import { Outlet, useLocation } from "react-router-dom";

import { useMe } from "../auth/AuthProvider";
import { BrandingProvider } from "../branding/BrandingProvider";
import { PageTransition } from "../motion/PageTransition";
import { ImpersonationBanner } from "./ImpersonationBanner";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import "./transitions.css";

export function Layout() {
  const { data: me } = useMe();
  const location = useLocation();

  // ProtectedRoute guarantees ``me`` exists before we get here; this
  // narrowing keeps the rest of the component honest against TS strict.
  if (!me) return null;

  // P7: navigation is driven by the user's *active* role — the one
  // they picked via the topbar switcher. Falls back to the first
  // entry in ``available_roles`` for the legacy super-admin synthetic
  // (which doesn't carry a single active role per tenant).
  const role = me.active_role ?? me.roles[0] ?? "Employee";
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
      <Sidebar role={role} />
      <div className="main">
        <Topbar pageId={pageId} role={role} me={me} />
        <div className="content">
          {/* Framer Motion's AnimatePresence (in PageTransition)
              detects path changes via location.pathname and runs
              the outgoing-fade-out + incoming-fade-in. Sidebar /
              topbar / impersonation banner sit outside this wrapper
              and stay stable. TanStack Query caches survive the
              remount — re-entering a page is instant when data is
              hot. Reduced-motion preference disables the wrapper
              entirely (pages snap instantly). */}
          <div className="content-wrap">
            <PageTransition>
              <Outlet />
            </PageTransition>
          </div>
        </div>
      </div>
    </div>
  );
}
