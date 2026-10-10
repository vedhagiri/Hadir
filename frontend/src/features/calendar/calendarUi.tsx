// Shared building blocks for the Attendance Calendar redesign (Oct 2026):
// month navigator, six-tile summary strip, legend, status colours and
// the profile header used on the single-employee view. Kept in one
// module so the Company and Per-person views read as one calendar.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import type { Employee } from "../employees/types";

export type SummaryKey = "present" | "late" | "absent" | "leave" | "holiday" | "weekend";

/** Status colours. Design-system tokens where they exist; holiday has
 *  no token so it carries its own purple pair. */
export const TONE: Record<SummaryKey, { fg: string; soft: string; dot: string }> = {
  present: { fg: "var(--success-text)", soft: "var(--success-soft)", dot: "var(--success)" },
  late: { fg: "var(--warning-text)", soft: "var(--warning-soft)", dot: "var(--warning)" },
  absent: { fg: "var(--danger-text)", soft: "var(--danger-soft)", dot: "var(--danger)" },
  leave: { fg: "var(--info-text)", soft: "var(--info-soft)", dot: "var(--info)" },
  holiday: { fg: "#7e3fd1", soft: "#f3ebff", dot: "#9b5cf0" },
  weekend: { fg: "var(--text-secondary)", soft: "var(--bg-sunken)", dot: "var(--info-soft)" },
};

/** Light-blue tint used for weekend cells (matches the approved mock). */
export const WEEKEND_CELL_BG = "color-mix(in oklab, var(--info-soft) 70%, var(--bg-elev))";

// ---------------------------------------------------------------------------
// Month navigator: ‹  [ 📅 October 2026 ]  ›   (native month input inside)
// ---------------------------------------------------------------------------

export function MonthNav({
  month,
  onChange,
}: {
  month: string;
  onChange: (m: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const label = new Date(`${month}-01T00:00:00`).toLocaleDateString(
    i18n.language === "ar" ? "ar-OM" : "en-GB",
    { month: "long", year: "numeric" },
  );
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        className="btn"
        style={navBtn}
        onClick={() => onChange(shiftMonth(month, -1))}
        aria-label={t("calendar.prevMonth", { defaultValue: "Previous month" }) as string}
        title={t("calendar.prevMonth", { defaultValue: "Previous month" }) as string}
      >
        <Icon name="chevronLeft" size={14} />
      </button>
      <label
        className="btn"
        style={{ ...navBtn, width: "auto", padding: "0 14px", gap: 8, position: "relative", fontWeight: 600 }}
      >
        <Icon name="calendar" size={14} />
        <span style={{ minWidth: 104, textAlign: "center" }}>{label}</span>
        {/* Invisible native picker over the label: click opens the
            browser's month chooser, keyboard users get a real input. */}
        <input
          type="month"
          value={month}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          aria-label={t("calendar.month") as string}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%" }}
        />
      </label>
      <button
        type="button"
        className="btn"
        style={navBtn}
        onClick={() => onChange(shiftMonth(month, 1))}
        aria-label={t("calendar.nextMonth", { defaultValue: "Next month" }) as string}
        title={t("calendar.nextMonth", { defaultValue: "Next month" }) as string}
      >
        <Icon name="chevronRight" size={14} />
      </button>
    </div>
  );
}

const navBtn = {
  height: 38,
  width: 38,
  padding: 0,
  justifyContent: "center",
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 10,
} as const;

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Summary strip: six tiles, each with an icon, count, label and change
// versus the previous month.
// ---------------------------------------------------------------------------

export type SummaryCounts = Record<SummaryKey, number>;

const ICON_PATHS: Record<SummaryKey, ReactNode> = {
  present: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4M8.5 15l2.5 2.5 4.5-4.5" />
    </>
  ),
  late: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2M5 3L2 6M19 3l3 3" />
    </>
  ),
  absent: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </>
  ),
  leave: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  holiday: <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z" />,
  weekend: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4M8 13h2M14 13h2M8 17h2" />
    </>
  ),
};

export function SummaryStrip({
  counts,
  previous,
}: {
  counts: SummaryCounts;
  /** Same counts for the previous month; omit to hide the change. */
  previous?: SummaryCounts | null;
}) {
  const { t } = useTranslation();
  const keys: SummaryKey[] = ["present", "late", "absent", "leave", "holiday", "weekend"];
  return (
    <div
      className="card"
      style={{
        padding: 12,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 10,
        marginBottom: 16,
      }}
    >
      {keys.map((k) => {
        const tone = TONE[k];
        const prev = previous?.[k];
        // No baseline (prev month had none of this status) → no badge;
        // "+100%" against zero would be misleading.
        const change =
          prev === undefined ? null : prev === 0 ? (counts[k] === 0 ? 0 : null) : Math.round(((counts[k] - prev) / prev) * 100);
        return (
          <div
            key={k}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              borderRadius: 12,
              background: `color-mix(in oklab, ${tone.soft} 55%, var(--bg-elev))`,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 42,
                height: 42,
                flex: "0 0 42px",
                borderRadius: 11,
                display: "grid",
                placeItems: "center",
                background: tone.soft,
                color: k === "weekend" ? "var(--text-secondary)" : tone.fg,
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {ICON_PATHS[k]}
              </svg>
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, color: k === "leave" ? tone.fg : "var(--text)" }}>
                {counts[k]}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                {t(`calendar.status.${k}`) as string}
              </div>
            </div>
            {change !== null && (
              <span
                className="mono"
                title={t("calendar.vsPrevMonth", { defaultValue: "Change vs previous month" }) as string}
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: change === 0 ? "var(--text-tertiary)" : k === "weekend" ? "var(--text-secondary)" : tone.fg,
                  whiteSpace: "nowrap",
                }}
              >
                {change > 0 ? "↗ " : change < 0 ? "↘ " : ""}
                {Math.abs(change)}%
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend + small pieces
// ---------------------------------------------------------------------------

export function Legend() {
  const { t } = useTranslation();
  const keys: SummaryKey[] = ["present", "late", "absent", "leave", "holiday", "weekend"];
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 22,
        marginTop: 16,
        paddingTop: 14,
        borderTop: "1px solid var(--border)",
        fontSize: 12.5,
        color: "var(--text-secondary)",
      }}
    >
      {keys.map((k) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: TONE[k].dot,
              border: k === "weekend" ? "1px solid var(--border)" : "none",
            }}
          />
          {t(`calendar.status.${k}`) as string}
        </span>
      ))}
    </div>
  );
}

export function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block", flex: "0 0 8px" }}
    />
  );
}

export function WeekendPill() {
  const { t } = useTranslation();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 6,
        background: "var(--bg-elev)",
        color: "var(--info-text)",
        border: "1px solid color-mix(in oklab, var(--info) 45%, transparent)",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
      {t("calendar.status.weekend") as string}
    </span>
  );
}

export function GreyPill({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        fontSize: 11,
        fontWeight: 500,
        borderRadius: 6,
        background: "var(--bg-sunken)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </span>
  );
}

export const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function DowHeader() {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        gap: 6,
        marginBottom: 6,
        background: "var(--bg-sunken)",
        borderRadius: 8,
      }}
    >
      {DOW_KEYS.map((k) => (
        <div key={k} style={{ textAlign: "center", padding: "8px 0", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {t(`calendar.dow.${k}`) as string}
        </div>
      ))}
    </div>
  );
}

export function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Profile header for the single-employee view.
// ---------------------------------------------------------------------------

export function ProfileHeader({
  fullName,
  employeeCode,
  employee,
}: {
  fullName: string;
  employeeCode: string;
  employee: Employee | null | undefined;
}) {
  const { t } = useTranslation();
  const dept = employee?.department?.name ?? null;
  const active = employee ? employee.status === "active" : true;
  const facts: Array<{ icon: ReactNode; value: string; label: string }> = [];
  if (employee?.email) facts.push({ icon: <Icon name="mail" size={16} />, value: employee.email, label: t("calendar.profile.email", { defaultValue: "Email" }) as string });
  if (employee?.phone) facts.push({ icon: <PhoneIcon />, value: employee.phone, label: t("calendar.profile.phone", { defaultValue: "Phone" }) as string });
  if (dept) facts.push({ icon: <BuildingIcon />, value: dept, label: t("calendar.profile.department", { defaultValue: "Department" }) as string });

  return (
    <div
      className="card"
      style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", marginBottom: 20 }}
    >
      <div
        aria-hidden
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          background: avatarBg(fullName),
          color: "#fff",
          display: "grid",
          placeItems: "center",
          fontSize: 22,
          fontWeight: 700,
          flex: "0 0 64px",
        }}
      >
        {initials(fullName)}
      </div>
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 22, fontWeight: 700, color: "var(--text)" }}>{fullName}</span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "2px 10px",
              borderRadius: 6,
              background: active ? "var(--success-soft)" : "var(--bg-sunken)",
              color: active ? "var(--success-text)" : "var(--text-secondary)",
            }}
          >
            {active ? (t("calendar.profile.active", { defaultValue: "Active" }) as string) : (t("calendar.profile.inactive", { defaultValue: "Inactive" }) as string)}
          </span>
        </div>
        <div className="text-sm" style={{ color: "var(--text-secondary)", marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span className="mono">{employeeCode}</span>
          {employee?.designation && (
            <>
              <span aria-hidden style={{ color: "var(--border)" }}>|</span>
              <span>{employee.designation}</span>
            </>
          )}
          {dept && (
            <>
              <span aria-hidden style={{ color: "var(--border)" }}>|</span>
              <span>{dept}</span>
            </>
          )}
        </div>
      </div>
      {facts.map((f, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            paddingInlineStart: 18,
            borderInlineStart: "1px solid var(--border)",
            minWidth: 0,
          }}
        >
          <span
            aria-hidden
            style={{ width: 38, height: 38, borderRadius: 10, background: "var(--info-soft)", color: "var(--info-text)", display: "grid", placeItems: "center" }}
          >
            {f.icon}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)", overflowWrap: "anywhere" }}>{f.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{f.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" />
    </svg>
  );
}

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}

export function avatarBg(fullName: string): string {
  const palette = ["#f59e0b", "#f97316", "#8b5cf6", "#2563eb", "#06b6d4", "#0ea5e9", "#1d4ed8", "#ef4444", "#10b981", "#7c3aed"];
  let hash = 0;
  for (let i = 0; i < fullName.length; i++) hash = (hash * 31 + fullName.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length] as string;
}
