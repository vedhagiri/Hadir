// Wraps authenticated routes. While the ``useMe`` probe is in flight we
// render nothing — no spinner, no flicker — and once it resolves we either
// render children (user logged in) or redirect to /login (user not logged
// in, which is how 401 surfaces from ``fetchMe``).

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useMe } from "./AuthProvider";

interface Props {
  children: ReactNode;
}

export function ProtectedRoute({ children }: Props) {
  const { data: me, isLoading } = useMe();
  const location = useLocation();

  if (isLoading) {
    return null;
  }
  if (me == null) {
    // Forward the original target via `state.from` so P5+ can redirect
    // back after login if we want that UX; unused for now.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
