// Shared building blocks for the Attendance Calendar redesign (Oct 2026):
// month navigator, six-tile summary strip, legend, status colours and
// the profile header used on the single-employee view. Kept in one
// module so the Company and Per-person views read as one calendar.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import type { Employee } from "../employees/types";
import "../cameras/coreUi";

export type SummaryKey = "present" | "late" | "absent" | "leave" | "holiday" | "weekend";

/** Status colours. Design-system tokens where they exist; holiday has
 *  no token so it carries its own purple pair. */
export const TONE: Record<SummaryKey, { fg: string; soft: string; dot: string }> = {
  present: { fg: "var(--success-text)", soft: "var(--success-soft)", dot: "var(--success)" },
  late: { fg: "var(--warning-text)", soft: "var(--warning-soft)", dot: "var(--warning)" },
  absent: { fg: "var(--danger-text)", soft: "var(--danger-soft)", dot: "var(--danger)" },
  leave: { fg: "var(--info-text)", soft: "var(--info-soft)", dot: "var(--info)" },
  holiday: { fg: "var(--co-holiday-fg)", soft: "var(--co-holiday-soft)", dot: "var(--co-holiday-dot)" },
  weekend: { fg: "var(--text-secondary)", soft: "var(--bg-sunken)", dot: "var(--info-soft)" },
};


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
    <div className="card co-summary">
      {keys.map((k) => {
        const tone = TONE[k];
        const prev = previous?.[k];
        // No baseline (prev month had none of this status) → no badge;
        // "+100%" against zero would be misleading.
        const change =
          prev === undefined ? null : prev === 0 ? (counts[k] === 0 ? 0 : null) : Math.round(((counts[k] - prev) / prev) * 100);
        return (
          <div key={k} className="co-summary-tile">
            <span
              aria-hidden
              className="co-summary-icon"
              style={{ background: tone.soft, color: k === "weekend" ? "var(--text-secondary)" : tone.fg }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {ICON_PATHS[k]}
              </svg>
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="co-summary-value">{counts[k]}</div>
              <div className="co-summary-label">{t(`calendar.status.${k}`) as string}</div>
            </div>
            {change !== null && (
              <span
                className="co-summary-delta"
                title={t("calendar.vsPrevMonth", { defaultValue: "Change vs previous month" }) as string}
                style={{ color: change === 0 ? "var(--text-tertiary)" : k === "weekend" ? "var(--text-secondary)" : tone.fg }}
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

export function Legend({ hint }: { hint?: string }) {
  const { t } = useTranslation();
  const keys: SummaryKey[] = ["present", "late", "absent", "leave", "holiday", "weekend"];
  return (
    <div className="cal-legend">
      {keys.map((k) => (
        <span key={k} className="co-cal-legend-item">
          <span
            aria-hidden
            className="dot"
            style={{ background: TONE[k].dot, border: k === "weekend" ? "1px solid var(--border)" : "none" }}
          />
          {t(`calendar.status.${k}`) as string}
        </span>
      ))}
      {hint && <span className="co-cal-hint">{hint}</span>}
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
    <span className="co-cal-pill tone-weekend">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
      {t("calendar.status.weekend") as string}
    </span>
  );
}

export function HolidayPill({ children }: { children: ReactNode }) {
  return <span className="co-cal-pill tone-holiday">{children}</span>;
}

export function GreyPill({ children }: { children: ReactNode }) {
  return <span className="co-cal-pill">{children}</span>;
}

export const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function DowHeader() {
  const { t } = useTranslation();
  return (
    <div className="co-cal-dow-row">
      {DOW_KEYS.map((k) => (
        <div key={k} className="cal-dow">
          {t(`calendar.dow.${k}`) as string}
        </div>
      ))}
    </div>
  );
}

/** Leading blank cells before the 1st of the month. */
export function PadCells({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={`pad-${i}`} aria-hidden className="cal-day is-pad" />
      ))}
    </>
  );
}

/** Inline empty message for a month with no attendance records at all
 *  — replaces the all-grey grid (brief addendum). */
export function EmptyMonth({ month }: { month: string }) {
  const { t, i18n } = useTranslation();
  const label = new Date(`${month}-01T00:00:00`).toLocaleDateString(
    i18n.language === "ar" ? "ar-OM" : "en-GB",
    { month: "long", year: "numeric" },
  );
  return (
    <div className="co-cal-empty" role="status">
      <span aria-hidden className="co-cal-empty-icon">
        <Icon name="calendar" size={18} />
      </span>
      <div>
        <div className="co-cal-empty-title">
          {t("calendar.emptyMonthTitle", { month: label, defaultValue: "No attendance recorded for {{month}}" }) as string}
        </div>
        <div className="co-cal-empty-body">
          {t("calendar.emptyMonthBody", { defaultValue: "Days fill in as cameras and terminals report presence. Use the month navigator to look at another month." }) as string}
        </div>
      </div>
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
    <div className="card co-profile">
      <div aria-hidden className="co-profile-avatar" style={{ background: avatarBg(fullName) }}>
        {initials(fullName)}
      </div>
      <div className="co-profile-main">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="co-profile-name">{fullName}</span>
          <span className={`pill ${active ? "pill-success" : "pill-neutral"}`}>
            {active ? (t("calendar.profile.active", { defaultValue: "Active" }) as string) : (t("calendar.profile.inactive", { defaultValue: "Inactive" }) as string)}
          </span>
        </div>
        <div className="co-profile-sub">
          <span className="mono">{employeeCode}</span>
          {employee?.designation && (
            <>
              <span aria-hidden className="co-profile-sep">|</span>
              <span>{employee.designation}</span>
            </>
          )}
          {dept && (
            <>
              <span aria-hidden className="co-profile-sep">|</span>
              <span>{dept}</span>
            </>
          )}
        </div>
      </div>
      {facts.map((f, i) => (
        <div key={i} className="co-profile-fact">
          <span aria-hidden className="co-profile-fact-icon">{f.icon}</span>
          <div style={{ minWidth: 0 }}>
            <div className="co-profile-fact-value">{f.value}</div>
            <div className="co-profile-fact-label">{f.label}</div>
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
  // Hue wheel in OKLCH so every avatar sits at the same lightness/chroma.
  const palette = [40, 70, 300, 255, 200, 230, 265, 25, 160, 290].map((h) => `oklch(0.62 0.16 ${h})`);
  let hash = 0;
  for (let i = 0; i < fullName.length; i++) hash = (hash * 31 + fullName.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length] as string;
}
