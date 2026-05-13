// Wraps authenticated routes. While the ``useMe`` probe is in flight we
// render nothing — no spinner, no flicker — and once it resolves we
// either render children (user logged in) or redirect to /login.
//
// Session-expiry behaviour: when a user IS logged in (we've seen a real
// ``me`` at least once during this app load) and the session later
// expires mid-session, ``SessionExpiryWatcher`` shows a modal first.
// Only the "never logged in" case still falls through to the immediate
// redirect, so the user can't sneak in via a deep link.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useMe } from "./AuthProvider";

interface Props {
  children: ReactNode;
}

export function ProtectedRoute({ children }: Props) {
  const { data: me, isLoading } = useMe();
  const location = useLocation();

  // Track whether we've ever seen the user logged in during this
  // page load. The SessionExpiryWatcher needs the chance to show its
  // "session expired" modal — auto-redirecting on the first 401 would
  // race the watcher and the user would just see the login page.
  const wasLoggedInRef = useRef(false);
  useEffect(() => {
    if (me != null) wasLoggedInRef.current = true;
  }, [me]);

  if (isLoading) {
    return null;
  }
  if (me == null) {
    // If we've ever seen them logged in this load, the session
    // expired mid-flight — keep rendering the shell so the watcher
    // can prompt for refresh. The watcher's "Sign in again" button
    // does the final hard redirect once the user acknowledges.
    if (wasLoggedInRef.current) {
      return <>{children}</>;
    }
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
