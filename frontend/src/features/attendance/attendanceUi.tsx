// Small presentational helpers shared by the attendance, reports,
// camera-logs and unidentified-faces pages. Kept local (not in
// components/) so the shared ListPageUi primitives stay untouched.
//
// Stat cards come from the shared ``StatCard`` + ``StatGrid`` in
// components/ListPageUi — there is deliberately no area-local stat card.
// Page-specific layout lives in ./attendance.css (prefix ``at-``).

import type { CSSProperties, ReactNode } from "react";

import { FIELD_H } from "../../components/ListPageUi";

import "./attendance.css";

export type DotTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

/** Soft status pill with a leading dot — same shape as the Cameras
 *  page's StatusDot so status reads identically across the app. */
export function DotPill({
  tone,
  children,
  title,
}: {
  tone: DotTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span title={title} className={`at-pill tone-${tone}`}>
      <span aria-hidden className="at-pill-dot" />
      <span className="at-pill-text">{children}</span>
    </span>
  );
}

/** DatePicker trigger sized to match the toolbar's fields. The shared
 *  DatePicker only accepts a style object for its trigger, so this is
 *  the one place an inline style is unavoidable. */
export const fieldDateStyle: CSSProperties = {
  height: FIELD_H,
  borderRadius: 10,
  padding: "0 12px",
  fontSize: 13,
  background: "var(--bg-elev)",
  border: "1px solid var(--border-strong)",
  boxShadow: "var(--shadow-xs)",
};

/** Tiny uppercase caption placed before a toolbar control. */
export function FieldCaption({ children }: { children: ReactNode }) {
  return <span className="at-caption">{children}</span>;
}

/** Caption + control pair for toolbars. */
export function FieldGroup({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="at-field">
      <FieldCaption>{label}</FieldCaption>
      {children}
    </label>
  );
}

/** 24×24 stroke-icon paths for StatCard / EmptyPanel. */
export const ATT_ICON = {
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </>
  ),
  present: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.7 2.7L16 9.8" />
    </>
  ),
  late: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  absent: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  leave: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  face: (
    <>
      <circle cx="12" cy="9" r="4" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  unknown: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.4M12 17h.01" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M12 8v4M12 15.5h.01" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.5l9 16h-18z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  ),
  report: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 13h5M10 17h5" />
    </>
  ),
} as const;

/** Wrap ATT_ICON paths in a sized svg for EmptyPanel's icon slot. */
export function StrokeIcon({ children, size = 30 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
