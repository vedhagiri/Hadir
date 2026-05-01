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
import type { ReactNode } from "react";

import { api } from "../../api/client";
import { DatePicker } from "../../components/DatePicker";
import { PdfOptionsModal } from "../../components/PdfOptionsModal";
import { Icon, type IconName } from "../../shell/Icon";
import { useAttendance } from "../attendance/hooks";
import type { AttendanceItem } from "../attendance/types";
import { useDepartments } from "../departments/hooks";

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

const PRESET_LABELS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "this-week", label: "This week" },
  { key: "last-3", label: "Last 3 days" },
  { key: "last-7", label: "Last 7 days" },
  { key: "custom", label: "Custom range" },
];

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.length >= 5 ? iso.slice(0, 5) : iso;
}

function decimalHours(minutes: number | null): string {
  if (minutes === null) return "—";
  return `${(minutes / 60).toFixed(1)}h`;
}

function formatTimestamp(iso: string): string {
  // Server sends ISO; render as "YYYY-MM-DD HH:mm:ss" without TZ noise.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${dd} ${hh}:${mm}:${ss}`;
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
  for (const row of rows) {
    lines.push(row.map(escape).join(","));
  }
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ReportsPage() {
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

  useEffect(() => {
    setInfo(null);
    setError(null);
  }, [activeReport, date, endDate]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">
            Preview data live, run on-demand, or schedule delivery to HR &
            managers
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={() => setActiveReport(activeReport)}
            title="Refresh the live preview"
          >
            <Icon name="download" size={12} />
            Download current
          </button>
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
          title="Attendance"
          subtitle="one row per person per day · worked hours vs policy · pick a date range"
          meta="9 columns · xlsx / pdf"
        />
        <ReportTypeCard
          active={activeReport === "event-log"}
          onClick={() => setActiveReport("event-log")}
          icon="activity"
          title="Event Log"
          subtitle="one row per detected face appearance"
          meta="6 columns · xlsx / pdf"
        />
        <ReportTypeCard
          active={activeReport === "department-summary"}
          onClick={() => setActiveReport("department-summary")}
          icon="users"
          title="Department Summary"
          subtitle="aggregated present / late / absent per department per day"
          meta="8 columns · xlsx / pdf"
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
          onDownload={async (format) => {
            if (format === "pdf") {
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
            });
          }}
        />
      )}
      {activeReport === "event-log" && (
        <EventLogPreview
          date={date}
          setDate={setDate}
          downloading={downloading}
          onDownload={async () => {
            await downloadEventLog({
              date,
              setDownloading,
              setInfo,
              setError,
            });
          }}
        />
      )}
      {activeReport === "department-summary" && (
        <DepartmentSummaryPreview
          date={date}
          setDate={setDate}
          downloading={downloading}
          onDownload={async () => {
            await downloadDepartmentSummary({
              date,
              setDownloading,
              setInfo,
              setError,
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
          });
          setPdfModalOpen(false);
        }}
        busy={downloading === "pdf"}
      />
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
  onDownload: (format: "xlsx" | "pdf") => Promise<void>;
}) {
  const [preset, setPreset] = useState<PresetKey>("today");

  // Sync start/end whenever a preset (non-custom) is chosen.
  useEffect(() => {
    if (preset === "custom") return;
    const { start: s, end: e } = presetRange(preset);
    setStart(s);
    setEnd(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  // Live preview samples the start day only — fetching every day in a
  // range client-side would mean N round-trips.
  const list = useAttendance(start, null);
  const items = list.data?.items ?? [];
  const previewItems = items.slice(0, 8);

  const filterSlot = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {/* Preset quick-pick */}
      <div className="seg" role="group" aria-label="Date range preset">
        {PRESET_LABELS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`seg-btn${preset === key ? " active" : ""}`}
            onClick={() => setPreset(key)}
            aria-pressed={preset === key}
          >
            {label}
          </button>
        ))}
      </div>
      {/* Custom date pickers — only shown when Custom is active */}
      {preset === "custom" && (
        <>
          <DatePicker
            value={start}
            onChange={(next) => {
              setStart(next);
              if (end < next) setEnd(next);
            }}
            max={todayIso()}
            ariaLabel="From date"
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
            ariaLabel="To date"
          />
        </>
      )}
    </div>
  );

  return (
    <PreviewCard
      title="Attendance"
      date={start}
      setDate={setStart}
      endDate={end}
      filterSlot={filterSlot}
      previewCount={previewItems.length}
      totalCount={items.length}
      isLoading={list.isLoading}
      isError={list.isError}
      downloadXlsx={() => onDownload("xlsx")}
      downloadingXlsx={downloading === "xlsx"}
      downloadingPdf={downloading === "pdf"}
      onDownloadPdf={() => onDownload("pdf")}
      runAndDownload={() => onDownload("xlsx")}
      columns={[
        "#",
        "Employee ID",
        "Name",
        "Department",
        "Date",
        "Status",
        "In",
        "Out",
        "Hours",
        "OT",
      ]}
    >
      {previewItems.length === 0 ? (
        <EmptyTableRow colSpan={10}>
          No attendance rows for {start}.
        </EmptyTableRow>
      ) : (
        previewItems.map((it, idx) => (
          <tr key={`${it.employee_id}-${it.date}`}>
            <td className="text-sm text-dim mono">{idx + 1}</td>
            <td className="mono text-sm">{it.employee_code}</td>
            <td className="text-sm" style={{ fontWeight: 500 }}>
              {it.full_name}
            </td>
            <td className="text-sm">{it.department.name}</td>
            <td className="mono text-sm">{it.date}</td>
            <td>
              <DailyStatusPill item={it} />
            </td>
            <td className="mono text-sm">{shortTime(it.in_time)}</td>
            <td className="mono text-sm">{shortTime(it.out_time)}</td>
            <td className="mono text-sm">{decimalHours(it.total_minutes)}</td>
            <td className="mono text-sm">
              {it.overtime_minutes > 0
                ? `${(it.overtime_minutes / 60).toFixed(1)}h`
                : "—"}
            </td>
          </tr>
        ))
      )}
    </PreviewCard>
  );
}

function DailyStatusPill({ item }: { item: AttendanceItem }) {
  if (item.absent && item.leave_type_id !== null) {
    return <span className="pill pill-info">On leave</span>;
  }
  if (item.is_holiday && !item.in_time) {
    return (
      <span className="pill pill-info">
        Holiday{item.holiday_name ? ` — ${item.holiday_name}` : ""}
      </span>
    );
  }
  if (item.is_weekend && !item.in_time) {
    return <span className="pill pill-neutral">Weekend</span>;
  }
  if (item.pending) {
    return <span className="pill pill-info">Waiting for login</span>;
  }
  if (!item.in_time) {
    return <span className="pill pill-danger">Absent</span>;
  }
  if (item.late) {
    return <span className="pill pill-warning">Late</span>;
  }
  return <span className="pill pill-success">Present</span>;
}

async function downloadAttendance({
  format,
  start,
  end,
  pdfOpts,
  setDownloading,
  setInfo,
  setError,
}: {
  format: "xlsx" | "pdf";
  start: string;
  end: string;
  pdfOpts?: { includeEmployeePhotos: boolean };
  setDownloading: (v: "xlsx" | "pdf" | null) => void;
  setInfo: (v: string | null) => void;
  setError: (v: string | null) => void;
}): Promise<void> {
  if (start > end) {
    setError("Start date must be on or before end date.");
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
      setError(`Download failed (${resp.status}).`);
      return;
    }
    const blob = await resp.blob();
    // Single-day range collapses the filename to ``attendance_{date}``
    // for backwards compatibility; otherwise the operator gets the
    // full ``attendance_{start}_to_{end}`` shape.
    const stem =
      start === end
        ? `attendance_${start}`
        : `attendance_${start}_to_${end}`;
    downloadBlob(blob, `${stem}.${format}`);
    setInfo(`Downloaded ${stem}.${format}.`);
  } catch {
    setError("Network error.");
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
  onDownload: () => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Reset to page 1 when the date or page-size changes — otherwise
  // a smaller dataset can leave us on an out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [date, pageSize]);

  const evts = useEventLog(date, page, pageSize);
  const items = evts.data?.items ?? [];
  const total = evts.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  const columns = [
    "#",
    "Photo",
    "Event ID",
    "Timestamp",
    "Camera",
    "Employee",
    "Confidence",
    "Type",
  ];

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">Preview · Event Log</h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {total === 0
              ? `No events for ${date}`
              : `Showing ${rangeStart}–${rangeEnd} of ${total} · date ${date}`}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DatePicker
            value={date}
            onChange={setDate}
            max={todayIso()}
            ariaLabel="Event log date"
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={onDownload}
            disabled={downloading !== null}
          >
            <Icon name="download" size={11} />
            {downloading === "xlsx" ? "Downloading…" : "Run & download"}
          </button>
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
              Loading preview…
            </EmptyTableRow>
          )}
          {evts.error && (
            <tr>
              <td
                colSpan={columns.length}
                className="text-sm"
                style={{ padding: 16, color: "var(--danger-text)" }}
              >
                Could not load the preview.
              </td>
            </tr>
          )}
          {!evts.loading && !evts.error && items.length === 0 && (
            <EmptyTableRow colSpan={columns.length}>
              No detection events for {date}.
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
                  {formatTimestamp(evt.captured_at)}
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
                    <span className="text-xs text-dim">Unidentified</span>
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

      {/* Pager */}
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>
            {total === 0
              ? "0 rows"
              : `${rangeStart}–${rangeEnd} of ${total}`}
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
            Page size
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
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            className="btn btn-sm"
            onClick={() => setPage(1)}
            disabled={page <= 1}
            aria-label="First page"
          >
            «
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            ‹ Prev
          </button>
          <span
            className="mono text-xs"
            style={{ minWidth: 80, textAlign: "center" }}
          >
            Page {page} / {totalPages}
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            Next ›
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
            aria-label="Last page"
          >
            »
          </button>
          <button
            className="btn btn-sm"
            onClick={onDownload}
            disabled={downloading !== null}
            style={{ marginInlineStart: 8 }}
          >
            <Icon name="download" size={11} />
            {downloading === "xlsx" ? "Downloading…" : "Download CSV"}
          </button>
        </div>
      </div>
    </div>
  );
}

async function downloadEventLog({
  date,
  setDownloading,
  setInfo,
  setError,
}: {
  date: string;
  setDownloading: (v: "xlsx" | "pdf" | null) => void;
  setInfo: (v: string | null) => void;
  setError: (v: string | null) => void;
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
        formatTimestamp(evt.captured_at),
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
    setInfo(`Downloaded event_log_${date}.csv (${all.length} rows).`);
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
  if (it.is_holiday && !it.in_time) return null;
  if (it.is_weekend && !it.in_time) return null;
  if (it.pending) return null;
  if (it.absent && it.leave_type_id !== null) return "onLeave";
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
  const bucket = classifyForSummary(it);
  if (bucket === null) return;
  row.headcount += 1;
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
    return Array.from(byDept.values())
      .filter((r) => r.headcount > 0)
      .sort((a, b) => b.headcount - a.headcount);
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
  onDownload: () => Promise<void>;
}) {
  const { rows, loading, error } = useDepartmentSummary(date);
  const previewRows = rows.slice(0, 8);
  return (
    <PreviewCard
      title="Department Summary"
      date={date}
      setDate={setDate}
      previewCount={previewRows.length}
      totalCount={rows.length}
      isLoading={loading}
      isError={!!error}
      downloadXlsx={onDownload}
      downloadingXlsx={downloading === "xlsx"}
      downloadingPdf={false}
      runAndDownload={onDownload}
      columns={[
        "#",
        "Department",
        "Head",
        "Headcount",
        "Present",
        "Late",
        "Absent",
        "On-leave",
        "Avg hours",
      ]}
    >
      {previewRows.length === 0 ? (
        <EmptyTableRow colSpan={9}>
          No attendance rows for {date}, so the summary is empty.
        </EmptyTableRow>
      ) : (
        previewRows.map((r, idx) => {
          const workedHours =
            r.present + r.late > 0
              ? r.totalMinutes / 60 / (r.present + r.late)
              : 0;
          return (
            <tr key={r.id}>
              <td className="text-sm text-dim mono">{idx + 1}</td>
              <td className="text-sm" style={{ fontWeight: 500 }}>
                {r.name}
              </td>
              <td className="text-sm text-dim">—</td>
              <td className="mono text-sm">{r.headcount}</td>
              <td className="mono text-sm">{r.present}</td>
              <td className="mono text-sm">{r.late}</td>
              <td className="mono text-sm">{r.absent}</td>
              <td className="mono text-sm">{r.onLeave}</td>
              <td className="mono text-sm">{workedHours.toFixed(1)}h</td>
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
}: {
  date: string;
  setDownloading: (v: "xlsx" | "pdf" | null) => void;
  setInfo: (v: string | null) => void;
  setError: (v: string | null) => void;
}): Promise<void> {
  setDownloading("xlsx");
  setError(null);
  setInfo(null);
  try {
    type AttRows = {
      date: string;
      items: AttendanceItem[];
    };
    const attendance = await api<AttRows>(`/api/attendance?date=${date}`);
    const items = attendance.items ?? [];
    const grouped = new Map<number, DeptRow>();
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
        "Headcount",
        "Present",
        "Late",
        "Absent",
        "On-leave",
        "Avg hours",
      ],
      Array.from(grouped.values())
        .filter((r) => r.headcount > 0)
        .sort((a, b) => b.headcount - a.headcount)
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
    setInfo(`Downloaded department_summary_${date}.csv.`);
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
  isLoading,
  isError,
  downloadXlsx,
  downloadingXlsx,
  downloadingPdf,
  onDownloadPdf,
  runAndDownload,
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
  isLoading: boolean;
  isError: boolean;
  downloadXlsx: () => void;
  downloadingXlsx: boolean;
  downloadingPdf: boolean;
  onDownloadPdf?: () => void;
  runAndDownload: () => void;
  columns: string[];
  children: ReactNode;
}) {
  const hasRange = endDate !== undefined && setEndDate !== undefined;

  // Subtitle shows range whenever endDate is supplied, regardless of
  // whether the built-in date inputs or a filterSlot owns the controls.
  const subtitle =
    endDate !== undefined
      ? `Preview of ${date} · range ${date} → ${endDate}`
      : `Preview · date ${date}`;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">Preview · {title}</h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {subtitle}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {filterSlot ?? (
            <>
              <DatePicker
                value={date}
                onChange={setDate}
                max={todayIso()}
                ariaLabel={hasRange ? "Start date" : "Date"}
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
                    ariaLabel="End date"
                  />
                </>
              )}
            </>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={runAndDownload}
            disabled={downloadingXlsx || downloadingPdf}
          >
            <Icon name="download" size={11} />
            {downloadingXlsx ? "Downloading…" : "Run & download"}
          </button>
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
            <EmptyTableRow colSpan={columns.length}>Loading preview…</EmptyTableRow>
          )}
          {isError && (
            <tr>
              <td
                colSpan={columns.length}
                className="text-sm"
                style={{ padding: 16, color: "var(--danger-text)" }}
              >
                Could not load the preview.
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
        }}
      >
        <span>
          {previewCount} preview row{previewCount === 1 ? "" : "s"} · full
          dataset would be ~{totalCount} rows
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {onDownloadPdf && (
            <button
              className="btn btn-sm"
              onClick={onDownloadPdf}
              disabled={downloadingXlsx || downloadingPdf}
            >
              <Icon name="fileText" size={11} />
              {downloadingPdf ? "Generating PDF…" : "Download PDF"}
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={downloadXlsx}
            disabled={downloadingXlsx || downloadingPdf}
          >
            <Icon name="download" size={11} />
            {downloadingXlsx ? "Downloading…" : "Download XLSX"}
          </button>
        </div>
      </div>
    </div>
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

