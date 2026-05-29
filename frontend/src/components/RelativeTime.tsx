// Live-ticking relative timestamp ("3 min ago" / "5 hours ago"). Falls
// back to the absolute tenant-formatted string after
// RELATIVE_THRESHOLD_DAYS so a months-old event stays readable. Tooltip
// always carries the exact timestamp (with seconds, in tenant
// timezone) for operators who need the precise moment.
//
// Migration 0068: the absolute fallback + tooltip now route through
// ``useTenantDateTime`` so the tenant's chosen timezone + date/time
// formats apply everywhere this component is rendered (Camera Logs,
// Audit Log, Notifications, etc.).

import { useEffect, useState } from "react";

import { useTenantDateTime } from "../util/datetime";

const RELATIVE_THRESHOLD_DAYS = 3;
const RELATIVE_THRESHOLD_MS = RELATIVE_THRESHOLD_DAYS * 86_400_000;

export function relativeText(iso: string, now: number): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diffMs = now - ts;
  // Future timestamps (clock skew) bottom out at "just now".
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec} sec ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

export function RelativeTime({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  const dt = useTenantDateTime();
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const ts = new Date(iso).getTime();
  const tooltip = dt.formatTimeWithSeconds(iso) || iso;
  const label =
    !Number.isFinite(ts) || now - ts >= RELATIVE_THRESHOLD_MS
      ? (dt.formatDateTime(iso) || iso)
      : relativeText(iso, now);
  return <span title={`${dt.formatDate(iso)} ${tooltip}`.trim()}>{label}</span>;
}
