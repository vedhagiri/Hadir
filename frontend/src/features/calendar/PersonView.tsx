// Per-person monthly calendar — laid out like
// docs/scripts/issues-screenshots/04-Monthly_attendance_calender_view.png:
//   * day number top-right
//   * "→ 09:30" in-time row (up-arrow, success accent)
//   * "→ 19:00" out-time row (down-arrow, danger accent)
//   * "9 hrs" totals row
//   * status pill at bottom (Week off / Absent / Holiday / Leave / etc.)
//
// Cells are taller than the company view so all four lines fit. The
// design CSS's ``.cal-day`` is too compact for this layout, so the
// person view uses its own inline-styled cell wrapper.

import { useTranslation } from "react-i18next";

import { LateBadge } from "../../components/LateBadge";
import { Icon } from "../../shell/Icon";
import { formatMinutes } from "../attendance/timeFormat";
import type { CalendarStatus, PersonDay, PersonMonth } from "./types";

interface Props {
  person: PersonMonth;
  onPickDay: (isoDate: string) => void;
}

export function PersonView({ person, onPickDay }: Props) {
  const { t } = useTranslation();

  const first = person.days[0]
    ? new Date(`${person.days[0].date}T00:00:00`)
    : new Date();
  const leadingPad = first.getDay();
  const todayIso = isoToday();

  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: 12, gap: 12 }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {person.full_name}
          </div>
          <div className="text-xs text-dim mono">{person.employee_code}</div>
        </div>
        {/* Show the policy name from any day in the month so the
            operator sees the active shift at a glance — same shape as
            the screenshot's "Shift: General · 9:30 AM to 6:30 PM". */}
        <div className="text-xs text-dim">
          {policyLabel(person.days)
            ? `${t("calendar.shiftLabel") as string}: ${policyLabel(person.days)}`
            : null}
        </div>
      </div>

      <div className="cal-month-grid" style={{ marginBottom: 4 }}>
        {DOW_KEYS.map((k) => (
          <div key={k} className="cal-dow">
            {t(`calendar.dow.${k}`) as string}
          </div>
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 4,
        }}
      >
        {Array.from({ length: leadingPad }).map((_, i) => (
          <div
            key={`pad-${i}`}
            style={{ aspectRatio: "1 / 1.15", visibility: "hidden" }}
            aria-hidden
          />
        ))}
        {person.days.map((d) => (
          <DayCell
            key={d.date}
            day={d}
            isToday={d.date === todayIso}
            onClick={() => onPickDay(d.date)}
          />
        ))}
      </div>
    </div>
  );
}

function DayCell({
  day,
  isToday,
  onClick,
}: {
  day: PersonDay;
  isToday: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const dayNum = parseInt(day.date.slice(8, 10), 10);
  const clickable = day.status !== "future";

  // Cell background — match the screenshot's flat white cells,
  // tinted only for special statuses. ``waiting`` is the today-only
  // state for employees who can still arrive within the open shift
  // window — distinct from absent (danger) so the operator isn't
  // misled about staff who simply haven't checked in yet.
  const bg =
    day.status === "weekend"        ? "var(--info-soft)"
    : day.status === "holiday"      ? "var(--accent-soft)"
    : day.status === "leave"        ? "var(--warning-soft)"
    : day.status === "absent"       ? "var(--danger-soft)"
    : day.status === "waiting"      ? "var(--accent-soft)"
    : day.status === "late"         ? "var(--warning-soft)"
    : day.status === "present"      ? "var(--success-soft)"
    : day.status === "escalation_present" ? "var(--success-soft)"
    : day.status === "no_record"    ? "var(--bg-sunken)"
    : "var(--bg-elev)";

  const totalHours =
    day.total_minutes != null && day.total_minutes > 0
      ? formatMinutes(day.total_minutes)
      : null;

  const tooltip = [
    day.date,
    t(`calendar.status.${day.status}`) as string,
    day.in_time ? `in ${day.in_time.slice(0, 5)}` : null,
    day.out_time ? `out ${day.out_time.slice(0, 5)}` : null,
    totalHours,
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
        background: bg,
        border: `1px solid ${isToday ? "var(--accent)" : "var(--border)"}`,
        borderWidth: isToday ? 1.5 : 1,
        borderRadius: 7,
        padding: "6px 8px 8px",
        position: "relative",
        cursor: clickable ? "pointer" : "default",
        opacity: day.status === "future" ? 0.45 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 3,
        minHeight: 96,
      }}
    >
      {/* Late status stripe */}
      {day.status === "late" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            insetInlineStart: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: "var(--warning-text)",
            borderTopLeftRadius: 7,
            borderBottomLeftRadius: 7,
          }}
        />
      )}
      {/* Escalation-present stripe — teal accent stripe marks that the
          attendance was confirmed via Manager + HR escalation approval,
          not a direct camera detection. */}
      {day.status === "escalation_present" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            insetInlineStart: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: "var(--accent)",
            borderTopLeftRadius: 7,
            borderBottomLeftRadius: 7,
          }}
        />
      )}

      {/* Day number — top-right per screenshot */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 2,
        }}
      >
        <span style={{ width: 14 }} aria-hidden />
        <span
          className="mono"
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            color: "var(--text)",
          }}
        >
          {dayNum}
        </span>
      </div>

      {/* In time / Out time / hours — only when there's an actual record */}
      {day.in_time && (
        <TimeRow
          arrow="in"
          time={day.in_time.slice(0, 5)}
          color={
            day.status === "late"
              ? "var(--warning-text)"
              : "var(--success-text, var(--success))"
          }
        />
      )}
      {/* Late: show expected time + late-by duration beneath the in-time row */}
      {day.status === "late" && day.in_time && day.policy_shift_start && (
        <LateByRow
          inTime={day.in_time}
          shiftStart={day.policy_shift_start}
          graceMinutes={day.policy_grace_minutes ?? 0}
        />
      )}
      {day.out_time && (
        <TimeRow
          arrow="out"
          time={day.out_time.slice(0, 5)}
          color="var(--danger-text, var(--danger))"
        />
      )}
      {totalHours && (
        <div
          className="mono text-xs"
          style={{
            fontSize: 10.5,
            color: "var(--text-secondary)",
            marginTop: 1,
          }}
        >
          {totalHours}
        </div>
      )}

      {/* Status pill — anchored to the bottom of the cell */}
      <div style={{ marginTop: "auto", paddingTop: 4 }}>
        <StatusPill day={day} />
      </div>
    </button>
  );
}

function TimeRow({
  arrow,
  time,
  color,
}: {
  arrow: "in" | "out";
  time: string;
  color: string;
}) {
  // Up-arrow for in (clock-in, green); down-arrow for out (clock-out,
  // red). Same convention as the reference screenshot.
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        color,
      }}
    >
      <Icon
        name={arrow === "in" ? "chevronUp" : "chevronDown"}
        size={10}
      />
      <span
        className="mono"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {time}
      </span>
    </div>
  );
}

function LateByRow({
  inTime,
  shiftStart,
  graceMinutes,
}: {
  inTime: string;
  shiftStart: string;
  graceMinutes: number;
}) {
  const lateBy = calcLateMinutes(inTime, shiftStart, graceMinutes);
  if (lateBy == null || lateBy <= 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        fontSize: 10,
        color: "var(--warning-text)",
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      <span aria-hidden>+</span>
      <span className="mono">{formatMinutes(lateBy)}</span>
    </div>
  );
}

function StatusPill({ day }: { day: PersonDay }) {
  const { t } = useTranslation();
  // Late is the call-to-action status, so it gets a dedicated badge
  // with stronger weight + an icon (see ``LateBadge``). Other states
  // keep the soft generic pill — they communicate state without
  // demanding the operator's attention.
  if (day.status === "late") {
    return <LateBadge size="sm" />;
  }
  const label = labelFor(day, t);
  if (label === null) return null;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        fontSize: 10,
        fontWeight: 500,
        borderRadius: 3,
        background: pillBg(day.status),
        color: pillFg(day.status),
        border: `1px solid ${pillBorder(day.status)}`,
      }}
    >
      {label}
    </span>
  );
}

function labelFor(
  day: PersonDay,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (day.is_weekend && !day.in_time) {
    return t("calendar.weekendShort", {
      defaultValue: "Week off",
    }) as string;
  }
  if (day.holiday_name) return day.holiday_name;
  if (day.leave_name) return day.leave_name;
  if (day.status === "waiting") {
    return t("calendar.waitingShort", {
      defaultValue: "Waiting",
    }) as string;
  }
  if (day.status === "absent") {
    return t("calendar.absentShort", { defaultValue: "Absent" }) as string;
  }
  if (day.status === "late") {
    return t("calendar.lateShort", { defaultValue: "Late" }) as string;
  }
  if (day.status === "escalation_present") {
    return t("calendar.escalationPresentShort", { defaultValue: "Escalation" }) as string;
  }
  return null;
}

function pillBg(status: CalendarStatus): string {
  switch (status) {
    case "weekend":          return "var(--info-soft)";
    case "holiday":          return "var(--accent-soft)";
    case "leave":            return "var(--warning-soft)";
    case "absent":           return "var(--danger-soft)";
    case "late":             return "var(--warning-soft)";
    case "waiting":          return "var(--accent-soft)";
    case "present":          return "var(--success-soft)";
    case "escalation_present": return "color-mix(in oklab, var(--accent) 18%, var(--bg))";
    default:                 return "var(--bg-sunken)";
  }
}

function pillFg(status: CalendarStatus): string {
  switch (status) {
    case "weekend":          return "var(--info-text, var(--info))";
    case "holiday":          return "var(--accent-text)";
    case "leave":            return "var(--warning-text)";
    case "absent":           return "var(--danger-text)";
    case "late":             return "var(--warning-text)";
    case "present":          return "var(--success-text)";
    case "escalation_present": return "var(--accent-text)";
    default:                 return "var(--text-secondary)";
  }
}

function pillBorder(status: CalendarStatus): string {
  switch (status) {
    case "weekend":          return "var(--info-text, var(--info))";
    case "holiday":          return "var(--accent-text)";
    case "leave":            return "var(--warning-text)";
    case "absent":           return "var(--danger-text)";
    case "late":             return "var(--warning-text)";
    case "present":          return "var(--success-text)";
    case "escalation_present": return "var(--accent)";
    default:                 return "var(--border)";
  }
}

function policyLabel(days: PersonDay[]): string | null {
  for (const d of days) {
    if (d.policy_name) return d.policy_name;
  }
  return null;
}

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function isoToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
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
