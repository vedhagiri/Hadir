// Reports page — three report types (Attendance / Event Log /
// Department Summary) in a two-column layout: an options card
// (report type, range, download) on the inline-start side and a live
// preview card on the inline-end side.
//
// Attendance flows through /api/reports/attendance.{xlsx,pdf} and
// supports a date range (start..end) — the table preview samples the
// range (capped), the download streams the full range. Event Log + Dept
// Summary download as client-side CSV blobs for now (server-side
// XLSX/PDF for those types is a follow-up); both keep a single-day
// picker since their data shape is per-event-on-day.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { api } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { DatePicker } from "../../components/DatePicker";
import { PdfOptionsModal } from "../../components/PdfOptionsModal";
import { useConfidentialDownload } from "../../components/useConfidentialDownload";
import { Icon, type IconName } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { useAttendance } from "../attendance/hooks";
import { formatMinutes } from "../attendance/timeFormat";
import type {
  AttendanceItem,
  AttendanceListResponse,
} from "../attendance/types";
import { useDepartments } from "../departments/hooks";
import { RematchModal } from "./RematchModal";
import { EmptyPanel } from "../../components/ListPageUi";
import { SkeletonRows } from "../../components/Skeleton";
import { ATT_ICON, DotPill, StrokeIcon, fieldDateStyle } from "../attendance/attendanceUi";

import "./reports.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReportKey = "attendance" | "event-log" | "department-summary";

interface DetectionEventRow {
  id: number;
  captured_at: string;
  camera_name: string;
  employee_name: string | null;
  employee_code: string | null;
  confidence: number | null;
  track_id: string;
  has_crop: boolean;
}

interface DetectionEventListResponse {
  items: DetectionEventRow[];
  total: number;
  page: number;
  page_size: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Date preset helpers
// ---------------------------------------------------------------------------

type PresetKey = "today" | "this-week" | "last-3" | "last-7" | "custom";

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Enumerate every YYYY-MM-DD in [start..end] inclusive, capped to
// ``cap`` most-recent days so a wide custom range doesn't fire
// hundreds of round-trips just to fill a preview. Returns dates
// in chronological order.
function enumerateDays(start: string, end: string, cap: number): string[] {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || a > b) return [start];
  const out: string[] = [];
  const cur = new Date(a);
  while (cur <= b) {
    out.push(isoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  if (out.length <= cap) return out;
  return out.slice(out.length - cap); // keep the most recent ``cap`` days
}

function presetRange(preset: Exclude<PresetKey, "custom">): { start: string; end: string } {
  const today = new Date();
  switch (preset) {
    case "today":
      return { start: isoDate(today), end: isoDate(today) };
    case "this-week": {
      const day = today.getDay(); // 0=Sun
      const diff = day === 0 ? -6 : 1 - day;
      const mon = new Date(today);
      mon.setDate(today.getDate() + diff);
      return { start: isoDate(mon), end: isoDate(today) };
    }
    case "last-3": {
      const d = new Date(today);
      d.setDate(today.getDate() - 2);
      return { start: isoDate(d), end: isoDate(today) };
    }
    case "last-7": {
      const d = new Date(today);
      d.setDate(today.getDate() - 6);
      return { start: isoDate(d), end: isoDate(today) };
    }
  }
}

function getPresetLabels(t: TFunction<"translation", undefined>): { key: PresetKey; label: string }[] {
  return [
    { key: "today", label: t("reports.presets.today") },
    { key: "this-week", label: t("reports.presets.thisWeek") },
    { key: "last-3", label: t("reports.presets.last3") },
    { key: "last-7", label: t("reports.presets.last7") },
    { key: "custom", label: t("reports.presets.custom") },
  ];
}

// Display-side hour formatting uses ``formatMinutes`` from
// attendance/timeFormat for consistent ``8h 45m`` rendering. Date +
// time rendering is centralised in ``util/datetime`` (migration 0068).

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
  for (const row of rows) {
    lines.push(row.map(escape).join(","));
  }
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** What the active preview reports back to the options card so the
 *  download buttons can disable on an empty / loading dataset. */
interface PreviewMeta {
  total: number;
  isLoading: boolean;
  isError: boolean;
}

const PREVIEW_DAYS_CAP = 31;

export function ReportsPage() {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [activeReport, setActiveReport] = useState<ReportKey>("attendance");
  // Attendance uses a date range (start..end); Event Log + Department
  // Summary keep a single-day picker. The single ``date`` state below
  // backs both — for Attendance it tracks the start day, with
  // ``endDate`` carrying the upper bound.
  const [date, setDate] = useState<string>(todayIso());
  const [endDate, setEndDate] = useState<string>(todayIso());
  const [preset, setPreset] = useState<PresetKey>("today");
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [rematchOpen, setRematchOpen] = useState(false);
  const [meta, setMeta] = useState<PreviewMeta>({ total: 0, isLoading: true, isError: false });
  const me = useMe();
  // Re-match rewrites detection history + triggers attendance
  // recompute, so it's gated to operator roles. Admin + HR both
  // already have full org visibility; Manager + Employee stay out.
  const canRematch =
    !!me.data?.roles?.includes("Admin") ||
    !!me.data?.roles?.includes("HR");

  // Every report download (XLSX / PDF / CSV) is gated through this
  // confidentiality modal so the operator has to acknowledge the
  // org-internal red line before the file leaves the browser.
  const { gate: gateDownload, modal: confidentialModal } =
    useConfidentialDownload();

  useEffect(() => {
    setInfo(null);
    setError(null);
  }, [activeReport, date, endDate]);

  // Sync start/end whenever a preset (non-custom) is chosen.
  useEffect(() => {
    if (preset === "custom") return;
    const { start: s, end: e } = presetRange(preset);
    setDate(s);
    setEndDate(e);
  }, [preset]);

  // ``true`` when the preview covers fewer days than the operator
  // selected because the cap kicked in.
  const truncated =
    activeReport === "attendance" &&
    enumerateDays(date, endDate, PREVIEW_DAYS_CAP + 1).length > PREVIEW_DAYS_CAP;

  const PRESET_LABELS = getPresetLabels(t);
  const noData = meta.isLoading || meta.isError || meta.total === 0;
  const busy = downloading !== null;

  const onDownloadAttendance = (format: "xlsx" | "pdf") => {
    const rangeLabel = date === endDate ? date : `${date} → ${endDate}`;
    gateDownload({
      format,
      reportName: `Attendance — ${rangeLabel}`,
      action: async () => {
        if (format === "pdf") {
          // PDF flow: warning modal first, then PdfOptionsModal,
          // then the actual download (the options modal owns its
          // own busy state).
          setPdfModalOpen(true);
          return;
        }
        await downloadAttendance({
          format,
          start: date,
          end: endDate,
          setDownloading,
          setInfo,
          setError,
          t,
        });
      },
    });
  };

  const onDownloadEventLog = () => {
    gateDownload({
      format: "csv",
      reportName: `Event log — ${date}`,
      action: () =>
        downloadEventLog({ date, dt, setDownloading, setInfo, setError, t }),
    });
  };

  const onDownloadDeptSummary = () => {
    gateDownload({
      format: "csv",
      reportName: `Department summary — ${date}`,
      action: () =>
        downloadDepartmentSummary({ date, setDownloading, setInfo, setError, t }),
    });
  };

  // Primary action for the "no records" empty state — offer a wider
  // range first, then fall back to the page that creates the data.
  const emptyAction: ReactNode =
    activeReport === "attendance" ? (
      preset !== "last-7" && preset !== "custom" ? (
        <button type="button" className="btn" onClick={() => setPreset("last-7")}>
          <Icon name="calendar" size={12} />
          {t("reports.emptyState.widenRange", { defaultValue: "Show last 7 days" })}
        </button>
      ) : (
        <Link to="/daily-attendance" className="btn">
          <Icon name="refresh" size={12} />
          {t("reports.emptyState.goRegenerate", { defaultValue: "Regenerate from events" })}
        </Link>
      )
    ) : activeReport === "event-log" ? (
      date !== todayIso() ? (
        <button type="button" className="btn" onClick={() => setDate(todayIso())}>
          <Icon name="calendar" size={12} />
          {t("reports.emptyState.useToday", { defaultValue: "Use today" })}
        </button>
      ) : (
        <Link to="/camera-logs" className="btn">
          <Icon name="camera" size={12} />
          {t("reports.emptyState.openCameraLogs", { defaultValue: "Open camera logs" })}
        </Link>
      )
    ) : (
      <Link to="/daily-attendance" className="btn">
        <Icon name="calendar" size={12} />
        {t("reports.emptyState.openDaily", { defaultValue: "Open daily attendance" })}
      </Link>
    );

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("reports.title")}</h1>
          <p className="page-sub">{t("reports.sub")}</p>
        </div>
        <div className="page-actions">
          {canRematch && activeReport === "attendance" && (
            <button
              type="button"
              className="btn"
              onClick={() => setRematchOpen(true)}
              title={t("reports.rematchTitle")}
            >
              <Icon name="refresh" size={12} />
              {t("reports.rematchBtn")}
            </button>
          )}
        </div>
      </div>

      {(info || error) && (
        <div className={`rp-banner ${error ? "tone-danger" : "tone-success"}`} role="status">
          <Icon name={error ? "x" : "check"} size={14} />
          {error ?? info}
        </div>
      )}

      {/* ── Report type: three tiles across the full width ────── */}
      <div
        className="rp-types"
        role="radiogroup"
        aria-label={t("reports.options.type", { defaultValue: "Report type" })}
      >
        <ReportOption
          active={activeReport === "attendance"}
          onClick={() => setActiveReport("attendance")}
          icon="fileText"
          title={t("reports.cards.attendance.title")}
          subtitle={t("reports.cards.attendance.sub")}
          meta={t("reports.cards.attendance.meta")}
        />
        <ReportOption
          active={activeReport === "event-log"}
          onClick={() => setActiveReport("event-log")}
          icon="activity"
          title={t("reports.cards.eventLog.title")}
          subtitle={t("reports.cards.eventLog.sub")}
          meta={t("reports.cards.eventLog.meta")}
        />
        <ReportOption
          active={activeReport === "department-summary"}
          onClick={() => setActiveReport("department-summary")}
          icon="users"
          title={t("reports.cards.deptSummary.title")}
          subtitle={t("reports.cards.deptSummary.sub")}
          meta={t("reports.cards.deptSummary.meta")}
        />
      </div>

      {/* ── Control bar: range on the start side, downloads on the end ── */}
      <div className="rp-controls">
        <div className="rp-controls-range">
          {activeReport === "attendance" ? (
            <>
              <span className="rp-controls-label">
                {t("reports.attendance.rangeLabel", { defaultValue: "Range" })}
              </span>
              <div className="seg rp-presets" role="group" aria-label={t("reports.attendance.rangePresetAria")}>
                {PRESET_LABELS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    className={`seg-btn${preset === key ? " active" : ""}`}
                    aria-pressed={preset === key}
                    onClick={() => setPreset(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {preset === "custom" && (
                <div className="rp-range">
                  <DatePicker
                    value={date}
                    onChange={(next) => {
                      setDate(next);
                      // Keep end ≥ start to avoid an inverted range.
                      if (endDate < next) setEndDate(next);
                    }}
                    max={todayIso()}
                    ariaLabel={t("reports.attendance.fromDateAria")}
                    triggerStyle={fieldDateStyle}
                  />
                  <span className="rp-range-arrow" aria-hidden>→</span>
                  <DatePicker
                    value={endDate}
                    onChange={setEndDate}
                    min={date}
                    max={todayIso()}
                    ariaLabel={t("reports.attendance.toDateAria")}
                    triggerStyle={fieldDateStyle}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              <span className="rp-controls-label">{t("reports.preview.dateAria")}</span>
              <DatePicker
                value={date}
                onChange={setDate}
                max={todayIso()}
                ariaLabel={activeReport === "event-log" ? t("reports.eventLog.dateAria") : t("reports.preview.dateAria")}
                triggerStyle={fieldDateStyle}
              />
            </>
          )}
        </div>

        <div className="rp-controls-actions">
          {activeReport === "attendance" && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => onDownloadAttendance("pdf")}
                disabled={busy || noData}
                title={noData ? t("reports.preview.noDataTitle") : undefined}
              >
                <Icon name="fileText" size={13} />
                {downloading === "pdf" ? t("reports.preview.generatingPdf") : t("reports.preview.downloadPdf")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onDownloadAttendance("xlsx")}
                disabled={busy || noData}
                title={noData ? t("reports.preview.noDataTitle") : undefined}
              >
                <Icon name="download" size={13} />
                {downloading === "xlsx" ? t("reports.preview.downloading") : t("reports.preview.downloadXlsx", { defaultValue: "Download XLSX" })}
              </button>
            </>
          )}
          {activeReport === "event-log" && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onDownloadEventLog}
              disabled={busy || noData}
              title={noData ? t("reports.eventLog.noExportTitle") : undefined}
            >
              <Icon name="download" size={13} />
              {downloading === "xlsx" ? t("reports.eventLog.downloading") : t("reports.eventLog.downloadCsv")}
            </button>
          )}
          {activeReport === "department-summary" && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onDownloadDeptSummary}
              disabled={busy || noData}
              title={noData ? t("reports.preview.noDataTitle") : undefined}
            >
              <Icon name="download" size={13} />
              {downloading === "xlsx" ? t("reports.preview.downloading") : t("reports.deptSummary.downloadCsv")}
            </button>
          )}
        </div>

        {truncated && (
          <div className="rp-controls-note rp-hint tone-warning">
            {t("reports.attendance.previewCapTitle", { n: PREVIEW_DAYS_CAP })}
          </div>
        )}
      </div>

      {/* ── Preview: full width ───────────────────────────────── */}
      <section className="rp-preview">
        {activeReport === "attendance" && (
          <AttendancePreview start={date} end={endDate} onMeta={setMeta} emptyAction={emptyAction} />
        )}
        {activeReport === "event-log" && (
          <EventLogPreview date={date} onMeta={setMeta} emptyAction={emptyAction} />
        )}
        {activeReport === "department-summary" && (
          <DepartmentSummaryPreview date={date} onMeta={setMeta} emptyAction={emptyAction} />
        )}
      </section>

      <PdfOptionsModal
        open={pdfModalOpen}
        onClose={() => {
          if (downloading !== "pdf") setPdfModalOpen(false);
        }}
        onConfirm={async (includePhotos) => {
          await downloadAttendance({
            format: "pdf",
            start: date,
            end: endDate,
            pdfOpts: { includeEmployeePhotos: includePhotos },
            setDownloading,
            setInfo,
            setError,
            t,
          });
          setPdfModalOpen(false);
        }}
        busy={downloading === "pdf"}
      />

      {rematchOpen && (
        <RematchModal onClose={() => setRematchOpen(false)} />
      )}

      {confidentialModal}
    </>
  );
}

// ---------------------------------------------------------------------------
// Report type option (vertical list inside the options card)
// ---------------------------------------------------------------------------

function ReportOption({
  active,
  onClick,
  icon,
  title,
  subtitle,
  meta,
}: {
  active: boolean;
  onClick: () => void;
  icon: IconName;
  title: string;
  subtitle: string;
  meta: string;
}) {
  return (
    <button type="button" className="rp-type" onClick={onClick} role="radio" aria-checked={active}>
      <span className="rp-type-top">
        <span aria-hidden className="rp-type-icon">
          <Icon name={icon} size={18} />
        </span>
        <span aria-hidden className="rp-type-check">
          {active && <Icon name="check" size={12} />}
        </span>
      </span>
      <span className="rp-type-title">{title}</span>
      <span className="rp-type-desc">{subtitle}</span>
      <span className="rp-type-meta">{meta}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Attendance preview (date range)
// ---------------------------------------------------------------------------

function AttendancePreview({
  start,
  end,
  onMeta,
  emptyAction,
}: {
  start: string;
  end: string;
  onMeta: (m: PreviewMeta) => void;
  emptyAction: ReactNode;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Multi-day preview — enumerate every date in [start..end] and
  // fetch in parallel via useQueries so picking "Last 7 days" /
  // "This week" actually shows multiple days of rows. Capped at
  // PREVIEW_DAYS_CAP so a wide custom range doesn't fire 90+
  // round-trips just to fill a preview; the downloaded XLSX/PDF
  // still covers the full range.
  const dates = useMemo(() => enumerateDays(start, end, PREVIEW_DAYS_CAP), [start, end]);
  const dayQueries = useQueries({
    queries: dates.map((d) => ({
      queryKey: ["attendance", d, null] as const,
      queryFn: () => api<AttendanceListResponse>(`/api/attendance?date=${d}`),
      staleTime: 30 * 1000,
    })),
  });
  const isLoading = dayQueries.some((q) => q.isLoading);
  const isError = dayQueries.some((q) => q.isError);
  const errorMessage = dayQueries.find((q) => q.error)?.error?.message ?? null;
  const items = useMemo(
    () => dayQueries.flatMap((q) => q.data?.items ?? []),
    [dayQueries],
  );
  const total = items.length;
  const retry = () => {
    for (const q of dayQueries) if (q.isError) void q.refetch();
  };

  useEffect(() => {
    onMeta({ total, isLoading, isError });
  }, [total, isLoading, isError, onMeta]);

  // Reset to page 1 when the range or page size changes — otherwise a
  // smaller dataset can leave us on an out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [start, end, pageSize]);

  const pageStart = (page - 1) * pageSize;
  const previewItems = items.slice(pageStart, pageStart + pageSize);

  return (
    <PreviewCard
      title={t("reports.preview.cardTitle", { title: t("reports.cards.attendance.title") })}
      subtitle={t("reports.preview.subtitleRange", { date: start, end })}
      state={isLoading ? "loading" : isError ? "error" : total === 0 ? "empty" : "ready"}
      errorBody={errorMessage ?? t("reports.preview.loadFailed")}
      onRetry={retry}
      empty={{
        icon: <StrokeIcon>{ATT_ICON.calendar}</StrokeIcon>,
        title: t("reports.emptyState.attendanceTitle", { defaultValue: "No attendance in this range" }),
        body: t("reports.attendance.empty", { date: start }),
        action: emptyAction,
      }}
      footer={
        <Pager
          page={page}
          pageSize={pageSize}
          total={total}
          setPage={setPage}
          setPageSize={setPageSize}
        />
      }
      columns={[
        t("reports.attendance.colNum"),
        t("reports.attendance.colEmployeeId"),
        t("reports.attendance.colName"),
        t("reports.attendance.colDept"),
        t("reports.attendance.colDate"),
        t("reports.attendance.colStatus"),
        t("reports.attendance.colIn"),
        t("reports.attendance.colOut"),
        t("reports.attendance.colHours"),
        t("reports.attendance.colOt"),
      ]}
    >
      {previewItems.map((it, idx) => (
        <tr key={`${it.employee_id}-${it.date}`}>
          <td className="text-sm text-dim mono">{pageStart + idx + 1}</td>
          <td className="mono text-sm at-nowrap">{it.employee_code}</td>
          <td className="text-sm row-person-name">{it.full_name}</td>
          <td className="text-sm">{it.department.name}</td>
          <td className="mono text-sm">{dt.formatLocalDate(it.date)}</td>
          <td>
            <DailyStatusPill item={it} />
          </td>
          <td className="mono text-sm">{dt.formatLocalTime(it.in_time) || "—"}</td>
          <td className="mono text-sm">{dt.formatLocalTime(it.out_time) || "—"}</td>
          <td className="mono text-sm">{formatMinutes(it.total_minutes)}</td>
          <td className="mono text-sm">
            {it.overtime_minutes > 0
              ? formatMinutes(it.overtime_minutes)
              : "—"}
          </td>
        </tr>
      ))}
    </PreviewCard>
  );
}

function DailyStatusPill({ item }: { item: AttendanceItem }) {
  const { t } = useTranslation();
  if (item.leave_type_id !== null) {
    return <DotPill tone="info">{t("reports.status.onLeave")}</DotPill>;
  }
  if (item.is_holiday && !item.in_time) {
    return (
      <DotPill tone="accent">
        {item.holiday_name
          ? t("reports.status.holidayNamed", { name: item.holiday_name })
          : t("reports.status.holiday")}
      </DotPill>
    );
  }
  if (item.is_weekend && !item.in_time) {
    return <DotPill tone="neutral">{t("reports.status.weekend")}</DotPill>;
  }
  if (item.pending) {
    return <DotPill tone="info">{t("reports.status.waitingLogin")}</DotPill>;
  }
  if (!item.in_time) {
    return <DotPill tone="danger">{t("reports.status.absent")}</DotPill>;
  }
  if (item.late) {
    return <DotPill tone="warning">{t("reports.status.late")}</DotPill>;
  }
  return <DotPill tone="success">{t("reports.status.present")}</DotPill>;
}

async function downloadAttendance({
  format,
  start,
  end,
  pdfOpts,
  setDownloading,
  setInfo,
  setError,
  t,
}: {
  format: "xlsx" | "pdf";
  start: string;
  end: string;
  pdfOpts?: { includeEmployeePhotos: boolean };
  setDownloading: (v: "xlsx" | "pdf" | null) => void;
  setInfo: (v: string | null) => void;
  setError: (v: string | null) => void;
  t: TFunction<"translation", undefined>;
}): Promise<void> {
  if (start > end) {
    setError(t("reports.attendance.startBeforeEnd"));
    return;
  }
  setDownloading(format);
  setError(null);
  setInfo(null);
  try {
    const path =
      format === "pdf"
        ? "/api/reports/attendance.pdf"
        : "/api/reports/attendance.xlsx";
    const body: Record<string, unknown> = { start, end };
    if (format === "pdf" && pdfOpts) {
      body.include_employee_photos = pdfOpts.includeEmployeePhotos;
    }
    const resp = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      setError(t("reports.attendance.downloadFailed", { status: resp.status }));
      return;
    }
    const blob = await resp.blob();
    const stem =
      start === end
        ? `attendance_${start}`
        : `attendance_${start}_to_${end}`;
    downloadBlob(blob, `${stem}.${format}`);
    setInfo(t("reports.attendance.downloaded", { filename: `${stem}.${format}` }));
  } catch {
    setError(t("reports.attendance.networkError"));
  } finally {
    setDownloading(null);
  }
}

// ---------------------------------------------------------------------------
// Event Log preview
// ---------------------------------------------------------------------------

// Convert a YYYY-MM-DD picked in the browser into a true UTC window
// covering that local day. Sending naive strings would let Postgres
// coerce them to UTC (session TZ) and exclude events that landed in
// the local day but live in a different UTC date — see e.g. Asia/Muscat
// 01:30 maps to UTC 21:30 the previous day.
function localDayUtcRange(date: string): { start: string; end: string } {
  const startLocal = new Date(`${date}T00:00:00`);
  const endLocal = new Date(`${date}T23:59:59.999`);
  return { start: startLocal.toISOString(), end: endLocal.toISOString() };
}

function useEventLog(date: string, page: number, pageSize: number, reload: number) {
  const { start, end } = localDayUtcRange(date);
  return useApi<DetectionEventListResponse>(
    `/api/detection-events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&page=${page}&page_size=${pageSize}`,
    [date, page, pageSize, reload],
  );
}

function useApi<T>(
  path: string,
  deps: ReadonlyArray<unknown>,
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<T>(path)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, loading, error };
}

function EventLogPreview({
  date,
  onMeta,
  emptyAction,
}: {
  date: string;
  onMeta: (m: PreviewMeta) => void;
  emptyAction: ReactNode;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setPage(1);
  }, [date, pageSize]);

  const evts = useEventLog(date, page, pageSize, reload);
  const items = evts.data?.items ?? [];
  const total = evts.data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  useEffect(() => {
    onMeta({ total, isLoading: evts.loading, isError: !!evts.error });
  }, [total, evts.loading, evts.error, onMeta]);

  const columns = [
    t("reports.eventLog.colNum"),
    t("reports.eventLog.colPhoto"),
    t("reports.eventLog.colEventId"),
    t("reports.eventLog.colTimestamp"),
    t("reports.eventLog.colCamera"),
    t("reports.eventLog.colEmployee"),
    t("reports.eventLog.colConfidence"),
    t("reports.eventLog.colType"),
  ];

  return (
    <PreviewCard
      title={t("reports.eventLog.cardTitle")}
      subtitle={
        total === 0
          ? t("reports.eventLog.noEvents", { date })
          : t("reports.eventLog.showing", { from: rangeStart, to: rangeEnd, total, date })
      }
      state={evts.loading ? "loading" : evts.error ? "error" : total === 0 ? "empty" : "ready"}
      errorBody={evts.error ?? t("reports.eventLog.loadFailed")}
      onRetry={() => setReload((n) => n + 1)}
      empty={{
        icon: <StrokeIcon>{ATT_ICON.face}</StrokeIcon>,
        title: t("reports.emptyState.eventsTitle", { defaultValue: "No detections on this day" }),
        body: t("reports.eventLog.emptyDate", { date }),
        action: emptyAction,
      }}
      footer={
        <Pager
          page={page}
          pageSize={pageSize}
          total={total}
          setPage={setPage}
          setPageSize={setPageSize}
        />
      }
      columns={columns}
    >
      {items.map((evt, idx) => (
        <tr key={evt.id}>
          <td className="text-sm text-dim mono">
            {(page - 1) * pageSize + idx + 1}
          </td>
          <td>
            {evt.has_crop ? (
              <img
                src={`/api/detection-events/${evt.id}/crop`}
                alt={`Event ${evt.id}`}
                loading="lazy"
                className="at-thumb sm"
              />
            ) : (
              <span aria-hidden className="at-thumb-empty sm">—</span>
            )}
          </td>
          <td className="mono text-sm">
            EV-{String(evt.id).padStart(6, "0")}
          </td>
          <td className="mono text-sm at-nowrap">
            {dt.formatDateTime(evt.captured_at) || evt.captured_at}
          </td>
          <td className="text-sm">{evt.camera_name}</td>
          <td className="text-sm">
            {evt.employee_name ? (
              <>
                <span className="row-person-name">{evt.employee_name}</span>
                {evt.employee_code && (
                  <span className="mono text-xs text-dim">
                    {" "}
                    · {evt.employee_code}
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs text-dim">{t("reports.eventLog.unidentified")}</span>
            )}
          </td>
          <td className="mono text-sm">
            {evt.confidence !== null
              ? `${(evt.confidence * 100).toFixed(1)}%`
              : "—"}
          </td>
          <td className="text-sm text-dim">—</td>
        </tr>
      ))}
    </PreviewCard>
  );
}

async function downloadEventLog({
  date,
  dt,
  setDownloading,
  setInfo,
  setError,
  t,
}: {
  date: string;
  dt: import("../../util/datetime").TenantDateTime;
  setDownloading: (v: "xlsx" | "pdf" | null) => void;
  setInfo: (v: string | null) => void;
  setError: (v: string | null) => void;
  t: TFunction<"translation", undefined>;
}): Promise<void> {
  setDownloading("xlsx");
  setError(null);
  setInfo(null);
  try {
    const { start, end } = localDayUtcRange(date);
    // Pull all rows in chunks (page_size capped at 200).
    const all: DetectionEventRow[] = [];
    let page = 1;
    while (true) {
      const resp = await api<DetectionEventListResponse>(
        `/api/detection-events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&page_size=200&page=${page}`,
      );
      all.push(...resp.items);
      if (page * resp.page_size >= resp.total) break;
      page += 1;
      if (page > 50) break; // 10 000 rows safety stop.
    }
    const csv = rowsToCsv(
      ["#", "Event ID", "Timestamp", "Camera", "Employee", "Employee code", "Confidence"],
      all.map((evt, idx) => [
        idx + 1,
        `EV-${String(evt.id).padStart(6, "0")}`,
        dt.formatDateTime(evt.captured_at) || evt.captured_at,
        evt.camera_name,
        evt.employee_name ?? "Unidentified",
        evt.employee_code ?? "",
        evt.confidence !== null
          ? `${(evt.confidence * 100).toFixed(1)}%`
          : "",
      ]),
    );
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `event_log_${date}.csv`,
    );
    setInfo(t("reports.eventLog.downloadedInfo", { date, n: all.length }));
  } catch (e) {
    setError((e as Error).message);
  } finally {
    setDownloading(null);
  }
}

// ---------------------------------------------------------------------------
// Department Summary preview
// ---------------------------------------------------------------------------

interface DeptRow {
  id: number;
  code: string;
  name: string;
  headcount: number;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  totalMinutes: number;
}

// Classify an attendance row into a department-summary bucket.
// Mirrors DailyStatusPill's logic so the per-department totals match
// what the user sees on the daily attendance page. Weekend/holiday/
// pending rows aren't part of "today's working population" and are
// excluded by returning ``null``.
type SummaryBucket = "present" | "late" | "absent" | "onLeave";

function classifyForSummary(it: AttendanceItem): SummaryBucket | null {
  // Leave wins — engine clears ``absent`` on a leave day, so the marker
  // is leave_type_id, not absent.
  if (it.leave_type_id !== null) return "onLeave";
  if (it.is_holiday && !it.in_time) return null;
  if (it.is_weekend && !it.in_time) return null;
  if (it.pending) return null;
  if (!it.in_time) return "absent";
  if (it.late) return "late";
  return "present";
}

function emptyDeptRow(d: { id: number; code: string; name: string }): DeptRow {
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    headcount: 0,
    present: 0,
    late: 0,
    absent: 0,
    onLeave: 0,
    totalMinutes: 0,
  };
}

function applyToDeptRow(row: DeptRow, it: AttendanceItem): void {
  // Total employees = one row per active employee (the scheduler
  // emits one attendance_records row per active employee per day —
  // weekend, holiday, and pending rows still count toward the
  // department roster, they just don't bucket into present/late/
  // absent/on-leave).
  row.headcount += 1;
  const bucket = classifyForSummary(it);
  if (bucket === null) return;
  row[bucket] += 1;
  if (bucket === "present" || bucket === "late") {
    row.totalMinutes += it.total_minutes ?? 0;
  }
}

function useDepartmentSummary(date: string): {
  rows: DeptRow[];
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const list = useAttendance(date, null);
  const departments = useDepartments();
  const rows = useMemo(() => {
    const items = list.data?.items ?? [];
    const allDepts = departments.data?.items ?? [];
    if (items.length === 0 && allDepts.length === 0) return [];
    const byDept = new Map<number, DeptRow>();
    for (const d of allDepts) byDept.set(d.id, emptyDeptRow(d));
    for (const it of items) {
      let row = byDept.get(it.department.id);
      if (!row) {
        row = emptyDeptRow(it.department);
        byDept.set(it.department.id, row);
      }
      applyToDeptRow(row, it);
    }
    return Array.from(byDept.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
  }, [list.data, departments.data]);

  return {
    rows,
    loading: list.isLoading || departments.isLoading,
    error: list.error?.message ?? departments.error?.message ?? null,
    retry: () => {
      void list.refetch();
      void departments.refetch();
    },
  };
}

function DepartmentSummaryPreview({
  date,
  onMeta,
  emptyAction,
}: {
  date: string;
  onMeta: (m: PreviewMeta) => void;
  emptyAction: ReactNode;
}) {
  const { t } = useTranslation();
  const { rows, loading, error, retry } = useDepartmentSummary(date);
  const previewRows = rows;

  useEffect(() => {
    onMeta({ total: rows.length, isLoading: loading, isError: !!error });
  }, [rows.length, loading, error, onMeta]);

  return (
    <PreviewCard
      title={t("reports.preview.cardTitle", { title: t("reports.cards.deptSummary.title") })}
      subtitle={t("reports.preview.subtitleSingle", { date })}
      state={loading ? "loading" : error ? "error" : rows.length === 0 ? "empty" : "ready"}
      errorBody={error ?? t("reports.preview.loadFailed")}
      onRetry={retry}
      empty={{
        icon: <StrokeIcon>{ATT_ICON.people}</StrokeIcon>,
        title: t("reports.emptyState.deptTitle", { defaultValue: "No departments to summarise" }),
        body: t("reports.deptSummary.empty"),
        action: emptyAction,
      }}
      footer={
        <span>
          {t("reports.preview.footerRows", { count: previewRows.length, total: rows.length })}
        </span>
      }
      columns={[
        t("reports.deptSummary.colNum"),
        t("reports.deptSummary.colDept"),
        t("reports.deptSummary.colTotal"),
        t("reports.deptSummary.colPresent"),
        t("reports.deptSummary.colLate"),
        t("reports.deptSummary.colAbsent"),
        t("reports.deptSummary.colOnLeave"),
        t("reports.deptSummary.colAvgHours"),
      ]}
    >
      {previewRows.map((r, idx) => {
        const avgWorkedMinutes =
          r.present + r.late > 0
            ? r.totalMinutes / (r.present + r.late)
            : 0;
        return (
          <tr key={r.id}>
            <td className="text-sm text-dim mono">{idx + 1}</td>
            <td className="text-sm row-person-name">{r.name}</td>
            <td className="mono text-sm">{r.headcount}</td>
            <td className="mono text-sm">{r.present}</td>
            <td className="mono text-sm">{r.late}</td>
            <td className="mono text-sm">{r.absent}</td>
            <td className="mono text-sm">{r.onLeave}</td>
            <td className="mono text-sm">
              {avgWorkedMinutes > 0 ? formatMinutes(avgWorkedMinutes) : "—"}
            </td>
          </tr>
        );
      })}
    </PreviewCard>
  );
}

async function downloadDepartmentSummary({
  date,
  setDownloading,
  setInfo,
  setError,
  t,
}: {
  date: string;
  setDownloading: (v: "xlsx" | "pdf" | null) => void;
  setInfo: (v: string | null) => void;
  setError: (v: string | null) => void;
  t: TFunction<"translation", undefined>;
}): Promise<void> {
  setDownloading("xlsx");
  setError(null);
  setInfo(null);
  try {
    type AttRows = {
      date: string;
      items: AttendanceItem[];
    };
    type DeptListResp = {
      items: { id: number; code: string; name: string }[];
    };
    const [attendance, deptResp] = await Promise.all([
      api<AttRows>(`/api/attendance?date=${date}`),
      api<DeptListResp>("/api/departments"),
    ]);
    const items = attendance.items ?? [];
    const grouped = new Map<number, DeptRow>();
    for (const d of deptResp.items ?? []) grouped.set(d.id, emptyDeptRow(d));
    for (const it of items) {
      let row = grouped.get(it.department.id);
      if (!row) {
        row = emptyDeptRow(it.department);
        grouped.set(it.department.id, row);
      }
      applyToDeptRow(row, it);
    }
    const csv = rowsToCsv(
      [
        "#",
        "Department code",
        "Department",
        "Total employees",
        "Present",
        "Late",
        "Absent",
        "On-leave",
        "Avg hours",
      ],
      Array.from(grouped.values())
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((r, idx) => {
          const worked =
            r.present + r.late > 0
              ? r.totalMinutes / 60 / (r.present + r.late)
              : 0;
          return [
            idx + 1,
            r.code,
            r.name,
            r.headcount,
            r.present,
            r.late,
            r.absent,
            r.onLeave,
            worked.toFixed(2),
          ];
        }),
    );
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `department_summary_${date}.csv`,
    );
    setInfo(t("reports.deptSummary.downloadedInfo", { date }));
  } catch (e) {
    setError((e as Error).message);
  } finally {
    setDownloading(null);
  }
}


// ---------------------------------------------------------------------------
// Shared preview card shell — five states: loading / error / empty / ready
// (the "no results for filter" state doesn't apply: the only filter is
// the range itself, which the empty-state action widens).
// ---------------------------------------------------------------------------

type PreviewState = "loading" | "error" | "empty" | "ready";

function PreviewCard({
  title,
  subtitle,
  state,
  errorBody,
  onRetry,
  empty,
  footer,
  columns,
  children,
}: {
  title: string;
  subtitle: string;
  state: PreviewState;
  errorBody: string;
  onRetry: () => void;
  empty: { icon: ReactNode; title: string; body: string; action?: ReactNode };
  footer?: ReactNode;
  columns: string[];
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <div className="at-card-head">
        <div>
          <h3 className="card-title">{title}</h3>
          <div className="card-sub">{subtitle}</div>
        </div>
      </div>
      {state === "error" ? (
        <EmptyPanel
          tone="danger"
          icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
          title={t("reports.preview.errorTitle", { defaultValue: "Couldn't load the preview" })}
          body={errorBody}
          actions={
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" size={12} />
              {t("reports.preview.retry", { defaultValue: "Retry" })}
            </button>
          }
        />
      ) : state === "empty" ? (
        <EmptyPanel
          tone="accent"
          icon={empty.icon}
          title={empty.title}
          body={empty.body}
          {...(empty.action ? { actions: empty.action } : {})}
        />
      ) : (
        <>
          <div className="at-scroll-x">
            <table className="table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state === "loading" ? <SkeletonRows cols={columns.length} /> : children}
              </tbody>
            </table>
          </div>
          {footer && <div className="at-table-foot">{footer}</div>}
        </>
      )}
    </div>
  );
}

// Page size options reused by every paginated preview.
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function Pager({
  page,
  pageSize,
  total,
  setPage,
  setPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  setPage: (next: number) => void;
  setPageSize: (next: number) => void;
}) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const rangeStart = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, safePage * pageSize);
  return (
    <>
      <div className="at-row">
        <span>
          {total === 0
            ? t("reports.pager.zeroRows")
            : t("reports.pager.range", { from: rangeStart, to: rangeEnd, total })}
        </span>
        <label className="rp-pager-size">
          {t("reports.pager.pageSize")}
          <select
            className="select"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="rp-pager">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setPage(1)}
          disabled={page <= 1}
          aria-label={t("reports.pager.firstPage")}
        >
          «
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label={t("reports.pager.prevPage")}
        >
          {t("reports.pager.prev")}
        </button>
        <span className="rp-pager-label mono">
          {t("reports.pager.pageOf", { page: safePage, total: totalPages })}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          aria-label={t("reports.pager.nextPage")}
        >
          {t("reports.pager.next")}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setPage(totalPages)}
          disabled={page >= totalPages}
          aria-label={t("reports.pager.lastPage")}
        >
          »
        </button>
      </div>
    </>
  );
}
