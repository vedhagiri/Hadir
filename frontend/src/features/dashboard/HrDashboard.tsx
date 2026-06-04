// HR dashboard — composed against existing endpoints, no new backend
// work. The reference at docs/scripts/issues-screenshots/11-HR_Dashboard.png
// inspires the layout; visualisations use only what /api/attendance,
// /api/departments, /api/policies, /api/requests/inbox/*, and
// /api/report-schedules already return.
//
// 7-day series is built client-side via parallel useQueries — no
// /api/attendance/series endpoint yet. Fine for ≤ a few hundred
// employees; once the aggregate endpoint lands we swap the source.

import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { api } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { LateBadge } from "../../components/LateBadge";
import { useConfidentialDownload } from "../../components/useConfidentialDownload";
import { usePolicies } from "../../policies/hooks";
import { useInboxPending, useInboxSummary } from "../../requests/hooks";
import {
  useReportSchedules,
  useRunNow,
} from "../../scheduled-reports/hooks";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import type {
  AttendanceItem,
  AttendanceListResponse,
} from "../attendance/types";
import { formatMinutes } from "../attendance/timeFormat";
import { useDepartments } from "../departments/hooks";
import { BarChart } from "./charts/BarChart";
import { Donut } from "./charts/Donut";
import { LineChart, Sparkline } from "./charts/LineChart";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDaysBefore(anchor: string, n: number): string {
  // ``anchor`` is a YYYY-MM-DD picked by the operator; n=0 returns
  // the anchor unchanged. Doing the math via Date keeps month-rollover
  // correct (e.g. anchor=2026-05-02 minus 6 → 2026-04-26).
  const d = new Date(`${anchor}T00:00:00`);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "2-digit",
  });
}

type Bucket = "present" | "late" | "absent" | "onLeave" | "off" | "pending";

function classify(it: AttendanceItem): Bucket {
  if (it.is_holiday && !it.in_time) return "off";
  if (it.is_weekend && !it.in_time) return "off";
  if (it.pending) return "pending";
  if (it.absent && it.leave_type_id !== null) return "onLeave";
  if (!it.in_time) return "absent";
  if (it.late) return "late";
  return "present";
}

interface DaySummary {
  date: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  working: number;
  /** Tenant-wide day classification, derived from item flags. */
  kind: "working" | "weekend" | "holiday";
  /** Holiday name when kind === "holiday", else null. */
  holidayName: string | null;
  /** Check-ins on a non-working day → counted as overtime. */
  otCheckIns: number;
}

function dayKindFor(items: AttendanceItem[]): {
  kind: "working" | "weekend" | "holiday";
  holidayName: string | null;
} {
  // ``is_weekend`` and ``is_holiday`` are tenant-wide for the date —
  // backend computes one value per request — so we sample the first
  // row. (Cross-tenant: the request itself is already tenant-scoped.)
  const sample = items[0];
  if (!sample) return { kind: "working", holidayName: null };
  if (sample.is_holiday) {
    return { kind: "holiday", holidayName: sample.holiday_name ?? null };
  }
  if (sample.is_weekend) return { kind: "weekend", holidayName: null };
  return { kind: "working", holidayName: null };
}

function summarise(date: string, items: AttendanceItem[]): DaySummary {
  const { kind, holidayName } = dayKindFor(items);

  // Non-working days: every check-in is OT, no working population.
  // Showing 100% Present on a weekend (because one OT employee
  // came in) was the load-bearing bug behind this branch.
  if (kind !== "working") {
    const otCheckIns = items.filter((it) => Boolean(it.in_time)).length;
    return {
      date,
      present: 0,
      late: 0,
      absent: 0,
      onLeave: 0,
      working: 0,
      kind,
      holidayName,
      otCheckIns,
    };
  }

  let present = 0,
    late = 0,
    absent = 0,
    onLeave = 0,
    working = 0;
  for (const it of items) {
    const b = classify(it);
    if (b === "off" || b === "pending") continue;
    working += 1;
    if (b === "present") present += 1;
    else if (b === "late") late += 1;
    else if (b === "absent") absent += 1;
    else if (b === "onLeave") onLeave += 1;
  }
  return {
    date,
    present,
    late,
    absent,
    onLeave,
    working,
    kind,
    holidayName,
    otCheckIns: 0,
  };
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.length >= 5 ? iso.slice(0, 5) : iso;
}

// HR dashboard reuses the shared ``formatMinutes`` helper from
// attendance/timeFormat for consistent ``8h 45m`` rendering across pages.

// ---------------------------------------------------------------------------
// 7-day attendance series via parallel queries. Yes, that's 7 round
// trips — fine for ≤ a few hundred employees. Swap to a single
// /api/attendance/series call when the aggregate endpoint lands.
// ---------------------------------------------------------------------------

const SERIES_DAYS = 7;

function useAttendanceSeries(anchor: string): {
  isLoading: boolean;
  series: DaySummary[];
  selectedItems: AttendanceItem[];
} {
  const dates = useMemo(
    () =>
      Array.from({ length: SERIES_DAYS }, (_, i) =>
        isoDaysBefore(anchor, SERIES_DAYS - 1 - i),
      ),
    [anchor],
  );
  const queries = useQueries({
    queries: dates.map((d) => ({
      queryKey: ["attendance", d, null],
      queryFn: () => api<AttendanceListResponse>(`/api/attendance?date=${d}`),
      staleTime: 60 * 1000,
    })),
  });
  const isLoading = queries.some((q) => q.isLoading);
  const series = useMemo(
    () => dates.map((d, i) => summarise(d, queries[i]?.data?.items ?? [])),
    [dates, queries],
  );
  const selectedItems = queries[queries.length - 1]?.data?.items ?? [];
  return { isLoading, series, selectedItems };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HrDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  const departments = useDepartments();
  const inboxPending = useInboxPending();
  const inboxSummary = useInboxSummary();
  const policies = usePolicies();
  const schedules = useReportSchedules();
  const runNow = useRunNow();

  // Selected date — defaults to wall-clock today; clamped to today
  // by the picker so HR can't peek into the future. Past data stays
  // available for reviewing yesterday's, last week's, or any prior
  // attendance day.
  const [selectedDate, setSelectedDate] = useState<string>(todayIso());
  const isToday = selectedDate === todayIso();

  // Every report download (XLSX) is gated behind a one-time
  // confidentiality acknowledgement.
  const { gate: gateDownload, modal: confidentialModal } =
    useConfidentialDownload();

  const { series, selectedItems: todayItems } = useAttendanceSeries(selectedDate);
  const todaySummary = series[series.length - 1];
  const yesterday = series[series.length - 2];

  // Per-day presence percentage for the trend line + sparklines.
  const presenceSeries = useMemo(
    () =>
      series.map((d) => ({
        date: d.date,
        label: shortDay(d.date),
        value:
          d.working === 0
            ? 0
            : Math.round(((d.present + d.late) / d.working) * 100),
      })),
    [series],
  );

  // Sparkline series (last 7 daily values per metric).
  const sparkPresent = presenceSeries.map((p) => p.value);
  const sparkLate = series.map((d) => d.late);
  const sparkAbsent = series.map((d) => d.absent);

  const todayPresentPct = todaySummary
    ? todaySummary.working === 0
      ? null
      : Math.round(
          ((todaySummary.present + todaySummary.late) / todaySummary.working) *
            100,
        )
    : null;
  const deltaVsYesterday =
    yesterday && todaySummary && yesterday.working > 0 && todaySummary.working > 0
      ? Math.round(
          ((todaySummary.present + todaySummary.late) / todaySummary.working) *
            100 -
            ((yesterday.present + yesterday.late) / yesterday.working) * 100,
        )
      : null;

  // Per-department roll-up + punctuality leaderboard.
  const deptRows = useMemo(() => {
    const allDepts = departments.data?.items ?? [];
    type DRow = {
      id: number;
      code: string;
      name: string;
      present: number;
      late: number;
      absent: number;
      onLeave: number;
      total: number;
    };
    const byDept = new Map<number, DRow>();
    for (const d of allDepts) {
      byDept.set(d.id, {
        id: d.id,
        code: d.code,
        name: d.name,
        present: 0,
        late: 0,
        absent: 0,
        onLeave: 0,
        total: 0,
      });
    }
    for (const it of todayItems) {
      let row = byDept.get(it.department.id);
      if (!row) {
        row = {
          id: it.department.id,
          code: it.department.code,
          name: it.department.name,
          present: 0,
          late: 0,
          absent: 0,
          onLeave: 0,
          total: 0,
        };
        byDept.set(it.department.id, row);
      }
      row.total += 1;
      const b = classify(it);
      if (b === "present") row.present += 1;
      else if (b === "late") row.late += 1;
      else if (b === "absent") row.absent += 1;
      else if (b === "onLeave") row.onLeave += 1;
    }
    return Array.from(byDept.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }, [departments.data, todayItems]);

  // Punctuality leaderboard — sort by (present+late)/total, descending.
  const punctualityLeaders = useMemo(
    () =>
      deptRows
        .filter((r) => r.total > 0)
        .map((r) => ({
          id: r.id,
          name: r.name,
          on_time: r.present,
          late: r.late,
          absent: r.absent,
          total: r.total,
          punctuality:
            r.total > 0 ? Math.round((r.present / r.total) * 100) : 0,
        }))
        .sort((a, b) => b.punctuality - a.punctuality),
    [deptRows],
  );

  // Arrival distribution today — bucket in_time by hour. Only rows
  // with an actual check-in count.
  const arrivalByHour = useMemo(() => {
    const buckets: Record<number, number> = {};
    for (const it of todayItems) {
      if (!it.in_time) continue;
      const h = parseInt(it.in_time.slice(0, 2), 10);
      if (!Number.isFinite(h)) continue;
      buckets[h] = (buckets[h] ?? 0) + 1;
    }
    // Always render a 6-11 window (HR-relevant arrival hours);
    // expand if data falls outside.
    const minH = Math.min(6, ...Object.keys(buckets).map(Number));
    const maxH = Math.max(11, ...Object.keys(buckets).map(Number));
    return Array.from({ length: maxH - minH + 1 }, (_, i) => {
      const h = minH + i;
      return { label: pad(h), value: buckets[h] ?? 0 };
    });
  }, [todayItems]);

  // Pending requests — split by type and stage.
  const pendingByStage = useMemo(() => {
    const rows = inboxPending.data ?? [];
    let manager = 0,
      hr = 0,
      breached = 0;
    for (const r of rows) {
      if (r.status === "submitted") manager += 1;
      else if (r.status === "manager_approved") hr += 1;
      if (r.sla_breached) breached += 1;
    }
    return { manager, hr, breached, total: rows.length };
  }, [inboxPending.data]);

  const pendingByType = useMemo(() => {
    const rows = inboxPending.data ?? [];
    let leave = 0,
      exception = 0;
    for (const r of rows) {
      if (r.type === "leave") leave += 1;
      else exception += 1;
    }
    return { leave, exception };
  }, [inboxPending.data]);

  // Active policy mix — count assignments by type to give HR a quick
  // glance at how much of the org is on Ramadan / Custom right now.
  const policyMix = useMemo(() => {
    const counts: { Fixed: number; Flex: number; Ramadan: number; Custom: number } = {
      Fixed: 0,
      Flex: 0,
      Ramadan: 0,
      Custom: 0,
    };
    for (const p of policies.data ?? []) {
      if (p.type === "Ramadan" || p.type === "Custom") {
        if (
          p.config.start_date &&
          p.config.end_date &&
          p.config.start_date <= selectedDate &&
          selectedDate <= p.config.end_date
        ) {
          counts[p.type] += 1;
        }
        continue;
      }
      counts[p.type] += 1;
    }
    return counts;
  }, [policies.data, selectedDate]);

  const ramadanBanner = useMemo(() => {
    if (policyMix.Ramadan === 0) return null;
    const r = (policies.data ?? []).find(
      (p) =>
        p.type === "Ramadan" &&
        p.config.start_date &&
        p.config.end_date &&
        p.config.start_date <= selectedDate &&
        selectedDate <= p.config.end_date,
    );
    if (!r || !r.config.end_date) return t("dashboard.hr.ramadan.active");
    const daysLeft = Math.max(
      0,
      Math.round(
        (new Date(r.config.end_date).getTime() -
          new Date(selectedDate).getTime()) /
          86_400_000,
      ),
    );
    return daysLeft > 0
      ? t("dashboard.hr.ramadan.remaining", { count: daysLeft })
      : t("dashboard.hr.ramadan.endsToday");
  }, [policies.data, policyMix.Ramadan, selectedDate, t]);

  const dayKindLabel = useMemo(() => {
    if (!todaySummary) return null;
    if (todaySummary.kind === "weekend") return t("dashboard.hr.dayKind.weekend");
    if (todaySummary.kind === "holiday") {
      return todaySummary.holidayName
        ? t("dashboard.hr.dayKind.holidayNamed", { name: todaySummary.holidayName })
        : t("dashboard.hr.dayKind.holiday");
    }
    return null;
  }, [todaySummary, t]);

  const subtitle = useMemo(() => {
    // Use the selected date — the dashboard's frame of reference is
    // whatever HR pinned in the picker, not wall-clock today.
    const d = new Date(`${selectedDate}T00:00:00`);
    const day = d.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const parts = [day];
    if (!isToday) parts.push(t("dashboard.hr.historic"));
    if (dayKindLabel) {
      parts.push(
        todaySummary && todaySummary.otCheckIns > 0
          ? t("dashboard.hr.kindWithOt", {
              kind: dayKindLabel,
              count: todaySummary.otCheckIns,
            })
          : dayKindLabel,
      );
    } else if (ramadanBanner) {
      parts.push(ramadanBanner);
    }
    if (todayPresentPct !== null) {
      parts.push(
        isToday
          ? t("dashboard.hr.presenceToday", { pct: todayPresentPct })
          : t("dashboard.hr.presenceOnDate", { pct: todayPresentPct }),
      );
    }
    return parts.join(" · ");
  }, [
    ramadanBanner,
    todayPresentPct,
    dayKindLabel,
    todaySummary,
    selectedDate,
    isToday,
    t,
  ]);

  const dailySchedule = useMemo(
    () => (schedules.data ?? []).find((s) => s.active && s.format === "xlsx"),
    [schedules.data],
  );

  function downloadSelectedXlsx() {
    void fetch("/api/reports/attendance.xlsx", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: selectedDate, end: selectedDate }),
    })
      .then(async (r) => {
        if (!r.ok) {
          toast.error(t("dashboard.hr.toasts.exportFailed", { status: r.status }));
          return;
        }
        const blob = await r.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `attendance_${selectedDate}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        toast.success(
          isToday
            ? t("dashboard.hr.toasts.exportedToday")
            : t("dashboard.hr.toasts.exportedDate", { date: selectedDate }),
        );
      })
      .catch(() => toast.error(t("dashboard.hr.toasts.networkError")));
  }

  function sendDailyReport() {
    if (!dailySchedule) {
      toast.warning(t("dashboard.hr.toasts.noSchedule"));
      navigate("/settings/schedules");
      return;
    }
    runNow.mutate(dailySchedule.id, {
      onSuccess: () => toast.success(t("dashboard.hr.toasts.queued", { name: dailySchedule.name })),
      onError: () => toast.error(t("dashboard.hr.toasts.runFailed")),
    });
  }

  const pendingPreview = (inboxPending.data ?? []).slice(0, 5);

  const statusSlices = todaySummary
    ? todaySummary.kind !== "working"
      ? [
          {
            label: t("dashboard.hr.slices.otCheckIns"),
            value: todaySummary.otCheckIns,
            color: "var(--accent)",
          },
          {
            label: t("dashboard.hr.slices.off"),
            value:
              todayItems.length - todaySummary.otCheckIns,
            color: "var(--text-tertiary)",
          },
        ]
      : [
          {
            label: t("dashboard.hr.slices.present"),
            value: todaySummary.present,
            color: "var(--success)",
          },
          { label: t("dashboard.hr.slices.late"), value: todaySummary.late, color: "var(--warning)" },
          {
            label: t("dashboard.hr.slices.onLeave"),
            value: todaySummary.onLeave,
            color: "var(--info)",
          },
          {
            label: t("dashboard.hr.slices.absent"),
            value: todaySummary.absent,
            color: "var(--danger)",
          },
        ]
    : [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data
              ? t(`dashboard.hr.greeting.${greeting()}`, { name: firstName(me.data.full_name) })
              : t("dashboard.hr.title")}
          </h1>
          <p className="page-sub">{subtitle}</p>
        </div>
        <div
          className="page-actions"
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <DatePicker
            value={selectedDate}
            onChange={setSelectedDate}
            max={todayIso()}
            ariaLabel={t("dashboard.hr.datePickerAria")}
          />
          {!isToday && (
            <button
              className="btn btn-sm"
              onClick={() => setSelectedDate(todayIso())}
              title={t("dashboard.hr.jumpToday")}
            >
              {t("dashboard.hr.today")}
            </button>
          )}
          <button
            className="btn"
            onClick={() =>
              gateDownload({
                format: "xlsx",
                reportName: t("dashboard.hr.reportName", { date: selectedDate }),
                action: downloadSelectedXlsx,
              })
            }
          >
            <Icon name="download" size={12} />{" "}
            {isToday
              ? t("dashboard.hr.exportToday")
              : t("dashboard.hr.exportDate", { date: selectedDate })}
          </button>
          <button
            className="btn btn-primary"
            onClick={sendDailyReport}
            disabled={runNow.isPending}
            title={
              dailySchedule
                ? t("dashboard.hr.runNamedTitle", { name: dailySchedule.name })
                : t("dashboard.hr.createScheduleTitle")
            }
          >
            <Icon name="send" size={12} />
            {runNow.isPending ? t("dashboard.hr.sending") : t("dashboard.hr.sendDaily")}
          </button>
        </div>
      </div>

      {/* KPI strip with sparklines */}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <KpiCard
          icon="users"
          label={t("dashboard.hr.kpi.presentToday")}
          value={
            dayKindLabel
              ? dayKindLabel
              : todayPresentPct === null
                ? "—"
                : `${todayPresentPct}%`
          }
          delta={
            dayKindLabel
              ? t("dashboard.hr.kpi.otCheckIns", { count: todaySummary?.otCheckIns ?? 0 })
              : deltaVsYesterday === null
                ? undefined
                : t("dashboard.hr.kpi.vsYesterday", {
                    sign: deltaVsYesterday > 0 ? "+" : "",
                    pct: deltaVsYesterday,
                  })
          }
          deltaTone={
            dayKindLabel
              ? undefined
              : deltaVsYesterday === null
                ? undefined
                : deltaVsYesterday >= 0
                  ? "up"
                  : "down"
          }
          spark={sparkPresent}
          sparkColor="var(--success)"
        />
        <KpiCard
          icon="clock"
          label={t("dashboard.hr.kpi.lateArrivals")}
          value={dayKindLabel ? "—" : String(todaySummary?.late ?? 0)}
          delta={
            dayKindLabel
              ? t("dashboard.hr.kpi.noWorkingDay")
              : t("dashboard.hr.kpi.lateToday", { count: todaySummary?.late ?? 0 })
          }
          spark={sparkLate}
          sparkColor="var(--warning)"
        />
        <KpiCard
          icon="inbox"
          label={t("dashboard.hr.kpi.pendingApprovals")}
          value={String(inboxSummary.data?.pending_count ?? 0)}
          delta={
            inboxSummary.data && inboxSummary.data.breached_count > 0
              ? t("dashboard.hr.kpi.pastSla", { count: inboxSummary.data.breached_count })
              : t("dashboard.hr.kpi.withHrManagers")
          }
          deltaTone={
            inboxSummary.data && inboxSummary.data.breached_count > 0
              ? "down"
              : undefined
          }
          spark={[
            pendingByStage.manager,
            pendingByStage.hr,
            pendingByStage.total,
          ]}
          sparkColor="var(--accent)"
        />
        <KpiCard
          icon="user"
          label={t("dashboard.hr.kpi.absentToday")}
          value={dayKindLabel ? "—" : String(todaySummary?.absent ?? 0)}
          delta={dayKindLabel ? t("dashboard.hr.kpi.noWorkingDay") : t("dashboard.hr.kpi.noEvents")}
          spark={sparkAbsent}
          sparkColor="var(--danger)"
        />
      </div>

      {/* Trend (left, big) + Status donut (right) */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "2fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">{t("dashboard.hr.presence.title")}</h3>
              <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                {t("dashboard.hr.presence.subtitle", { date: selectedDate })}
              </div>
            </div>
            <span
              className="pill pill-info"
              style={{ fontSize: 10.5 }}
              title={t("dashboard.hr.presence.serverAggTitle")}
            >
              {t("dashboard.hr.presence.clientAgg")}
            </span>
          </div>
          <div className="card-body">
            <LineChart
              data={presenceSeries}
              target={90}
              unit="%"
              yMin={0}
              yMax={100}
            />
            <div
              style={{
                marginTop: 10,
                display: "flex",
                gap: 16,
                fontSize: 11.5,
                color: "var(--text-secondary)",
              }}
            >
              <LegendDot color="var(--accent)" label={t("dashboard.hr.presence.presencePct")} />
              <LegendDot
                color="var(--text-tertiary)"
                label={t("dashboard.hr.presence.target")}
                dashed
              />
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">{t("dashboard.hr.statusBreakdown")}</h3>
            <span className="text-xs text-dim mono">
              {dayKindLabel ?? selectedDate}
            </span>
          </div>
          <div
            className="card-body"
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              alignItems: "center",
              justifyContent: "center",
              columnGap: 16,
            }}
          >
            <div style={{ display: "grid", placeItems: "center" }}>
              <Donut
                slices={statusSlices}
                centerValue={
                  todaySummary && todaySummary.kind !== "working"
                    ? String(todaySummary.otCheckIns)
                    : String(todaySummary?.working ?? 0)
                }
                centerLabel={
                  todaySummary && todaySummary.kind !== "working"
                    ? t("dashboard.hr.donutOt")
                    : t("dashboard.hr.donutWorking")
                }
              />
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                fontSize: 12.5,
                minWidth: 0,
              }}
            >
              {statusSlices.map((s) => (
                <Counter
                  key={s.label}
                  color={s.color}
                  label={s.label}
                  value={s.value}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Arrival distribution */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">{t("dashboard.hr.arrival.title")}</h3>
            <div className="text-xs text-dim" style={{ marginTop: 2 }}>
              {t("dashboard.hr.arrival.subtitle")}
            </div>
          </div>
        </div>
        <div className="card-body">
          <BarChart
            data={arrivalByHour}
            fill="var(--accent)"
            colorAt={(_, b) => {
              const v = b.value;
              if (v === 0) return "var(--bg-sunken)";
              const max = Math.max(...arrivalByHour.map((x) => x.value));
              const intensity = max > 0 ? v / max : 0;
              if (intensity > 0.66) return "var(--success)";
              if (intensity > 0.33) return "var(--accent)";
              return "color-mix(in oklch, var(--accent) 50%, transparent)";
            }}
          />
          <div
            className="text-xs text-dim"
            style={{ marginTop: 6, fontFamily: "var(--font-mono)" }}
          >
            {t("dashboard.hr.arrival.note")}
          </div>
        </div>
      </div>

      {/* Punctuality leaderboard + Pending requests breakdown */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">{t("dashboard.hr.punctuality.title")}</h3>
              <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                {t("dashboard.hr.punctuality.subtitle")}
              </div>
            </div>
          </div>
          <div
            className="card-body"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              maxHeight: 360,
              overflowY: "auto",
            }}
          >
            {punctualityLeaders.length === 0 && (
              <div className="text-sm text-dim">
                {t("dashboard.hr.punctuality.empty")}
              </div>
            )}
            {punctualityLeaders.map((r, idx) => (
              <div
                key={r.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "20px 1fr 80px",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span
                  className="mono text-xs text-dim"
                  style={{ textAlign: "center" }}
                >
                  {idx + 1}
                </span>
                <div>
                  <div
                    className="text-sm"
                    style={{ fontWeight: 500, marginBottom: 4 }}
                  >
                    {r.name}
                  </div>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 3,
                      background: "var(--bg-sunken)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${r.punctuality}%`,
                        height: "100%",
                        background:
                          r.punctuality >= 90
                            ? "var(--success)"
                            : r.punctuality >= 75
                              ? "var(--warning)"
                              : "var(--danger)",
                      }}
                    />
                  </div>
                  <div
                    className="text-xs text-dim mono"
                    style={{ marginTop: 3 }}
                  >
                    {t("dashboard.hr.punctuality.row", {
                      onTime: r.on_time,
                      late: r.late,
                      absent: r.absent,
                      total: r.total,
                    })}
                  </div>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    textAlign: "end",
                    color:
                      r.punctuality >= 90
                        ? "var(--success)"
                        : r.punctuality >= 75
                          ? "var(--warning)"
                          : "var(--danger)",
                  }}
                >
                  {r.punctuality}%
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">{t("dashboard.hr.pending.title")}</h3>
              <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                {pendingByStage.total === 0
                  ? t("dashboard.hr.pending.empty")
                  : t("dashboard.hr.pending.awaiting", { count: pendingByStage.total })}
              </div>
            </div>
            <button
              className="btn btn-sm"
              onClick={() => navigate("/approvals")}
            >
              {t("dashboard.hr.pending.seeAll")}
            </button>
          </div>
          <div
            className="card-body"
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              columnGap: 16,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ display: "grid", placeItems: "center" }}>
              <Donut
                slices={[
                  {
                    label: t("dashboard.hr.pending.withManager"),
                    value: pendingByStage.manager,
                    color: "var(--accent)",
                  },
                  {
                    label: t("dashboard.hr.pending.withHr"),
                    value: pendingByStage.hr,
                    color: "var(--warning)",
                  },
                ]}
                size={130}
                centerValue={String(pendingByStage.total)}
                centerLabel={t("dashboard.hr.pending.donutLabel")}
              />
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                fontSize: 12.5,
                minWidth: 0,
              }}
            >
              <Counter
                color="var(--accent)"
                label={t("dashboard.hr.pending.withManagersPlural")}
                value={pendingByStage.manager}
              />
              <Counter
                color="var(--warning)"
                label={t("dashboard.hr.pending.withHr")}
                value={pendingByStage.hr}
              />
              <Counter
                color="var(--danger)"
                label={t("dashboard.hr.pending.pastSla")}
                value={pendingByStage.breached}
              />
              <div
                style={{
                  marginTop: 4,
                  paddingTop: 6,
                  borderTop: "1px solid var(--border)",
                }}
              />
              <Counter
                color="var(--info)"
                label={t("dashboard.hr.pending.leaveRequests")}
                value={pendingByType.leave}
              />
              <Counter
                color="var(--text-secondary)"
                label={t("dashboard.hr.pending.exceptions")}
                value={pendingByType.exception}
              />
            </div>
          </div>
          {pendingPreview.length > 0 && (
            <table
              className="table"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              <thead>
                <tr>
                  <th>{t("dashboard.hr.pending.cols.employee")}</th>
                  <th>{t("dashboard.hr.pending.cols.type")}</th>
                  <th>{t("dashboard.hr.pending.cols.date")}</th>
                  <th>{t("dashboard.hr.pending.cols.stage")}</th>
                </tr>
              </thead>
              <tbody>
                {pendingPreview.map((r) => (
                  <tr
                    key={r.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => navigate("/approvals")}
                  >
                    <td>
                      <div className="text-sm" style={{ fontWeight: 500 }}>
                        {r.employee.full_name}
                      </div>
                      <div className="text-xs text-dim mono">
                        {r.employee.employee_code}
                      </div>
                    </td>
                    <td className="text-sm">
                      {r.type === "exception"
                        ? t("dashboard.hr.pending.exception")
                        : t("dashboard.hr.pending.leave")}
                    </td>
                    <td className="mono text-sm">{r.target_date_start}</td>
                    <td>
                      <StagePill
                        status={r.status}
                        breached={r.sla_breached}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Policy mix + Scheduled reports */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "1fr 1.3fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">{t("dashboard.hr.policyMix.title")}</h3>
              <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                {t("dashboard.hr.policyMix.subtitle")}
              </div>
            </div>
          </div>
          <div
            className="card-body"
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              columnGap: 16,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ display: "grid", placeItems: "center" }}>
              <Donut
                slices={[
                  {
                    label: t("dashboard.hr.policyMix.fixed"),
                    value: policyMix.Fixed,
                    color: "var(--accent)",
                  },
                  {
                    label: t("dashboard.hr.policyMix.flex"),
                    value: policyMix.Flex,
                    color: "var(--info)",
                  },
                  {
                    label: t("dashboard.hr.policyMix.ramadan"),
                    value: policyMix.Ramadan,
                    color: "var(--warning)",
                  },
                  {
                    label: t("dashboard.hr.policyMix.custom"),
                    value: policyMix.Custom,
                    color: "var(--success)",
                  },
                ]}
                size={130}
                centerValue={String(
                  Object.values(policyMix).reduce((a, b) => a + b, 0),
                )}
                centerLabel={t("dashboard.hr.policyMix.policies")}
              />
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                fontSize: 12.5,
                minWidth: 0,
              }}
            >
              <Counter
                color="var(--accent)"
                label={t("dashboard.hr.policyMix.fixed")}
                value={policyMix.Fixed}
              />
              <Counter color="var(--info)" label={t("dashboard.hr.policyMix.flex")} value={policyMix.Flex} />
              <Counter
                color="var(--warning)"
                label={t("dashboard.hr.policyMix.ramadan")}
                value={policyMix.Ramadan}
              />
              <Counter
                color="var(--success)"
                label={t("dashboard.hr.policyMix.custom")}
                value={policyMix.Custom}
              />
            </div>
          </div>
        </div>

        <ScheduledReports
          rows={schedules.data ?? []}
          loading={schedules.isLoading}
          onManage={() => navigate("/settings/schedules")}
          onRun={(id, name) =>
            runNow.mutate(id, {
              onSuccess: () => toast.success(`Queued: ${name}`),
              onError: () => toast.error("Could not run the schedule"),
            })
          }
          runningId={runNow.isPending ? runNow.variables ?? null : null}
        />
      </div>

      {/* Live attendance preview */}
      <LiveAttendance
        rows={todayItems.slice(0, 10)}
        total={todayItems.length}
        loading={!todaySummary}
        date={selectedDate}
        isToday={isToday}
        onSeeAll={() => navigate("/daily-attendance")}
      />
      {confidentialModal}
    </>
  );
}

// ---------------------------------------------------------------------------
// Small UI bits
// ---------------------------------------------------------------------------

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}

function LegendDot({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span
        style={{
          width: 14,
          height: 2,
          background: dashed
            ? `repeating-linear-gradient(to right, ${color} 0 3px, transparent 3px 6px)`
            : color,
          borderRadius: 2,
        }}
      />
      {label}
    </span>
  );
}

function Counter({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: color,
        }}
      />
      <span style={{ flex: 1 }}>{label}</span>
      <span className="mono text-dim">{value}</span>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  delta,
  deltaTone,
  spark,
  sparkColor,
}: {
  icon: "users" | "clock" | "inbox" | "user" | "zap";
  label: string;
  value: string;
  delta?: string | undefined;
  deltaTone?: "up" | "down" | undefined;
  spark?: number[] | undefined;
  sparkColor?: string | undefined;
}) {
  const deltaColor =
    deltaTone === "up"
      ? "var(--success)"
      : deltaTone === "down"
        ? "var(--danger)"
        : "var(--text-tertiary)";
  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            background: "var(--bg-sunken)",
            display: "grid",
            placeItems: "center",
            color: "var(--text-secondary)",
          }}
        >
          <Icon name={icon} size={14} />
        </div>
        {spark && spark.length > 1 && (
          <Sparkline values={spark} stroke={sparkColor} />
        )}
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 28,
          letterSpacing: "-0.01em",
          marginTop: 4,
        }}
      >
        {value}
      </div>
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginTop: 6,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      {delta && (
        <div
          className="text-xs"
          style={{ marginTop: 2, color: deltaColor }}
        >
          {delta}
        </div>
      )}
    </div>
  );
}

function StagePill({
  status,
  breached,
}: {
  status: string;
  breached: boolean;
}) {
  const { t } = useTranslation();
  let label = status.replace("_", " ");
  let tone = "pill-info";
  if (status === "submitted") {
    label = t("dashboard.hr.stagePill.pendingManager");
    tone = breached ? "pill-danger" : "pill-warning";
  } else if (status === "manager_approved") {
    label = t("dashboard.hr.stagePill.pendingHr");
    tone = breached ? "pill-danger" : "pill-warning";
  } else if (status.endsWith("approved")) {
    tone = "pill-success";
  } else if (status.endsWith("rejected")) {
    tone = "pill-danger";
  }
  return <span className={`pill ${tone}`}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Scheduled reports panel
// ---------------------------------------------------------------------------

interface ScheduleRow {
  id: number;
  name: string;
  format: string;
  schedule_cron: string;
  active: boolean;
  recipients: string[];
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
}

function ScheduledReports({
  rows,
  loading,
  onManage,
  onRun,
  runningId,
}: {
  rows: ScheduleRow[];
  loading: boolean;
  onManage: () => void;
  onRun: (id: number, name: string) => void;
  runningId: number | null;
}) {
  const { t } = useTranslation();
  const next = rows
    .filter((r) => r.active && r.next_run_at)
    .map((r) => r.next_run_at as string)
    .sort()[0];
  const subtitle = next
    ? t("dashboard.hr.schedules.nextDelivery", { when: formatRelative(next, t) })
    : t("dashboard.hr.schedules.noUpcoming");
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">{t("dashboard.hr.schedules.title")}</h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {subtitle}
          </div>
        </div>
        <button className="btn btn-sm" onClick={onManage}>
          {t("dashboard.hr.schedules.manage")}
        </button>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {loading && (
          <div className="text-sm text-dim" style={{ padding: 14 }}>
            {t("dashboard.hr.schedules.loading")}
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="text-sm text-dim" style={{ padding: 14 }}>
            {t("dashboard.hr.schedules.empty")}
          </div>
        )}
        {!loading &&
          rows.slice(0, 4).map((s, i) => (
            <div
              key={s.id}
              style={{
                padding: "10px 14px",
                borderBottom:
                  i < Math.min(rows.length, 4) - 1
                    ? "1px solid var(--border)"
                    : 0,
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={s.name}
                >
                  {s.name}
                </div>
                <div
                  className="text-xs text-dim mono"
                  style={{
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={`${s.schedule_cron} · ${s.format.toUpperCase()}`}
                >
                  {s.schedule_cron} · {s.format.toUpperCase()}
                </div>
                {s.recipients.length > 0 && (
                  <div
                    className="text-xs text-dim"
                    style={{
                      marginTop: 2,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={s.recipients.join(", ")}
                  >
                    <Icon name="mail" size={11} />
                    {s.recipients.join(", ")}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  className={`pill ${s.active ? "pill-success" : "pill-neutral"}`}
                  style={{ fontSize: 10.5 }}
                >
                  {s.active ? t("dashboard.hr.schedules.active") : t("dashboard.hr.schedules.paused")}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => onRun(s.id, s.name)}
                  disabled={!s.active || runningId === s.id}
                >
                  {runningId === s.id ? "…" : t("dashboard.hr.schedules.run")}
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function formatRelative(iso: string, t: TFunction<"translation", undefined>): string {
  const target = new Date(iso);
  if (isNaN(target.getTime())) return iso;
  const diffMs = target.getTime() - Date.now();
  const mins = Math.round(diffMs / 60_000);
  if (Math.abs(mins) < 60) return t("dashboard.hr.schedules.relMin", { count: mins });
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return t("dashboard.hr.schedules.relHour", { count: hours });
  const days = Math.round(hours / 24);
  return t("dashboard.hr.schedules.relDay", { count: days });
}

// ---------------------------------------------------------------------------
// Live attendance preview
// ---------------------------------------------------------------------------

function LiveAttendance({
  rows,
  total,
  loading,
  date,
  isToday,
  onSeeAll,
}: {
  rows: AttendanceItem[];
  total: number;
  loading: boolean;
  date: string;
  isToday: boolean;
  onSeeAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">
            {isToday
              ? t("dashboard.hr.live.titleToday")
              : t("dashboard.hr.live.titleDate", { date })}
          </h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {total === 0
              ? t("dashboard.hr.live.empty")
              : t("dashboard.hr.live.showing", { shown: rows.length, total })}
          </div>
        </div>
        <button className="btn btn-sm" onClick={onSeeAll}>
          {t("dashboard.hr.live.viewAll")}
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t("dashboard.hr.live.cols.employee")}</th>
            <th>{t("dashboard.hr.live.cols.dept")}</th>
            <th>{t("dashboard.hr.live.cols.policy")}</th>
            <th>{t("dashboard.hr.live.cols.in")}</th>
            <th>{t("dashboard.hr.live.cols.out")}</th>
            <th>{t("dashboard.hr.live.cols.hours")}</th>
            <th>{t("dashboard.hr.live.cols.status")}</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td
                colSpan={7}
                className="text-sm text-dim"
                style={{ padding: 14, textAlign: "center" }}
              >
                {t("dashboard.common.loading")}
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={7}
                className="text-sm text-dim"
                style={{ padding: 14, textAlign: "center" }}
              >
                {t("dashboard.hr.live.emptyRows")}
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((it) => (
              <tr key={`${it.employee_id}-${it.date}`}>
                <td>
                  <div className="text-sm" style={{ fontWeight: 500 }}>
                    {it.full_name}
                  </div>
                  <div className="text-xs text-dim mono">
                    {it.employee_code}
                  </div>
                </td>
                <td className="text-sm">{it.department.name}</td>
                <td className="text-sm">{it.policy.name}</td>
                <td className="mono text-sm">{shortTime(it.in_time)}</td>
                <td className="mono text-sm">{shortTime(it.out_time)}</td>
                <td className="mono text-sm">
                  {formatMinutes(it.total_minutes)}
                </td>
                <td>
                  <AttendancePill it={it} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function AttendancePill({ it }: { it: AttendanceItem }) {
  const { t } = useTranslation();
  const b = classify(it);
  if (b === "off") {
    if (it.is_holiday) {
      return (
        <span className="pill pill-info">
          {it.holiday_name
            ? t("dashboard.hr.attPill.holidayNamed", { name: it.holiday_name })
            : t("dashboard.hr.attPill.holiday")}
        </span>
      );
    }
    return <span className="pill pill-neutral">{t("dashboard.hr.attPill.weekend")}</span>;
  }
  if (b === "pending") {
    return <span className="pill pill-info">{t("dashboard.hr.attPill.waitingLogin")}</span>;
  }
  if (b === "onLeave") return <span className="pill pill-info">{t("dashboard.hr.attPill.onLeave")}</span>;
  if (b === "absent") return <span className="pill pill-danger">{t("dashboard.hr.attPill.absent")}</span>;
  if (b === "late") return <LateBadge size="md" />;
  return <span className="pill pill-success">{t("dashboard.hr.attPill.present")}</span>;
}
