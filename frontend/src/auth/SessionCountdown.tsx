// Always-visible session countdown chip in the topbar.
//
// Reads ``me.session_started_at + idle_minutes`` (decoupled from the
// per-request sliding ``expires_at`` so polling doesn't reset the
// popup target) and ticks once per second. Display-only — clicking
// the chip does NOT refresh the session. Refresh happens exclusively
// via the "Stay Signed In" button in the warning modal.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { serverNow, useMe } from "./AuthProvider";

const WARN_S = 5 * 60; // amber at < 5 min
const CRIT_S = 2 * 60; // red    at < 2 min


function diffSeconds(targetIso: string | null | undefined): number {
  if (!targetIso) return Number.POSITIVE_INFINITY;
  const t = new Date(targetIso).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  // Anchor to server time, not local — skew offset is maintained
  // by AuthProvider against every /me + /login + /refresh response.
  return Math.floor((t - serverNow()) / 1000);
}

// Popup countdown target = session_started_at + idle_minutes.
// Decouples from the per-request sliding ``expires_at`` so polling on
// other queries doesn't push the countdown forward. The backend resets
// session_started_at when the user clicks "Stay signed in" (bumps
// ``user_sessions.data.refresh_anchor_at``), so the refresh button
// still visibly extends the countdown.
function computePopupTargetIso(
  startedAt: string | null | undefined,
  idleMinutes: number | null | undefined,
): string | null {
  if (!startedAt || !idleMinutes) return null;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;
  return new Date(startMs + idleMinutes * 60_000).toISOString();
}


function format(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds - h * 3600) / 60);
  const s = Math.floor(seconds - h * 3600 - m * 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}


export function SessionCountdown() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const [now, setNow] = useState(() => Date.now());

  const targetIso = computePopupTargetIso(
    me?.session_started_at,
    me?.session_idle_minutes,
  );

  // Tick every second while we have an expiry to count down to.
  useEffect(() => {
    if (!targetIso) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [targetIso]);

  if (!targetIso) return null;

  void now; // re-render trigger; the value itself is computed below
  const remaining = diffSeconds(targetIso);

  const tone: "ok" | "warn" | "crit" =
    remaining <= CRIT_S ? "crit" : remaining <= WARN_S ? "warn" : "ok";

  const color =
    tone === "crit"
      ? "#dc2626"
      : tone === "warn"
        ? "#b45309"
        : "var(--text-secondary)";
  const bg =
    tone === "crit"
      ? "rgba(220,38,38,0.10)"
      : tone === "warn"
        ? "rgba(245,158,11,0.12)"
        : "var(--bg-elev, var(--bg))";

  const labelPrefix =
    (t("session.expiresIn") as string) || "Session expires in";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${labelPrefix} ${format(remaining)}`}
      title={`${labelPrefix} ${format(remaining)}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        border: `1px solid ${tone === "ok" ? "var(--border)" : color}`,
        background: bg,
        color,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.1,
        cursor: "default",
        userSelect: "none",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span aria-hidden style={{ fontSize: 13 }}>⏱</span>
      <span>{format(remaining)}</span>
    </div>
  );
}
