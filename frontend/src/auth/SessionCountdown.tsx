// Always-visible session countdown chip in the topbar.
//
// Reads ``me.session_expires_at`` (which the backend slides on every
// authenticated request) and ticks once per second. Click to call
// /api/auth/refresh and extend the session without going through the
// 2-minute warning modal.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { serverNow, useMe, useRefreshSession } from "./AuthProvider";

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
  const refresh = useRefreshSession();
  const [now, setNow] = useState(() => Date.now());

  // Tick every second while we have an expiry to count down to.
  useEffect(() => {
    if (!me?.session_expires_at) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [me?.session_expires_at]);

  if (!me?.session_expires_at) return null;

  void now; // re-render trigger; the value itself is computed below
  const remaining = diffSeconds(me.session_expires_at);

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
    <button
      type="button"
      onClick={() => refresh.mutate()}
      disabled={refresh.isPending}
      aria-label={`${labelPrefix} ${format(remaining)}. Click to extend.`}
      title={
        refresh.isPending
          ? "Refreshing…"
          : `${labelPrefix} ${format(remaining)} — click to extend.`
      }
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
        cursor: refresh.isPending ? "wait" : "pointer",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span aria-hidden style={{ fontSize: 13 }}>⏱</span>
      <span>
        {refresh.isPending ? "…" : format(remaining)}
      </span>
    </button>
  );
}
