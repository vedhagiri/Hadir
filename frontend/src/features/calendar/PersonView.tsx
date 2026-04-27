// Per-person calendar — one row per day with the engine's status pill,
// in/out times, and totals. Click a day to open the DayDetailDrawer.

import { useTranslation } from "react-i18next";

import type { PersonDay, PersonMonth } from "./types";

interface Props {
  person: PersonMonth;
  onPickDay: (isoDate: string) => void;
}

export function PersonView({ person, onPickDay }: Props) {
  const { t } = useTranslation();

  // Same Sunday-first month grid as CompanyView.
  const first = person.days[0]
    ? new Date(`${person.days[0].date}T00:00:00`)
    : new Date();
  const leadingPad = first.getDay();

  const todayIso = isoToday();

  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: 12 }}
      >
        <div>
          <div
            style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}
          >
            {person.full_name}
          </div>
          <div className="text-xs text-dim mono">{person.employee_code}</div>
        </div>
        <div className="text-xs text-dim">
          {t("calendar.month") as string}: <strong>{person.month}</strong>
        </div>
      </div>

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

  const tooltip = [
    day.date,
    t(`calendar.status.${day.status}`) as string,
    day.in_time ? `in ${day.in_time}` : null,
    day.out_time ? `out ${day.out_time}` : null,
    day.total_minutes != null
      ? `${(day.total_minutes / 60).toFixed(1)}h`
      : null,
    day.holiday_name ? `holiday: ${day.holiday_name}` : null,
    day.leave_name ? `leave: ${day.leave_name}` : null,
  ]
    .filter(Boolean)
    .join(" — ");

  // The future cell is not clickable — there is no day-detail to view.
  const clickable = day.status !== "future";

  // Distinct fills for holiday vs weekend — design CSS gives both the
  // same ``--bg-sunken`` background, which is hard to tell apart at a
  // glance. Holiday → cyan accent-soft (not used elsewhere on the
  // calendar palette); Weekend → diagonal stripes over the sunken
  // base for clear "off day" semantics.
  const fillOverride =
    day.status === "holiday"
      ? { background: "var(--accent-soft)" }
      : day.status === "weekend"
        ? {
            background:
              "repeating-linear-gradient(135deg, var(--bg-sunken) 0 6px, var(--bg-elev) 6px 12px)",
          }
        : null;

  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className={[
        "cal-day",
        `status-${day.status}`,
        isToday ? "today" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        cursor: clickable ? "pointer" : "default",
        textAlign: "start",
        font: "inherit",
        opacity: day.status === "future" ? 0.4 : undefined,
        ...(fillOverride ?? {}),
      }}
      title={tooltip}
      aria-label={tooltip}
    >
      <div className="cal-day-num">{dayNum}</div>
      {day.in_time && (
        <div className="cal-hours">
          {day.in_time.slice(0, 5)}
          {day.out_time ? ` – ${day.out_time.slice(0, 5)}` : ""}
        </div>
      )}
      {day.holiday_name ? (
        <div className="cal-flag" style={{ fontSize: 10 }}>
          {day.holiday_name}
        </div>
      ) : day.leave_name ? (
        <div className="cal-flag" style={{ fontSize: 10 }}>
          {day.leave_name}
        </div>
      ) : null}
    </button>
  );
}

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function isoToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
