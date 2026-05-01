// Live-ticking relative timestamp ("3 min ago" / "5 hours ago"). Falls
// back to the absolute locale string after RELATIVE_THRESHOLD_DAYS so
// a months-old event stays readable. Tooltip always carries the exact
// timestamp (with seconds) for operators who need the precise moment.

import { useEffect, useState } from "react";

const RELATIVE_THRESHOLD_DAYS = 3;
const RELATIVE_THRESHOLD_MS = RELATIVE_THRESHOLD_DAYS * 86_400_000;

export function formatRelative(iso: string, now: number): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diffMs = now - ts;
  if (diffMs >= RELATIVE_THRESHOLD_MS) {
    return new Date(iso).toLocaleString();
  }
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

export function formatExact(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export function RelativeTime({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return <span title={formatExact(iso)}>{formatRelative(iso, now)}</span>;
}
