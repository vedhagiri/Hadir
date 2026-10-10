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
  GreyPill,
  Legend,
  TONE,
  WEEKEND_CELL_BG,
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

  return (
    <div className="card" style={{ padding: 16 }}>
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
      <DowHeader />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
        {Array.from({ length: leadingPad }).map((_, i) => (
          <div key={`pad-${i}`} aria-hidden style={{ border: "1px solid var(--border)", borderRadius: 10, minHeight: 82, background: "var(--bg-elev)" }} />
        ))}
        {person.days.map((d) => (
          <DayCell key={d.date} day={d} isToday={d.date === todayIso} onClick={() => onPickDay(d.date)} />
        ))}
      </div>
      <Legend />
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

function DayCell({ day, isToday, onClick }: { day: PersonDay; isToday: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const dayNum = parseInt(day.date.slice(8, 10), 10);
  const clickable = day.status !== "future";
  const isWeekend = day.is_weekend || day.status === "weekend";
  const bg = isWeekend ? WEEKEND_CELL_BG : day.status === "holiday" ? TONE.holiday.soft : "var(--bg-elev)";
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

  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      title={tooltip}
      aria-label={tooltip}
      style={{
        appearance: "none",
        textAlign: "start",
        font: "inherit",
        position: "relative",
        background: bg,
        border: isToday ? "2px solid var(--accent)" : "1px solid var(--border)",
        borderRadius: 10,
        padding: isToday ? "7px 11px 9px" : "8px 12px 10px",
        cursor: clickable ? "pointer" : "default",
        opacity: day.status === "future" ? 0.5 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 5,
        minHeight: 82,
        overflow: "hidden",
      }}
    >
      {day.status === "escalation_present" && (
        <span aria-hidden style={{ position: "absolute", insetInlineStart: 0, top: 0, bottom: 0, width: 3, background: "var(--accent)" }} />
      )}
      <span className="mono" style={{ alignSelf: "flex-end", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{dayNum}</span>
      {line && (
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text)", minWidth: 0 }}>
          <Dot color={line.color} />
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{line.label}</span>
        </span>
      )}
      {day.in_time && (
        <span className="mono" style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11.5, color: "var(--text-secondary)", flexWrap: "wrap" }}>
          <span>
            {day.in_time.slice(0, 5)}
            {day.out_time ? ` - ${day.out_time.slice(0, 5)}` : ""}
          </span>
          {total && <span>{total}</span>}
        </span>
      )}
      <span style={{ marginTop: "auto" }}>
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
