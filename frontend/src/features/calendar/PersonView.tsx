// Per-person monthly calendar (redesign, Oct 2026). Each worked day
// shows a coloured dot + status, then "in – out" times with the total
// on the right. Weekends get the light-blue tint + "Weekend" pill,
// days without a record a grey "No record" pill, future days are
// dimmed and not clickable. Escalation-confirmed days keep the teal
// left stripe.

import { useTranslation } from "react-i18next";

import { formatMinutes } from "../attendance/timeFormat";
import {
  Dot,
  DowHeader,
  EmptyMonth,
  GreyPill,
  Legend,
  PadCells,
  TONE,
  WeekendPill,
  isoToday,
} from "./calendarUi";
import type { PersonDay, PersonMonth } from "./types";

interface Props {
  person: PersonMonth;
  onPickDay: (isoDate: string) => void;
  /** The Calendar page shows a full profile card above, so it hides
   *  this compact name/code/shift header. */
  hideHeader?: boolean;
}

export function PersonView({ person, onPickDay, hideHeader = false }: Props) {
  const { t } = useTranslation();
  const first = person.days[0] ? new Date(`${person.days[0].date}T00:00:00`) : new Date();
  const leadingPad = first.getDay();
  const todayIso = isoToday();
  const shift = policyLabel(person.days);

  const hasRecords = person.days.some(
    (d) => d.in_time || (d.total_minutes != null && d.total_minutes > 0) || ["present", "escalation_present", "late", "absent", "leave", "waiting"].includes(d.status),
  );

  return (
    <div className="card co-cal">
      {!hideHeader && (
        <div className="flex items-center justify-between" style={{ marginBottom: 12, gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{person.full_name}</div>
            <div className="text-xs text-dim mono">{person.employee_code}</div>
          </div>
          {shift && (
            <div className="text-xs text-dim">
              {t("calendar.shiftLabel") as string}: {shift}
            </div>
          )}
        </div>
      )}
      {hasRecords ? (
        <>
          <DowHeader />
          <div className="cal-month-grid">
            <PadCells count={leadingPad} />
            {person.days.map((d) => (
              <DayCell key={d.date} day={d} isToday={d.date === todayIso} onClick={() => onPickDay(d.date)} />
            ))}
          </div>
          <Legend />
        </>
      ) : (
        <EmptyMonth month={person.month} />
      )}
    </div>
  );
}

function statusLine(day: PersonDay, t: ReturnType<typeof useTranslation>["t"]): { color: string; label: string } | null {
  switch (day.status) {
    case "present":
      return { color: TONE.present.dot, label: t("calendar.status.present") as string };
    case "escalation_present":
      return { color: "var(--accent)", label: t("calendar.status.escalation_present") as string };
    case "late":
      return { color: TONE.late.dot, label: t("calendar.status.late") as string };
    case "absent":
      return { color: TONE.absent.dot, label: t("calendar.status.absent") as string };
    case "waiting":
      return { color: "var(--accent)", label: t("calendar.status.waiting") as string };
    case "leave":
      return { color: TONE.leave.dot, label: day.leave_name || (t("calendar.status.leave") as string) };
    case "holiday":
      return { color: TONE.holiday.dot, label: day.holiday_name || (t("calendar.status.holiday") as string) };
    case "weekend":
      // Worked on a weekend — show it as present (overtime day).
      return day.in_time ? { color: TONE.present.dot, label: t("calendar.status.present") as string } : null;
    default:
      return null;
  }
}

/** Design status class for the tinted cell background. */
function cellStatusClass(day: PersonDay, isWeekend: boolean): string | null {
  if (isWeekend && !day.in_time) return "status-weekend";
  switch (day.status) {
    case "present":
    case "weekend":
      return day.in_time ? "status-present" : null;
    case "escalation_present":
      return "status-present status-escalation";
    case "late":
      return "status-late";
    case "absent":
      return "status-absent";
    case "leave":
      return "status-leave";
    case "holiday":
      return "status-holiday";
    default:
      return null;
  }
}

function DayCell({ day, isToday, onClick }: { day: PersonDay; isToday: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const dayNum = parseInt(day.date.slice(8, 10), 10);
  const clickable = day.status !== "future";
  const isWeekend = day.is_weekend || day.status === "weekend";
  const line = statusLine(day, t);
  const total = day.total_minutes != null && day.total_minutes > 0 ? formatMinutes(day.total_minutes) : null;
  const tooltip = [
    day.date,
    t(`calendar.status.${day.status}`) as string,
    day.in_time ? `in ${day.in_time.slice(0, 5)}` : null,
    day.out_time ? `out ${day.out_time.slice(0, 5)}` : null,
    total,
    day.holiday_name ?? null,
    day.leave_name ?? null,
  ]
    .filter(Boolean)
    .join(" — ");
  const cls = ["cal-day is-compact", isToday && "today", !clickable && "is-future", cellStatusClass(day, isWeekend)]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      title={tooltip}
      aria-label={tooltip}
      className={cls}
    >
      <span className="cal-day-num">{dayNum}</span>
      {line && (
        <span className="co-cal-line" style={{ fontSize: 12.5, color: "var(--text)" }}>
          <Dot color={line.color} />
          <span className="co-cal-line-label" style={{ color: "inherit" }}>{line.label}</span>
        </span>
      )}
      {day.in_time && (
        <span className="cal-hours">
          <span>
            {day.in_time.slice(0, 5)}
            {day.out_time ? ` - ${day.out_time.slice(0, 5)}` : ""}
          </span>
          {total && <span>{total}</span>}
        </span>
      )}
      <span className="cal-flag">
        {isWeekend && !day.in_time ? (
          <WeekendPill />
        ) : day.status === "no_record" ? (
          <GreyPill>{t("calendar.status.no_record") as string}</GreyPill>
        ) : null}
      </span>
    </button>
  );
}

function policyLabel(days: PersonDay[]): string | null {
  for (const d of days) if (d.policy_name) return d.policy_name;
  return null;
}

/** Parse ``HH:MM[:SS]`` → minutes since midnight. Returns null on parse failure. */
function hhmToMinutes(s: string): number | null {
  const parts = s.split(":");
  const h = parseInt(parts[0] ?? "", 10);
  const m = parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/** How many minutes past the grace-end did the employee arrive?
 *  Returns null when inputs are insufficient, 0 when on time. */
export function calcLateMinutes(
  inTime: string,
  shiftStart: string,
  graceMinutes: number,
): number | null {
  const actual = hhmToMinutes(inTime);
  const expected = hhmToMinutes(shiftStart);
  if (actual == null || expected == null) return null;
  const graceEnd = expected + graceMinutes;
  return Math.max(0, actual - graceEnd);
}

/** Format a minute count as a compact ``Xh Ym`` / ``Xm`` string.
 *  Re-export so existing call sites (LateBy row) keep working; the
 *  canonical implementation lives in ``attendance/timeFormat`` so
 *  total / overtime / late durations all render identically.
 */
export { formatMinutes as fmtMinutes };
