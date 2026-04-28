// Company-wide month view. Same cell shape as PersonView so the two
// tabs feel like one calendar — flat tinted background per status,
// day number top-right, four rows of icon+count (P/L/A/Lv) when
// non-zero, and a status pill anchored to the bottom for weekend /
// holiday / no-record days.

import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
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
        {days.map((d) => (
          <DayCell
            key={d.date}
            day={d}
            isToday={d.date === todayIso}
            onClick={() => onPickDate(d.date)}
          />
        ))}
      </div>

      <Legend />
      <div className="text-xs text-dim" style={{ marginTop: 8 }}>
        {t("calendar.companyHint", { month }) as string}
      </div>
    </div>
  );
}

function DayCell({
  day,
  isToday,
  onClick,
}: {
  day: CompanyDay;
  isToday: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const dayNum = parseInt(day.date.slice(8, 10), 10);

  // Same tinting palette as PersonView so the two views read as one
  // calendar.
  const bg = day.is_weekend
    ? "var(--info-soft)"
    : day.is_holiday
      ? "var(--accent-soft)"
      : "var(--bg-elev)";

  const statusLabel = bottomLabel(day, t);

  // Count rows — present, late, absent, leave. Skipped when 0 to keep
  // the cell readable on uniform months. Each row uses the same
  // icon + mono number convention as PersonView's in/out rows.
  const counts = [
    {
      key: "present",
      value: day.present_count,
      label: t("calendar.statusShort.present", {
        defaultValue: "Present",
      }) as string,
      color: "var(--success-text, var(--success))",
    },
    {
      key: "late",
      value: day.late_count,
      label: t("calendar.statusShort.late", {
        defaultValue: "Late",
      }) as string,
      color: "var(--warning-text, var(--warning))",
    },
    {
      key: "absent",
      value: day.absent_count,
      label: t("calendar.statusShort.absent", {
        defaultValue: "Absent",
      }) as string,
      color: "var(--danger-text, var(--danger))",
    },
    {
      key: "leave",
      value: day.leave_count,
      label: t("calendar.statusShort.leave", {
        defaultValue: "Leave",
      }) as string,
      color: "var(--info-text, var(--info))",
    },
  ].filter((c) => c.value > 0);

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
        border: `1px solid ${isToday ? "var(--accent)" : "var(--border)"}`,
        borderWidth: isToday ? 1.5 : 1,
        borderRadius: 7,
        padding: "6px 8px 8px",
        position: "relative",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        minHeight: 96,
      }}
    >
      {/* Day number — top-right per the design. */}
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

      {/* Per-status counts — match the time-row look from PersonView
          (icon + mono number + small label). */}
      {counts.map((c) => (
        <div
          key={c.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            color: c.color,
          }}
        >
          <Icon name={iconForStatus(c.key)} size={10} />
          <span
            className="mono"
            style={{ fontVariantNumeric: "tabular-nums", minWidth: 14 }}
          >
            {c.value}
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--text-tertiary)",
              marginInlineStart: 2,
              textTransform: "lowercase",
            }}
          >
            {c.label}
          </span>
        </div>
      ))}

      {/* Status pill (bottom) — only when the day carries info to
          surface beyond the counts: weekend / holiday / no-record. */}
      <div style={{ marginTop: "auto", paddingTop: 4 }}>
        {statusLabel && (
          <span
            style={{
              display: "inline-block",
              padding: "1px 6px",
              fontSize: 10,
              fontWeight: 500,
              borderRadius: 3,
              background: pillBg(day),
              color: pillFg(day),
              border: `1px solid ${pillBorder(day)}`,
            }}
          >
            {statusLabel}
          </span>
        )}
      </div>
    </button>
  );
}

function bottomLabel(
  day: CompanyDay,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (day.is_weekend) {
    return t("calendar.weekendShort", {
      defaultValue: "Week off",
    }) as string;
  }
  if (day.holiday_name) return day.holiday_name;
  if (day.is_holiday) return t("calendar.holiday") as string;
  // No-counts day with active employees in the tenant — surface "no
  // record" so the cell isn't visually empty.
  if (
    day.active_employees > 0 &&
    day.present_count === 0 &&
    day.late_count === 0 &&
    day.absent_count === 0 &&
    day.leave_count === 0
  ) {
    return t("calendar.statusShort.no_record", {
      defaultValue: "No record",
    }) as string;
  }
  return null;
}

function pillBg(day: CompanyDay): string {
  if (day.is_weekend) return "var(--info-soft)";
  if (day.is_holiday) return "var(--accent-soft)";
  return "var(--bg-sunken)";
}

function pillFg(day: CompanyDay): string {
  if (day.is_weekend) return "var(--info-text, var(--info))";
  if (day.is_holiday) return "var(--accent-text)";
  return "var(--text-secondary)";
}

function pillBorder(day: CompanyDay): string {
  if (day.is_weekend) return "var(--info-text, var(--info))";
  if (day.is_holiday) return "var(--accent-text)";
  return "var(--border)";
}

function iconForStatus(key: string): "chevronUp" | "chevronDown" | "circle" {
  // Match the PersonView convention: up = positive (present), down =
  // negative (absent), circle = neutral (late / leave).
  switch (key) {
    case "present":
      return "chevronUp";
    case "absent":
      return "chevronDown";
    default:
      return "circle";
  }
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

function Legend() {
  const { t } = useTranslation();
  const items = [
    { key: "present", color: "var(--success)" },
    { key: "late", color: "var(--warning)" },
    { key: "absent", color: "var(--danger)" },
    { key: "leave", color: "var(--info)" },
    { key: "holiday", color: "var(--accent-soft)", border: true },
    { key: "weekend", color: "var(--info-soft)", border: true },
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

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function isoToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
