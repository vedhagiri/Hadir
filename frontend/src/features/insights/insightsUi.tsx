// Shared building blocks for the MaugoodAI Insights pages (Overview,
// Departments, People). Owned by the Overview build; the Departments and
// People pages import from here.
//
// Everything is plain SVG / CSS over the theme tokens — no chart lib.
// Colour logic follows the attendance PDF: green present / amber late /
// red absent / blue leave. Layout classes live in ./insights.css (ins-).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import { DatePicker, todayIso } from "../../components/DatePicker";
import { PdfOptionsModal } from "../../components/PdfOptionsModal";
import { useConfidentialDownload } from "../../components/useConfidentialDownload";
import { Icon } from "../../shell/Icon";
import { Panel, PanelEmpty, PanelError, SoftPill, Tile, TileGrid } from "../dashboard/DashUi";
import type { Tone } from "../dashboard/DashUi";
import { avatarBg, initials } from "../employees/EmployeesPage";
import type { InsightsRange } from "./hooks";
import type {
  InsightsArrivalBucket,
  InsightsBreakdownRow,
  InsightsDepartmentRow,
  InsightsException,
  InsightsHeatmap,
  InsightsKpis,
  InsightsShift,
  InsightsWatchlist,
  InsightsWeekday,
  InsightsPeriod,
  InsightsStatus,
  InsightsTrendDay,
} from "./types";

import "../../components/skeleton.css";
import "./insights.css";

export { Panel, PanelEmpty, PanelError, SoftPill, Tile, TileGrid };
export type { Tone };

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const MAX_RANGE_DAYS = 92;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(iso: string, n: number): string {
  const d = parseIsoDate(iso) ?? new Date();
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

export function daysBetween(a: string, b: string): number {
  const da = parseIsoDate(a);
  const db = parseIsoDate(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

function locale(lang: string): string {
  return lang.startsWith("ar") ? "ar" : "en-GB";
}

/** "2026-10-07" → "Wed, 7 Oct" (localised). */
export function useDateFmt() {
  const { i18n } = useTranslation();
  const loc = locale(i18n.language);
  return useMemo(
    () => ({
      short: (iso: string) => {
        const d = parseIsoDate(iso);
        return d ? d.toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "short" }) : iso;
      },
      dayMonth: (iso: string) => {
        const d = parseIsoDate(iso);
        return d ? d.toLocaleDateString(loc, { day: "numeric", month: "short" }) : iso;
      },
      weekdayShort: (iso: string) => {
        const d = parseIsoDate(iso);
        return d ? d.toLocaleDateString(loc, { weekday: "short" }) : "";
      },
    }),
    [loc],
  );
}

// ---------------------------------------------------------------------------
// Range ↔ URL (?start=&end=)
// ---------------------------------------------------------------------------

export type RangePreset = "today" | "yesterday" | "week" | "month" | "last30" | "custom";

export function presetRange(preset: Exclude<RangePreset, "custom">, today = todayIso()): InsightsRange {
  const d = parseIsoDate(today) ?? new Date();
  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { start: y, end: y };
    }
    case "week": {
      // ISO week (Monday start) — matches the DatePicker's grid.
      const dow = (d.getDay() + 6) % 7;
      return { start: addDays(today, -dow), end: today };
    }
    case "month":
      return { start: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), end: today };
    case "last30":
      return { start: addDays(today, -29), end: today };
  }
}

export function detectPreset(range: InsightsRange): RangePreset {
  const presets: Array<Exclude<RangePreset, "custom">> = ["today", "yesterday", "week", "month", "last30"];
  for (const p of presets) {
    const r = presetRange(p);
    if (r.start === range.start && r.end === range.end) return p;
  }
  return "custom";
}

/** Normalise a (start, end) pair: valid dates, start ≤ end, ≤ 92 days. */
export function clampRange(start: string, end: string): InsightsRange {
  const today = todayIso();
  let s = parseIsoDate(start) ? start : today;
  let e = parseIsoDate(end) ? end : s;
  if (e > today) e = today;
  if (s > e) [s, e] = [e, s];
  if (daysBetween(s, e) > MAX_RANGE_DAYS - 1) s = addDays(e, -(MAX_RANGE_DAYS - 1));
  return { start: s, end: e };
}

/** The page's date range, read from and written to ``?start=&end=`` so
 *  links are shareable. Other query params (department_id, page, …) are
 *  preserved; ``page`` resets when the range changes. */
export function useInsightsRange(): {
  range: InsightsRange;
  preset: RangePreset;
  setRange: (next: InsightsRange) => void;
} {
  const [params, setParams] = useSearchParams();
  const rawStart = params.get("start") ?? "";
  const rawEnd = params.get("end") ?? "";
  const range = useMemo(() => {
    if (!rawStart && !rawEnd) {
      const t = todayIso();
      return { start: t, end: t };
    }
    return clampRange(rawStart || rawEnd, rawEnd || rawStart);
  }, [rawStart, rawEnd]);
  const setRange = useCallback(
    (next: InsightsRange) => {
      const r = clampRange(next.start, next.end);
      setParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          sp.set("start", r.start);
          sp.set("end", r.end);
          sp.delete("page");
          return sp;
        },
        { replace: false },
      );
    },
    [setParams],
  );
  return { range, preset: detectPreset(range), setRange };
}

/** ``?start=…&end=…`` suffix for links to the sibling Insights pages. */
export function rangeQuery(range: InsightsRange): string {
  return `?start=${range.start}&end=${range.end}`;
}

// ---------------------------------------------------------------------------
// Range picker
// ---------------------------------------------------------------------------

export function RangePicker({
  range,
  preset,
  onChange,
}: {
  range: InsightsRange;
  preset: RangePreset;
  onChange: (next: InsightsRange) => void;
}) {
  const { t } = useTranslation();
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  useEffect(() => {
    if (preset === "custom") setCustomOpen(true);
  }, [preset]);
  const today = todayIso();
  const presets: Array<[Exclude<RangePreset, "custom">, string]> = [
    ["today", t("insights.range.today", { defaultValue: "Today" })],
    ["yesterday", t("insights.range.yesterday", { defaultValue: "Yesterday" })],
    ["week", t("insights.range.week", { defaultValue: "This week" })],
    ["month", t("insights.range.month", { defaultValue: "This month" })],
    ["last30", t("insights.range.last30", { defaultValue: "Last 30 days" })],
  ];
  const showCustom = customOpen || preset === "custom";
  return (
    <div className="ins-range">
      <div className="seg" role="group" aria-label={t("insights.range.label", { defaultValue: "Date range" })}>
        {presets.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`seg-btn${preset === key && !showCustom ? " active" : ""}`}
            aria-pressed={preset === key && !showCustom}
            onClick={() => {
              setCustomOpen(false);
              onChange(presetRange(key, today));
            }}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={`seg-btn${showCustom ? " active" : ""}`}
          aria-pressed={showCustom}
          onClick={() => setCustomOpen(true)}
        >
          <Icon name="calendar" size={12} />
          {t("insights.range.custom", { defaultValue: "Custom" })}
        </button>
      </div>
      {showCustom && (
        <div className="ins-range-custom">
          <DatePicker
            value={range.start}
            max={range.end}
            min={addDays(range.end, -(MAX_RANGE_DAYS - 1))}
            ariaLabel={t("insights.range.from", { defaultValue: "From" })}
            onChange={(v) => onChange({ start: v, end: range.end })}
          />
          <span aria-hidden className="ins-range-arrow">→</span>
          <DatePicker
            value={range.end}
            min={range.start}
            max={today}
            ariaLabel={t("insights.range.to", { defaultValue: "To" })}
            onChange={(v) => onChange({ start: range.start, end: v })}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Number + status helpers
// ---------------------------------------------------------------------------

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const r = Math.round(n);
  return `${r.toLocaleString()}%`;
}

export function fmtHours(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function clock(v: string | null | undefined): string {
  if (!v) return "—";
  const m = /(\d{2}):(\d{2})/.exec(v);
  return m ? `${m[1]}:${m[2]}` : v;
}

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

const STATUS_TONE: Record<string, StatusTone> = {
  present: "success",
  present_weekend: "success",
  present_holiday: "success",
  late: "warning",
  early: "warning",
  absent: "danger",
  leave: "info",
  weekend: "neutral",
  holiday: "accent",
  waiting: "neutral",
  pending: "neutral",
  no_record: "neutral",
  short: "warning",
};

export function statusTone(status: InsightsStatus): StatusTone {
  return STATUS_TONE[status] ?? "neutral";
}

export function useStatusLabel(): (status: InsightsStatus) => string {
  const { t } = useTranslation();
  return useCallback(
    (status: InsightsStatus) => {
      const en: Record<string, string> = {
        present: "Present",
        present_weekend: "Worked weekend",
        present_holiday: "Worked holiday",
        late: "Late",
        early: "Early out",
        short: "Short hours",
        absent: "Absent",
        leave: "On leave",
        weekend: "Weekend",
        holiday: "Holiday",
        waiting: "Waiting",
        pending: "No record",
        no_record: "No record",
      };
      const fallback = en[status] ?? status.replace(/_/g, " ");
      return t(`insights.status.${status}`, { defaultValue: fallback });
    },
    [t],
  );
}

export function StatusPill({ status }: { status: InsightsStatus }) {
  const label = useStatusLabel();
  return <SoftPill tone={statusTone(status)}>{label(status)}</SoftPill>;
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

export function PersonAvatar({
  name,
  employeeId,
  photoId,
  size = 30,
}: {
  name: string;
  employeeId?: number;
  photoId?: number | null;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const src =
    employeeId !== undefined && photoId !== null && photoId !== undefined && !broken
      ? `/api/employees/${employeeId}/photos/${photoId}/thumb`
      : null;
  return (
    <span
      className="avatar ins-avatar"
      style={{ background: src ? "var(--bg-sunken)" : avatarBg(name), width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden
    >
      {src ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Container width (charts draw at real pixel size so text never stretches)
// ---------------------------------------------------------------------------

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0;
      setW(Math.floor(cw));
    });
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------------------------------------------------------------------------
// KPI tile row (same six tiles + sub-lines as the PDF)
// ---------------------------------------------------------------------------

export function KpiRow({ kpis, period }: { kpis: InsightsKpis; period: InsightsPeriod }) {
  const { t } = useTranslation();
  const single = period.is_single_day;
  return (
    <div className="ins-kpis">
      <Tile
        tone="neutral"
        icon="users"
        label={t("insights.kpi.employees", { defaultValue: "Employees" })}
        value={fmtNum(kpis.total)}
        {...(single ? {} : { title: t("insights.kpi.personDaysHint", { defaultValue: "Present, late, absent and leave count person-days across the range" }) })}
        sub={
          single
            ? t("insights.kpi.employeesSubDay", { defaultValue: "active on this date" })
            : t("insights.kpi.employeesSubRange", {
                defaultValue: "active · {{days}} working days",
                days: period.working_days,
              })
        }
      />
      <Tile
        tone="success"
        icon="check"
        label={t("insights.kpi.present", { defaultValue: "Present" })}
        value={
          <>
            {fmtNum(kpis.present)} <span className="ins-kpi-pct">{fmtPct(kpis.present_pct)}</span>
          </>
        }
        sub={t("insights.kpi.presentSub", {
          defaultValue: "incl. {{late}} late · {{early}} early out",
          late: fmtNum(kpis.late),
          early: fmtNum(kpis.early),
        })}
      />
      <Tile
        tone="warning"
        icon="clock"
        label={t("insights.kpi.late", { defaultValue: "Late" })}
        value={fmtNum(kpis.late)}
        sub={
          kpis.avg_late_minutes !== null
            ? t("insights.kpi.lateSub", {
                defaultValue: "after grace · avg {{min}} min",
                min: fmtNum(kpis.avg_late_minutes),
              })
            : t("insights.kpi.lateSubNone", { defaultValue: "after grace" })
        }
      />
      <Tile
        tone="danger"
        icon="x"
        label={t("insights.kpi.absent", { defaultValue: "Absent" })}
        value={
          <>
            {fmtNum(kpis.absent)} <span className="ins-kpi-pct">{fmtPct(kpis.absent_pct)}</span>
          </>
        }
        sub={t("insights.kpi.absentSub", { defaultValue: "no detection, not on leave" })}
      />
      <Tile
        tone="info"
        icon="calendar"
        label={t("insights.kpi.leave", { defaultValue: "On leave" })}
        value={fmtNum(kpis.leave)}
        sub={t("insights.kpi.leaveSub", { defaultValue: "approved leave" })}
      />
      <Tile
        tone="accent"
        icon="zap"
        label={t("insights.kpi.overtime", { defaultValue: "Overtime" })}
        value={
          <>
            {fmtHours(kpis.ot_hours)} <span className="ins-kpi-pct">{t("insights.unit.h", { defaultValue: "h" })}</span>
          </>
        }
        sub={t("insights.kpi.overtimeSub", {
          defaultValue: "{{count}} employees",
          count: kpis.ot_employees,
        })}
      />
    </div>
  );
}

export function KpiRowSkeleton() {
  return (
    <div className="ins-kpis" role="status" aria-label="Loading">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="mg-stat dsh-static ins-sk-tile">
          <span className="sk sk-line" style={{ width: "50%", height: 10 }} />
          <span className="sk sk-line" style={{ width: "40%", height: 26, marginTop: 12 }} />
          <span className="sk sk-line" style={{ width: "75%", height: 9, marginTop: 10 }} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status breakdown (stacked bar + table with change vs previous)
// ---------------------------------------------------------------------------

const BREAKDOWN_TONE: Record<string, string> = {
  present: "success",
  late: "warning",
  early: "early",
  absent: "danger",
  leave: "info",
  weekend: "neutral",
  holiday: "holiday",
  pending: "neutral",
  no_record: "neutral",
  waiting: "neutral",
  short: "early",
};

export function StatusBreakdownCard({
  rows,
  total,
  prevLabel,
}: {
  rows: InsightsBreakdownRow[];
  total: number;
  prevLabel: string | null;
}) {
  const { t } = useTranslation();
  const sum = rows.reduce((s, r) => s + r.count, 0);
  const hasDelta = rows.some((r) => r.delta !== null);
  return (
    <Panel
      title={t("insights.breakdown.title", { defaultValue: "Status breakdown" })}
      sub={
        prevLabel
          ? t("insights.breakdown.subPrev", {
              defaultValue: "{{total}} records · change vs {{prev}}",
              total: fmtNum(total),
              prev: prevLabel,
            })
          : t("insights.breakdown.sub", { defaultValue: "{{total}} records", total: fmtNum(total) })
      }
    >
      {sum === 0 ? (
        <PanelEmpty icon="activity" title={t("insights.empty.noRecords", { defaultValue: "No attendance records" })} />
      ) : (
        <>
          <div className="ins-stack" role="img" aria-label={rows.map((r) => `${r.label}: ${r.count}`).join(", ")}>
            {rows.map((r) =>
              r.count > 0 ? (
                <span
                  key={r.key}
                  className={`ins-seg is-${BREAKDOWN_TONE[r.key] ?? "neutral"}`}
                  style={{ flex: r.count }}
                  title={`${r.label}: ${fmtNum(r.count)} (${fmtPct(r.share)})`}
                />
              ) : null,
            )}
          </div>
          <table className="ins-mini-table">
            <thead>
              <tr>
                <th>{t("insights.breakdown.status", { defaultValue: "Status" })}</th>
                <th className="ins-end">{t("insights.breakdown.count", { defaultValue: "Count" })}</th>
                <th className="ins-end">{t("insights.breakdown.share", { defaultValue: "Share" })}</th>
                {hasDelta && <th className="ins-end">{t("insights.breakdown.change", { defaultValue: "Change" })}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <span className="ins-legend-item">
                      <i aria-hidden className={`ins-dot is-${BREAKDOWN_TONE[r.key] ?? "neutral"}`} />
                      {t(`insights.breakdown.key.${r.key}`, { defaultValue: r.label })}
                    </span>
                  </td>
                  <td className="ins-end ins-num ins-strong">{fmtNum(r.count)}</td>
                  <td className="ins-end ins-num ins-muted">{fmtPct(r.share)}</td>
                  {hasDelta && (
                    <td className={`ins-end ins-num ${r.delta_good ? "ins-good" : r.delta_bad ? "ins-bad" : "ins-muted"}`}>
                      {r.delta === null ? "—" : r.delta === 0 ? "—" : `${r.delta > 0 ? "+" : "−"}${fmtNum(Math.abs(r.delta))}`}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Trend chart — stacked present/late/absent/leave per day + present % line
// ---------------------------------------------------------------------------

interface TrendStack {
  onTime: number;
  late: number;
  absent: number;
  leave: number;
  total: number;
}

/** ``present`` in the API is "had an in-time" (late included, as in the
 *  PDF's department table). Detect that from the numbers so the stack
 *  never double-counts late arrivals. */
function stackOf(d: InsightsTrendDay): TrendStack {
  const includesLate = d.headcount > 0 && d.present + d.late + d.absent + d.leave > d.headcount;
  const onTime = includesLate ? Math.max(0, d.present - d.late) : d.present;
  return { onTime, late: d.late, absent: d.absent, leave: d.leave, total: onTime + d.late + d.absent + d.leave };
}

export function TrendChart({ days, height = 240 }: { days: InsightsTrendDay[]; height?: number }) {
  const { t } = useTranslation();
  const fmt = useDateFmt();
  const [ref, width] = useWidth<HTMLDivElement>();
  const stacks = days.map(stackOf);
  const maxY = Math.max(1, ...stacks.map((s) => s.total), ...days.map((d) => d.headcount));
  const padL = 36;
  const padR = 40;
  const padT = 10;
  const padB = 34;
  const w = Math.max(0, width);
  const plotW = Math.max(10, w - padL - padR);
  const plotH = height - padT - padB;
  const n = Math.max(1, days.length);
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(44, slot * 0.68));
  const y = (v: number) => padT + plotH - (v / maxY) * plotH;
  const yPct = (p: number) => padT + plotH - (Math.max(0, Math.min(100, p)) / 100) * plotH;
  const ticks = niceTicks(maxY);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 54))));
  const lbl = {
    present: t("insights.trend.onTime", { defaultValue: "Present on time" }),
    late: t("insights.trend.late", { defaultValue: "Late" }),
    absent: t("insights.trend.absent", { defaultValue: "Absent" }),
    leave: t("insights.trend.leave", { defaultValue: "On leave" }),
    pct: t("insights.trend.presentPct", { defaultValue: "Present %" }),
    off: t("insights.trend.offDay", { defaultValue: "Weekend / holiday" }),
  };
  const linePts = days
    .map((d, i) => (d.headcount > 0 && !(d.is_weekend || d.is_holiday) ? `${padL + slot * i + slot / 2},${yPct(d.present_pct)}` : null))
    .filter((p): p is string => p !== null);

  return (
    <div className="ins-chart">
      <div ref={ref} className="ins-chart-canvas" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} role="img" aria-label={t("insights.trend.aria", { defaultValue: "Daily attendance trend" })}>
            {ticks.map((tv) => (
              <g key={tv}>
                <line x1={padL} x2={padL + plotW} y1={y(tv)} y2={y(tv)} className="ins-grid" />
                <text x={padL - 8} y={y(tv) + 3.5} textAnchor="end" className="ins-axis">
                  {fmtNum(tv)}
                </text>
              </g>
            ))}
            {[0, 50, 100].map((p) => (
              <text key={p} x={padL + plotW + 8} y={yPct(p) + 3.5} className="ins-axis ins-axis-pct">
                {p}%
              </text>
            ))}
            {days.map((d, i) => {
              const s = stacks[i]!;
              const cx = padL + slot * i + slot / 2;
              const x = cx - barW / 2;
              const off = d.is_weekend || d.is_holiday;
              let acc = 0;
              const seg = (v: number, cls: string) => {
                if (v <= 0) return null;
                const y1 = y(acc + v);
                const h = y(acc) - y1;
                acc += v;
                return <rect key={cls} x={x} y={y1} width={barW} height={Math.max(0, h)} className={`ins-bar ${cls}`} />;
              };
              const tip = [
                `${fmt.short(d.date)}${d.holiday_name ? ` · ${d.holiday_name}` : d.is_weekend ? ` · ${t("insights.trend.weekend", { defaultValue: "Weekend" })}` : ""}`,
                `${lbl.present}: ${fmtNum(s.onTime)}`,
                `${lbl.late}: ${fmtNum(s.late)}`,
                `${lbl.absent}: ${fmtNum(s.absent)}`,
                `${lbl.leave}: ${fmtNum(s.leave)}`,
                `${lbl.pct}: ${fmtPct(d.present_pct)}`,
              ].join("\n");
              return (
                <g key={d.date}>
                  {off && <rect x={padL + slot * i + 1} y={padT} width={Math.max(0, slot - 2)} height={plotH} className="ins-offday" />}
                  {seg(s.onTime, "is-success")}
                  {seg(s.late, "is-warning")}
                  {seg(s.absent, "is-danger")}
                  {seg(s.leave, "is-info")}
                  <rect x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent">
                    <title>{tip}</title>
                  </rect>
                  {i % labelEvery === 0 && (
                    <>
                      <text x={cx} y={height - padB + 14} textAnchor="middle" className={`ins-axis${off ? " is-off" : ""}`}>
                        {n <= 10 ? fmt.weekdayShort(d.date) : fmt.dayMonth(d.date)}
                      </text>
                      {n <= 10 && (
                        <text x={cx} y={height - padB + 27} textAnchor="middle" className="ins-axis ins-axis-sub">
                          {fmt.dayMonth(d.date)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
            {linePts.length > 1 && <polyline points={linePts.join(" ")} className="ins-line" />}
            {linePts.map((p) => {
              const [cx, cy] = p.split(",");
              return <circle key={p} cx={cx} cy={cy} r={3} className="ins-line-dot" />;
            })}
          </svg>
        )}
      </div>
      <div className="ins-legend">
        <span><i className="is-success" />{lbl.present}</span>
        <span><i className="is-warning" />{lbl.late}</span>
        <span><i className="is-danger" />{lbl.absent}</span>
        <span><i className="is-info" />{lbl.leave}</span>
        <span><i className="is-line" />{lbl.pct}</span>
        <span><i className="is-off" />{lbl.off}</span>
      </div>
    </div>
  );
}

function niceTicks(max: number): number[] {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  const step = steps.find((s) => max / s <= 4) ?? Math.ceil(max / 4);
  const out: number[] = [];
  for (let v = 0; v <= max + 0.0001; v += step) out.push(v);
  return out;
}

// ---------------------------------------------------------------------------
// Arrivals histogram (first-in, 30-min buckets)
// ---------------------------------------------------------------------------

/** Fill gaps between buckets and pad to at least ``minBuckets`` 30-min
 *  slots so a sparse day doesn't render as two giant bars. */
function fillBuckets(raw: InsightsArrivalBucket[], minBuckets = 12): InsightsArrivalBucket[] {
  const toMin = (b: string) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(b);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const parsed = raw.map((b) => ({ m: toMin(b.bucket), count: b.count }));
  if (parsed.length === 0 || parsed.some((p) => p.m === null)) return raw;
  const counts = new Map(parsed.map((p) => [p.m as number, p.count]));
  let lo = Math.min(...counts.keys());
  let hi = Math.max(...counts.keys());
  while ((hi - lo) / 30 + 1 < minBuckets) {
    if (lo - 30 >= 0) lo -= 30;
    if ((hi - lo) / 30 + 1 < minBuckets && hi + 30 < 24 * 60) hi += 30;
    if (lo === 0 && hi + 30 >= 24 * 60) break;
  }
  const out: InsightsArrivalBucket[] = [];
  for (let m = lo; m <= hi; m += 30) {
    out.push({ bucket: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, count: counts.get(m) ?? 0 });
  }
  return out;
}

export function ArrivalsHistogram({ buckets: rawBuckets, height = 200 }: { buckets: InsightsArrivalBucket[]; height?: number }) {
  const { t } = useTranslation();
  const buckets = useMemo(() => fillBuckets(rawBuckets), [rawBuckets]);
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const peak = buckets.reduce<InsightsArrivalBucket | null>((p, b) => (!p || b.count > p.count ? b : p), null);
  if (total === 0) {
    return (
      <PanelEmpty
        icon="clock"
        title={t("insights.arrivals.empty", { defaultValue: "No arrivals in this period" })}
        body={t("insights.arrivals.emptyBody", { defaultValue: "First-in times appear once employees are detected." })}
      />
    );
  }
  const labelEvery = buckets.length > 16 ? 2 : 1;
  return (
    <div className="ins-hist-wrap">
      <div className="ins-hist-facts">
        <span>
          {t("insights.arrivals.total", { defaultValue: "{{count}} arrivals", count: total })}
        </span>
        {peak && (
          <span>
            {t("insights.arrivals.peak", { defaultValue: "Peak {{bucket}} · {{count}}", bucket: peak.bucket, count: peak.count })}
          </span>
        )}
      </div>
      <div className="ins-hist" style={{ height }} role="img" aria-label={t("insights.arrivals.aria", { defaultValue: "First-in time distribution" })}>
        {buckets.map((b, i) => (
          <div key={b.bucket} className="ins-hist-col" title={`${b.bucket} · ${fmtNum(b.count)}`}>
            <span className="ins-hist-val">{b.count > 0 ? fmtNum(b.count) : ""}</span>
            <div className="ins-hist-track">
              <div
                className={`ins-hist-bar${peak && b.bucket === peak.bucket ? " is-peak" : ""}`}
                style={{ height: `${(b.count / max) * 100}%` }}
              />
            </div>
            <span className="ins-hist-lbl">{i % labelEvery === 0 ? b.bucket : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presence bar (department tables)
// ---------------------------------------------------------------------------

export function PresenceBar({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  const tone = p >= 85 ? "is-good" : p >= 60 ? "is-mid" : "is-low";
  return (
    <span className="ins-presence">
      <span className="ins-presence-track">
        <span className={`ins-presence-fill ${tone}`} style={{ width: `${p}%` }} />
      </span>
      <span className="ins-presence-pct">{fmtPct(pct)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Department ranking table
// ---------------------------------------------------------------------------

export function DepartmentTable({
  rows,
  onOpen,
}: {
  rows: InsightsDepartmentRow[];
  onOpen: (departmentId: number) => void;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <PanelEmpty icon="users" title={t("insights.dept.empty", { defaultValue: "No departments in scope" })} />;
  }
  const tot = rows.reduce(
    (a, r) => ({
      headcount: a.headcount + r.headcount,
      present: a.present + r.present,
      late: a.late + r.late,
      absent: a.absent + r.absent,
      leave: a.leave + r.leave,
      ot: a.ot + r.ot_hours,
    }),
    { headcount: 0, present: 0, late: 0, absent: 0, leave: 0, ot: 0 },
  );
  return (
    <div className="ins-table-wrap">
      <table className="table ins-table">
        <thead>
          <tr>
            <th className="ins-rank">#</th>
            <th>{t("insights.dept.department", { defaultValue: "Department" })}</th>
            <th className="ins-end">{t("insights.dept.headcount", { defaultValue: "Headcount" })}</th>
            <th className="ins-end">{t("insights.dept.present", { defaultValue: "Present" })}</th>
            <th className="ins-end">{t("insights.dept.late", { defaultValue: "Late" })}</th>
            <th className="ins-end">{t("insights.dept.absent", { defaultValue: "Absent" })}</th>
            <th className="ins-end">{t("insights.dept.leave", { defaultValue: "Leave" })}</th>
            <th className="ins-end">{t("insights.dept.avgHours", { defaultValue: "Avg h" })}</th>
            <th className="ins-end">{t("insights.dept.otHours", { defaultValue: "OT h" })}</th>
            <th className="ins-presence-col">{t("insights.dept.presence", { defaultValue: "Presence" })}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.department_id}
              className="ins-click-row"
              tabIndex={0}
              onClick={() => onOpen(r.department_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(r.department_id);
                }
              }}
              aria-label={t("insights.dept.open", { defaultValue: "Open {{name}}", name: r.name })}
            >
              <td className="ins-rank ins-muted ins-num">{i + 1}</td>
              <td className="ins-strong">{r.name}</td>
              <td className="ins-end ins-num">{fmtNum(r.headcount)}</td>
              <td className="ins-end ins-num">{fmtNum(r.present)}</td>
              <td className={`ins-end ins-num${r.late > 0 ? " ins-warn-text" : " ins-muted"}`}>{fmtNum(r.late)}</td>
              <td className={`ins-end ins-num${r.absent > 0 ? " ins-bad" : " ins-muted"}`}>{fmtNum(r.absent)}</td>
              <td className={`ins-end ins-num${r.leave > 0 ? " ins-info-text" : " ins-muted"}`}>{fmtNum(r.leave)}</td>
              <td className="ins-end ins-num">{fmtHours(r.avg_hours)}</td>
              <td className="ins-end ins-num">{fmtHours(r.ot_hours)}</td>
              <td className="ins-presence-col">
                <PresenceBar pct={r.pct} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td className="ins-strong">{t("insights.dept.all", { defaultValue: "All departments" })}</td>
            <td className="ins-end ins-num ins-strong">{fmtNum(tot.headcount)}</td>
            <td className="ins-end ins-num ins-strong">{fmtNum(tot.present)}</td>
            <td className="ins-end ins-num ins-strong">{fmtNum(tot.late)}</td>
            <td className="ins-end ins-num ins-strong">{fmtNum(tot.absent)}</td>
            <td className="ins-end ins-num ins-strong">{fmtNum(tot.leave)}</td>
            <td className="ins-end ins-num">—</td>
            <td className="ins-end ins-num ins-strong">{fmtHours(tot.ot)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exceptions table (avatars + status pills, client-side pagination)
// ---------------------------------------------------------------------------

export const EXCEPTIONS_PAGE_SIZE = 25;

export function ExceptionsTable({
  rows,
  total,
  showDate,
  showDepartment = true,
  page,
  onPageChange,
  onOpenPerson,
  pageSize = EXCEPTIONS_PAGE_SIZE,
}: {
  rows: InsightsException[];
  total: number;
  showDate: boolean;
  showDepartment?: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onOpenPerson: (employeeId: number) => void;
  pageSize?: number;
}) {
  const { t } = useTranslation();
  const fmt = useDateFmt();
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const cur = Math.min(Math.max(1, page), pages);
  const slice = rows.slice((cur - 1) * pageSize, cur * pageSize);
  if (rows.length === 0) {
    return (
      <PanelEmpty
        tone="success"
        icon="check"
        title={t("insights.exc.emptyTitle", { defaultValue: "No exceptions" })}
        body={t("insights.exc.emptyBody", { defaultValue: "Nobody was absent, late, early out or short on hours." })}
      />
    );
  }
  return (
    <>
      <div className="ins-table-wrap">
        <table className="table ins-table">
          <thead>
            <tr>
              <th>{t("insights.exc.employee", { defaultValue: "Employee" })}</th>
              {showDepartment && <th>{t("insights.exc.department", { defaultValue: "Department" })}</th>}
              {showDate && <th>{t("insights.exc.date", { defaultValue: "Date" })}</th>}
              <th>{t("insights.exc.status", { defaultValue: "Status" })}</th>
              <th className="ins-end">{t("insights.exc.in", { defaultValue: "In" })}</th>
              <th className="ins-end">{t("insights.exc.out", { defaultValue: "Out" })}</th>
              <th className="ins-end">{t("insights.exc.hours", { defaultValue: "Hours" })}</th>
              <th>{t("insights.exc.detail", { defaultValue: "Detail" })}</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={`${r.employee_id}-${r.date}-${i}`}>
                <td>
                  <button
                    type="button"
                    className="ins-person"
                    onClick={() => onOpenPerson(r.employee_id)}
                    title={t("insights.exc.openPerson", { defaultValue: "Open {{name}}", name: r.full_name })}
                  >
                    <PersonAvatar name={r.full_name} />
                    <span className="ins-person-text">
                      <span className="ins-person-name">{r.full_name}</span>
                      <span className="ins-person-code">{r.employee_code}</span>
                    </span>
                  </button>
                </td>
                {showDepartment && <td className="ins-muted ins-wrap">{r.department}</td>}
                {showDate && <td className="ins-num ins-nowrap">{fmt.short(r.date)}</td>}
                <td>
                  <StatusPill status={r.status} />
                </td>
                <td className="ins-end ins-num">{clock(r.in_time)}</td>
                <td className="ins-end ins-num">{clock(r.out_time)}</td>
                <td className="ins-end ins-num ins-nowrap">{fmtHoursDuration(r.hours)}</td>
                <td className="ins-muted ins-wrap">{r.detail || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ins-pager">
        <span className="ins-muted">
          {t("insights.exc.showing", {
            defaultValue: "Showing {{from}}–{{to}} of {{n}}",
            from: fmtNum((cur - 1) * pageSize + 1),
            to: fmtNum(Math.min(cur * pageSize, rows.length)),
            n: fmtNum(rows.length),
          })}
          {total > rows.length &&
            ` · ${t("insights.exc.truncated", { defaultValue: "{{total}} in total — narrow the range to see all", total: fmtNum(total) })}`}
        </span>
        {pages > 1 && (
          <span className="ins-pager-nav">
            <button type="button" className="btn btn-sm" disabled={cur <= 1} onClick={() => onPageChange(cur - 1)} aria-label={t("insights.exc.prev", { defaultValue: "Previous page" })}>
              <Icon name="chevronLeft" size={13} />
            </button>
            <span className="ins-num">
              {t("insights.exc.page", { defaultValue: "Page {{page}} of {{pages}}", page: cur, pages })}
            </span>
            <button type="button" className="btn btn-sm" disabled={cur >= pages} onClick={() => onPageChange(cur + 1)} aria-label={t("insights.exc.next", { defaultValue: "Next page" })}>
              <Icon name="chevronRight" size={13} />
            </button>
          </span>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Ranked people list (top late / most absent)
// ---------------------------------------------------------------------------

export interface RankedPerson {
  employee_id: number;
  full_name: string;
  employee_code: string;
  department: string;
  count: number;
  detail?: string;
}

export function RankedPeopleList({
  items,
  tone,
  unit,
  emptyLabel,
  onOpen,
  showMeter = true,
}: {
  items: RankedPerson[];
  showMeter?: boolean;
  tone: Tone;
  unit: (n: number) => string;
  emptyLabel: string;
  onOpen: (employeeId: number) => void;
}) {
  if (items.length === 0) return <p className="ins-list-empty">{emptyLabel}</p>;
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ol className="ins-rank-list">
      {items.map((it) => (
        <li key={it.employee_id}>
          <button type="button" className={`ins-rank-item${showMeter ? "" : " no-meter"}`} onClick={() => onOpen(it.employee_id)}>
            <PersonAvatar name={it.full_name} size={28} />
            <span className="ins-rank-text">
              <span className="ins-person-name">{it.full_name}</span>
              <span className="ins-person-code">
                {it.department}
                {it.detail ? ` · ${it.detail}` : ""}
              </span>
            </span>
            {showMeter ? (
              <span className="ins-rank-meter" aria-hidden>
                <span className={`is-${tone}`} style={{ width: `${(it.count / max) * 100}%` }} />
              </span>
            ) : null}
            <span className="ins-rank-count">{unit(it.count)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Download PDF (existing POST /api/reports/attendance.pdf, gated)
// ---------------------------------------------------------------------------

export function DownloadPdfButton({
  range,
  departmentId,
  employeeId,
  reportName,
  filenameStem,
}: {
  range: InsightsRange;
  departmentId?: number | null;
  employeeId?: number | null;
  reportName: string;
  filenameStem?: string;
}) {
  const { t } = useTranslation();
  const { gate, modal } = useConfidentialDownload();
  const [optsOpen, setOptsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (includePhotos: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        start: range.start,
        end: range.end,
        include_employee_photos: includePhotos,
      };
      if (departmentId !== null && departmentId !== undefined) body.department_id = departmentId;
      if (employeeId !== null && employeeId !== undefined) body.employee_id = employeeId;
      const resp = await fetch("/api/reports/attendance.pdf", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        setError(t("insights.pdf.failed", { defaultValue: "PDF failed (HTTP {{status}})", status: resp.status }));
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stem = filenameStem ?? `attendance_${range.start}${range.end !== range.start ? `_${range.end}` : ""}`;
      a.download = `${stem}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(t("insights.pdf.failedNetwork", { defaultValue: "PDF failed — check your connection" }));
    } finally {
      setBusy(false);
      setOptsOpen(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        title={error ?? undefined}
        onClick={() => gate({ action: () => setOptsOpen(true), reportName, format: "pdf" })}
      >
        <Icon name="download" size={13} />
        {busy ? t("insights.pdf.generating", { defaultValue: "Generating…" }) : t("insights.pdf.download", { defaultValue: "Download PDF" })}
      </button>
      {error && (
        <span className="ins-pdf-error" role="alert">
          {error}
        </span>
      )}
      {/* Portaled: the page header animates in (transform), which would
          otherwise trap these fixed overlays in its stacking context. */}
      {createPortal(
        <>
          {modal}
          <PdfOptionsModal open={optsOpen} busy={busy} onClose={() => !busy && setOptsOpen(false)} onConfirm={(inc) => void run(inc)} />
        </>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Page-level states
// ---------------------------------------------------------------------------

export function InsightsError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="card ins-page-state">
      <PanelError
        title={t("insights.error.title", { defaultValue: "Couldn't load insights" })}
        body={error.message}
        retryLabel={t("insights.error.retry", { defaultValue: "Retry" })}
        onRetry={onRetry}
      />
    </div>
  );
}

export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="ins-sk-chart" style={{ height }} role="status" aria-label="Loading chart">
      {Array.from({ length: 14 }, (_, i) => (
        <span key={i} className="sk sk-line" style={{ height: `${30 + ((i * 37) % 60)}%`, borderRadius: "6px 6px 0 0" }} />
      ))}
    </div>
  );
}

/** Small header chip: "34 departments · 175 employees". */
export function ScopeChip({ children }: { children: ReactNode }) {
  return <span className="ins-scope-chip">{children}</span>;
}

// ===========================================================================
// v2 shared pieces — plain-language numbers, comparisons, findings,
// watchlists and question-led charts. Used by all three Insights pages.
// ===========================================================================

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 407 → "6h 47m"; 45 → "45m"; 0 → "0m". ``null`` → "—". */
export function fmtDuration(
  minutes: number | null | undefined,
  units: { h: string; m: string } = { h: "h", m: "m" },
): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "—";
  const neg = minutes < 0;
  const total = Math.round(Math.abs(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const body = h === 0 ? `${m}${units.m}` : m === 0 ? `${h.toLocaleString()}${units.h}` : `${h.toLocaleString()}${units.h} ${m}${units.m}`;
  return neg ? `−${body}` : body;
}

/** Decimal hours (6.78) → "6h 47m". */
export function fmtHoursDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return "—";
  return fmtDuration(hours * 60);
}

/** Localised ``fmtDuration`` (h / m unit letters from i18n). */
export function useDurationFmt(): (minutes: number | null | undefined) => string {
  const { t } = useTranslation();
  return useCallback(
    (minutes: number | null | undefined) =>
      fmtDuration(minutes, {
        h: t("insights.unit.hShort", { defaultValue: "h" }),
        m: t("insights.unit.mShort", { defaultValue: "m" }),
      }),
    [t],
  );
}

/** "07:41" → 461. Anything else → null. */
export function clockToMinutes(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 461 → "07:41" (wraps past midnight). */
export function minutesToClock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** current − previous, or null when either side is missing. */
export function deltaOf(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  if (Number.isNaN(cur) || Number.isNaN(prev)) return null;
  return cur - prev;
}

/** Minutes between two "HH:MM" clocks (b − a), or null. */
export function clockDelta(cur: string | null | undefined, prev: string | null | undefined): number | null {
  return deltaOf(clockToMinutes(cur), clockToMinutes(prev));
}

/** Rounded percentage of a ratio, null-safe. */
export function pctOf(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

// ---------------------------------------------------------------------------
// DeltaBadge — ▲/▼ change with good/bad colour
// ---------------------------------------------------------------------------

/** ``pts`` percentage points · ``count`` plain number · ``min`` minutes
 *  duration · ``clock`` minutes later/earlier · ``hours`` decimal hours. */
export type DeltaUnit = "pts" | "count" | "min" | "clock" | "hours";
/** Which direction is good: "up" (attendance), "down" (late, absent), "none". */
export type DeltaBetter = "up" | "down" | "none";

export function DeltaBadge({
  delta,
  unit,
  better,
  vs,
  title,
  size = "md",
}: {
  delta: number | null | undefined;
  unit: DeltaUnit;
  better: DeltaBetter;
  /** Short suffix, e.g. "vs last period" / "vs company". */
  vs?: string;
  title?: string;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation();
  const dur = useDurationFmt();
  if (delta === null || delta === undefined || Number.isNaN(delta)) {
    return (
      <span className={`ins-delta is-none is-${size}`} title={title}>
        <span className="ins-delta-val">{t("insights.delta.noData", { defaultValue: "no comparison" })}</span>
      </span>
    );
  }
  const flatEps = unit === "hours" ? 0.05 : 0.5;
  const flat = Math.abs(delta) < flatEps;
  const up = delta > 0;
  const tone = flat || better === "none" ? "flat" : (up && better === "up") || (!up && better === "down") ? "good" : "bad";
  const abs = Math.abs(delta);
  let text: string;
  if (flat) text = t("insights.delta.same", { defaultValue: "no change" });
  else if (unit === "pts") text = t("insights.delta.pts", { defaultValue: "{{n}} pts", defaultValue_one: "{{n}} pt", n: fmtNum(abs), count: Math.round(abs) });
  else if (unit === "count") text = fmtNum(abs);
  else if (unit === "hours") text = dur(abs * 60);
  else if (unit === "min") text = dur(abs);
  else
    text = up
      ? t("insights.delta.later", { defaultValue: "{{d}} later", d: dur(abs) })
      : t("insights.delta.earlier", { defaultValue: "{{d}} earlier", d: dur(abs) });
  return (
    <span className={`ins-delta is-${tone} is-${size}`} title={title}>
      {!flat && unit !== "clock" && (
        <span aria-hidden className="ins-delta-arrow">
          {up ? "▲" : "▼"}
        </span>
      )}
      <span className="ins-delta-val">{text}</span>
      {vs && <span className="ins-delta-vs">{vs}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Headline metrics (max 4 per page)
// ---------------------------------------------------------------------------

export interface HeadlineComparison {
  /** "vs 28 Sep – 4 Oct" / "vs company". */
  vs: string;
  delta: number | null;
  unit: DeltaUnit;
  better: DeltaBetter;
  title?: string;
}

export function HeadlineMetric({
  label,
  value,
  suffix,
  context,
  comparisons = [],
  meter,
  title,
  onClick,
}: {
  label: string;
  value: ReactNode;
  /** Small unit after the value ("%"). */
  suffix?: ReactNode;
  /** Plain-language line: "7 of 1,050 expected days". */
  context?: ReactNode;
  comparisons?: HeadlineComparison[];
  /** Optional thin meter (0–100) under the value. */
  meter?: { pct: number | null; tone?: "accent" | "success" | "warning" | "danger" | "neutral"; marker?: number | null; markerLabel?: string };
  title?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="ins-hl-label">{label}</span>
      <span className="ins-hl-value">
        {value}
        {suffix !== undefined && suffix !== null && <span className="ins-hl-suffix">{suffix}</span>}
      </span>
      {meter && (
        <span className="ins-hl-meter" aria-hidden>
          <span
            className={`ins-hl-meter-fill is-${meter.tone ?? "accent"}`}
            style={{ width: `${Math.max(0, Math.min(100, meter.pct ?? 0))}%` }}
          />
          {meter.marker !== null && meter.marker !== undefined && (
            <span className="ins-hl-meter-mark" style={{ insetInlineStart: `${Math.max(0, Math.min(100, meter.marker))}%` }} title={meter.markerLabel} />
          )}
        </span>
      )}
      {context && <span className="ins-hl-context">{context}</span>}
      {comparisons.length > 0 && (
        <span className="ins-hl-compare">
          {comparisons.map((c, i) => (
            <DeltaBadge key={i} delta={c.delta} unit={c.unit} better={c.better} vs={c.vs} size="sm" {...(c.title ? { title: c.title } : {})} />
          ))}
        </span>
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="ins-hl is-click" onClick={onClick} title={title}>
        {body}
      </button>
    );
  }
  return (
    <div className="ins-hl" title={title}>
      {body}
    </div>
  );
}

export function HeadlineRow({ children }: { children: ReactNode }) {
  return <div className="ins-hl-row">{children}</div>;
}

export function HeadlineSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="ins-hl-row" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ins-hl">
          <span className="sk sk-line" style={{ width: "45%", height: 10 }} />
          <span className="sk sk-line" style={{ width: "35%", height: 30, marginTop: 14 }} />
          <span className="sk sk-line" style={{ width: "70%", height: 9, marginTop: 14 }} />
          <span className="sk sk-line" style={{ width: "55%", height: 9, marginTop: 10 }} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calm notice (sparse data, missing comparison, …)
// ---------------------------------------------------------------------------

export function InsightsNotice({
  tone = "info",
  icon = "info",
  title,
  body,
  action,
}: {
  tone?: "info" | "warn" | "neutral";
  icon?: Parameters<typeof Icon>[0]["name"];
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`ins-notice is-${tone}`} role="note">
      <span className="ins-notice-icon" aria-hidden>
        <Icon name={icon} size={16} />
      </span>
      <div className="ins-notice-text">
        <div className="ins-notice-title">{title}</div>
        {body && <div className="ins-notice-body">{body}</div>}
      </div>
      {action && <div className="ins-notice-action">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key findings — short computed sentences
// ---------------------------------------------------------------------------

export type FindingTone = "good" | "bad" | "warn" | "info" | "neutral";

export interface Finding {
  id: string;
  tone: FindingTone;
  text: ReactNode;
  /** Optional in-app link (keeps the range in the URL). */
  to?: string;
  linkLabel?: string;
}

const FINDING_ICON: Record<FindingTone, Parameters<typeof Icon>[0]["name"]> = {
  good: "check",
  bad: "activity",
  warn: "clock",
  info: "info",
  neutral: "sparkles",
};

export function KeyFindings({
  items,
  title,
  sub,
  emptyText,
  max = 6,
}: {
  items: Finding[];
  title?: string;
  sub?: string;
  emptyText?: string;
  max?: number;
}) {
  const { t } = useTranslation();
  const shown = items.slice(0, max);
  return (
    <section className="card ins-findings" aria-label={title ?? t("insights.findings.title", { defaultValue: "Key findings" })}>
      <header className="ins-findings-head">
        <span className="ins-findings-badge" aria-hidden>
          <Icon name="sparkles" size={14} />
        </span>
        <div>
          <h3 className="card-title">{title ?? t("insights.findings.title", { defaultValue: "Key findings" })}</h3>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
      </header>
      {shown.length === 0 ? (
        <p className="ins-findings-empty">{emptyText ?? t("insights.findings.empty", { defaultValue: "Nothing stands out in this period." })}</p>
      ) : (
        <ul className="ins-findings-list">
          {shown.map((f) => (
            <li key={f.id} className={`ins-finding is-${f.tone}`}>
              <span className="ins-finding-icon" aria-hidden>
                <Icon name={FINDING_ICON[f.tone]} size={13} />
              </span>
              <span className="ins-finding-text">{f.text}</span>
              {f.to && (
                <Link className="ins-finding-link" to={f.to}>
                  {f.linkLabel ?? t("insights.findings.view", { defaultValue: "View" })}
                  <Icon name="chevronRight" size={12} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Watchlists — actionable people lists
// ---------------------------------------------------------------------------

export interface WatchItem {
  employee_id: number;
  full_name: string;
  employee_code?: string;
  department?: string;
  department_id?: number | null;
  primary_photo_id?: number | null;
  /** Right-hand figure: "5 days", "6h 40m". */
  value: string;
  /** Second line after the department: "avg 18 min late". */
  detail?: string;
  /** 0–1 relative meter (omit to hide). */
  meter?: number;
}

export type WatchTone = "warning" | "danger" | "info" | "accent" | "neutral";

export function Watchlist({
  items,
  tone,
  emptyLabel,
  personHref,
  deptHref,
  hideDepartment = false,
  total,
  moreLabel,
  moreHref,
  initialRows,
}: {
  items: WatchItem[];
  tone: WatchTone;
  emptyLabel: ReactNode;
  personHref: (employeeId: number) => string;
  deptHref?: (departmentId: number) => string;
  hideDepartment?: boolean;
  /** Full count when ``items`` is a top-N. */
  total?: number;
  moreLabel?: (hidden: number) => string;
  /** Link target for the "+N more" footer. */
  moreHref?: string;
  /** Rows shown before a "Show more" toggle (default: all). */
  initialRows?: number;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return (
      <div className="ins-watch-empty">
        <Icon name="check" size={14} />
        <span>{emptyLabel}</span>
      </div>
    );
  }
  const hidden = total !== undefined ? Math.max(0, total - items.length) : 0;
  const cap = initialRows !== undefined && !expanded ? initialRows : items.length;
  const visible = items.slice(0, cap);
  return (
    <>
      <ol className="ins-watch">
        {visible.map((it) => (
          <li key={it.employee_id} className="ins-watch-item">
            <PersonAvatar name={it.full_name} employeeId={it.employee_id} photoId={it.primary_photo_id ?? null} size={30} />
            <span className="ins-watch-text">
              <Link className="ins-watch-name" to={personHref(it.employee_id)} title={it.full_name}>
                {it.full_name}
              </Link>
              <span className="ins-watch-sub">
                {!hideDepartment && it.department && (
                  deptHref && it.department_id !== null && it.department_id !== undefined ? (
                    <Link className="ins-watch-dept" to={deptHref(it.department_id)}>
                      {it.department}
                    </Link>
                  ) : (
                    <span>{it.department}</span>
                  )
                )}
                {!hideDepartment && it.department && it.detail ? <span aria-hidden> · </span> : null}
                {it.detail && <span>{it.detail}</span>}
              </span>
            </span>
            {it.meter !== undefined && (
              <span className="ins-watch-meter" aria-hidden>
                <span className={`is-${tone}`} style={{ width: `${Math.max(4, Math.min(1, it.meter) * 100)}%` }} />
              </span>
            )}
            <span className={`ins-watch-value is-${tone}`}>{it.value}</span>
          </li>
        ))}
      </ol>
      {(items.length > cap || (hidden > 0 && moreLabel)) && (
        <div className="ins-watch-more">
          {items.length > cap ? (
            <button type="button" className="ins-link-btn" onClick={() => setExpanded(true)}>
              {t("insights.watch.showMore", { defaultValue: "Show {{count}} more", count: items.length - cap })}
            </button>
          ) : (
            <span />
          )}
          {hidden > 0 && moreLabel && (moreHref ? <Link to={moreHref}>{moreLabel(hidden)}</Link> : <span>{moreLabel(hidden)}</span>)}
        </div>
      )}
    </>
  );
}

export type WatchKey = "frequent_late" | "repeated_absent" | "early_leavers" | "overtime" | "never_seen";

/** One panel with a tab per watchlist (count in each tab). Pass the
 *  ``watchlist`` block from overview / department responses. */
export function WatchlistPanel({
  watchlist,
  range,
  single = false,
  hideDepartment = false,
  title,
  sub,
  initial,
  keys = ["frequent_late", "repeated_absent", "early_leavers", "overtime", "never_seen"],
  initialRows = 6,
}: {
  watchlist: InsightsWatchlist;
  range: InsightsRange;
  single?: boolean;
  hideDepartment?: boolean;
  title?: string;
  sub?: string;
  initial?: WatchKey;
  keys?: WatchKey[];
  /** Rows before "Show more" (default 6). */
  initialRows?: number;
}) {
  const { t } = useTranslation();
  const dur = useDurationFmt();
  const firstNonEmpty = keys.find((k) => (watchlist.totals[k] ?? 0) > 0) ?? keys[0] ?? "frequent_late";
  const [tab, setTab] = useState<WatchKey>(initial ?? firstNonEmpty);
  const rq = rangeQuery(range);
  const personHref = (id: number) => `/insights/people/${id}${rq}`;
  const deptHref = (id: number) => `/insights/departments/${id}${rq}`;
  const days = (n: number) => t("insights.watch.days", { defaultValue: "{{count}} days", defaultValue_one: "{{count}} day", count: n });
  const labels: Record<WatchKey, string> = {
    frequent_late: t("insights.watch.tab.late", { defaultValue: "Often late" }),
    repeated_absent: t("insights.watch.tab.absent", { defaultValue: "Absences" }),
    early_leavers: t("insights.watch.tab.early", { defaultValue: "Leave early" }),
    overtime: t("insights.watch.tab.overtime", { defaultValue: "Overtime" }),
    never_seen: t("insights.watch.tab.neverSeen", { defaultValue: "Never seen" }),
  };
  const hints: Record<WatchKey, string> = {
    frequent_late: single
      ? t("insights.watch.hint.lateDay", { defaultValue: "Arrived after the grace period today." })
      : t("insights.watch.hint.late", { defaultValue: "Late on 2 or more days. A quiet word often fixes this." }),
    repeated_absent: single
      ? t("insights.watch.hint.absentDay", { defaultValue: "Absent without approved leave today." })
      : t("insights.watch.hint.absent", { defaultValue: "Absent on 2 or more working days without approved leave." }),
    early_leavers: t("insights.watch.hint.early", { defaultValue: "Left before the end of their shift." }),
    overtime: t("insights.watch.hint.overtime", { defaultValue: "Worked the most beyond their required hours — check workload." }),
    never_seen: t("insights.watch.hint.neverSeen", {
      defaultValue: "No camera sighting at all in this period — usually a missing or poor reference photo, or a camera gap.",
    }),
  };
  const empty: Record<WatchKey, string> = {
    frequent_late: t("insights.watch.empty.late", { defaultValue: "Nobody was late repeatedly." }),
    repeated_absent: t("insights.watch.empty.absent", { defaultValue: "No repeated absences." }),
    early_leavers: t("insights.watch.empty.early", { defaultValue: "Nobody left early." }),
    overtime: t("insights.watch.empty.overtime", { defaultValue: "No overtime recorded." }),
    never_seen: t("insights.watch.empty.neverSeen", { defaultValue: "Everyone was seen by a camera at least once." }),
  };
  let items: WatchItem[] = [];
  let tone: WatchTone = "neutral";
  if (tab === "frequent_late") {
    tone = "warning";
    const max = Math.max(1, ...watchlist.frequent_late.map((p) => p.count));
    items = watchlist.frequent_late.map((p) => ({
      ...p,
      value: days(p.count),
      meter: p.count / max,
      ...(p.avg_late_minutes !== null
        ? { detail: t("insights.watch.avgLate", { defaultValue: "avg {{d}} late", d: dur(p.avg_late_minutes) }) }
        : {}),
    }));
  } else if (tab === "repeated_absent") {
    tone = "danger";
    const max = Math.max(1, ...watchlist.repeated_absent.map((p) => p.count));
    items = watchlist.repeated_absent.map((p) => ({
      ...p,
      value: days(p.count),
      meter: p.count / max,
      ...(p.longest_streak >= 2
        ? { detail: t("insights.watch.streak", { defaultValue: "{{count}} in a row", count: p.longest_streak }) }
        : {}),
    }));
  } else if (tab === "early_leavers") {
    tone = "warning";
    const max = Math.max(1, ...watchlist.early_leavers.map((p) => p.count));
    items = watchlist.early_leavers.map((p) => ({ ...p, value: days(p.count), meter: p.count / max }));
  } else if (tab === "overtime") {
    tone = "accent";
    const max = Math.max(1, ...watchlist.overtime.map((p) => p.ot_minutes));
    items = watchlist.overtime.map((p) => ({ ...p, value: dur(p.ot_minutes), meter: p.ot_minutes / max }));
  } else {
    tone = "neutral";
    items = watchlist.never_seen.map((p) => ({
      ...p,
      value: "",
      ...(p.employee_code ? { detail: p.employee_code } : {}),
    }));
  }
  return (
    <Panel
      className="ins-watch-panel"
      title={title ?? t("insights.watch.title", { defaultValue: "Who needs a follow-up?" })}
      sub={sub ?? t("insights.watch.sub", { defaultValue: "People to talk to, by reason — click a name for their full record" })}
    >
      <div className="ins-watch-tabs" role="tablist" aria-label={title ?? t("insights.watch.title", { defaultValue: "Who needs a follow-up?" })}>
        {keys.map((k) => {
          const n = watchlist.totals[k] ?? 0;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={`ins-watch-tab${tab === k ? " active" : ""}`}
              onClick={() => setTab(k)}
            >
              {labels[k]}
              <span className={`ins-watch-count${n > 0 ? ` has-${k}` : ""}`}>{fmtNum(n)}</span>
            </button>
          );
        })}
      </div>
      <p className="ins-watch-hint">{hints[tab]}</p>
      <Watchlist
        items={items}
        tone={tone}
        emptyLabel={empty[tab]}
        personHref={personHref}
        deptHref={deptHref}
        hideDepartment={hideDepartment}
        total={watchlist.totals[tab]}
        moreLabel={(h) => t("insights.watch.more", { defaultValue: "+ {{count}} more in People", count: h })}
        moreHref={`/insights/people${rq}`}
        initialRows={initialRows}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// "Is attendance holding up?" — attendance % per working day
// ---------------------------------------------------------------------------

/** A trend day with no records at all (future, before data) → null. */
function dayHasData(d: InsightsTrendDay): boolean {
  return d.present + d.late + d.absent + d.leave > 0;
}

export function AttendanceTrendChart({
  days,
  reference,
  referenceLabel,
  height = 230,
  highlightDate,
}: {
  days: InsightsTrendDay[];
  /** Dashed reference line (e.g. previous-period attendance %). */
  reference?: number | null;
  referenceLabel?: string;
  height?: number;
  /** Emphasise one day (e.g. the selected single day). */
  highlightDate?: string;
}) {
  const { t } = useTranslation();
  const fmt = useDateFmt();
  const [ref, width] = useWidth<HTMLDivElement>();
  // Drop leading / trailing days with no data at all; keep gaps inside.
  const firstIdx = days.findIndex((d) => dayHasData(d) || d.is_weekend || d.is_holiday);
  const lastData = (() => {
    for (let i = days.length - 1; i >= 0; i--) if (dayHasData(days[i]!)) return i;
    return -1;
  })();
  const shown = firstIdx >= 0 && lastData >= 0 ? days.slice(firstIdx, lastData + 1) : [];
  if (shown.length === 0) {
    return (
      <PanelEmpty
        icon="activity"
        title={t("insights.trend2.empty", { defaultValue: "No attendance recorded yet" })}
        body={t("insights.trend2.emptyBody", { defaultValue: "The trend appears once the first working day has records." })}
      />
    );
  }
  const padL = 40;
  const padR = 14;
  const padT = 14;
  const padB = 38;
  const w = Math.max(0, width);
  const plotW = Math.max(10, w - padL - padR);
  const plotH = height - padT - padB;
  const n = shown.length;
  const slot = plotW / n;
  const barW = Math.max(3, Math.min(30, slot * 0.6));
  const y = (p: number) => padT + plotH - (Math.max(0, Math.min(100, p)) / 100) * plotH;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 58))));
  // Time runs left → right in both languages (the canvas is direction: ltr).
  const xOf = (i: number) => padL + slot * i + slot / 2;
  const offLbl = t("insights.trend2.off", { defaultValue: "Weekend" });
  return (
    <div className="ins-chart">
      <div ref={ref} className="ins-chart-canvas" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} role="img" aria-label={t("insights.trend2.aria", { defaultValue: "Attendance rate per working day" })}>
            {[0, 25, 50, 75, 100].map((p) => (
              <g key={p}>
                <line x1={padL} x2={padL + plotW} y1={y(p)} y2={y(p)} className="ins-grid" />
                <text x={padL - 8} y={y(p) + 3.5} textAnchor="end" className="ins-axis">
                  {p}%
                </text>
              </g>
            ))}
            {shown.map((d, i) => {
              const cx = xOf(i);
              const off = d.is_weekend || d.is_holiday;
              const has = dayHasData(d);
              const hc = Math.max(1, d.headcount);
              const pct = d.present_pct;
              const latePct = Math.min(pct, (d.late / hc) * 100);
              const tip = off
                ? `${fmt.short(d.date)} · ${d.holiday_name ?? offLbl}`
                : has
                  ? [
                      fmt.short(d.date),
                      t("insights.trend2.tipAttended", { defaultValue: "Attended: {{pct}} ({{n}} of {{hc}})", pct: fmtPct(pct), n: fmtNum(d.present), hc: fmtNum(d.headcount) }),
                      t("insights.trend2.tipLate", { defaultValue: "Late: {{n}}", n: fmtNum(d.late) }),
                      t("insights.trend2.tipAbsent", { defaultValue: "Absent: {{n}}", n: fmtNum(d.absent) }),
                      t("insights.trend2.tipLeave", { defaultValue: "On leave: {{n}}", n: fmtNum(d.leave) }),
                    ].join("\n")
                  : `${fmt.short(d.date)} · ${t("insights.trend2.noData", { defaultValue: "no records" })}`;
              return (
                <g key={d.date}>
                  {d.date === highlightDate && (
                    <rect x={cx - slot / 2 + 1} y={padT - 6} width={Math.max(0, slot - 2)} height={plotH + 6 + padB - 6} rx={8} className="ins-hi-day" />
                  )}
                  {off ? (
                    <>
                      <line x1={cx} x2={cx} y1={padT + plotH - 6} y2={padT + plotH} className="ins-tick-off" />
                      {d.is_holiday && <circle cx={cx} cy={padT + plotH - 12} r={2.5} className="ins-holiday-dot" />}
                    </>
                  ) : has ? (
                    <>
                      <rect x={cx - barW / 2} y={y(pct)} width={barW} height={Math.max(0, y(0) - y(pct))} rx={Math.min(4, barW / 3)} className="ins-tbar" />
                      {latePct > 0 && (
                        <rect x={cx - barW / 2} y={y(pct)} width={barW} height={Math.max(1.5, y(0) - y(latePct))} rx={Math.min(4, barW / 3)} className="ins-tbar-late" />
                      )}
                    </>
                  ) : (
                    <line x1={cx - barW / 2} x2={cx + barW / 2} y1={y(0) - 1} y2={y(0) - 1} className="ins-tick-none" />
                  )}
                  <rect x={cx - slot / 2} y={padT} width={slot} height={plotH} fill="transparent">
                    <title>{tip}</title>
                  </rect>
                  {(i % labelEvery === 0 || d.date === highlightDate) && (
                    <>
                      <text x={cx} y={height - padB + 15} textAnchor="middle" className={`ins-axis${off ? " is-off" : ""}${d.date === highlightDate ? " is-hi" : ""}`}>
                        {n <= 14 ? fmt.weekdayShort(d.date) : fmt.dayMonth(d.date)}
                      </text>
                      {n <= 14 && (
                        <text x={cx} y={height - padB + 28} textAnchor="middle" className="ins-axis ins-axis-sub">
                          {fmt.dayMonth(d.date)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
            {reference !== null && reference !== undefined && (
              <g>
                <line x1={padL} x2={padL + plotW} y1={y(reference)} y2={y(reference)} className="ins-ref-line">
                  <title>{`${referenceLabel ?? ""} ${fmtPct(reference)}`}</title>
                </line>
              </g>
            )}
          </svg>
        )}
      </div>
      <div className="ins-legend">
        <span><i className="is-accent" />{t("insights.trend2.legendAttended", { defaultValue: "Attended" })}</span>
        <span><i className="is-warning" />{t("insights.trend2.legendLate", { defaultValue: "of which late" })}</span>
        {reference !== null && reference !== undefined && (
          <span><i className="is-ref" />{referenceLabel ?? t("insights.trend2.legendRef", { defaultValue: "Previous period" })} · {fmtPct(reference)}</span>
        )}
        <span><i className="is-offtick" />{t("insights.trend2.legendOff", { defaultValue: "Weekend / holiday" })}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Are people arriving on time?" — arrivals with shift start + grace
// ---------------------------------------------------------------------------

export function ArrivalChart({
  buckets: raw,
  shift,
  height = 200,
}: {
  buckets: InsightsArrivalBucket[];
  shift: InsightsShift | null | undefined;
  height?: number;
}) {
  const { t } = useTranslation();
  const [ref, width] = useWidth<HTMLDivElement>();
  const startMin = clockToMinutes(shift?.start);
  const graceMin = startMin !== null ? startMin + (shift?.grace_minutes ?? 0) : null;
  const buckets = useMemo(() => {
    const filled = fillBuckets(raw, 10);
    if (startMin === null || filled.length === 0) return filled;
    // Make sure the shift start (and one slot before it) is on the axis.
    const first = clockToMinutes(filled[0]!.bucket) ?? 0;
    const last = clockToMinutes(filled[filled.length - 1]!.bucket) ?? 0;
    const want0 = Math.min(first, Math.floor((startMin - 60) / 30) * 30);
    const want1 = Math.max(last, Math.floor(((graceMin ?? startMin) + 30) / 30) * 30);
    const counts = new Map(filled.map((b) => [clockToMinutes(b.bucket) ?? 0, b.count]));
    const out: InsightsArrivalBucket[] = [];
    for (let m = Math.max(0, want0); m <= Math.min(1410, want1); m += 30) out.push({ bucket: minutesToClock(m), count: counts.get(m) ?? 0 });
    return out;
  }, [raw, startMin, graceMin]);
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) {
    return (
      <PanelEmpty
        icon="clock"
        title={t("insights.arrivals.empty", { defaultValue: "No arrivals in this period" })}
        body={t("insights.arrivals.emptyBody", { defaultValue: "First-in times appear once employees are detected." })}
      />
    );
  }
  const padL = 30;
  const padR = 10;
  // Top band reserved for the marker label so it never meets a bar value.
  const padT = 42;
  const padB = 24;
  const w = Math.max(0, width);
  const plotW = Math.max(10, w - padL - padR);
  const plotH = height - padT - padB;
  const first = clockToMinutes(buckets[0]!.bucket) ?? 0;
  const span = buckets.length * 30;
  const x = (min: number) => padL + ((min - first) / span) * plotW;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const slotW = plotW / buckets.length;
  const barW = Math.max(3, slotW - Math.min(6, slotW * 0.2));
  // Thin out the time labels by the room each one gets ("10:00" needs
  // ~38px), so narrow screens never run them together.
  const labelEvery = Math.max(1, Math.ceil(38 / Math.max(1, slotW)));
  const late = (b: InsightsArrivalBucket) => graceMin !== null && (clockToMinutes(b.bucket) ?? 0) >= graceMin;
  const mixed = (b: InsightsArrivalBucket) => {
    const m = clockToMinutes(b.bucket) ?? 0;
    return graceMin !== null && m < graceMin && m + 30 > graceMin;
  };
  return (
    <div className="ins-chart">
      <div ref={ref} className="ins-chart-canvas" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} role="img" aria-label={t("insights.arrivals.aria", { defaultValue: "First-in time distribution" })}>
            <line x1={padL} x2={padL + plotW} y1={y(0)} y2={y(0)} className="ins-grid" />
            {startMin !== null && (
              <g className="ins-marker">
                <line x1={x(startMin)} x2={x(startMin)} y1={6} y2={y(0)} className="ins-marker-line" />
                <text x={x(startMin) + 5} y={14} textAnchor="start" className="ins-marker-lbl">
                  {t("insights.arrivals.shiftStart", { defaultValue: "Start {{time}}", time: minutesToClock(startMin) })}
                </text>
              </g>
            )}
            {graceMin !== null && startMin !== null && graceMin !== startMin && (
              <g className="ins-marker">
                <line x1={x(graceMin)} x2={x(graceMin)} y1={padT} y2={y(0)} className="ins-marker-line is-grace" />
              </g>
            )}
            {buckets.map((b, i) => {
              const m = clockToMinutes(b.bucket) ?? 0;
              const cx = x(m + 15);
              const cls = late(b) ? "is-late" : mixed(b) ? "is-mixed" : "is-ontime";
              return (
                <g key={b.bucket}>
                  {b.count > 0 && (
                    <>
                      <rect x={cx - barW / 2} y={y(b.count)} width={barW} height={Math.max(0, y(0) - y(b.count))} rx={4} className={`ins-abar ${cls}`} />
                      <text x={cx} y={y(b.count) - 5} textAnchor="middle" className="ins-axis ins-abar-val">
                        {fmtNum(b.count)}
                      </text>
                    </>
                  )}
                  <rect x={cx - slotW / 2} y={padT} width={slotW} height={plotH} fill="transparent">
                    <title>{`${b.bucket}–${minutesToClock(m + 30)} · ${t("insights.arrivals.tip", { defaultValue: "{{count}} arrivals", defaultValue_one: "{{count}} arrival", count: b.count })}`}</title>
                  </rect>
                  {i % labelEvery === 0 && (
                    <text x={x(m)} y={height - padB + 15} textAnchor="middle" className="ins-axis">
                      {b.bucket}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <div className="ins-legend">
        <span><i className="is-accent" />{t("insights.arrivals.legendOnTime", { defaultValue: "On time" })}</span>
        {graceMin !== null && <span><i className="is-warning" />{t("insights.arrivals.legendLate", { defaultValue: "After grace ({{time}})", time: minutesToClock(graceMin) })}</span>}
        {startMin !== null && <span><i className="is-marker" />{t("insights.arrivals.legendStart", { defaultValue: "Shift start" })}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Which day of the week is weakest?"
// ---------------------------------------------------------------------------

export function WeekdayChart({
  days: rawDays,
  reference,
  referenceLabel,
}: {
  days: InsightsWeekday[];
  /** Dashed reference (e.g. period / company average attendance %). */
  reference?: number | null;
  referenceLabel?: string;
}) {
  let days: InsightsWeekday[];
  const { t } = useTranslation();
  // Work-week order: start right after the longest gap (e.g. Fri/Sat
  // weekend → Sun, Mon, …, Thu).
  days = useMemo(() => {
    const s = [...rawDays].sort((a, b) => a.weekday - b.weekday);
    if (s.length < 2) return s;
    let cut = 0;
    let best = -1;
    for (let i = 0; i < s.length; i++) {
      const cur = s[i]!.weekday;
      const prev = s[(i - 1 + s.length) % s.length]!.weekday;
      const gap = (cur - prev + 7) % 7;
      if (gap > best) {
        best = gap;
        cut = i;
      }
    }
    return [...s.slice(cut), ...s.slice(0, cut)];
  }, [rawDays]);
  const valid = days.filter((d) => d.attendance_pct !== null);
  if (valid.length === 0) {
    return (
      <PanelEmpty
        icon="calendar"
        title={t("insights.weekday.empty", { defaultValue: "Not enough days yet" })}
        body={t("insights.weekday.emptyBody", { defaultValue: "Pick a range of at least a week to compare weekdays." })}
      />
    );
  }
  const weakest = valid.reduce((a, b) => ((b.attendance_pct ?? 0) < (a.attendance_pct ?? 0) ? b : a));
  const strongest = valid.reduce((a, b) => ((b.attendance_pct ?? 0) > (a.attendance_pct ?? 0) ? b : a));
  const showWeak = valid.length > 1 && (strongest.attendance_pct ?? 0) - (weakest.attendance_pct ?? 0) >= 2;
  const dayName = (d: InsightsWeekday) => t(`insights.weekday.name.${d.weekday}`, { defaultValue: d.name });
  return (
    <div className="ins-wd">
      <div className="ins-wd-plot" role="img" aria-label={t("insights.weekday.aria", { defaultValue: "Attendance rate by day of the week" })}>
        {days.map((d) => {
          const p = d.attendance_pct;
          const isWeak = showWeak && d.weekday === weakest.weekday;
          return (
            <div
              key={d.weekday}
              className={`ins-wd-col${isWeak ? " is-weak" : ""}`}
              title={[
                dayName(d),
                t("insights.weekday.tipAtt", { defaultValue: "Attendance {{pct}}", pct: fmtPct(p) }),
                t("insights.weekday.tipPunct", { defaultValue: "On time {{pct}}", pct: fmtPct(d.punctuality_pct) }),
                t("insights.weekday.tipCounts", { defaultValue: "{{late}} late · {{absent}} absent · over {{days}} days", late: fmtNum(d.late), absent: fmtNum(d.absent), days: d.working_days }),
              ].join("\n")}
            >
              <span className="ins-wd-val">{fmtPct(p)}</span>
              <span className="ins-wd-track">
                <span className="ins-wd-bar" style={{ height: `${Math.max(0, Math.min(100, p ?? 0))}%` }} />
                {reference !== null && reference !== undefined && (
                  <span className="ins-wd-ref" style={{ bottom: `${Math.max(0, Math.min(100, reference))}%` }} />
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="ins-wd-labels">
        {days.map((d) => (
          <div key={d.weekday} className={`ins-wd-lbl${showWeak && d.weekday === weakest.weekday ? " is-weak" : ""}`}>
            <span className="ins-wd-name">{dayName(d)}</span>
            <span className="ins-wd-sub">
              {d.punctuality_pct !== null
                ? t("insights.weekday.onTime", { defaultValue: "{{pct}} on time", pct: fmtPct(d.punctuality_pct) })
                : "—"}
            </span>
          </div>
        ))}
      </div>
      {reference !== null && reference !== undefined && (
        <div className="ins-legend">
          <span><i className="is-ref" />{referenceLabel ?? ""} · {fmtPct(reference)}</span>
        </div>
      )}
      {showWeak && (
        <p className="ins-wd-note">
          {t("insights.weekday.weakest", {
            defaultValue: "{{day}} is the weakest day ({{pct}}), {{gap}} points below {{best}}.",
            day: dayName(weakest),
            pct: fmtPct(weakest.attendance_pct),
            gap: fmtNum((strongest.attendance_pct ?? 0) - (weakest.attendance_pct ?? 0)),
            best: dayName(strongest),
          })}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Department comparison (compact sortable table, average marker)
// ---------------------------------------------------------------------------

type DeptSort = "pct" | "name" | "headcount" | "late" | "absent";

export function DepartmentCompareTable({
  rows,
  range,
  average,
  limit = 10,
}: {
  rows: InsightsDepartmentRow[];
  range: InsightsRange;
  /** Company / scope average attendance % (marker on every bar). */
  average: number | null;
  limit?: number;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<DeptSort>("pct");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    const r = [...rows];
    const k = (x: InsightsDepartmentRow): number | string =>
      sort === "name" ? x.name.toLowerCase() : sort === "headcount" ? x.headcount : sort === "late" ? x.late : sort === "absent" ? x.absent : x.pct;
    r.sort((a, b) => {
      const va = k(a);
      const vb = k(b);
      const c = typeof va === "string" ? va.localeCompare(String(vb)) : va - (vb as number);
      return dir === "asc" ? c : -c;
    });
    return r;
  }, [rows, sort, dir]);
  if (rows.length === 0) {
    return <PanelEmpty icon="users" title={t("insights.dept.empty", { defaultValue: "No departments in scope" })} />;
  }
  const shown = all ? sorted : sorted.slice(0, limit);
  const head = (key: DeptSort, label: string, end = false) => {
    const active = sort === key;
    return (
      <th className={end ? "ins-end" : undefined} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          className={`ins-sort${active ? " active" : ""}`}
          onClick={() => {
            if (active) setDir(dir === "asc" ? "desc" : "asc");
            else {
              setSort(key);
              setDir(key === "name" ? "asc" : key === "pct" ? "asc" : "desc");
            }
          }}
        >
          {label}
          <Icon name={active ? (dir === "asc" ? "chevronUp" : "chevronDown") : "chevronsUpDown"} size={11} />
        </button>
      </th>
    );
  };
  const rq = rangeQuery(range);
  return (
    <>
      <div className="ins-table-wrap">
        <table className="table ins-table ins-dcmp">
          <thead>
            <tr>
              {head("name", t("insights.dept.department", { defaultValue: "Department" }))}
              {head("headcount", t("insights.dept.people", { defaultValue: "People" }), true)}
              {head("pct", t("insights.dept.attendance", { defaultValue: "Attendance" }))}
              <th className="ins-end">{t("insights.dept.vsAvg", { defaultValue: "vs average" })}</th>
              {head("late", t("insights.dept.lateDays", { defaultValue: "Late days" }), true)}
              {head("absent", t("insights.dept.absentDays", { defaultValue: "Absent days" }), true)}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.department_id}>
                <td>
                  <Link className="ins-dcmp-name" to={`/insights/departments/${r.department_id}${rq}`}>
                    {r.name}
                  </Link>
                </td>
                <td className="ins-end ins-num ins-muted">{fmtNum(r.headcount)}</td>
                <td className="ins-dcmp-barcell">
                  <span className="ins-dcmp-bar" title={`${r.name}: ${fmtPct(r.pct)}`}>
                    <span className="ins-dcmp-track">
                      <span className="ins-dcmp-fill" style={{ width: `${Math.max(0, Math.min(100, r.pct))}%` }} />
                      {average !== null && <span className="ins-dcmp-avg" style={{ insetInlineStart: `${Math.max(0, Math.min(100, average))}%` }} />}
                    </span>
                    <span className="ins-dcmp-pct ins-num">{fmtPct(r.pct)}</span>
                  </span>
                </td>
                <td className="ins-end">
                  <DeltaBadge delta={average !== null ? Math.round(r.pct) - Math.round(average) : null} unit="pts" better="up" size="sm" />
                </td>
                <td className={`ins-end ins-num${r.late > 0 ? "" : " ins-muted"}`}>{fmtNum(r.late)}</td>
                <td className={`ins-end ins-num${r.absent > 0 ? "" : " ins-muted"}`}>{fmtNum(r.absent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <div className="ins-pager">
          <span className="ins-muted">
            {average !== null &&
              t("insights.dept.avgNote", { defaultValue: "The thin line on each bar is the average ({{pct}}).", pct: fmtPct(average) })}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setAll(!all)}>
            {all
              ? t("insights.dept.showLess", { defaultValue: "Show fewer" })
              : t("insights.dept.showAll", { defaultValue: "Show all {{count}} departments", count: rows.length })}
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Department × day heatmap (attendance %)
// ---------------------------------------------------------------------------

export function heatTone(p: number | null): string {
  if (p === null) return "is-none";
  if (p >= 90) return "is-h5";
  if (p >= 80) return "is-h4";
  if (p >= 65) return "is-h3";
  if (p >= 45) return "is-h2";
  return "is-h1";
}

export function DeptDayHeatmap({ heatmap, range }: { heatmap: InsightsHeatmap; range: InsightsRange }) {
  const { t } = useTranslation();
  const fmt = useDateFmt();
  if (heatmap.dates.length === 0 || heatmap.rows.length === 0) {
    return <PanelEmpty icon="calendar" title={t("insights.heat.empty", { defaultValue: "Pick a range of several days to see the heatmap" })} />;
  }
  const rq = rangeQuery(range);
  const cols = heatmap.dates.length;
  return (
    <div className="ins-heat-wrap">
      <div className="ins-heat" style={{ gridTemplateColumns: `minmax(160px, 220px) repeat(${cols}, minmax(14px, 1fr))` }}>
        <span />
        {heatmap.dates.map((d, i) => (
          <span key={d} className="ins-heat-date" title={fmt.short(d)}>
            {cols <= 31 || i % 2 === 0 ? fmt.dayMonth(d).split(" ")[0] : ""}
          </span>
        ))}
        {heatmap.rows.map((r) => (
          <div key={r.department_id} className="ins-heat-row" style={{ display: "contents" }}>
            <Link className="ins-heat-name" to={`/insights/departments/${r.department_id}${rq}`} title={r.name}>
              {r.name}
            </Link>
            {r.cells.map((c, i) => (
              <span
                key={i}
                className={`ins-heat-cell ${heatTone(c)}`}
                title={`${r.name} · ${fmt.short(heatmap.dates[i] ?? "")} · ${c === null ? t("insights.heat.noData", { defaultValue: "no data" }) : fmtPct(c)}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="ins-legend ins-heat-legend">
        <span>{t("insights.heat.low", { defaultValue: "Lower" })}</span>
        {["is-h1", "is-h2", "is-h3", "is-h4", "is-h5"].map((c) => (
          <i key={c} className={`ins-heat-cell ${c}`} />
        ))}
        <span>{t("insights.heat.high", { defaultValue: "Higher attendance" })}</span>
        <i className="ins-heat-cell is-none" />
        <span>{t("insights.heat.noData", { defaultValue: "no data" })}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status strip (one small square per day) + attention chips
// ---------------------------------------------------------------------------

export function StatusStrip({ strip, dates }: { strip: InsightsStatus[]; dates?: string[] }) {
  const label = useStatusLabel();
  return (
    <span className="ins-strip" role="img" aria-label={strip.map((s) => label(s)).join(", ")}>
      {strip.map((s, i) => (
        <i key={i} className={`ins-strip-cell is-${statusTone(s)}${s === "weekend" || s === "holiday" ? " is-off" : ""}${s === "no_record" ? " is-blank" : ""}`} title={`${dates?.[i] ? `${dates[i]} · ` : ""}${label(s)}`} />
      ))}
    </span>
  );
}

export function AttentionChips({ reasons }: { reasons: string[] }) {
  const { t } = useTranslation();
  if (reasons.length === 0) return null;
  const lbl: Record<string, string> = {
    late: t("insights.attention.late", { defaultValue: "Often late" }),
    absent: t("insights.attention.absent", { defaultValue: "Absences" }),
    never_seen: t("insights.attention.never_seen", { defaultValue: "Never seen" }),
    early: t("insights.attention.early", { defaultValue: "Leaves early" }),
  };
  const tone: Record<string, Tone> = { late: "warning", absent: "danger", never_seen: "neutral", early: "warning" };
  return (
    <span className="ins-attn">
      {reasons.map((r) => (
        <SoftPill key={r} tone={tone[r] ?? "neutral"}>
          {lbl[r] ?? r}
        </SoftPill>
      ))}
    </span>
  );
}

/** Section heading that states the question a chart answers. */
export function QuestionTitle({ question, answer }: { question: string; answer?: ReactNode }) {
  return (
    <span className="ins-q">
      <span className="ins-q-text">{question}</span>
      {answer && <span className="ins-q-answer">{answer}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Mini stats strip (small facts under a chart)
// ---------------------------------------------------------------------------

export interface MiniStat {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "accent" | "success" | "warning" | "danger" | "info" | "neutral";
}

export function MiniStats({ items }: { items: MiniStat[] }) {
  return (
    <dl className="ins-mini-stats">
      {items.map((it, i) => (
        <div key={i} className={`ins-mini-stat is-${it.tone ?? "neutral"}`}>
          <dt>{it.label}</dt>
          <dd>
            <span className="ins-mini-val">{it.value}</span>
            {it.sub && <span className="ins-mini-sub">{it.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
