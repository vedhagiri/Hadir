// SessionExpiryWatcher — surfaces a "session about to expire" modal
// inside the authenticated shell. Reads ``me.session_expires_at`` from
// the auth cache and schedules a warning when the remaining time drops
// below a threshold. "Stay signed in" hits POST /api/auth/refresh to
// extend the session without forcing a re-login; "Sign out" routes
// through the normal logout flow. When the countdown reaches zero we
// give the user one last chance via the modal in "expired" mode rather
// than auto-redirecting to /login.

import { useEffect, useRef, useState } from "react";

import { serverNow, useLogout, useMe, useRefreshSession } from "./AuthProvider";

// Show the modal when the session has this many seconds (or fewer)
// remaining. Last 30 s of the session window — explicit "Stay Signed
// In" click is the only thing that extends it.
const WARN_BEFORE_EXPIRY_S = 30;

// Hard upper bound on countdown polling — re-evaluates remaining time
// once per second so the displayed "1:58" actually ticks down.
const COUNTDOWN_INTERVAL_MS = 1000;

type Phase = "idle" | "warning" | "expired";

function diffSeconds(targetIso: string | null | undefined): number {
  if (!targetIso) return Number.POSITIVE_INFINITY;
  const t = new Date(targetIso).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  // Anchor to server time so a backgrounded / throttled tab doesn't
  // miscompute the remaining seconds. ``serverNow()`` is the local
  // clock plus the skew offset re-synced on every backend response.
  return Math.floor((t - serverNow()) / 1000);
}

// Popup countdown target = session_started_at + idle_minutes.
// See SessionCountdown.tsx for the rationale: decouples popup timing
// from the per-request sliding ``expires_at``, so polling on other
// queries doesn't push the warning modal forward indefinitely. The
// backend bumps session_started_at when "Stay signed in" is clicked
// so the refresh button still visibly extends the window.
function computePopupTargetIso(
  startedAt: string | null | undefined,
  idleMinutes: number | null | undefined,
): string | null {
  if (!startedAt || !idleMinutes) return null;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;
  return new Date(startMs + idleMinutes * 60_000).toISOString();
}

function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SessionExpiryWatcher() {
  const { data: me } = useMe();
  const refresh = useRefreshSession();
  const logout = useLogout();

  const [phase, setPhase] = useState<Phase>("idle");
  const [remaining, setRemaining] = useState<number>(0);

  // Keep a ref so the interval tick always reads the current pending state
  // rather than a stale closure value. Set synchronously during render so
  // it is accurate before the next tick fires.
  const refreshPendingRef = useRef(false);
  refreshPendingRef.current = refresh.isPending;

  const expiresAt = computePopupTargetIso(
    me?.session_started_at,
    me?.session_idle_minutes,
  );

  // Drive the countdown off a single interval keyed only on the target.
  // ``phase`` is intentionally NOT a dependency: each tick re-derives
  // phase from the remaining-time math, so including it in the deps
  // would tear down the interval mid-countdown the moment phase first
  // transitions (idle → warning), and the early-return guard from the
  // old implementation prevented the interval from being re-created.
  useEffect(() => {
    if (!expiresAt) {
      setPhase("idle");
      return;
    }

    const tick = () => {
      const left = diffSeconds(expiresAt);
      setRemaining(left);
      if (left <= 0) {
        // Don't flip to "expired" while a refresh request is already
        // in-flight (user clicked "Stay signed in" with seconds left).
        // The onSuccess handler will reset phase to "idle" once done.
        if (!refreshPendingRef.current) {
          setPhase("expired");
        }
      } else if (left <= WARN_BEFORE_EXPIRY_S) {
        // Use direct set (not functional guard) so that if the phase was
        // erroneously stuck at "expired" from a race condition, a new
        // popup target with time remaining can recover the UI to "warning".
        setPhase("warning");
      } else {
        // Same rationale: always reflect the true countdown state.
        setPhase("idle");
      }
    };

    tick();
    const id = window.setInterval(tick, COUNTDOWN_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  // If a refresh succeeds, ``me`` updates with a fresh
  // ``session_expires_at`` and the effect above resets the timer.

  const handleStay = () => {
    refresh.mutate(undefined, {
      onSuccess: () => {
        // Reset phase locally too; the next tick will pick up the new
        // expiry from the cache.
        setPhase("idle");
      },
      onError: () => {
        // If the refresh itself 401s (race with idle timeout) flip to
        // expired so the user can re-sign in.
        setPhase("expired");
      },
    });
  };

  const handleSignOut = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        window.location.href = "/login";
      },
      onError: () => {
        // Session already invalid server-side — navigate anyway.
        window.location.href = "/login";
      },
    });
  };

  // Hard-navigate to /login only AFTER the server session has been
  // invalidated.  Without the logout call, the server session can still
  // be alive (the 30-second poll slides it), LoginPage sees me != null
  // and immediately returns <Navigate to="/" />, bouncing the user back
  // to the app with the same stale session_started_at — the "expired"
  // popup fires again on remount, creating an infinite loop.
  const handleRelogin = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        window.location.href = "/login";
      },
      onError: () => {
        // Session already gone server-side — safe to navigate anyway.
        window.location.href = "/login";
      },
    });
  };

  // When the server session genuinely expires — GET /api/auth/me returns
  // 401 so fetchMe returns null and TanStack sets me to null — transition
  // to "expired" immediately so the "Sign in again" modal is shown.
  // Without this, the render guard below would hide the component while
  // phase is still "warning", leaving the user on a blank authenticated
  // shell (the "automatic logout" symptom).
  useEffect(() => {
    if (me === null && phase !== "expired") {
      setPhase("expired");
    }
  }, [me, phase]);

  // When me is null (server session gone), force the expired state
  // immediately on this render rather than waiting for the useEffect.
  // This prevents a one-frame blank when the component remounts after
  // Layout's "if (!me) return <SessionExpiryWatcher />" swap.
  const effectivePhase: Phase = me === null ? "expired" : phase;

  if (effectivePhase === "idle") return null;

  const isWarning = effectivePhase === "warning";
  const isExpired = effectivePhase === "expired";
  const busy = refresh.isPending || logout.isPending;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Session"
      onClick={(e) => {
        // Click-outside is intentionally a no-op for warning state —
        // the user must explicitly choose stay / sign out. In expired
        // state we only allow re-login so also no-op.
        e.stopPropagation();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(2, 6, 23, 0.55)",
        backdropFilter: "blur(4px)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          maxWidth: 460,
          width: "100%",
          padding: 0,
          overflow: "hidden",
        }}
      >
        {/* Accent header bar — amber on warning, red on expired */}
        <div
          aria-hidden
          style={{
            height: 4,
            background: isExpired ? "#dc2626" : "#f59e0b",
          }}
        />
        <div style={{ padding: "22px 26px 18px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 8,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: isExpired
                  ? "rgba(220,38,38,0.12)"
                  : "rgba(245,158,11,0.14)",
                color: isExpired ? "#dc2626" : "#b45309",
                display: "grid",
                placeItems: "center",
                fontSize: 18,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {isExpired ? "!" : "⏱"}
            </span>
            <div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "var(--text)",
                  lineHeight: 1.2,
                }}
              >
                {isExpired
                  ? "Your session has expired"
                  : "Your session is about to expire"}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  marginTop: 3,
                }}
              >
                {isExpired
                  ? "Sign in again to continue."
                  : isWarning
                    ? "Do you want to stay logged in, or log out?"
                    : ""}
              </div>
            </div>
          </div>

          {/* Countdown — only shown while warning */}
          {isWarning && (
            <div
              style={{
                marginTop: 18,
                marginBottom: 18,
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "16px 18px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-secondary)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Time remaining
              </div>
              <div
                style={{
                  fontSize: 38,
                  fontWeight: 700,
                  color: remaining <= 30 ? "#dc2626" : "#b45309",
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1.05,
                  marginTop: 4,
                  letterSpacing: "-0.02em",
                }}
              >
                {formatCountdown(remaining)}
              </div>
              <div
                style={{
                  marginTop: 10,
                  height: 6,
                  borderRadius: 3,
                  background: "var(--border)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${Math.max(2, Math.min(100, (remaining / WARN_BEFORE_EXPIRY_S) * 100))}%`,
                    background: remaining <= 30 ? "#dc2626" : "#f59e0b",
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
            </div>
          )}

          {/* Helper text on expired */}
          {isExpired && (
            <div
              style={{
                marginTop: 14,
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "12px 14px",
              }}
            >
              Your session ended because of inactivity. None of your
              work was lost — sign back in and you'll return to the
              same page.
            </div>
          )}

          {/* Actions */}
          <div
            style={{
              display: "flex",
              gap: 10,
              marginTop: 18,
              justifyContent: "flex-end",
              flexWrap: "wrap",
            }}
          >
            {isWarning && (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleSignOut}
                  disabled={busy}
                  style={{
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--text)",
                  }}
                >
                  {logout.isPending ? "Signing out…" : "Sign out now"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleStay}
                  disabled={busy}
                  style={{
                    background: "#0b6e4f",
                    color: "#fff",
                    fontWeight: 600,
                  }}
                >
                  {refresh.isPending ? "Refreshing…" : "Stay signed in"}
                </button>
              </>
            )}
            {isExpired && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={handleRelogin}
                disabled={busy}
                style={{
                  background: "var(--text)",
                  color: "var(--bg)",
                  fontWeight: 600,
                }}
              >
                {logout.isPending ? "Signing out…" : "Sign in again"}
              </button>
            )}
          </div>

          {/* Error from refresh */}
          {refresh.isError && (
            <div
              style={{
                marginTop: 12,
                fontSize: 12,
                color: "var(--danger-text)",
              }}
            >
              Could not refresh the session. Please sign in again.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
