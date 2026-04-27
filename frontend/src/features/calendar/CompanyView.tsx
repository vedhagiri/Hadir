// Company-wide month view — % present per day with a mini stacked
// bar revealing late + absent + leave counts on hover. Click any day
// to drill into a per-person table for that date in the parent page.

import { useTranslation } from "react-i18next";

import type { CompanyDay } from "./types";

interface Props {
  month: string;
  days: CompanyDay[];
  onPickDate: (isoDate: string) => void;
}

export function CompanyView({ month, days, onPickDate }: Props) {
  const { t } = useTranslation();

  // ``date`` parses with ``new Date(`${month}-01`)`` — we use the first
  // day's index in the week to pad leading cells so the month grid
  // aligns with Sunday-first column headers (the design's pattern in
  // ``employee.jsx``).
  const first = days[0] ? new Date(`${days[0].date}T00:00:00`) : new Date();
  const leadingPad = first.getDay();

  const todayIso = isoToday();

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="cal-month-grid" style={{ marginBottom: 4 }}>
        {DOW_KEYS.map((k) => (
          <div key={k} className="cal-dow">
            {t(`calendar.dow.${k}`) as string}
          </div>
        ))}
      </div>
      <div className="cal-month-grid">
        {Array.from({ length: leadingPad }).map((_, i) => (
          <div key={`pad-${i}`} className="cal-day other-month" aria-hidden />
        ))}
        {days.map((d) => {
          const status = pickStatus(d);
          const isToday = d.date === todayIso;
          const dayNum = parseInt(d.date.slice(8, 10), 10);
          // Holiday + weekend share ``--bg-sunken`` in the design CSS,
          // which makes them visually identical. Override here to give
          // holidays a distinct cyan tint (the only soft token the
          // calendar's status set leaves unused) while weekends stay
          // on the muted sunken fill plus a diagonal-stripe pattern
          // for at-a-glance "off day" semantics.
          const fillOverride = d.is_holiday
            ? { background: "var(--accent-soft)" }
            : d.is_weekend
              ? {
                  background:
                    "repeating-linear-gradient(135deg, var(--bg-sunken) 0 6px, var(--bg-elev) 6px 12px)",
                }
              : null;
          return (
            <button
              key={d.date}
              type="button"
              onClick={() => onPickDate(d.date)}
              className={[
                "cal-day",
                `status-${status}`,
                isToday ? "today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                cursor: "pointer",
                textAlign: "start",
                font: "inherit",
                ...(fillOverride ?? {}),
              }}
              title={tooltipFor(d)}
            >
              <div className="cal-day-num">{dayNum}</div>
              {d.is_holiday ? (
                <div className="cal-flag" style={{ fontSize: 10 }}>
                  {(t("calendar.holiday") as string)}
                </div>
              ) : d.is_weekend ? (
                <div className="cal-flag" style={{ fontSize: 10 }}>
                  {(t("calendar.weekend") as string)}
                </div>
              ) : (
                <>
                  <div className="cal-hours">
                    {d.percent_present}%
                  </div>
                  <StackedBar day={d} />
                </>
              )}
            </button>
          );
        })}
      </div>

      <Legend />
      <div
        className="text-xs text-dim"
        style={{ marginTop: 8 }}
      >
        {t("calendar.companyHint", { month }) as string}
      </div>
    </div>
  );
}

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function pickStatus(d: CompanyDay): string {
  if (d.is_holiday) return "holiday";
  if (d.is_weekend) return "weekend";
  if (d.absent_count > 0 && d.absent_count > d.late_count + d.present_count) {
    return "absent";
  }
  if (d.late_count > 0 && d.late_count >= d.present_count) return "late";
  if (d.present_count > 0 || d.leave_count > 0) return "present";
  return "no_record";
}

function tooltipFor(d: CompanyDay): string {
  const parts = [
    `${d.date}`,
    `${d.percent_present}% present`,
    `${d.present_count}p · ${d.late_count}L · ${d.absent_count}A · ${d.leave_count}lv`,
    `of ${d.active_employees}`,
  ];
  if (d.holiday_name) parts.push(`holiday: ${d.holiday_name}`);
  return parts.join(" — ");
}

function StackedBar({ day }: { day: CompanyDay }) {
  const total = Math.max(
    1,
    day.present_count + day.late_count + day.absent_count + day.leave_count,
  );
  const seg = (n: number) => `${(100 * n) / total}%`;
  return (
    <div
      style={{
        display: "flex",
        height: 4,
        marginTop: "auto",
        borderRadius: 2,
        overflow: "hidden",
        background: "var(--bg-sunken)",
      }}
      aria-hidden
    >
      <span style={{ width: seg(day.present_count), background: "var(--success)" }} />
      <span style={{ width: seg(day.late_count), background: "var(--warning)" }} />
      <span style={{ width: seg(day.absent_count), background: "var(--danger)" }} />
      <span style={{ width: seg(day.leave_count), background: "var(--info)" }} />
    </div>
  );
}

function Legend() {
  const { t } = useTranslation();
  // Swatches mirror the day-cell fills:
  // - present/late/absent/leave use the design's solid accent colors
  //   (deeper than the cell's soft tint, but the same hue family so a
  //   reader maps swatch → cell at a glance).
  // - holiday: cyan accent-soft (matches the cell override)
  // - weekend: diagonal stripes (matches the cell override)
  const items = [
    { key: "present", color: "var(--success)" },
    { key: "late", color: "var(--warning)" },
    { key: "absent", color: "var(--danger)" },
    { key: "leave", color: "var(--info)" },
    { key: "holiday", color: "var(--accent-soft)", border: true },
    {
      key: "weekend",
      color:
        "repeating-linear-gradient(135deg, var(--bg-sunken) 0 4px, var(--bg-elev) 4px 8px)",
      border: true,
    },
  ];
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        marginTop: 14,
        paddingTop: 12,
        borderTop: "1px solid var(--border)",
        fontSize: 11,
        color: "var(--text-tertiary)",
      }}
    >
      {items.map((it) => (
        <div
          key={it.key}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: it.color,
              border: it.border ? "1px solid var(--border)" : "none",
              display: "inline-block",
            }}
            aria-hidden
          />
          <span>{t(`calendar.status.${it.key}`) as string}</span>
        </div>
      ))}
    </div>
  );
}

function isoToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
