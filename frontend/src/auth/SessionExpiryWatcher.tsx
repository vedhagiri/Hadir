// SessionExpiryWatcher — surfaces a "session about to expire" modal
// inside the authenticated shell. Reads ``me.session_expires_at`` from
// the auth cache and schedules a warning when the remaining time drops
// below a threshold. "Stay signed in" hits POST /api/auth/refresh to
// extend the session without forcing a re-login; "Sign out" routes
// through the normal logout flow. When the countdown reaches zero we
// give the user one last chance via the modal in "expired" mode rather
// than auto-redirecting to /login.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import productMark from "../assets/mts_mark.png";
import { Icon } from "../shell/Icon";
import { serverNow, useLogout, useMe, useRefreshSession } from "./AuthProvider";
import { rememberReturnTo } from "./returnTo";
import "./session-expiry.css";

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

// The workspace remembered by the login page; the public logo endpoint
// needs no session, so the client logo still shows after expiry.
const LAST_WORKSPACE_KEY = "maugood.lastWorkspace";

function workspaceLogo(slug: string | null | undefined): string | null {
  const s = (slug || localStorage.getItem(LAST_WORKSPACE_KEY) || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,39}$/.test(s) ? `/api/branding/public/logo?tenant=${encodeURIComponent(s)}` : null;
}

export function SessionExpiryWatcher() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const [logoFailed, setLogoFailed] = useState(false);
  // Remember the workspace while signed in, so the client logo can still
  // be shown once the session is gone (``me`` is null by then).
  useEffect(() => {
    if (me?.tenant_slug) {
      try {
        localStorage.setItem(LAST_WORKSPACE_KEY, me.tenant_slug);
      } catch {
        /* storage unavailable — the MTS mark is shown instead */
      }
    }
  }, [me?.tenant_slug]);
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

  // The popup target moves forward every time the user clicks "Stay
  // signed in" — the backend bumps ``refresh_anchor_at``, which flows
  // back into ``me.session_started_at``, which shifts ``expiresAt``.
  //
  // The previous implementation keyed the countdown ``useEffect`` on
  // ``[expiresAt]``, tearing the interval down and recreating it on
  // every target change. That re-creation is the fragile bit: the
  // 30-second ``/api/auth/me`` poll churns the ``me`` object
  // constantly, so the effect's teardown/re-run can race with a poll
  // and — on the *second* cycle after a refresh — leave the countdown
  // without a live interval. The warning then never re-arms and the
  // session silently runs out (the reported bug).
  //
  // Fix: run exactly ONE interval for the component's lifetime
  // (mount-once, empty deps) and read the *current* target from a ref
  // each tick. The ref is refreshed on every render, so the warning
  // re-arms automatically on every refresh cycle without depending on
  // an effect re-run firing at the right moment.
  const targetRef = useRef<string | null>(expiresAt);
  targetRef.current = expiresAt;

  useEffect(() => {
    const tick = () => {
      const target = targetRef.current;
      if (!target) {
        setPhase("idle");
        setRemaining(0);
        return;
      }
      const left = diffSeconds(target);
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
  }, []);

  // If a refresh succeeds, ``me`` updates with a fresh
  // ``session_started_at``; ``targetRef`` picks it up on the next render
  // and the next tick re-arms the warning for the new cycle.

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
  // The current page is remembered so the login page brings the user
  // straight back to it.
  const handleRelogin = () => {
    rememberReturnTo(window.location.pathname + window.location.search);
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

  const isExpired = effectivePhase === "expired";
  const busy = refresh.isPending || logout.isPending;
  const logoSrc = (!logoFailed && workspaceLogo(me?.tenant_slug)) || productMark;
  const idle = me?.session_idle_minutes;
  // Countdown ring: full at the start of the warning window, empty at 0.
  const R = 34;
  const C = 2 * Math.PI * R;
  const frac = Math.max(0, Math.min(1, remaining / WARN_BEFORE_EXPIRY_S));

  return (
    <div className={`sx-backdrop${me === null ? " is-solid" : ""}`} onClick={(e) => e.stopPropagation()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sx-title"
        aria-describedby="sx-body"
        className={`sx-card ${isExpired ? "is-expired" : "is-warning"}`}
      >
        <img src={logoSrc} alt="" className="sx-logo" onError={() => setLogoFailed(true)} />

        {isExpired ? (
          <div className="sx-badge" aria-hidden>
            <Icon name="clock" size={30} />
          </div>
        ) : (
          <div className="sx-ring" aria-hidden>
            <svg viewBox="0 0 80 80" width="88" height="88">
              <circle cx="40" cy="40" r={R} className="sx-ring-track" />
              <circle
                cx="40"
                cy="40"
                r={R}
                className="sx-ring-fill"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - frac)}
                transform="rotate(-90 40 40)"
              />
            </svg>
            <span className="sx-ring-time">{formatCountdown(remaining)}</span>
          </div>
        )}

        <h2 id="sx-title" className="sx-title">
          {isExpired
            ? t("session.expired.title", { defaultValue: "You've been signed out" })
            : t("session.warning.title", { defaultValue: "Are you still there?" })}
        </h2>
        <p id="sx-body" className="sx-body">
          {isExpired
            ? idle
              ? t("session.expired.bodyIdle", {
                  defaultValue: "For your security, we sign you out after {{minutes}} minutes without activity.",
                  minutes: idle,
                })
              : t("session.expired.body", { defaultValue: "For your security, we sign you out after a period without activity." })
            : t("session.warning.body", {
                defaultValue: "For your security, you'll be signed out in {{time}}. Stay signed in to keep working.",
                time: formatCountdown(remaining),
              })}
        </p>

        {isExpired && (
          <div className="sx-note">
            <Icon name="check" size={15} />
            <span>
              {t("session.expired.note", {
                defaultValue: "Sign in again and you'll come straight back to this page.",
              })}
            </span>
          </div>
        )}

        {refresh.isError && (
          <div className="sx-error" role="alert">
            {t("session.refreshFailed", { defaultValue: "Couldn't keep you signed in. Please sign in again." })}
          </div>
        )}

        <div className={`sx-actions${isExpired ? " is-single" : ""}`}>
          {isExpired ? (
            <button type="button" className="btn btn-primary" onClick={handleRelogin} disabled={busy} autoFocus>
              <Icon name="logout" size={14} />
              {logout.isPending
                ? t("session.working", { defaultValue: "One moment…" })
                : t("session.expired.signIn", { defaultValue: "Sign in again" })}
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={handleSignOut} disabled={busy}>
                {logout.isPending
                  ? t("session.signingOut", { defaultValue: "Signing out…" })
                  : t("session.warning.signOut", { defaultValue: "Sign out" })}
              </button>
              <button type="button" className="btn btn-primary" onClick={handleStay} disabled={busy} autoFocus>
                {refresh.isPending
                  ? t("session.working", { defaultValue: "One moment…" })
                  : t("session.warning.stay", { defaultValue: "Stay signed in" })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
