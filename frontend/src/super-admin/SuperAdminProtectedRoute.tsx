// Mirrors auth/ProtectedRoute but for the Super-Admin session. Redirects
// to /super-admin/login when the super-session probe returns null.

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { useSuperMe } from "./SuperAdminProvider";

export function SuperAdminProtectedRoute({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useSuperMe();
  if (isLoading) return null;
  if (me == null) return <Navigate to="/super-admin/login" replace />;
  return <>{children}</>;
}
