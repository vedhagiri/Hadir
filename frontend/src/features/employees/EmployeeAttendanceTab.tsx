// Attendance tab of the employee profile (/employees/:id?tab=attendance)
// and the read-only EmployeeViewDrawer.
//
// Answers "how has this person's attendance been, and what happened on a
// given day?":
//   * a range segmented control (This month · Last month · 7 days ·
//     30 days · Custom) — URL-synced on the profile page (?range=&from=&to=)
//   * summary tiles for the range (attendance %, on time %, late / absent /
//     leave days, average arrival + hours)
//   * a month calendar of the range coloured by status; clicking a day
//     selects it (?day=)
//   * the selected day's full detail — the shared calendar DayDetailContent
//     (status hero, key facts, why-absent checklist, timeline, policy,
//     evidence) with prev / next day arrows
//   * a compact day-by-day list with All / Late / Absent / Leave chips;
//     long runs of empty days collapse into one row
//
// Data: GET /api/insights/employees/{id}?start&end (same builders as the
// Insights person page and the PDF — the tab never derives attendance
// itself) + GET /api/attendance/calendar/day/{id}/{date} for the selected
// day (via DayDetailContent).
//
// "Today" guard: the insights endpoint keeps reporting today as absent (so
// it stays identical to the PDF) even while the shift window is still open.
// The calendar cells / day list / tile note therefore show "Not in yet" for
// today when the shift hasn't started or is in progress (overnight shifts
// included). Display-only — no shared cache is written. The selected-day
// body gets "waiting" from the day API itself.
//
// Styling: ./employee-attendance.css (prefix ``pe-at-``) + the shared
// stat-tile / toolbar classes from ./employee-events.css (``pe-ev-``).

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { DatePicker } from "../../components/DatePicker";
import { EmptyPanel } from "../../components/ListPageUi";
import { SkeletonCards, SkeletonLine } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { DayDetailContent } from "../calendar/DayDetailDrawer";
import { TONE } from "../calendar/calendarUi";
import type { SummaryKey } from "../calendar/calendarUi";
import { useDayDetail } from "../calendar/hooks";
import { addDaysIso, tenantDayKey } from "../camera-logs/clUi";
import { useInsightsEmployee } from "../insights/hooks";
import { MAX_RANGE_DAYS } from "../insights/insightsUi";
import type { InsightsEmployee, InsightsEmployeeDay } from "../insights/types";

import "./employee-events.css";
import "./employee-attendance.css";

type Range = "month" | "lastmonth" | "7d" | "30d" | "custom";
const RANGES: Range[] = ["month", "lastmonth", "7d", "30d", "custom"];
const DEFAULT_RANGE: Range = "month";

/** What a day shows as in this tab. ``waiting`` = today, shift still open. */
type DisplayStatus =
  | "present"
  | "present_weekend"
  | "present_holiday"
  | "late"
  | "absent"
  | "leave"
  | "weekend"
  | "holiday"
  | "waiting"
  | "no_record"
  | "future";

type DayFilter = "all" | "late" | "absent" | "leave";

// ---------------------------------------------------------------------------
// State: URL-synced on the profile page, local in the drawer
// ---------------------------------------------------------------------------

type StateKey = "range" | "from" | "to" | "day";

function useTabState(syncUrl: boolean): {
  get: (k: StateKey) => string;
  patch: (next: Partial<Record<StateKey, string | null>>) => void;
} {
  const [params, setParams] = useSearchParams();
  const [local, setLocal] = useState<Partial<Record<StateKey, string>>>({});
  const get = (k: StateKey) => (syncUrl ? (params.get(k) ?? "") : (local[k] ?? ""));
  const patch = (next: Partial<Record<StateKey, string | null>>) => {
    const entries = Object.entries(next) as [StateKey, string | null][];
    if (syncUrl) {
      setParams(
        (cur) => {
          const p = new URLSearchParams(cur);
          for (const [k, v] of entries) {
            if (v === null || v === "") p.delete(k);
            else p.set(k, v);
          }
          return p;
        },
        { replace: true },
      );
    } else {
      setLocal((cur) => {
        const p = { ...cur };
        for (const [k, v] of entries) {
          if (v === null || v === "") delete p[k];
          else p[k] = v;
        }
        return p;
      });
    }
  };
  return { get, patch };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoParts(iso: string): [number, number, number] {
  return iso.split("-").map(Number) as [number, number, number];
}
function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
/** "07:32" / "07:32:10" / ISO datetime → minutes since midnight. */
function toMin(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.includes("T") ? (v.split("T")[1] ?? "") : v;
  const m = /(\d{1,2}):(\d{2})/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function hhmm(v: string | null | undefined): string {
  const m = toMin(v);
  if (m === null) return "—";
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
/** Minutes → "6h 47m" / "45m". */
function fmtMinutes(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || Number.isNaN(mins)) return "—";
  const total = Math.round(Math.abs(mins));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
}
function fmtHours(h: number | null | undefined): string {
  return h === null || h === undefined || Number.isNaN(h) ? "—" : fmtMinutes(h * 60);
}
/** "16:00–02:03" → [start, end] minutes; end +1440 when the shift wraps midnight. */
function parseWindow(w: string | null | undefined): [number, number] | null {
  if (!w) return null;
  const parts = w.split(/\s*[–—-]\s*/);
  const a = toMin(parts[0]);
  const b = toMin(parts[1]);
  if (a === null || b === null) return null;
  return [a, b <= a ? b + 1440 : b];
}
/** Minutes since midnight in the tenant timezone. */
function tenantNowMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
/** Shift still open for today: not started yet, or in progress (an
 *  overnight shift that started today is open until tomorrow). */
function shiftStillOpen(win: [number, number] | null, nowMin: number): boolean {
  if (!win) return false;
  return win[1] > 1440 || nowMin < win[1];
}

function useLocaleTag(): string {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("ar") ? "ar-OM" : "en-GB";
}

/** Re-render every minute so "today" + the shift-open guard stay fresh. */
function useMinuteTick(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function toneOf(s: DisplayStatus): SummaryKey | "neutral" {
  switch (s) {
    case "present":
    case "present_weekend":
    case "present_holiday":
      return "present";
    case "late":
    case "absent":
    case "leave":
    case "holiday":
    case "weekend":
      return s;
    default:
      return "neutral";
  }
}

const PILL: Record<DisplayStatus, string> = {
  present: "pill-success",
  present_weekend: "pill-success",
  present_holiday: "pill-success",
  late: "pill-warning",
  absent: "pill-danger",
  leave: "pill-info",
  weekend: "pill-neutral",
  holiday: "pill-accent",
  waiting: "pill-neutral",
  no_record: "pill-neutral",
  future: "pill-neutral",
};

function useStatusLabel(): (s: DisplayStatus) => string {
  const { t } = useTranslation();
  return (s) =>
    ({
      present: t("employees.attendance.status.present", { defaultValue: "Present" }),
      present_weekend: t("employees.attendance.status.present_weekend", { defaultValue: "Worked weekend" }),
      present_holiday: t("employees.attendance.status.present_holiday", { defaultValue: "Worked holiday" }),
      late: t("employees.attendance.status.late", { defaultValue: "Late" }),
      absent: t("employees.attendance.status.absent", { defaultValue: "Absent" }),
      leave: t("employees.attendance.status.leave", { defaultValue: "Leave" }),
      weekend: t("employees.attendance.status.weekend", { defaultValue: "Weekend" }),
      holiday: t("employees.attendance.status.holiday", { defaultValue: "Holiday" }),
      waiting: t("employees.attendance.status.waiting", { defaultValue: "Not in yet" }),
      no_record: t("employees.attendance.status.no_record", { defaultValue: "No record" }),
      future: t("employees.attendance.status.future", { defaultValue: "Future" }),
    })[s];
}

function StatusPill({ status }: { status: DisplayStatus }) {
  const label = useStatusLabel();
  return (
    <span className={`pill ${PILL[status]} pe-at-pill${status === "waiting" ? " is-waiting" : ""}`}>
      <span aria-hidden className="pill-dot" />
      {label(status)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function EmployeeAttendanceTab({ employeeId, syncUrl = false }: { employeeId: number; syncUrl?: boolean }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const tz = dt.timezone;
  const locale = useLocaleTag();
  const statusLabel = useStatusLabel();
  const { get, patch } = useTabState(syncUrl);
  const now = useMinuteTick();
  const todayKey = tenantDayKey(tz, now);
  const nowMin = tenantNowMinutes(tz, now);

  // ── Range ────────────────────────────────────────────────────────
  const rangeRaw = get("range") as Range;
  const range: Range = RANGES.includes(rangeRaw) ? rangeRaw : DEFAULT_RANGE;
  const fromRaw = get("from");
  const toRaw = get("to");
  const span = useMemo((): { from: string; to: string } => {
    const [y, m] = isoParts(todayKey);
    switch (range) {
      case "lastmonth": {
        const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
        const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
        return { from: first, to: last };
      }
      case "7d":
        return { from: addDaysIso(todayKey, -6), to: todayKey };
      case "30d":
        return { from: addDaysIso(todayKey, -29), to: todayKey };
      case "custom": {
        let f = ISO_RE.test(fromRaw) ? fromRaw : todayKey;
        let tt = ISO_RE.test(toRaw) ? toRaw : f;
        if (tt > todayKey) tt = todayKey;
        if (f > tt) f = tt;
        if (daysInclusive(f, tt) > MAX_RANGE_DAYS) f = addDaysIso(tt, -(MAX_RANGE_DAYS - 1));
        return { from: f, to: tt };
      }
      default:
        return { from: `${todayKey.slice(0, 7)}-01`, to: todayKey };
    }
  }, [range, fromRaw, toRaw, todayKey]);

  // ── Data ─────────────────────────────────────────────────────────
  const q = useInsightsEmployee(employeeId, { start: span.from, end: span.to });
  const data: InsightsEmployee | undefined = q.data && q.data.profile.id === employeeId ? q.data : undefined;
  const stale = !!data && (data.period.start !== span.from || data.period.end !== span.to);
  const notFound = !data && q.isError && (q.error as { status?: number }).status === 404;
  const isFirstLoad = !data && q.isLoading;

  const days = useMemo(() => (data ? data.days.filter((d) => !d.before_joining) : []), [data]);
  const hiddenBeforeJoining = data ? data.days.length - days.length : 0;
  const win = parseWindow(data?.policy?.window);

  const displayOf = useMemo(() => {
    return (d: InsightsEmployeeDay): DisplayStatus => {
      if (d.date > todayKey) return "future";
      if (
        d.date === todayKey &&
        !d.in_time &&
        (d.status === "waiting" || ((d.status === "absent" || d.status === "no_record") && shiftStillOpen(win, nowMin)))
      )
        return "waiting";
      if (d.status === "present" && d.in_time && d.is_holiday) return "present_holiday";
      if (d.status === "present" && d.in_time && d.is_weekend) return "present_weekend";
      switch (d.status) {
        case "present":
        case "present_weekend":
        case "present_holiday":
        case "late":
        case "absent":
        case "leave":
        case "weekend":
        case "holiday":
        case "waiting":
          return d.status as DisplayStatus;
        default:
          return "no_record";
      }
    };
  }, [todayKey, win, nowMin]);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const todayWaiting = (() => {
    const d = byDate.get(todayKey);
    return !!d && displayOf(d) === "waiting";
  })();
  const todayCountedAbsent = todayWaiting && byDate.get(todayKey)?.status === "absent";

  // ── Selected day ─────────────────────────────────────────────────
  const dayRaw = get("day");
  const maxDay = span.to < todayKey ? span.to : todayKey;
  const defaultDay = useMemo(() => {
    if (todayKey >= span.from && todayKey <= span.to) return todayKey;
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i]!;
      if (d.date <= maxDay && d.status !== "weekend" && d.status !== "holiday") return d.date;
    }
    return maxDay;
  }, [todayKey, span.from, span.to, days, maxDay]);
  const selected = ISO_RE.test(dayRaw) && dayRaw >= span.from && dayRaw <= maxDay ? dayRaw : defaultDay;
  const selectDay = (iso: string) => patch({ day: iso === defaultDay ? null : iso });
  const selectedRow = byDate.get(selected);
  const selectedStatus: DisplayStatus | null = selectedRow ? displayOf(selectedRow) : null;

  // ── Labels ───────────────────────────────────────────────────────
  const rangeLabel = (r: Range): string =>
    ({
      month: t("employees.attendance.range.month", { defaultValue: "This month" }),
      lastmonth: t("employees.attendance.range.lastMonth", { defaultValue: "Last month" }),
      "7d": t("employees.attendance.range.last7", { defaultValue: "7 days" }),
      "30d": t("employees.attendance.range.last30", { defaultValue: "30 days" }),
      custom: t("employees.attendance.range.custom", { defaultValue: "Custom" }),
    })[r];
  const fmtDay = (iso: string, o: Intl.DateTimeFormatOptions) => {
    const [y, m, d] = isoParts(iso);
    return new Date(y, m - 1, d).toLocaleDateString(locale, o);
  };
  const periodText =
    span.from === span.to
      ? fmtDay(span.from, { day: "numeric", month: "short", year: "numeric" })
      : `${fmtDay(span.from, { day: "numeric", month: "short" })} – ${fmtDay(span.to, { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <div className="pe-ev pe-at">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <div className="pe-ev-toolbar">
        <div className="seg pe-ev-seg" role="group" aria-label={t("employees.attendance.range.label", { defaultValue: "Date range" })}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              className={`seg-btn${range === r ? " active" : ""}`}
              onClick={() =>
                r === "custom"
                  ? patch({ range: "custom", from: span.from, to: span.to, day: null })
                  : patch({ range: r === DEFAULT_RANGE ? null : r, from: null, to: null, day: null })
              }
            >
              {rangeLabel(r)}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <div className="pe-ev-custom">
            <DatePicker
              value={span.from}
              max={todayKey}
              onChange={(v) => {
                if (!v) return;
                const to = span.to < v ? v : daysInclusive(v, span.to) > MAX_RANGE_DAYS ? addDaysIso(v, MAX_RANGE_DAYS - 1) : span.to;
                patch({ from: v, to: to > todayKey ? todayKey : to, day: null });
              }}
              ariaLabel={t("employees.attendance.fromLabel", { defaultValue: "From date" })}
              triggerStyle={{ height: "var(--control-h)" }}
            />
            <span className="pe-ev-dim" aria-hidden>
              →
            </span>
            <DatePicker
              value={span.to}
              min={span.from}
              max={todayKey}
              onChange={(v) => v && patch({ to: v, day: null })}
              ariaLabel={t("employees.attendance.toLabel", { defaultValue: "To date" })}
              triggerStyle={{ height: "var(--control-h)" }}
            />
          </div>
        )}
        <span className="pe-ev-toolbar-end">
          {q.isFetching && !isFirstLoad && <span className="pe-ev-spin" aria-hidden />}
          <span className="pe-at-period">{periodText}</span>
        </span>
      </div>

      {notFound ? (
        <EmptyPanel
          tone="neutral"
          icon={<Icon name="shield" size={28} />}
          title={t("employees.attendance.notAvailableTitle", { defaultValue: "Attendance summary not available" })}
          body={t("employees.attendance.notAvailableBody", {
            defaultValue: "This person's attendance isn't available to your role, or they are outside your scope.",
          })}
        />
      ) : q.isError && !data ? (
        <EmptyPanel
          tone="danger"
          icon={<Icon name="info" size={28} />}
          title={t("employees.attendance.loadFailedTitle", { defaultValue: "Couldn't load attendance" })}
          body={t("employees.attendance.loadFailedBody", { defaultValue: "The request failed. Check your connection and try again." })}
          actions={
            <button type="button" className="btn" onClick={() => void q.refetch()}>
              <Icon name="refresh" size={12} />
              {t("common.retry", { defaultValue: "Retry" })}
            </button>
          }
        />
      ) : (
        <>
          {/* ── Summary tiles ─────────────────────────────────────── */}
          {isFirstLoad || !data ? (
            <div className="pe-ev-stats-sk">
              <SkeletonCards count={6} minWidth={150} />
            </div>
          ) : (
            <Summary data={data} stale={stale} todayCountedAbsent={todayCountedAbsent} />
          )}

          {/* ── Calendar + selected day ───────────────────────────── */}
          <div className="pe-at-main" style={{ opacity: stale ? 0.6 : 1 }}>
            <div className="card pe-ev-card pe-at-cal-card">
              <div className="pe-ev-card-head">
                <h3 className="pe-ev-card-title">{t("employees.attendance.calendarTitle", { defaultValue: "Calendar" })}</h3>
                <span className="pe-ev-count">{t("employees.attendance.calendarHint", { defaultValue: "Click a day to see it" })}</span>
              </div>
              <MonthGrids
                span={span}
                todayKey={todayKey}
                byDate={byDate}
                loading={isFirstLoad}
                selected={selected}
                displayOf={displayOf}
                onSelect={selectDay}
              />
            </div>

            <SelectedDay
              employeeId={employeeId}
              iso={selected}
              status={selectedStatus}
              row={selectedRow ?? null}
              canPrev={selected > span.from}
              canNext={selected < maxDay}
              onPrev={() => selectDay(addDaysIso(selected, -1))}
              onNext={() => selectDay(addDaysIso(selected, 1))}
              isToday={selected === todayKey}
              todayKey={todayKey}
              nowMin={nowMin}
              win={win}
              fmtDay={fmtDay}
            />
          </div>

          {/* ── Day by day ────────────────────────────────────────── */}
          <DayList
            days={days}
            loading={isFirstLoad}
            selected={selected}
            displayOf={displayOf}
            statusLabel={statusLabel}
            onSelect={selectDay}
            fmtDay={fmtDay}
            hiddenBeforeJoining={hiddenBeforeJoining}
            joiningDate={data?.profile.joining_date ?? null}
            win={win}
            nowMin={nowMin}
            todayKey={todayKey}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary tiles
// ---------------------------------------------------------------------------

function Summary({ data, stale, todayCountedAbsent }: { data: InsightsEmployee; stale: boolean; todayCountedAbsent: boolean }) {
  const { t } = useTranslation();
  const k = data.kpis;
  const hl = data.highlights;
  const noWork = k.working_days === 0;
  const pct = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "—" : `${Math.round(n)}%`);
  return (
    <div className="pe-ev-stats pe-at-stats" style={{ opacity: stale ? 0.6 : 1 }}>
      <Stat
        tone="success"
        icon={
          <>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4" />
          </>
        }
        label={t("employees.attendance.stats.attendance", { defaultValue: "Attendance" })}
        value={noWork ? "—" : pct(k.attendance_pct)}
        sub={
          noWork
            ? t("employees.attendance.stats.noWorkingDays", { defaultValue: "No working days in range" })
            : t("employees.attendance.stats.presentOf", {
                present: k.present_days,
                working: k.working_days,
                defaultValue: "{{present}} of {{working}} working days",
              })
        }
      />
      <Stat
        tone="info"
        icon={
          <>
            <circle cx="12" cy="13" r="8" />
            <path d="M12 9v4l2.5 2M9 2h6" />
          </>
        }
        label={t("employees.attendance.stats.onTime", { defaultValue: "On time" })}
        value={k.present_days === 0 ? "—" : pct(k.punctuality_pct)}
        sub={
          k.present_days === 0
            ? t("employees.attendance.stats.noArrivals", { defaultValue: "No arrivals in range" })
            : t("employees.attendance.stats.onTimeSub", { defaultValue: "Within grace period" })
        }
      />
      <Stat
        tone="warning"
        icon={
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 3" />
          </>
        }
        label={t("employees.attendance.stats.late", { defaultValue: "Late days" })}
        value={String(k.late_days)}
        sub={
          k.late_days > 0 && hl?.avg_late_minutes
            ? t("employees.attendance.stats.avgLate", { value: fmtMinutes(hl.avg_late_minutes), defaultValue: "Late by {{value}} on average" })
            : t("employees.attendance.stats.noLate", { defaultValue: "No late arrivals" })
        }
      />
      <Stat
        tone="danger"
        icon={
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M9 9l6 6M15 9l-6 6" />
          </>
        }
        label={t("employees.attendance.stats.absent", { defaultValue: "Absent days" })}
        value={String(k.absent_days)}
        sub={
          todayCountedAbsent
            ? t("employees.attendance.stats.absentInclToday", { defaultValue: "Incl. today (shift open)" })
            : t("employees.attendance.stats.absentSub", { defaultValue: "No detection, no leave" })
        }
      />
      <Stat
        tone="neutral"
        icon={
          <>
            <path d="M4 20c2-6 6-9 8-9s6 3 8 9" />
            <circle cx="12" cy="6" r="3" />
          </>
        }
        label={t("employees.attendance.stats.leave", { defaultValue: "Leave days" })}
        value={String(k.leave_days)}
        sub={t("employees.attendance.stats.leaveSub", { defaultValue: "Approved leave" })}
      />
      <Stat
        tone="neutral"
        icon={<path d="M3 12h4l3-8 4 16 3-8h4" />}
        label={t("employees.attendance.stats.avgArrival", { defaultValue: "Avg arrival" })}
        value={k.avg_in ? hhmm(k.avg_in) : "—"}
        small
        sub={
          k.avg_hours !== null
            ? t("employees.attendance.stats.avgHours", { value: fmtHours(k.avg_hours), defaultValue: "{{value}} at work on average" })
            : t("employees.attendance.stats.noArrivals", { defaultValue: "No arrivals in range" })
        }
      />
    </div>
  );
}

function Stat({
  tone,
  icon,
  label,
  value,
  sub,
  small = false,
}: {
  tone: "info" | "success" | "warning" | "danger" | "neutral";
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  small?: boolean;
}) {
  return (
    <div className={`mg-stat pe-ev-stat tone-${tone}`} title={sub}>
      <span className="mg-stat-top">
        <span className="mg-stat-label">{label}</span>
        <span className="mg-stat-icon pe-ev-stat-icon" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </span>
      </span>
      <span className={`mg-stat-value${small ? " pe-ev-stat-value-sm" : ""}`}>
        <bdi>{value}</bdi>
      </span>
      <span className="mg-stat-sub pe-ev-stat-sub">{sub}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month calendar of the range
// ---------------------------------------------------------------------------

function MonthGrids({
  span,
  todayKey,
  byDate,
  loading,
  selected,
  displayOf,
  onSelect,
}: {
  span: { from: string; to: string };
  todayKey: string;
  byDate: Map<string, InsightsEmployeeDay>;
  loading: boolean;
  selected: string;
  displayOf: (d: InsightsEmployeeDay) => DisplayStatus;
  onSelect: (iso: string) => void;
}) {
  const locale = useLocaleTag();
  const statusLabel = useStatusLabel();
  const months = useMemo(() => {
    const out: string[] = [];
    let m = span.from.slice(0, 7);
    while (m <= span.to.slice(0, 7)) {
      out.push(m);
      const [y, mo] = isoParts(`${m}-01`);
      m = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
    }
    return out;
  }, [span.from, span.to]);
  // Week starts on Sunday (matches the Attendance Calendar). 2026-10-04 is a Sunday.
  const dows = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 4 + i).toLocaleDateString(locale, { weekday: "narrow" })),
    [locale],
  );
  const compact = months.length > 1;

  return (
    <div className="pe-at-cal-body">
      <div className={`pe-at-months${compact ? " is-compact" : ""}`}>
        {months.map((m) => {
          const [y, mo] = isoParts(`${m}-01`);
          const first = new Date(y, mo - 1, 1);
          const lead = first.getDay();
          const dim = new Date(y, mo, 0).getDate();
          const title = first.toLocaleDateString(locale, { month: "long", year: "numeric" });
          return (
            <div key={m} className="pe-at-month">
              <div className="pe-at-month-title">{title}</div>
              <div className="pe-at-cal" role="group" aria-label={title}>
                {dows.map((d, i) => (
                  <div key={i} className="pe-at-dow" aria-hidden>
                    {d}
                  </div>
                ))}
                {Array.from({ length: lead }).map((_, i) => (
                  <div key={`l${i}`} aria-hidden />
                ))}
                {Array.from({ length: dim }).map((_, i) => {
                  const iso = `${m}-${String(i + 1).padStart(2, "0")}`;
                  const inRange = iso >= span.from && iso <= span.to;
                  const future = iso > todayKey;
                  const row = byDate.get(iso);
                  if (!inRange || future || (!row && !loading)) {
                    return (
                      <div key={iso} className={`pe-at-cell is-out${future && inRange ? " is-future" : ""}`} aria-hidden>
                        <span className="d">{i + 1}</span>
                      </div>
                    );
                  }
                  if (!row) {
                    return <div key={iso} className="pe-at-cell is-loading" aria-hidden><span className="d">{i + 1}</span></div>;
                  }
                  const st = displayOf(row);
                  const tone = toneOf(st);
                  const tn = tone !== "neutral" && tone !== "weekend" ? TONE[tone] : null;
                  const quiet = (st === "weekend" || st === "holiday") && !row.in_time;
                  const cls = [
                    "pe-at-cell",
                    st === "weekend" ? "is-off" : "",
                    st === "no_record" ? "is-norec" : "",
                    st === "waiting" ? "is-waiting" : "",
                    iso === todayKey ? "is-today" : "",
                    iso === selected ? "is-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const style = (tn ? { "--c-soft": tn.soft, "--c-fg": tn.fg, "--c-dot": tn.dot } : {}) as CSSProperties;
                  const tip = [
                    fmtLong(iso, locale),
                    statusLabel(st),
                    row.in_time ? `${hhmm(row.in_time)} – ${hhmm(row.out_time)}` : "",
                    row.leave_name ?? "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <button
                      key={iso}
                      type="button"
                      className={cls}
                      style={style}
                      title={tip}
                      aria-label={tip}
                      aria-pressed={iso === selected}
                      onClick={() => onSelect(iso)}
                    >
                      <span className="d">{i + 1}</span>
                      {!compact && !quiet && row.in_time && <span className="m">{hhmm(row.in_time)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="pe-at-legend">
        {(["present", "late", "absent", "leave", "holiday"] as const).map((k) => (
          <span key={k}>
            <i style={{ background: TONE[k].soft, boxShadow: `inset 0 0 0 1px ${TONE[k].dot}` }} />
            {statusLabel(k)}
          </span>
        ))}
        <span>
          <i className="pe-at-legend-off" />
          {statusLabel("weekend")}
        </span>
        <span>
          <i className="pe-at-legend-norec" />
          {statusLabel("no_record")}
        </span>
      </div>
    </div>
  );
}

function fmtLong(iso: string, locale: string): string {
  const [y, m, d] = isoParts(iso);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
}

// ---------------------------------------------------------------------------
// Selected day — header with prev / next + the shared day-detail body
// ---------------------------------------------------------------------------

function SelectedDay({
  employeeId,
  iso,
  status: statusIn,
  row,
  canPrev,
  canNext,
  onPrev,
  onNext,
  isToday,
  todayKey,
  nowMin,
  win,
  fmtDay,
}: {
  employeeId: number;
  iso: string;
  status: DisplayStatus | null;
  row: InsightsEmployeeDay | null;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  isToday: boolean;
  todayKey: string;
  nowMin: number;
  win: [number, number] | null;
  fmtDay: (iso: string, o: Intl.DateTimeFormatOptions) => string;
}) {
  const { t } = useTranslation();
  const waitingText = useWaitingNoteText();
  // Read-only peek at the same day record DayDetailContent loads (shared
  // query key, no writes): when the day API says "waiting", prefer it.
  const dayQ = useDayDetail(employeeId, iso);
  const status = dayQ.data?.status === "waiting" ? "waiting" : statusIn;
  const waitingNote = status === "waiting" ? waitingText(win, nowMin) : null;
  return (
    <section className="card pe-ev-card pe-at-day" aria-label={fmtDay(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}>
      <div className="pe-ev-card-head pe-at-day-head">
        <div className="pe-at-daynav">
          <button type="button" className="pe-at-navbtn" onClick={onPrev} disabled={!canPrev} aria-label={t("employees.attendance.prevDay", { defaultValue: "Previous day" })}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <button type="button" className="pe-at-navbtn" onClick={onNext} disabled={!canNext} aria-label={t("employees.attendance.nextDay", { defaultValue: "Next day" })}>
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
        <h3 className="pe-ev-card-title pe-at-day-title">
          <bdi>{fmtDay(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</bdi>
          {isToday && <span className="pe-at-today">{t("employees.attendance.today", { defaultValue: "Today" })}</span>}
        </h3>
        {waitingNote && <span className="pe-at-waitnote">{waitingNote}</span>}
        {status && status !== "future" && <StatusPill status={status} />}
      </div>
      <div className="pe-at-day-body">
        {row || iso <= todayKey ? (
          <DayDetailContent employeeId={employeeId} isoDate={iso} />
        ) : null}
      </div>
    </section>
  );
}

/** "Shift starts at 16:00" / "Shift in progress · ends 02:03" for a
 *  today-waiting day, from the policy window (tenant clock). */
function useWaitingNoteText(): (win: [number, number] | null, nowMin: number) => string | null {
  const { t } = useTranslation();
  return (win, nowMin) => {
    if (!win) return null;
    const clockOf = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return nowMin < win[0]
      ? t("employees.attendance.waiting.startsAt", { time: clockOf(win[0]), defaultValue: "Shift starts at {{time}}" })
      : t("employees.attendance.waiting.inProgress", { time: clockOf(win[1]), defaultValue: "Shift in progress · ends {{time}}" });
  };
}

// ---------------------------------------------------------------------------
// Day-by-day list
// ---------------------------------------------------------------------------

function DayList({
  days,
  loading,
  selected,
  displayOf,
  statusLabel,
  onSelect,
  fmtDay,
  hiddenBeforeJoining,
  joiningDate,
  win,
  nowMin,
  todayKey,
}: {
  days: InsightsEmployeeDay[];
  loading: boolean;
  selected: string;
  displayOf: (d: InsightsEmployeeDay) => DisplayStatus;
  statusLabel: (s: DisplayStatus) => string;
  onSelect: (iso: string) => void;
  fmtDay: (iso: string, o: Intl.DateTimeFormatOptions) => string;
  hiddenBeforeJoining: number;
  joiningDate: string | null;
  win: [number, number] | null;
  nowMin: number;
  todayKey: string;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<DayFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const waitingNote = useWaitingNoteText()(win, nowMin);

  const match: Record<DayFilter, (d: InsightsEmployeeDay) => boolean> = {
    all: (d) => d.date <= todayKey,
    late: (d) => d.status === "late" || (d.late_minutes ?? 0) > 0,
    absent: (d) => displayOf(d) === "absent",
    leave: (d) => d.status === "leave",
  };
  const counts = (Object.keys(match) as DayFilter[]).reduce(
    (acc, k) => ({ ...acc, [k]: days.filter(match[k]).length }),
    {} as Record<DayFilter, number>,
  );
  const active: DayFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
  // Newest first.
  const rows = days.filter(match[active]).slice().reverse();

  const isQuiet = (d: InsightsEmployeeDay) => {
    const s = displayOf(d);
    return !d.in_time && (s === "no_record" || s === "weekend" || s === "holiday");
  };
  type Block = { kind: "day"; d: InsightsEmployeeDay } | { kind: "run"; key: string; days: InsightsEmployeeDay[] };
  const blocks: Block[] = [];
  if (active === "all") {
    let run: InsightsEmployeeDay[] = [];
    const flush = () => {
      if (run.length >= 3 && !expanded.has(run[0]!.date) && !run.some((d) => d.date === selected))
        blocks.push({ kind: "run", key: run[0]!.date, days: run });
      else for (const d of run) blocks.push({ kind: "day", d });
      run = [];
    };
    for (const d of rows) {
      if (isQuiet(d)) run.push(d);
      else {
        flush();
        blocks.push({ kind: "day", d });
      }
    }
    flush();
  } else {
    for (const d of rows) blocks.push({ kind: "day", d });
  }

  const chips: Array<[DayFilter, string]> = [
    ["all", t("employees.attendance.filter.all", { defaultValue: "All" })],
    ["late", t("employees.attendance.filter.late", { defaultValue: "Late" })],
    ["absent", t("employees.attendance.filter.absent", { defaultValue: "Absent" })],
    ["leave", t("employees.attendance.filter.leave", { defaultValue: "Leave" })],
  ];
  const shortDate = (iso: string) => fmtDay(iso, { day: "numeric", month: "short" });

  return (
    <div className="card pe-ev-card pe-at-list-card">
      <div className="pe-ev-card-head pe-at-list-head">
        <div className="pe-at-list-titles">
          <h3 className="pe-ev-card-title">{t("employees.attendance.listTitle", { defaultValue: "Day by day" })}</h3>
          <span className="pe-ev-count">
            {t("employees.attendance.listSub", { defaultValue: "In / out = first and last camera sighting" })}
            {hiddenBeforeJoining > 0 && joiningDate && (
              <>
                {" · "}
                {t("employees.attendance.beforeJoining", {
                  count: hiddenBeforeJoining,
                  date: fmtDay(joiningDate, { day: "numeric", month: "short", year: "numeric" }),
                  defaultValue: "{{count}} days before joining ({{date}}) not shown",
                })}
              </>
            )}
          </span>
        </div>
        <div className="pe-at-chips" role="group" aria-label={t("employees.attendance.filter.label", { defaultValue: "Show days" })}>
          {chips.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`pe-at-chip is-${k}${active === k ? " is-active" : ""}`}
              aria-pressed={active === k}
              disabled={loading || (k !== "all" && counts[k] === 0)}
              onClick={() => setFilter(k)}
            >
              {label}
              <span className="pe-at-chip-n">{loading ? "·" : counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="pe-at-sk" role="status" aria-label={t("employees.attendance.loading", { defaultValue: "Loading attendance" })}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="pe-at-sk-row" style={{ opacity: Math.max(0.25, 1 - i * 0.14) }}>
              <SkeletonLine width={110} />
              <SkeletonLine width={80} height={22} radius={999} />
              <SkeletonLine width={48} />
              <SkeletonLine width={48} />
              <SkeletonLine width={60} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyPanel
          tone="neutral"
          icon={<Icon name="calendar" size={28} />}
          title={t("employees.attendance.emptyTitle", { defaultValue: "No days in this range" })}
          body={
            hiddenBeforeJoining > 0
              ? t("employees.attendance.emptyBeforeJoining", { defaultValue: "This range is before the person's joining date. Pick a later range." })
              : t("employees.attendance.emptyBody", { defaultValue: "Pick a different range to see attendance." })
          }
        />
      ) : (
        <div className="pe-at-table" role="table" aria-label={t("employees.attendance.listTitle", { defaultValue: "Day by day" })}>
          <div className="pe-at-tr pe-at-th" role="row">
            <span role="columnheader">{t("employees.attendance.col.date", { defaultValue: "Date" })}</span>
            <span role="columnheader">{t("employees.attendance.col.status", { defaultValue: "Status" })}</span>
            <span role="columnheader" className="pe-at-num">{t("employees.attendance.col.in", { defaultValue: "In" })}</span>
            <span role="columnheader" className="pe-at-num">{t("employees.attendance.col.out", { defaultValue: "Out" })}</span>
            <span role="columnheader" className="pe-at-num pe-at-c-hours">{t("employees.attendance.col.hours", { defaultValue: "Hours" })}</span>
            <span role="columnheader" className="pe-at-num pe-at-c-late">{t("employees.attendance.col.lateBy", { defaultValue: "Late by" })}</span>
            <span role="columnheader" className="pe-at-num pe-at-c-ot">{t("employees.attendance.col.ot", { defaultValue: "Overtime" })}</span>
          </div>
          {blocks.map((b) => {
            if (b.kind === "run") {
              const noRec = b.days.filter((d) => displayOf(d) === "no_record").length;
              const off = b.days.length - noRec;
              const parts = [
                noRec ? t("employees.attendance.run.noRecord", { count: noRec, defaultValue: "{{count}} no record" }) : "",
                off ? t("employees.attendance.run.off", { count: off, defaultValue: "{{count}} weekend / holiday" }) : "",
              ]
                .filter(Boolean)
                .join(" · ");
              const last = b.days[0]!.date;
              const first = b.days[b.days.length - 1]!.date;
              return (
                <div key={`run-${b.key}`} role="row" className="pe-at-run">
                  <button
                    type="button"
                    role="cell"
                    className="pe-at-run-btn"
                    onClick={() => setExpanded((prev) => new Set(prev).add(b.key))}
                    aria-label={t("employees.attendance.run.expand", { defaultValue: "Show these days" })}
                  >
                    <Icon name="chevronDown" size={12} />
                    <b className="pe-at-tnum">
                      <bdi>
                        {shortDate(first)} – {shortDate(last)}
                      </bdi>
                    </b>
                    <span>{t("employees.attendance.run.summary", { count: b.days.length, defaultValue: "{{count}} days with nothing recorded" })}</span>
                    <span className="pe-ev-dim">({parts})</span>
                  </button>
                </div>
              );
            }
            const d = b.d;
            const st = displayOf(d);
            const isLate = (d.late_minutes ?? 0) > 0;
            const flags = (d.flags ?? []).map((f) => String(f).split(/[\s:]/)[0]?.toLowerCase());
            const tone = toneOf(st);
            const style = (tone !== "neutral" ? { "--row-dot": TONE[tone].dot } : {}) as CSSProperties;
            const dateTxt = fmtDay(d.date, { weekday: "short", day: "numeric", month: "short" });
            const quiet = isQuiet(d);
            return (
              <div key={d.date} role="row" className="pe-at-row-wrap">
                <button
                  type="button"
                  className={`pe-at-tr pe-at-row${d.date === selected ? " is-selected" : ""}${quiet ? " is-quiet" : ""}`}
                  style={style}
                  aria-pressed={d.date === selected}
                  aria-label={`${dateTxt} · ${statusLabel(st)}`}
                  onClick={() => onSelect(d.date)}
                >
                  <span role="cell" className="pe-at-date pe-at-tnum">
                    <i aria-hidden className="pe-at-dot" />
                    <bdi>{dateTxt}</bdi>
                    {d.date === todayKey && <span className="pe-at-today">{t("employees.attendance.today", { defaultValue: "Today" })}</span>}
                  </span>
                  <span role="cell" className="pe-at-status">
                    {quiet ? <span className="pe-ev-dim">{statusLabel(st)}</span> : <StatusPill status={st} />}
                    {st === "waiting" && waitingNote && <span className="pe-at-note">{waitingNote}</span>}
                    {st === "leave" && d.leave_name && <span className="pe-at-note">{d.leave_name}</span>}
                    {flags.includes("early") && <span className="pe-at-flag">{t("employees.attendance.flag.early", { defaultValue: "Early out" })}</span>}
                    {flags.includes("short") && <span className="pe-at-flag">{t("employees.attendance.flag.short", { defaultValue: "Short hours" })}</span>}
                  </span>
                  <span role="cell" className={`pe-at-num pe-at-tnum${d.in_time ? "" : " pe-ev-dim"}${isLate ? " is-late" : ""}`}>{hhmm(d.in_time)}</span>
                  <span role="cell" className={`pe-at-num pe-at-tnum${d.out_time ? "" : " pe-ev-dim"}`}>{hhmm(d.out_time)}</span>
                  <span role="cell" className={`pe-at-num pe-at-tnum pe-at-c-hours${d.hours === null ? " pe-ev-dim" : ""}`}>{fmtHours(d.hours)}</span>
                  <span role="cell" className={`pe-at-num pe-at-tnum pe-at-c-late${isLate ? " is-late" : " pe-ev-dim"}`}>{isLate ? fmtMinutes(d.late_minutes) : "—"}</span>
                  <span role="cell" className={`pe-at-num pe-at-tnum pe-at-c-ot${d.ot_minutes > 0 ? " is-ot" : " pe-ev-dim"}`}>{d.ot_minutes > 0 ? fmtMinutes(d.ot_minutes) : "—"}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
