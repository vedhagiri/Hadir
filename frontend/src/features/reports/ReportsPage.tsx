// Reports page — three report types (Attendance / Event Log /
// Department Summary), each with a live preview + Run & download
// button, plus a scheduled-delivery list at the bottom.
//
// Layout matches:
//   docs/scripts/issues-screenshots/06-Daily_Attendance_report.png
//   docs/scripts/issues-screenshots/07-Events_log _report.png
//   docs/scripts/issues-screenshots/08-Department_Summary.png
//
// Attendance flows through /api/reports/attendance.{xlsx,pdf} and
// supports a date range (start..end) — the table preview samples the
// start day, the download streams the full range. Event Log + Dept
// Summary download as client-side CSV blobs for now (server-side
// XLSX/PDF for those types is a follow-up); both keep a single-day
// picker since their data shape is per-event-on-day.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";

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

export function ReportsPage() {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [activeReport, setActiveReport] = useState<ReportKey>("attendance");
  // Attendance uses a date range (start..end); Event Log + Department
  // Summary keep a single-day picker. The single ``date`` state below
  // backs both — for Attendance it tracks the start day's preview
  // sample, with ``endDate`` carrying the upper bound.
  const [date, setDate] = useState<string>(todayIso());
  const [endDate, setEndDate] = useState<string>(todayIso());
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [rematchOpen, setRematchOpen] = useState(false);
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

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("reports.title")}</h1>
          <p className="page-sub">{t("reports.sub")}</p>
        </div>
        <div className="page-actions" style={{ display: "flex", gap: 8 }}>
          {canRematch && activeReport === "attendance" && (
            <button
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

      {/* Three report-type cards */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <ReportTypeCard
          active={activeReport === "attendance"}
          onClick={() => setActiveReport("attendance")}
          icon="fileText"
          title={t("reports.cards.attendance.title")}
          subtitle={t("reports.cards.attendance.sub")}
          meta={t("reports.cards.attendance.meta")}
        />
        <ReportTypeCard
          active={activeReport === "event-log"}
          onClick={() => setActiveReport("event-log")}
          icon="activity"
          title={t("reports.cards.eventLog.title")}
          subtitle={t("reports.cards.eventLog.sub")}
          meta={t("reports.cards.eventLog.meta")}
        />
        <ReportTypeCard
          active={activeReport === "department-summary"}
          onClick={() => setActiveReport("department-summary")}
          icon="users"
          title={t("reports.cards.deptSummary.title")}
          subtitle={t("reports.cards.deptSummary.sub")}
          meta={t("reports.cards.deptSummary.meta")}
        />
      </div>

      {/* Banner */}
      {(info || error) && (
        <div
          className="card"
          role="status"
          style={{
            padding: "10px 14px",
            marginBottom: 12,
            background: error ? "var(--danger-soft)" : "var(--success-soft)",
            color: error ? "var(--danger-text)" : "var(--success-text)",
            fontSize: 13,
            borderColor: "transparent",
          }}
        >
          {error ?? info}
        </div>
      )}

      {/* Preview */}
      {activeReport === "attendance" && (
        <AttendancePreview
          start={date}
          end={endDate}
          setStart={(d) => {
            setDate(d);
            // Keep end ≥ start to avoid an inverted range — when the
            // operator drags the start past the current end, snap end
            // forward. Same affordance most date-range pickers ship.
            if (endDate < d) setEndDate(d);
          }}
          setEnd={setEndDate}
          downloading={downloading}
          onDownload={(format) => {
            const rangeLabel =
              date === endDate ? date : `${date} → ${endDate}`;
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
          }}
        />
      )}
      {activeReport === "event-log" && (
        <EventLogPreview
          date={date}
          setDate={setDate}
          downloading={downloading}
          onDownload={() => {
            gateDownload({
              format: "csv",
              reportName: `Event log — ${date}`,
              action: () =>
                downloadEventLog({
                  date,
                  dt,
                  setDownloading,
                  setInfo,
                  setError,
                  t,
                }),
            });
          }}
        />
      )}
      {activeReport === "department-summary" && (
        <DepartmentSummaryPreview
          date={date}
          setDate={setDate}
          downloading={downloading}
          onDownload={() => {
            gateDownload({
              format: "csv",
              reportName: `Department summary — ${date}`,
              action: () =>
                downloadDepartmentSummary({
                  date,
                  setDownloading,
                  setInfo,
                  setError,
                  t,
                }),
            });
          }}
        />
      )}

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
// Report type cards
// ---------------------------------------------------------------------------

function ReportTypeCard({
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
    <button
      type="button"
      className="card"
      onClick={onClick}
      aria-pressed={active}
      style={{
        textAlign: "start",
        padding: 16,
        border: active
          ? "2px solid var(--accent)"
          : "1px solid var(--border)",
        background: active ? "var(--accent-soft, var(--bg-elev))" : "var(--bg-elev)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        transition: "border-color 120ms ease, background 120ms ease",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          width: 32,
          height: 32,
          borderRadius: 8,
          background: active ? "var(--accent)" : "var(--bg-sunken)",
          color: active ? "white" : "var(--text-secondary)",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 4,
        }}
      >
        <Icon name={icon} size={14} />
      </span>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
        {title}
      </div>
      <div className="text-xs text-dim" style={{ lineHeight: 1.4 }}>
        {subtitle}
      </div>
      <div
        className="text-xs"
        style={{
          color: "var(--text-tertiary)",
          marginTop: 6,
          fontFamily: "var(--font-mono)",
        }}
      >
        {meta}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Attendance preview (date range)
// ---------------------------------------------------------------------------

function AttendancePreview({
  start,
  end,
  setStart,
  setEnd,
  downloading,
  onDownload,
}: {
  start: string;
  end: string;
  setStart: (d: string) => void;
  setEnd: (d: string) => void;
  downloading: "xlsx" | "pdf" | null;
  onDownload: (format: "xlsx" | "pdf") => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const PRESET_LABELS = getPresetLabels(t);
  const [preset, setPreset] = useState<PresetKey>("today");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Sync start/end whenever a preset (non-custom) is chosen.
  useEffect(() => {
    if (preset === "custom") return;
    const { start: s, end: e } = presetRange(preset);
    setStart(s);
    setEnd(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  // Multi-day preview — enumerate every date in [start..end] and
  // fetch in parallel via useQueries so picking "Last 7 days" /
  // "This week" actually shows multiple days of rows. Capped at
  // PREVIEW_DAYS_CAP so a wide custom range doesn't fire 90+
  // round-trips just to fill a preview; the downloaded XLSX/PDF
  // still covers the full range.
  const PREVIEW_DAYS_CAP = 31;
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
  const items = useMemo(
    () => dayQueries.flatMap((q) => q.data?.items ?? []),
    [dayQueries],
  );
  const total = items.length;
  // ``true`` when we're looking at fewer days than the operator
  // selected because the cap kicked in; surfaces a hint near the
  // page-size dropdown.
  const truncated =
    enumerateDays(start, end, PREVIEW_DAYS_CAP + 1).length > PREVIEW_DAYS_CAP;

  // Reset to page 1 when the range or page size changes — otherwise a
  // smaller dataset can leave us on an out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [start, end, pageSize]);

  const pageStart = (page - 1) * pageSize;
  const previewItems = items.slice(pageStart, pageStart + pageSize);

  const presetSelectStyle: React.CSSProperties = {
    padding: "5px 9px",
    fontSize: 12.5,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--bg-elev)",
    color: "var(--text)",
    fontFamily: "var(--font-sans)",
    outline: "none",
  };

  const filterSlot = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <select
        value={preset}
        onChange={(e) => setPreset(e.target.value as PresetKey)}
        aria-label={t("reports.attendance.rangePresetAria")}
        style={presetSelectStyle}
      >
        {PRESET_LABELS.map(({ key, label }) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      {preset === "custom" && (
        <>
          <DatePicker
            value={start}
            onChange={(next) => {
              setStart(next);
              if (end < next) setEnd(next);
            }}
            max={todayIso()}
            ariaLabel={t("reports.attendance.fromDateAria")}
          />
          <span
            style={{
              fontSize: 12,
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            →
          </span>
          <DatePicker
            value={end}
            onChange={setEnd}
            min={start}
            max={todayIso()}
            ariaLabel={t("reports.attendance.toDateAria")}
          />
        </>
      )}
      {truncated && (
        <span
          className="text-xs"
          style={{
            color: "var(--warning-text, var(--warning))",
            fontFamily: "var(--font-mono)",
          }}
          title={t("reports.attendance.previewCapTitle", { n: PREVIEW_DAYS_CAP })}
        >
          {t("reports.attendance.previewCapLabel", { n: PREVIEW_DAYS_CAP })}
        </span>
      )}
    </div>
  );

  return (
    <PreviewCard
      title={t("reports.cards.attendance.title")}
      date={start}
      setDate={setStart}
      endDate={end}
      filterSlot={filterSlot}
      previewCount={previewItems.length}
      totalCount={total}
      pagerSlot={
        <Pager
          page={page}
          pageSize={pageSize}
          total={total}
          setPage={setPage}
          setPageSize={setPageSize}
        />
      }
      isLoading={isLoading}
      isError={isError}
      downloadXlsx={() => onDownload("xlsx")}
      downloadingXlsx={downloading === "xlsx"}
      downloadingPdf={downloading === "pdf"}
      onDownloadPdf={() => onDownload("pdf")}
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
      {previewItems.length === 0 ? (
        <EmptyTableRow colSpan={10}>
          {t("reports.attendance.empty", { date: start })}
        </EmptyTableRow>
      ) : (
        previewItems.map((it, idx) => (
          <tr key={`${it.employee_id}-${it.date}`}>
            <td className="text-sm text-dim mono">{pageStart + idx + 1}</td>
            <td className="mono text-sm">{it.employee_code}</td>
            <td className="text-sm" style={{ fontWeight: 500 }}>
              {it.full_name}
            </td>
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
        ))
      )}
    </PreviewCard>
  );
}

function DailyStatusPill({ item }: { item: AttendanceItem }) {
  const { t } = useTranslation();
  if (item.leave_type_id !== null) {
    return <span className="pill pill-info">{t("reports.status.onLeave")}</span>;
  }
  if (item.is_holiday && !item.in_time) {
    return (
      <span className="pill pill-info">
        {item.holiday_name
          ? t("reports.status.holidayNamed", { name: item.holiday_name })
          : t("reports.status.holiday")}
      </span>
    );
  }
  if (item.is_weekend && !item.in_time) {
    return <span className="pill pill-neutral">{t("reports.status.weekend")}</span>;
  }
  if (item.pending) {
    return <span className="pill pill-info">{t("reports.status.waitingLogin")}</span>;
  }
  if (!item.in_time) {
    return <span className="pill pill-danger">{t("reports.status.absent")}</span>;
  }
  if (item.late) {
    return <span className="pill pill-warning">{t("reports.status.late")}</span>;
  }
  return <span className="pill pill-success">{t("reports.status.present")}</span>;
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

function useEventLog(date: string, page: number, pageSize: number) {
  const { start, end } = localDayUtcRange(date);
  return useApi<DetectionEventListResponse>(
    `/api/detection-events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&page=${page}&page_size=${pageSize}`,
    [date, page, pageSize],
  );
}

// Tiny stand-in for TanStack Query — the existing `useDetectionEvents`
// hook lives in features/camera-logs/hooks.ts but pulls in a richer
// filter shape than we need here, so we use a one-shot fetch.
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
  setDate,
  downloading,
  onDownload,
}: {
  date: string;
  setDate: (d: string) => void;
  downloading: "xlsx" | "pdf" | null;
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    setPage(1);
  }, [date, pageSize]);

  const evts = useEventLog(date, page, pageSize);
  const items = evts.data?.items ?? [];
  const total = evts.data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

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
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">{t("reports.eventLog.cardTitle")}</h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {total === 0
              ? t("reports.eventLog.noEvents", { date })
              : t("reports.eventLog.showing", { from: rangeStart, to: rangeEnd, total, date })}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            className="btn btn-sm"
            onClick={onDownload}
            disabled={downloading !== null || total === 0}
            title={total === 0 ? t("reports.eventLog.noExportTitle") : undefined}
          >
            <Icon name="download" size={11} />
            {downloading === "xlsx" ? t("reports.eventLog.downloading") : t("reports.eventLog.downloadCsv")}
          </button>
          <span
            aria-hidden
            style={{
              width: 1,
              height: 20,
              background: "var(--border)",
              margin: "0 2px",
            }}
          />
          <DatePicker
            value={date}
            onChange={setDate}
            max={todayIso()}
            ariaLabel={t("reports.eventLog.dateAria")}
          />
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                style={{ textTransform: "uppercase", fontSize: 11 }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {evts.loading && (
            <EmptyTableRow colSpan={columns.length}>
              {t("reports.eventLog.loadingPreview")}
            </EmptyTableRow>
          )}
          {evts.error && (
            <tr>
              <td
                colSpan={columns.length}
                className="text-sm"
                style={{ padding: 16, color: "var(--danger-text)" }}
              >
                {t("reports.eventLog.loadFailed")}
              </td>
            </tr>
          )}
          {!evts.loading && !evts.error && items.length === 0 && (
            <EmptyTableRow colSpan={columns.length}>
              {t("reports.eventLog.emptyDate", { date })}
            </EmptyTableRow>
          )}
          {!evts.loading &&
            !evts.error &&
            items.map((evt, idx) => (
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
                      style={{
                        width: 44,
                        height: 44,
                        objectFit: "cover",
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                        background: "var(--bg-sunken)",
                      }}
                    />
                  ) : (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 44,
                        height: 44,
                        borderRadius: 4,
                        border: "1px dashed var(--border)",
                        background: "var(--bg-sunken)",
                        color: "var(--text-tertiary)",
                        fontSize: 10,
                        textAlign: "center",
                        lineHeight: "44px",
                      }}
                    >
                      —
                    </span>
                  )}
                </td>
                <td className="mono text-sm">
                  EV-{String(evt.id).padStart(6, "0")}
                </td>
                <td className="mono text-sm">
                  {dt.formatDateTime(evt.captured_at) || evt.captured_at}
                </td>
                <td className="text-sm">{evt.camera_name}</td>
                <td className="text-sm">
                  {evt.employee_name ? (
                    <>
                      <span style={{ fontWeight: 500 }}>
                        {evt.employee_name}
                      </span>
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
        </tbody>
      </table>

      {/* Pager — Download CSV moved to the card head (top, left of
          the date filter) to mirror the other report cards. */}
      <div
        style={{
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          borderTop: "1px solid var(--border)",
          fontSize: 12.5,
          color: "var(--text-secondary)",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Pager
          page={page}
          pageSize={pageSize}
          total={total}
          setPage={setPage}
          setPageSize={setPageSize}
        />
      </div>
    </div>
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
  };
}

function DepartmentSummaryPreview({
  date,
  setDate,
  downloading,
  onDownload,
}: {
  date: string;
  setDate: (d: string) => void;
  downloading: "xlsx" | "pdf" | null;
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  const { rows, loading, error } = useDepartmentSummary(date);
  const previewRows = rows;
  return (
    <PreviewCard
      title={t("reports.cards.deptSummary.title")}
      date={date}
      setDate={setDate}
      previewCount={previewRows.length}
      totalCount={rows.length}
      isLoading={loading}
      isError={!!error}
      downloadXlsx={onDownload}
      downloadingXlsx={downloading === "xlsx"}
      downloadingPdf={false}
      downloadXlsxLabel={t("reports.deptSummary.downloadCsv")}
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
      {previewRows.length === 0 ? (
        <EmptyTableRow colSpan={8}>
          {t("reports.deptSummary.empty")}
        </EmptyTableRow>
      ) : (
        previewRows.map((r, idx) => {
          const avgWorkedMinutes =
            r.present + r.late > 0
              ? r.totalMinutes / (r.present + r.late)
              : 0;
          return (
            <tr key={r.id}>
              <td className="text-sm text-dim mono">{idx + 1}</td>
              <td className="text-sm" style={{ fontWeight: 500 }}>
                {r.name}
              </td>
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
        })
      )}
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
// Shared preview card shell
// ---------------------------------------------------------------------------

function PreviewCard({
  title,
  date,
  setDate,
  endDate,
  setEndDate,
  filterSlot,
  previewCount,
  totalCount,
  pagerSlot,
  isLoading,
  isError,
  downloadXlsx,
  downloadingXlsx,
  downloadingPdf,
  onDownloadPdf,
  runAndDownload,
  downloadXlsxLabel,
  columns,
  children,
}: {
  title: string;
  date: string;
  setDate: (d: string) => void;
  /** When present the subtitle shows "{start} → {end}". */
  endDate?: string;
  /** When present together with endDate, a second date input renders. */
  setEndDate?: (d: string) => void;
  /** When provided, replaces the built-in date inputs in the card header.
   *  The Run & download button still renders after it. */
  filterSlot?: ReactNode;
  previewCount: number;
  totalCount: number;
  /** When provided, replaces the static "N preview rows · …" footer
   *  text with a paginator + page-size selector. The download buttons
   *  still render to the right. */
  pagerSlot?: ReactNode;
  isLoading: boolean;
  isError: boolean;
  downloadXlsx: () => void;
  downloadingXlsx: boolean;
  downloadingPdf: boolean;
  onDownloadPdf?: () => void;
  // Optional. When omitted the PreviewCard skips the primary
  // "Run & download" button in the header and lets the footer's
  // Download XLSX / PDF buttons carry the action — avoids two
  // visually competing download CTAs.
  runAndDownload?: () => void;
  // Footer button label for the primary download. Defaults to
  // "Download XLSX". Reports that emit CSV pass "Download CSV"
  // so the label matches the file the operator actually gets.
  downloadXlsxLabel?: string;
  columns: string[];
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const hasRange = endDate !== undefined && setEndDate !== undefined;

  const subtitle =
    endDate !== undefined
      ? t("reports.preview.subtitleRange", { date, end: endDate })
      : t("reports.preview.subtitleSingle", { date });

  const xlsxLabel = downloadXlsxLabel ?? t("reports.preview.downloading");

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">{t("reports.preview.cardTitle", { title })}</h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {subtitle}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* Download buttons sit at the leading edge of the filter row
              so the two primary export actions are reachable without
              scrolling the table footer into view. Disabled mirrors the
              footer behaviour — no exports on an empty dataset. */}
          {onDownloadPdf && (
            <button
              className="btn btn-sm"
              onClick={onDownloadPdf}
              disabled={downloadingXlsx || downloadingPdf || totalCount === 0}
              title={totalCount === 0 ? t("reports.preview.noDataTitle") : undefined}
            >
              <Icon name="fileText" size={11} />
              {downloadingPdf ? t("reports.preview.generatingPdf") : t("reports.preview.downloadPdf")}
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={downloadXlsx}
            disabled={downloadingXlsx || downloadingPdf || totalCount === 0}
            title={totalCount === 0 ? t("reports.preview.noDataTitle") : undefined}
          >
            <Icon name="download" size={11} />
            {downloadingXlsx ? t("reports.preview.downloading") : xlsxLabel}
          </button>
          {/* Vertical separator between download actions and filters. */}
          <span
            aria-hidden
            style={{
              width: 1,
              height: 20,
              background: "var(--border)",
              margin: "0 2px",
            }}
          />
          {filterSlot ?? (
            <>
              <DatePicker
                value={date}
                onChange={setDate}
                max={todayIso()}
                ariaLabel={hasRange ? t("reports.preview.startDateAria") : t("reports.preview.dateAria")}
              />
              {hasRange && (
                <>
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--text-tertiary)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    →
                  </span>
                  <DatePicker
                    value={endDate}
                    onChange={setEndDate!}
                    min={date}
                    max={todayIso()}
                    ariaLabel={t("reports.preview.endDateAria")}
                  />
                </>
              )}
            </>
          )}
          {runAndDownload && (
            <button
              className="btn btn-primary btn-sm"
              onClick={runAndDownload}
              disabled={downloadingXlsx || downloadingPdf}
            >
              <Icon name="download" size={11} />
              {downloadingXlsx ? t("reports.preview.downloading") : t("reports.preview.runAndDownload")}
            </button>
          )}
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                style={{ textTransform: "uppercase", fontSize: 11 }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <EmptyTableRow colSpan={columns.length}>{t("reports.preview.loadingPreview")}</EmptyTableRow>
          )}
          {isError && (
            <tr>
              <td
                colSpan={columns.length}
                className="text-sm"
                style={{ padding: 16, color: "var(--danger-text)" }}
              >
                {t("reports.preview.loadFailed")}
              </td>
            </tr>
          )}
          {!isLoading && !isError && children}
        </tbody>
      </table>
      <div
        style={{
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: "1px solid var(--border)",
          fontSize: 12.5,
          color: "var(--text-secondary)",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {pagerSlot ?? (
          <span>
            {totalCount === 0 ? (
              <strong style={{ color: "var(--danger-text)" }}>
                {t("reports.preview.noData")}
              </strong>
            ) : (
              t("reports.preview.footerRows", { count: previewCount, total: totalCount })
            )}
          </span>
        )}
        {/* Download buttons moved to the card head (left of filters).
            The footer keeps the row-count message only. */}
      </div>
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
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span>
          {total === 0
            ? t("reports.pager.zeroRows")
            : t("reports.pager.range", { from: rangeStart, to: rangeEnd, total })}
        </span>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-tertiary)",
          }}
        >
          {t("reports.pager.pageSize")}
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            style={{
              padding: "3px 6px",
              fontSize: 12,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-elev)",
              color: "var(--text)",
              outline: "none",
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          className="btn btn-sm"
          onClick={() => setPage(1)}
          disabled={page <= 1}
          aria-label={t("reports.pager.firstPage")}
        >
          «
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label={t("reports.pager.prevPage")}
        >
          {t("reports.pager.prev")}
        </button>
        <span
          className="mono text-xs"
          style={{ minWidth: 80, textAlign: "center" }}
        >
          {t("reports.pager.pageOf", { page: safePage, total: totalPages })}
        </span>
        <button
          className="btn btn-sm"
          onClick={() => setPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          aria-label={t("reports.pager.nextPage")}
        >
          {t("reports.pager.next")}
        </button>
        <button
          className="btn btn-sm"
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

function EmptyTableRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="text-sm text-dim"
        style={{ padding: 16, textAlign: "center" }}
      >
        {children}
      </td>
    </tr>
  );
}

