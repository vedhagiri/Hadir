// MaugoodAI full-screen loader (approved design, Oct 2026).
//
// Shown while the app is waiting on something before it can render a
// page — the session probe in ProtectedRoute / SuperAdminProtectedRoute.
// The static copy of this markup in index.html covers the moment before
// the JS bundle loads; both share the ``mg-loader-*`` styles declared in
// index.html and the ``window.__mgBootStart`` clock, so the progress bar
// carries on from the boot screen instead of jumping back to 0%.
//
// The bar runs linearly to 100% over ``BOOT_MS`` (4.5 s), matching the
// approved design; ``BootSplash`` keeps it on screen for that long.

import { useEffect, useState } from "react";

declare global {
  interface Window {
    __mgBootStart?: number;
  }
}

/** Minimum time the loader stays on screen after a full page load. */
export const BOOT_MS = 4500;

const STAGES: Array<[number, string]> = [
  [0, "Preparing your workspace…"],
  [28, "Loading camera configuration…"],
  [58, "Initialising attendance services…"],
  [84, "Opening your dashboard…"],
  [97, "Almost ready…"],
];

function bootStart(): number {
  if (window.__mgBootStart === undefined) window.__mgBootStart = performance.now();
  return window.__mgBootStart;
}

function progressAt(now: number): number {
  return Math.min(100, Math.round(((now - bootStart()) / BOOT_MS) * 100));
}

/**
 * Covers the app for ``BOOT_MS`` after a full page load, then fades out.
 * The app mounts underneath straight away, so the session probe and the
 * first page's data load run during the splash instead of after it.
 */
export function BootSplash() {
  const [phase, setPhase] = useState<"show" | "fade" | "gone">(() =>
    performance.now() - bootStart() >= BOOT_MS ? "gone" : "show",
  );
  // Schedule once on mount. (Depending on ``phase`` would cancel the
  // "gone" timer when phase flips to "fade", leaving an invisible
  // overlay that swallows every click.)
  useEffect(() => {
    const left = Math.max(0, BOOT_MS - (performance.now() - bootStart()));
    const t1 = window.setTimeout(() => setPhase((p) => (p === "show" ? "fade" : p)), left);
    const t2 = window.setTimeout(() => setPhase("gone"), left + 300);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);
  if (phase === "gone") return null;
  return (
    <div
      style={{
        opacity: phase === "fade" ? 0 : 1,
        transition: "opacity .3s ease",
        pointerEvents: phase === "fade" ? "none" : undefined,
      }}
    >
      <AppLoader />
    </div>
  );
}

export function AppLoader() {
  const [value, setValue] = useState(() => progressAt(performance.now()));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setValue(progressAt(performance.now()));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  let status = STAGES[0]![1];
  for (const [at, label] of STAGES) if (value >= at) status = label;

  return (
    <div className="mg-loader-screen">
      <main className="mg-loader" role="status" aria-live="polite" aria-label="MaugoodAI loading">
        <div className="mg-loader-mark" aria-hidden="true">
          <div className="mg-loader-ring" />
          <div className="mg-loader-ring inner" />
          <div className="mg-loader-halo" />
          <div className="mg-loader-logo">
            <img src="/maugood-loader-mark.png" alt="" />
          </div>
        </div>
        <div className="mg-loader-word">
          Maugood<span>AI</span>
        </div>
        <div className="mg-loader-sub">CCTV-Based AI Attendance System</div>
        <div className="mg-loader-rule" />
        <div className="mg-loader-status">{status}</div>
        <div
          className="mg-loader-progress"
          role="progressbar"
          aria-label="Loading"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
        >
          <div className="mg-loader-fill" style={{ width: `${value}%` }} />
        </div>
        <div className="mg-loader-percent">{value}%</div>
      </main>
    </div>
  );
}
