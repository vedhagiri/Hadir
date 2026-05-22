// Shared anomaly / camera-limitation banner component.
// Displayed once above image / event sections — not repeated per row.

import { BsInfoCircleFill } from "react-icons/bs";

// ---------------------------------------------------------------------------
// AnomalyInfoBanner — single informational note shown above a section.
// ---------------------------------------------------------------------------

export function AnomalyInfoBanner({ message }: { message: string }) {
  return (
    <div
      role="note"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "9px 13px",
        borderRadius: 8,
        background: "var(--info-soft)",
        color: "var(--info-text)",
        fontSize: 12.5,
        lineHeight: 1.55,
        marginBottom: 12,
      }}
    >
      <BsInfoCircleFill aria-hidden style={{ flexShrink: 0, marginTop: 2, fontSize: 14 }} />
      <span>{message}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keep AnomalyNote + AnomalyNoteStack for any remaining inline usages.
// ---------------------------------------------------------------------------

export type AnomalyTone = "warning" | "danger" | "info" | "neutral";

const BG: Record<AnomalyTone, string> = {
  warning: "var(--warning-soft)",
  danger:  "var(--danger-soft)",
  info:    "var(--info-soft)",
  neutral: "var(--bg-sunken)",
};
const FG: Record<AnomalyTone, string> = {
  warning: "var(--warning-text)",
  danger:  "var(--danger-text)",
  info:    "var(--info-text)",
  neutral: "var(--text-secondary)",
};
const ICON: Record<AnomalyTone, string> = {
  warning: "⚠",
  danger:  "⚠",
  info:    "ℹ",
  neutral: "ℹ",
};

export interface AnomalyNoteItem {
  tone: AnomalyTone;
  message: string;
}

export function AnomalyNote({
  tone,
  message,
  variant = "pill",
}: {
  tone: AnomalyTone;
  message: string;
  variant?: "pill" | "block";
}) {
  if (variant === "block") {
    return (
      <div
        role="note"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          padding: "9px 12px",
          borderRadius: 8,
          fontSize: 12.5,
          fontWeight: 500,
          lineHeight: 1.55,
          background: BG[tone],
          color: FG[tone],
        }}
      >
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1.4, flexShrink: 0, marginTop: 1 }}>
          {ICON[tone]}
        </span>
        <span>{message}</span>
      </div>
    );
  }

  return (
    <span
      role="note"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        background: BG[tone],
        color: FG[tone],
      }}
    >
      <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>{ICON[tone]}</span>
      {message}
    </span>
  );
}

export function AnomalyNoteStack({
  notes,
  variant = "pill",
}: {
  notes: AnomalyNoteItem[];
  variant?: "pill" | "block";
}) {
  if (notes.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: variant === "block" ? "column" : "row",
        flexWrap: "wrap",
        gap: variant === "block" ? 6 : 4,
        alignItems: variant === "pill" ? "center" : "stretch",
      }}
    >
      {notes.map((n, i) => (
        <AnomalyNote key={i} tone={n.tone} message={n.message} variant={variant} />
      ))}
    </div>
  );
}
