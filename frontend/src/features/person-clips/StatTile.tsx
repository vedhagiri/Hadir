// Thin wrapper over the shared ``StatCard`` (components/ListPageUi) for
// the clip / face-crop / analytics pages. Renders the exact same
// ``mg-stat`` markup and classes so every page shows one stat style;
// the only difference is that a tile with no ``onClick`` is an inert
// <div> (no pointer, no lift) and accepts a formatted value ("0 B",
// "32.59 s") because the figure is not always a plain count.

import type { ReactNode } from "react";

import { StatCard } from "../../components/ListPageUi";
import type { StatTone } from "../../components/ListPageUi";

import "./clips.css";

export function StatTile({
  tone,
  icon,
  label,
  value,
  sub,
  active,
  onClick,
}: {
  tone: StatTone;
  /** SVG children drawn in a 24×24 stroke icon. */
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  if (onClick && typeof value === "number") {
    return <StatCard tone={tone} icon={icon} label={label} value={value} sub={sub ?? ""} active={active ?? false} onClick={onClick} />;
  }
  return (
    <div className={`mg-stat cl-stat tone-${tone}`}>
      <span className="mg-stat-top">
        <span className="mg-stat-label">{label}</span>
        <span className="mg-stat-icon" aria-hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </span>
      </span>
      <span className="mg-stat-value">{typeof value === "number" ? value.toLocaleString() : value}</span>
      {sub ? <span className="mg-stat-sub">{sub}</span> : null}
    </div>
  );
}

/** Stroke-icon paths shared by the stat tiles on the clip pages. */
export const TILE_ICON = {
  video: (
    <>
      <rect x="2.5" y="6" width="13" height="12" rx="2" />
      <path d="M15.5 10.5 21 7.5v9l-5.5-3" />
    </>
  ),
  face: (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="10" r="3" />
      <path d="M7.5 17.5a5 5 0 0 1 9 0" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.6 2.6L16 9.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2.5 20h19L12 3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  storage: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
      <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" />
    </>
  ),
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />,
  camera: (
    <>
      <path d="M4 7h3l2-2.5h6L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
} as const;
