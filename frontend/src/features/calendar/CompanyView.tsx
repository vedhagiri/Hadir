// Company-wide month view (redesign, Oct 2026). Each day shows a
// coloured dot + count + label per status, the day number top-right,
// a light-blue tint and "Weekend" pill on weekends, a purple tint and
// the holiday name on holidays, and a grey "No record" pill when the
// day has no attendance rows. Today gets an accent outline.

import { useTranslation } from "react-i18next";

import {
  Dot,
  DowHeader,
  EmptyMonth,
  GreyPill,
  HolidayPill,
  Legend,
  PadCells,
  TONE,
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

  const hasRecords = days.some(
    (d) => d.present_count + d.late_count + d.absent_count + d.waiting_count + d.leave_count > 0,
  );

  return (
    <div className="card co-cal">
      {hasRecords ? (
        <>
          <DowHeader />
          <div className="cal-month-grid">
            <PadCells count={leadingPad} />
            {days.map((d) => (
              <DayCell key={d.date} day={d} isToday={d.date === todayIso} onClick={() => onPickDate(d.date)} />
            ))}
          </div>
          <Legend hint={t("calendar.companyHint", { month }) as string} />
        </>
      ) : (
        <EmptyMonth month={month} />
      )}
    </div>
  );
}

function DayCell({ day, isToday, onClick }: { day: CompanyDay; isToday: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const dayNum = parseInt(day.date.slice(8, 10), 10);
  const cls = ["cal-day", isToday && "today", day.is_weekend && "status-weekend", !day.is_weekend && day.is_holiday && "status-holiday"]
    .filter(Boolean)
    .join(" ");

  const counts = [
    { key: "present", value: day.present_count, color: TONE.present.dot, fg: TONE.present.fg },
    { key: "late", value: day.late_count, color: TONE.late.dot, fg: TONE.late.fg },
    { key: "absent", value: day.absent_count, color: TONE.absent.dot, fg: TONE.absent.fg },
    { key: "waiting", value: day.waiting_count, color: "var(--accent)", fg: "var(--accent-text)" },
    { key: "leave", value: day.leave_count, color: TONE.leave.dot, fg: TONE.leave.fg },
  ].filter((c) => c.value > 0);
  const empty = counts.length === 0;

  return (
    <button type="button" onClick={onClick} title={tooltipFor(day)} className={cls}>
      <span className="cal-day-num">{dayNum}</span>
      {counts.map((c) => (
        <span key={c.key} className="co-cal-line">
          <Dot color={c.color} />
          <span className="co-cal-line-num" style={{ color: c.fg }}>{c.value}</span>
          <span className="co-cal-line-label">{t(`calendar.status.${c.key}`) as string}</span>
        </span>
      ))}
      <span className="cal-flag">
        {day.is_weekend ? (
          <WeekendPill />
        ) : day.is_holiday ? (
          <HolidayPill>{day.holiday_name || (t("calendar.status.holiday") as string)}</HolidayPill>
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
