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

import { Icon } from "../../shell/Icon";
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
  // tinted only for special statuses.
  const bg =
    day.status === "weekend"
      ? "var(--info-soft)"
      : day.status === "holiday"
        ? "var(--accent-soft)"
        : day.status === "leave"
          ? "var(--warning-soft)"
          : day.status === "absent"
            ? "var(--danger-soft)"
            : "var(--bg-elev)";

  const totalHours =
    day.total_minutes != null && day.total_minutes > 0
      ? `${(day.total_minutes / 60).toFixed(0)} ${t("calendar.hrs", { defaultValue: "hrs" }) as string}`
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
          color="var(--success-text, var(--success))"
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

function StatusPill({ day }: { day: PersonDay }) {
  const { t } = useTranslation();
  // Distinct labels per status — only render when the status carries
  // information (week off, holiday, leave, absent). For "present" /
  // "late" / "no_record" the time row already conveys the state and
  // a redundant pill would clutter the cell.
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
  if (day.status === "absent") {
    return t("calendar.absentShort", {
      defaultValue: "Absent",
    }) as string;
  }
  if (day.status === "late") {
    return t("calendar.lateShort", {
      defaultValue: "Late",
    }) as string;
  }
  return null;
}

function pillBg(status: CalendarStatus): string {
  switch (status) {
    case "weekend":
      return "var(--info-soft)";
    case "holiday":
      return "var(--accent-soft)";
    case "leave":
      return "var(--warning-soft)";
    case "absent":
      return "var(--danger-soft)";
    case "late":
      return "var(--warning-soft)";
    default:
      return "var(--bg-sunken)";
  }
}

function pillFg(status: CalendarStatus): string {
  switch (status) {
    case "weekend":
      return "var(--info-text, var(--info))";
    case "holiday":
      return "var(--accent-text)";
    case "leave":
      return "var(--warning-text)";
    case "absent":
      return "var(--danger-text)";
    case "late":
      return "var(--warning-text)";
    default:
      return "var(--text-secondary)";
  }
}

function pillBorder(status: CalendarStatus): string {
  switch (status) {
    case "weekend":
      return "var(--info-text, var(--info))";
    case "holiday":
      return "var(--accent-text)";
    case "leave":
      return "var(--warning-text)";
    case "absent":
      return "var(--danger-text)";
    case "late":
      return "var(--warning-text)";
    default:
      return "var(--border)";
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
