// Employee report — Admin / HR / Manager.
// Search-an-employee → live attendance card for a date range.
// Layout matches docs/scripts/issues-screenshots/09-Employee_report_page.png:
// page header + Download buttons, search/range row with quick-range
// buttons, selected employee summary card, five stat tiles, and a
// day-by-day breakdown table.
//
// Backend role-scoping is the source of truth — Manager only sees
// employees in their visible set; Employee can only pick themselves
// (via the employee_id endpoint's 404/403 guards).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { DatePicker } from "../../components/DatePicker";
import { PdfOptionsModal } from "../../components/PdfOptionsModal";
import { useConfidentialDownload } from "../../components/useConfidentialDownload";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { DayDetailDrawer } from "../calendar/DayDetailDrawer";
import { useEmployeeList, useEmployeeDetail } from "../employees/hooks";
import type { Employee } from "../employees/types";
import { formatMinutes } from "../attendance/timeFormat";
import type { AttendanceItem, AttendanceListResponse } from "../attendance/types";
import { SkeletonCards, SkeletonLines, SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel, StatCard, StatGrid, Toolbar, pct } from "../../components/ListPageUi";
import { ATT_ICON, DotPill, FieldGroup, StrokeIcon, fieldDateStyle } from "../attendance/attendanceUi";

import "./reports.css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function firstOfMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// Migration 0068 — display-side time formatting goes through the
// tenant ``useTenantDateTime`` hook; the legacy ``shortTime`` helper
// was removed since it ignored the operator's 12h/24h choice.
//
// Display-side hour formatting uses ``formatMinutes`` from
// attendance/timeFormat for consistent ``8h 45m`` rendering.
// CSV/Excel exports keep decimal hours via ``(min / 60).toFixed(2)``
// at the row-build sites — that's a data-shape concern, not display.

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayName(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  if (isNaN(d.getTime())) return "";
  return WEEKDAY_LABELS[d.getDay()] ?? "";
}

function isWeekend(isoDate: string): boolean {
  const d = new Date(`${isoDate}T00:00:00`);
  const dow = d.getDay();
  // Asia/Muscat default: Fri + Sat. Tenant-specific override is
  // server-side; the toggle below just hides the rows.
  return dow === 5 || dow === 6;
}

function rowsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || s > e) return out;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${dd}`);
  }
  return out;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function rowsToCsv(headers: string[], rows: (string | number | null)[][]): string {
  const escape = (cell: string | number | null): string => {
    if (cell === null || cell === undefined) return "";
    const s = String(cell);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) lines.push(row.map(escape).join(","));
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function EmployeeReportPage() {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const fmtShort = (iso: string | null): string => {
    if (!iso) return "—";
    return dt.formatLocalTime(iso) || iso;
  };
  const [start, setStart] = useState<string>(firstOfMonthIso());
  const [end, setEnd] = useState<string>(todayIso());
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(
    null,
  );
  const [showWeekends, setShowWeekends] = useState(false);
  // Day-detail drawer — opened by clicking a day-by-day breakdown row.
  // Reuses the shared calendar drawer (same template set, incl. leave).
  const [openDayIso, setOpenDayIso] = useState<string | null>(null);
  // Click-to-filter on the summary cards (mirrors Daily attendance).
  const [statusFilter, setStatusFilter] = useState<ReportBucket | null>(null);
  const toggleStatus = (s: ReportBucket) =>
    setStatusFilter((cur) => (cur === s ? null : s));
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);

  // Admins don't raise requests on behalf of employees — the button
  // only shows for non-Admin roles (HR / Manager / Employee).
  const me = useMe();
  const isAdmin = me.data?.active_role === "Admin";

  // Downloads need a selected employee. Disabled until one is picked
  // (or while a download is in flight).
  const downloadDisabled = selectedEmployeeId === null || downloading !== null;

  // Every download (XLSX / PDF / CSV) is gated behind a one-time
  // confidentiality acknowledgement. ``gateDownload`` opens the
  // warning; only on confirm does ``action`` actually run.
  const { gate: gateDownload, modal: confidentialModal } =
    useConfidentialDownload();

  useEffect(() => {
    setInfo(null);
    setError(null);
  }, [selectedEmployeeId, start, end]);

  const employeeQuery = useEmployeeDetail(selectedEmployeeId);
  const employee = employeeQuery.data ?? null;
  const range = useEmployeeAttendance(selectedEmployeeId, start, end);
  const items = range.data?.items ?? [];

  // Stats panel — derived client-side from the loaded rows. Buckets
  // mirror DayStatusPill so the tiles agree with the day-by-day
  // table. Pre-fix bug: rows with ``absent=false`` but ``in_time=null``
  // (scheduler-seeded empty rows for past days the operator hasn't
  // computed) were counted as Present and inflated the percentage.
  const stats = useMemo(() => {
    const allDates = rowsBetween(start, end);
    const workingDates = allDates.filter((d) => !isWeekend(d));
    const totalDaysInRange = allDates.length;
    const itemByDate = new Map(items.map((it) => [it.date, it]));
    let present = 0;
    let late = 0;
    let absent = 0;
    let leave = 0;
    let totalMinutes = 0;
    let otMinutes = 0;
    for (const d of workingDates) {
      const it = itemByDate.get(d);
      if (!it) continue;
      // Leave wins over everything (an approved leave on a holiday
      // is still leave, server resolves the priority). The engine
      // clears ``absent`` on a leave day, so leave_type_id is the marker.
      if (it.leave_type_id !== null) {
        leave += 1;
        continue;
      }
      // Holiday / weekend rows without a check-in aren't part of the
      // working set — skip them so they don't pull the present % down.
      if ((it.is_holiday || it.is_weekend) && !it.in_time) continue;
      // Today's row before the operator clocked in — not absent yet.
      if (it.pending) continue;
      // No check-in on a past working day → absent.
      if (!it.in_time) {
        absent += 1;
        continue;
      }
      // Got a check-in: late or on-time, both count toward present.
      present += 1;
      if (it.late) late += 1;
      totalMinutes += it.total_minutes ?? 0;
      otMinutes += it.overtime_minutes;
    }
    // Weekend work is recorded as overtime by the engine (the whole
    // day is OT). It's not part of the working-days / present / absent
    // counts, but its hours are real — fold them into Total Hours + OT
    // only while "Show weekends" is on, so the tiles reconcile with
    // whatever rows are actually visible in the breakdown below.
    let weekendMinutes = 0;
    let weekendOtMinutes = 0;
    for (const d of allDates) {
      if (!isWeekend(d)) continue;
      const it = itemByDate.get(d);
      if (!it || !it.in_time) continue;
      weekendMinutes += it.total_minutes ?? 0;
      weekendOtMinutes += it.overtime_minutes;
    }
    const presentPct =
      workingDates.length > 0
        ? Math.round((present / workingDates.length) * 100)
        : 0;
    return {
      workingDays: workingDates.length,
      totalDaysInRange,
      present,
      late,
      absent,
      leave,
      totalMinutes: totalMinutes + (showWeekends ? weekendMinutes : 0),
      otMinutes: otMinutes + (showWeekends ? weekendOtMinutes : 0),
      weekendMinutes,
      weekendOtMinutes,
      presentPct,
    };
  }, [items, start, end, showWeekends]);

  const visibleDates = useMemo(() => {
    const allDates = rowsBetween(start, end);
    return showWeekends ? allDates : allDates.filter((d) => !isWeekend(d));
  }, [start, end, showWeekends]);

  const itemByDate = useMemo(
    () => new Map(items.map((it) => [it.date, it])),
    [items],
  );

  // Per-day status bucket for the four clickable summary cards. Mutually
  // exclusive (present excludes late) — mirrors Daily attendance so a
  // card's number always equals the rows clicking it filters to.
  const dayBuckets = useMemo(() => {
    const m = new Map<string, ReportBucket | "other">();
    for (const d of visibleDates) {
      m.set(d, reportDayBucket(itemByDate.get(d) ?? null));
    }
    return m;
  }, [visibleDates, itemByDate]);

  const counts = useMemo(() => {
    const c = { present: 0, late: 0, absent: 0, leave: 0 };
    for (const b of dayBuckets.values()) {
      if (b !== "other") c[b] += 1;
    }
    return c;
  }, [dayBuckets]);

  // Rows shown in the breakdown — narrowed to the active status filter.
  const filteredDates = useMemo(
    () =>
      statusFilter
        ? visibleDates.filter((d) => dayBuckets.get(d) === statusFilter)
        : visibleDates,
    [statusFilter, visibleDates, dayBuckets],
  );

  // Clear the filter when the employee or range changes so a stale filter
  // doesn't leave the table looking empty.
  useEffect(() => {
    setStatusFilter(null);
  }, [selectedEmployeeId, start, end]);

  const downloadXlsx = async () => {
    if (selectedEmployeeId === null) return;
    setDownloading("xlsx");
    setError(null);
    setInfo(null);
    try {
      const resp = await fetch("/api/reports/attendance.xlsx", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start,
          end,
          employee_id: selectedEmployeeId,
        }),
      });
      if (!resp.ok) {
        setError(t("employeeReport.downloadFailed", { status: resp.status }));
        return;
      }
      const blob = await resp.blob();
      const code = employee?.employee_code ?? selectedEmployeeId;
      downloadBlob(blob, `employee_report_${code}_${start}_to_${end}.xlsx`);
      setInfo(`Downloaded employee_report_${code}_${start}_to_${end}.xlsx.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(null);
    }
  };

  const downloadPdf = async (includePhotos: boolean) => {
    if (selectedEmployeeId === null) return;
    setDownloading("pdf");
    setError(null);
    setInfo(null);
    try {
      const resp = await fetch("/api/reports/attendance.pdf", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start,
          end,
          employee_id: selectedEmployeeId,
          include_employee_photos: includePhotos,
        }),
      });
      if (!resp.ok) {
        setError(t("employeeReport.downloadFailed", { status: resp.status }));
        return;
      }
      const blob = await resp.blob();
      const code = employee?.employee_code ?? selectedEmployeeId;
      downloadBlob(blob, `employee_report_${code}_${start}_to_${end}.pdf`);
      setInfo(`Downloaded employee_report_${code}_${start}_to_${end}.pdf.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(null);
    }
  };

  // Which quick-range chip (if any) matches the current range.
  const quick: "7d" | "30d" | "mtd" | null =
    end !== todayIso()
      ? null
      : start === daysAgoIso(6)
        ? "7d"
        : start === daysAgoIso(29)
          ? "30d"
          : start === firstOfMonthIso()
            ? "mtd"
            : null;

  // Five-state model for the breakdown: loading / error / no records
  // at all in the range / filter matches nothing / rows.
  const hasRecords = items.some((it) => it.in_time || it.leave_type_id !== null);
  const initialLoad = range.isLoading && range.data === null;

  const downloadDaysCsv = () => {
    if (!employee) return;
    const csv = rowsToCsv(
      ["Date", "Day", "Status", "In", "Out", "Hours", "Overtime", "Flags"],
      visibleDates.map((d) => {
        const it = itemByDate.get(d);
        return [
          d,
          dayName(d),
          statusLabel(it ?? null),
          fmtShort(it?.in_time ?? null),
          fmtShort(it?.out_time ?? null),
          it?.total_minutes != null ? (it.total_minutes / 60).toFixed(2) : "",
          it && it.overtime_minutes > 0
            ? `${(it.overtime_minutes / 60).toFixed(1)}h`
            : "",
          flagText(it ?? null),
        ];
      }),
    );
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `employee_report_${employee.employee_code}_${start}_to_${end}.csv`,
    );
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("employeeReport.title")}</h1>
          <p className="page-sub">{t("employeeReport.sub")}</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              const code = employee?.employee_code ?? selectedEmployeeId ?? "";
              gateDownload({
                format: "xlsx",
                reportName: `Employee report — ${employee?.full_name ?? code} · ${start} → ${end}`,
                action: downloadXlsx,
              });
            }}
            disabled={downloadDisabled}
          >
            <Icon name="download" size={12} />
            {downloading === "xlsx" ? t("employeeReport.downloadingXlsx") : t("employeeReport.downloadXlsx")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const code = employee?.employee_code ?? selectedEmployeeId ?? "";
              gateDownload({
                format: "pdf",
                reportName: `Employee report — ${employee?.full_name ?? code} · ${start} → ${end}`,
                action: () => setPdfModalOpen(true),
              });
            }}
            disabled={downloadDisabled}
          >
            <Icon name="fileText" size={12} />
            {downloading === "pdf" ? t("employeeReport.generatingPdf") : t("employeeReport.downloadPdf")}
          </button>
        </div>
      </div>

      {(info || error) && (
        <div className={`rp-banner ${error ? "tone-danger" : "tone-success"}`} role="status">
          <Icon name={error ? "x" : "check"} size={14} />
          {error ?? info}
        </div>
      )}

      {/* Search + range */}
      <Toolbar>
        <EmployeeSearch
          value={selectedEmployeeId}
          onChange={setSelectedEmployeeId}
          initial={employee}
        />
        <FieldGroup label={t("employeeReport.rangeLabel")}>
          <DatePicker
            value={start}
            onChange={setStart}
            max={todayIso()}
            ariaLabel={t("employeeReport.startDateAria")}
            triggerStyle={fieldDateStyle}
          />
          <DatePicker
            value={end}
            onChange={setEnd}
            min={start}
            max={todayIso()}
            ariaLabel={t("employeeReport.endDateAria")}
            triggerStyle={fieldDateStyle}
          />
        </FieldGroup>
        <div className="seg" role="group" aria-label={t("employeeReport.quickRange")}>
          <button
            type="button"
            className={`seg-btn${quick === "7d" ? " active" : ""}`}
            aria-pressed={quick === "7d"}
            onClick={() => {
              setStart(daysAgoIso(6));
              setEnd(todayIso());
            }}
          >
            7d
          </button>
          <button
            type="button"
            className={`seg-btn${quick === "30d" ? " active" : ""}`}
            aria-pressed={quick === "30d"}
            onClick={() => {
              setStart(daysAgoIso(29));
              setEnd(todayIso());
            }}
          >
            30d
          </button>
          <button
            type="button"
            className={`seg-btn${quick === "mtd" ? " active" : ""}`}
            aria-pressed={quick === "mtd"}
            onClick={() => {
              setStart(firstOfMonthIso());
              setEnd(todayIso());
            }}
          >
            MTD
          </button>
        </div>
      </Toolbar>

      {/* Selected-employee card */}
      {selectedEmployeeId === null && (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<StrokeIcon>{ATT_ICON.people}</StrokeIcon>}
            title={t("employeeReport.pickEmployee")}
            body={t("employeeReport.pickEmployeeHint")}
          />
        </div>
      )}

      {selectedEmployeeId !== null && employee && (
        <>
          <div className="card at-card-body rp-profile rp-profile-card">
              <Avatar name={employee.full_name} size="lg" />
              <div className="rp-profile-main">
                <h2 className="rp-profile-name">{employee.full_name}</h2>
                <div className="rp-profile-meta">
                  <span className="mono">{employee.employee_code}</span>
                  {employee.designation && (
                    <span> · {employee.designation}</span>
                  )}
                  <span> · {employee.department.name}</span>
                  {employee.reports_to_full_name && (
                    <span> · {t("employeeReport.reportsTo", { name: employee.reports_to_full_name })}</span>
                  )}
                </div>
                <div className="rp-profile-pills">
                  {(employee.role_codes ?? []).map((r) => (
                    <span key={r} className="pill pill-neutral">
                      {r}
                    </span>
                  ))}
                  <span className="pill pill-accent">
                    {t("employeeReport.rangePill", { start, end, count: visibleDates.length })}
                  </span>
                </div>
              </div>
              {!isAdmin && (
                <button
                  type="button"
                  className="btn"
                  title={t("employeeReport.raiseRequestTitle")}
                  onClick={() => {
                    window.location.assign("/my-requests");
                  }}
                >
                  <Icon name="plus" size={11} />
                  {t("employeeReport.raiseRequest")}
                </button>
              )}
          </div>

          {/* Loading → shape-matched skeletons; error → danger panel
              with Retry; no records at all → single accent panel (stats
              + table hidden); otherwise stats + breakdown. */}
          {initialLoad ? (
            <>
              <SkeletonCards count={5} minWidth={180} />
              <div className="card">
                <div className="at-card-head">
                  <h3 className="card-title">{t("employeeReport.breakdownTitle")}</h3>
                </div>
                <div className="at-scroll-x">
                  <table className="table">
                    <tbody>
                      <SkeletonRows cols={8} />
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : range.isError ? (
            <div className="card">
              <EmptyPanel
                tone="danger"
                icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
                title={t("employeeReport.errorTitle", { defaultValue: "Couldn't load attendance" })}
                body={t("employeeReport.loadFailed")}
                actions={
                  <button type="button" className="btn" onClick={range.retry}>
                    <Icon name="refresh" size={12} />
                    {t("employeeReport.retry", { defaultValue: "Retry" })}
                  </button>
                }
              />
            </div>
          ) : !hasRecords ? (
            <div className="card">
              <EmptyPanel
                tone="accent"
                icon={<StrokeIcon>{ATT_ICON.calendar}</StrokeIcon>}
                title={t("employeeReport.noRecordsTitle", { defaultValue: "No attendance recorded in this range" })}
                body={t("employeeReport.noRecordsBody", {
                  defaultValue: "{{name}} has no check-ins or approved leave between {{start}} and {{end}}.",
                  name: employee.full_name,
                  start,
                  end,
                })}
                actions={
                  quick !== "30d" ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setStart(daysAgoIso(29));
                        setEnd(todayIso());
                      }}
                    >
                      <Icon name="calendar" size={12} />
                      {t("employeeReport.widen30", { defaultValue: "Show last 30 days" })}
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
          <>
          {/* Summary — derived from the loaded day rows; each card
              doubles as the day-by-day status filter. */}
          <StatGrid>
            <StatCard
              tone="info"
              icon={ATT_ICON.calendar}
              label={t("employeeReport.statWorkingDays")}
              value={stats.workingDays}
              sub={
                stats.totalMinutes > 0
                  ? `${t("employeeReport.statTotalHours")}: ${formatMinutes(stats.totalMinutes)}${
                      stats.otMinutes > 0
                        ? ` · ${t("employeeReport.statOtHint", { n: formatMinutes(stats.otMinutes) })}`
                        : ""
                    }`
                  : `${t("employeeReport.statTotalHours")}: —`
              }
              active={statusFilter === null}
              onClick={() => setStatusFilter(null)}
            />
            <StatCard
              tone="success"
              icon={ATT_ICON.present}
              label={t("employeeReport.statPresent")}
              value={counts.present}
              sub={`${pct(counts.present, stats.workingDays)}%`}
              active={statusFilter === "present"}
              onClick={() => toggleStatus("present")}
            />
            <StatCard
              tone="warning"
              icon={ATT_ICON.late}
              label={t("employeeReport.statLate")}
              value={counts.late}
              sub={`${pct(counts.late, stats.workingDays)}%`}
              active={statusFilter === "late"}
              onClick={() => toggleStatus("late")}
            />
            <StatCard
              tone="danger"
              icon={ATT_ICON.absent}
              label={t("employeeReport.statAbsent")}
              value={counts.absent}
              sub={`${pct(counts.absent, stats.workingDays)}%`}
              active={statusFilter === "absent"}
              onClick={() => toggleStatus("absent")}
            />
            <StatCard
              tone="neutral"
              icon={ATT_ICON.leave}
              label={t("employeeReport.statOnLeave", { defaultValue: "On Leave" })}
              value={counts.leave}
              sub={`${pct(counts.leave, stats.workingDays)}%`}
              active={statusFilter === "leave"}
              onClick={() => toggleStatus("leave")}
            />
          </StatGrid>

          {/* Day-by-day breakdown */}
          <div className="card">
            <div className="at-card-head">
              <h3 className="card-title">{t("employeeReport.breakdownTitle")}</h3>
              <div className="at-card-head-actions">
                <label className="rp-inline-check">
                  <input
                    type="checkbox"
                    checked={showWeekends}
                    onChange={(e) => setShowWeekends(e.target.checked)}
                  />
                  {t("employeeReport.showWeekends")}
                </label>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (!employee) return;
                    gateDownload({
                      format: "csv",
                      reportName: `Employee report — ${employee.full_name} · ${start} → ${end}`,
                      action: downloadDaysCsv,
                    });
                  }}
                  disabled={!employee}
                >
                  <Icon name="download" size={11} />
                  {t("employeeReport.csvBtn")}
                </button>
              </div>
            </div>
            {filteredDates.length === 0 ? (
              <EmptyPanel
                tone="neutral"
                icon={<Icon name="filter" size={28} />}
                title={t("employeeReport.empty.title", { defaultValue: "No days match this filter" })}
                body={t("employeeReport.empty.body", { defaultValue: "Pick another summary card or widen the date range." })}
                actions={
                  statusFilter ? (
                    <button type="button" className="btn" onClick={() => setStatusFilter(null)}>
                      <Icon name="refresh" size={12} />
                      {t("employeeReport.empty.showAll", { defaultValue: "Show all days" })}
                    </button>
                  ) : undefined
                }
              />
            ) : (
            <div className={`at-scroll-x${range.isLoading ? " at-faded" : ""}`}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t("employeeReport.colDate")}</th>
                  <th>{t("employeeReport.colDay")}</th>
                  <th>{t("employeeReport.colStatus")}</th>
                  <th>{t("employeeReport.colIn")}</th>
                  <th>{t("employeeReport.colOut")}</th>
                  <th>{t("employeeReport.colHours")}</th>
                  <th>{t("employeeReport.colOvertime")}</th>
                  <th>{t("employeeReport.colFlags")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredDates.map((d) => {
                    const it = itemByDate.get(d) ?? null;
                    return (
                      <tr
                        key={d}
                        className="at-row-clickable"
                        onClick={() => setOpenDayIso(d)}
                        title={t("employeeReport.openDayDetail", {
                          defaultValue: "View day detail",
                        })}
                      >
                        <td className="mono text-sm at-nowrap">{dt.formatLocalDate(d) || d}</td>
                        <td className="text-sm">{dayName(d)}</td>
                        <td>
                          <DayStatusPill item={it} isoDate={d} />
                        </td>
                        <td className="mono text-sm">
                          {fmtShort(it?.in_time ?? null)}
                        </td>
                        <td className="mono text-sm">
                          {fmtShort(it?.out_time ?? null)}
                        </td>
                        <td className="mono text-sm">
                          {formatMinutes(it?.total_minutes ?? null)}
                        </td>
                        <td className="mono text-sm">
                          {it && it.overtime_minutes > 0
                            ? `+${formatMinutes(it.overtime_minutes)}`
                            : "—"}
                        </td>
                        <td className="text-xs">
                          {flagText(it)}
                        </td>
                        <td className="rp-row-chev-cell">
                          <span aria-hidden className="rp-row-chev">
                            <Icon name="chevronRight" size={14} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            </div>
            )}
          </div>
          </>
          )}
        </>
      )}

      {openDayIso !== null && selectedEmployeeId !== null && (
        <DayDetailDrawer
          employeeId={selectedEmployeeId}
          isoDate={openDayIso}
          onClose={() => setOpenDayIso(null)}
        />
      )}

      <PdfOptionsModal
        open={pdfModalOpen}
        onClose={() => {
          if (downloading !== "pdf") setPdfModalOpen(false);
        }}
        onConfirm={async (includePhotos) => {
          await downloadPdf(includePhotos);
          setPdfModalOpen(false);
        }}
        busy={downloading === "pdf"}
      />
      {confidentialModal}
    </>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function EmployeeSearch({
  value,
  onChange,
  initial,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  initial: Employee | null;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Show the picked employee's display label when the box is closed.
  const displayLabel = initial
    ? `${initial.full_name} · ${initial.employee_code}`
    : "";

  const list = useEmployeeList({
    q: q.trim(),
    department_id: null,
    include_inactive: false,
    page: 1,
    page_size: 12,
  });
  const items = list.data?.items ?? [];

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={wrapRef} className="rp-search">
      <span aria-hidden className="rp-search-icon">
        <Icon name="search" size={15} />
      </span>
      <input
        type="text"
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={open ? q : value !== null ? displayLabel : q}
        placeholder={t("employeeReport.search.placeholder")}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          if (e.target.value === "") onChange(null);
        }}
        aria-label={t("employeeReport.search.placeholder")}
      />
      {open && q.length >= 0 && (
        <div role="listbox" className="rp-search-menu">
          {list.isLoading && (
            <div className="rp-search-note">
              <SkeletonLines lines={2} />
            </div>
          )}
          {!list.isLoading && items.length === 0 && (
            <div className="rp-search-note">
              {q.trim() ? t("employeeReport.search.noMatches") : t("employeeReport.search.typeToSearch")}
            </div>
          )}
          {items.map((emp) => (
            <button
              key={emp.id}
              type="button"
              role="option"
              aria-selected={emp.id === value}
              className="rp-search-item"
              onClick={() => {
                onChange(emp.id);
                setOpen(false);
                setQ("");
              }}
            >
              <Avatar name={emp.full_name} size="sm" />
              <div className="rp-search-item-main">
                <div className="rp-search-item-name">{emp.full_name}</div>
                <div className="rp-search-item-meta">
                  <span className="mono">{emp.employee_code}</span> · {emp.department.name}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The four mutually-exclusive status buckets the summary cards filter on.
type ReportBucket = "present" | "late" | "absent" | "leave";

// Classify one day's row. "other" covers no-record / off-day / pending —
// days that none of the four cards count or filter to. Mirrors the
// summary loop + Daily attendance's classifyStatus priority.
function reportDayBucket(
  it: AttendanceItem | null,
): ReportBucket | "other" {
  if (!it) return "other";
  if (it.leave_type_id !== null) return "leave";
  if ((it.is_holiday || it.is_weekend) && !it.in_time) return "other";
  if (it.pending) return "other";
  if (!it.in_time) return "absent";
  if (it.late) return "late";
  return "present";
}

// Status priority mirrors DailyStatusPill in DailyAttendancePage /
// ReportsPage so all three surfaces agree on the meaning of a row.
// The previous version of this pill ignored ``pending`` / ``is_weekend``
// / ``is_holiday`` and any row with ``absent=false`` fell through to
// "Present" — even rows whose ``in_time`` was null (scheduler-seeded
// empty row, no events that day). Result: empty days were shown as
// green Present pills and inflated the Present stat tile.
function DayStatusPill({
  item,
  isoDate,
}: {
  item: AttendanceItem | null;
  isoDate: string;
}) {
  const { t } = useTranslation();
  if (!item) {
    if (isWeekend(isoDate))
      return <DotPill tone="neutral">{t("employeeReport.status.weekend")}</DotPill>;
    if (isoDate > todayIso())
      return <DotPill tone="neutral">—</DotPill>;
    return <DotPill tone="neutral">{t("employeeReport.status.noRecord")}</DotPill>;
  }
  if (item.leave_type_id !== null) {
    return <DotPill tone="info">{t("employeeReport.status.onLeave")}</DotPill>;
  }
  if (item.is_holiday && !item.in_time) {
    return (
      <DotPill tone="accent">
        {item.holiday_name
          ? t("employeeReport.status.holidayNamed", { name: item.holiday_name })
          : t("employeeReport.status.holiday")}
      </DotPill>
    );
  }
  if (item.is_weekend && !item.in_time) {
    return <DotPill tone="neutral">{t("employeeReport.status.weekend")}</DotPill>;
  }
  if (item.pending) {
    return <DotPill tone="info">{t("employeeReport.status.waitingLogin")}</DotPill>;
  }
  if (!item.in_time) {
    return <DotPill tone="danger">{t("employeeReport.status.absent")}</DotPill>;
  }
  if (item.late) {
    return <DotPill tone="warning">{t("employeeReport.status.late")}</DotPill>;
  }
  return <DotPill tone="success">{t("employeeReport.status.present")}</DotPill>;
}

function statusLabel(item: AttendanceItem | null): string {
  if (!item) return "No record";
  if (item.leave_type_id !== null) return "On leave";
  if (item.is_holiday && !item.in_time) {
    return item.holiday_name
      ? `Holiday — ${item.holiday_name}`
      : "Holiday";
  }
  if (item.is_weekend && !item.in_time) return "Weekend";
  if (item.pending) return "Waiting for login";
  if (!item.in_time) return "Absent";
  if (item.late) return "Late";
  return "Present";
}

function flagText(item: AttendanceItem | null): string {
  if (!item) return "—";
  const parts: string[] = [];
  if (item.late) parts.push("Late");
  if (item.early_out) parts.push("Early out");
  if (item.short_hours) parts.push("Short hours");
  if (item.overtime_minutes > 0) {
    parts.push(`+${formatMinutes(item.overtime_minutes)} OT`);
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

// Avatar — design ``.avatar`` (accent gradient) with up to two initials.
function Avatar({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  const initials = (() => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 0) return "?";
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (first + last).toUpperCase() || "?";
  })();
  return (
    <span aria-hidden className={`avatar ${size === "lg" ? "rp-avatar-lg" : "rp-avatar-sm"}`}>
      {initials}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useEmployeeAttendance(
  employeeId: number | null,
  start: string,
  end: string,
): {
  data: AttendanceListResponse | null;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
} {
  const [data, setData] = useState<AttendanceListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (employeeId === null) {
      setData(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setIsError(false);
    api<AttendanceListResponse>(
      `/api/attendance/employee/${employeeId}?start=${start}&end=${end}`,
    )
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setIsError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId, start, end, reload]);
  return { data, isLoading, isError, retry: () => setReload((n) => n + 1) };
}
