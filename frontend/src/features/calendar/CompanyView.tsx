// Company-wide month view (redesign, Oct 2026). Each day shows a
// coloured dot + count + label per status, the day number top-right,
// a light-blue tint and "Weekend" pill on weekends, a purple tint and
// the holiday name on holidays, and a grey "No record" pill when the
// day has no attendance rows. Today gets an accent outline.

import { useTranslation } from "react-i18next";

import {
  Dot,
  DowHeader,
  GreyPill,
  Legend,
  TONE,
  WEEKEND_CELL_BG,
  WeekendPill,
  isoToday,
} from "./calendarUi";
import type { CompanyDay } from "./types";

interface Props {
  month: string;
  days: CompanyDay[];
  onPickDate: (isoDate: string) => void;
}

export function CompanyView({ month, days, onPickDate }: Props) {
  const { t } = useTranslation();
  const first = days[0] ? new Date(`${days[0].date}T00:00:00`) : new Date();
  const leadingPad = first.getDay();
  const todayIso = isoToday();

  return (
    <div className="card" style={{ padding: 16 }}>
      <DowHeader />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
        {Array.from({ length: leadingPad }).map((_, i) => (
          <div key={`pad-${i}`} aria-hidden style={{ border: "1px solid var(--border)", borderRadius: 10, minHeight: 92, background: "var(--bg-elev)" }} />
        ))}
        {days.map((d) => (
          <DayCell key={d.date} day={d} isToday={d.date === todayIso} onClick={() => onPickDate(d.date)} />
        ))}
      </div>
      <Legend />
      <div className="text-xs text-dim" style={{ marginTop: 8 }}>
        {t("calendar.companyHint", { month }) as string}
      </div>
    </div>
  );
}

function DayCell({ day, isToday, onClick }: { day: CompanyDay; isToday: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const dayNum = parseInt(day.date.slice(8, 10), 10);
  const bg = day.is_weekend ? WEEKEND_CELL_BG : day.is_holiday ? TONE.holiday.soft : "var(--bg-elev)";

  const counts = [
    { key: "present", value: day.present_count, color: TONE.present.dot, fg: TONE.present.fg },
    { key: "late", value: day.late_count, color: TONE.late.dot, fg: TONE.late.fg },
    { key: "absent", value: day.absent_count, color: TONE.absent.dot, fg: TONE.absent.fg },
    { key: "waiting", value: day.waiting_count, color: "var(--accent)", fg: "var(--accent-text)" },
    { key: "leave", value: day.leave_count, color: TONE.leave.dot, fg: TONE.leave.fg },
  ].filter((c) => c.value > 0);
  const empty = counts.length === 0;

  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltipFor(day)}
      style={{
        appearance: "none",
        textAlign: "start",
        font: "inherit",
        background: bg,
        border: isToday ? "2px solid var(--accent)" : "1px solid var(--border)",
        borderRadius: 10,
        padding: isToday ? "7px 11px 9px" : "8px 12px 10px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 92,
      }}
    >
      <span className="mono" style={{ alignSelf: "flex-end", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{dayNum}</span>
      {counts.map((c) => (
        <span key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <Dot color={c.color} />
          <span className="mono" style={{ fontWeight: 700, color: c.fg, minWidth: 22 }}>{c.value}</span>
          <span style={{ color: "var(--text-secondary)" }}>{t(`calendar.status.${c.key}`) as string}</span>
        </span>
      ))}
      <span style={{ marginTop: "auto" }}>
        {day.is_weekend ? (
          <WeekendPill />
        ) : day.is_holiday ? (
          <span style={{ display: "inline-block", padding: "2px 8px", fontSize: 11, fontWeight: 600, borderRadius: 6, background: "var(--bg-elev)", color: TONE.holiday.fg, border: `1px solid ${TONE.holiday.dot}` }}>
            {day.holiday_name || (t("calendar.status.holiday") as string)}
          </span>
        ) : empty ? (
          <GreyPill>{t("calendar.status.no_record") as string}</GreyPill>
        ) : null}
      </span>
    </button>
  );
}

function tooltipFor(d: CompanyDay): string {
  const parts = [
    `${d.date}`,
    `${d.percent_present}% present`,
    `${d.present_count} present · ${d.late_count} late · ${d.absent_count} absent · ${d.leave_count} leave`,
    `of ${d.active_employees}`,
  ];
  if (d.holiday_name) parts.push(`holiday: ${d.holiday_name}`);
  return parts.join(" — ");
}
