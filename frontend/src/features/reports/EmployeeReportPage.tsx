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

import { api } from "../../api/client";
import { DatePicker } from "../../components/DatePicker";
import { PdfOptionsModal } from "../../components/PdfOptionsModal";
import { Icon } from "../../shell/Icon";
import { useEmployeeList, useEmployeeDetail } from "../employees/hooks";
import type { Employee } from "../employees/types";
import type { AttendanceItem, AttendanceListResponse } from "../attendance/types";

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

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.length >= 5 ? iso.slice(0, 5) : iso;
}

function decimalHours(minutes: number | null): string {
  if (minutes === null) return "—";
  return `${(minutes / 60).toFixed(1)}h`;
}

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
  const [start, setStart] = useState<string>(firstOfMonthIso());
  const [end, setEnd] = useState<string>(todayIso());
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(
    null,
  );
  const [showWeekends, setShowWeekends] = useState(false);
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);

  useEffect(() => {
    setInfo(null);
    setError(null);
  }, [selectedEmployeeId, start, end]);

  const employeeQuery = useEmployeeDetail(selectedEmployeeId);
  const employee = employeeQuery.data ?? null;
  const range = useEmployeeAttendance(selectedEmployeeId, start, end);
  const items = range.data?.items ?? [];

  // Stats panel — derived client-side from the loaded rows.
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
      if (it.absent && it.leave_type_id !== null) {
        leave += 1;
      } else if (it.absent) {
        absent += 1;
      } else if (it.late) {
        late += 1;
        present += 1;
        totalMinutes += it.total_minutes ?? 0;
        otMinutes += it.overtime_minutes;
      } else {
        present += 1;
        totalMinutes += it.total_minutes ?? 0;
        otMinutes += it.overtime_minutes;
      }
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
      totalHours: totalMinutes / 60,
      otHours: otMinutes / 60,
      presentPct,
    };
  }, [items, start, end]);

  const visibleDates = useMemo(() => {
    const allDates = rowsBetween(start, end);
    return showWeekends ? allDates : allDates.filter((d) => !isWeekend(d));
  }, [start, end, showWeekends]);

  const itemByDate = useMemo(
    () => new Map(items.map((it) => [it.date, it])),
    [items],
  );

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
        setError(`Download failed (${resp.status}).`);
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
        setError(`Download failed (${resp.status}).`);
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
          shortTime(it?.in_time ?? null),
          shortTime(it?.out_time ?? null),
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
          <h1 className="page-title">Employee report</h1>
          <p className="page-sub">
            Search any employee and get their complete attendance for a
            selected range
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={downloadXlsx}
            disabled={selectedEmployeeId === null || downloading !== null}
          >
            <Icon name="download" size={12} />
            {downloading === "xlsx" ? "Downloading…" : "Download XLSX"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setPdfModalOpen(true)}
            disabled={selectedEmployeeId === null || downloading !== null}
          >
            <Icon name="fileText" size={12} />
            {downloading === "pdf" ? "Generating…" : "PDF"}
          </button>
        </div>
      </div>

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

      {/* Search + range */}
      <div
        className="card"
        style={{
          padding: "12px 14px",
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 320px", minWidth: 260 }}>
          <EmployeeSearch
            value={selectedEmployeeId}
            onChange={setSelectedEmployeeId}
            initial={employee}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
            }}
          >
            Range
          </span>
          <DatePicker
            value={start}
            onChange={setStart}
            max={todayIso()}
            ariaLabel="Start date"
          />
          <DatePicker
            value={end}
            onChange={setEnd}
            min={start}
            max={todayIso()}
            ariaLabel="End date"
          />
          <div className="seg" role="tablist" aria-label="Quick range">
            <button
              type="button"
              className="seg-btn"
              onClick={() => {
                setStart(daysAgoIso(6));
                setEnd(todayIso());
              }}
            >
              7d
            </button>
            <button
              type="button"
              className="seg-btn"
              onClick={() => {
                setStart(daysAgoIso(29));
                setEnd(todayIso());
              }}
            >
              30d
            </button>
            <button
              type="button"
              className="seg-btn"
              onClick={() => {
                setStart(firstOfMonthIso());
                setEnd(todayIso());
              }}
            >
              MTD
            </button>
          </div>
        </div>
      </div>

      {/* Selected-employee card */}
      {selectedEmployeeId === null && (
        <div
          className="card"
          style={{
            padding: 28,
            textAlign: "center",
            color: "var(--text-tertiary)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
            Pick an employee to begin
          </div>
          <div className="text-xs">
            The card and the day-by-day breakdown render once you select someone
            from the search above.
          </div>
        </div>
      )}

      {selectedEmployeeId !== null && employee && (
        <>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <Avatar name={employee.full_name} seed={employee.employee_code} size={56} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: 22,
                    margin: 0,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {employee.full_name}
                </h2>
                <div
                  className="text-sm text-dim"
                  style={{ marginTop: 2 }}
                >
                  <span className="mono">{employee.employee_code}</span>
                  {employee.designation && (
                    <span> · {employee.designation}</span>
                  )}
                  <span> · {employee.department.name}</span>
                  {employee.reports_to_full_name && (
                    <span> · reports to {employee.reports_to_full_name}</span>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    marginTop: 8,
                  }}
                >
                  {(employee.role_codes ?? []).map((r) => (
                    <span key={r} className="pill pill-neutral">
                      {r}
                    </span>
                  ))}
                  <span className="pill pill-accent">
                    {start} → {end} · {visibleDates.length} day
                    {visibleDates.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="btn"
                title="Open the request submission flow on behalf of this employee"
                onClick={() => {
                  window.location.assign("/my-requests");
                }}
              >
                <Icon name="plus" size={11} />
                Raise request
              </button>
            </div>
          </div>

          {/* Stat tiles */}
          <div
            className="grid"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <StatTile label="Working days" value={stats.workingDays} />
            <StatTile
              label="Present"
              value={stats.present}
              tone="success"
              hint={
                stats.workingDays > 0
                  ? `${stats.presentPct}% of working`
                  : undefined
              }
            />
            <StatTile label="Late" value={stats.late} tone="warning" />
            <StatTile label="Absent" value={stats.absent} tone="danger" />
            <StatTile
              label="Total hours"
              value={stats.totalHours.toFixed(1)}
              hint={
                stats.otHours > 0
                  ? `+${stats.otHours.toFixed(1)}h OT`
                  : undefined
              }
              hintTone="success"
            />
          </div>

          {/* Day-by-day breakdown */}
          <div className="card">
            <div className="card-head">
              <div>
                <h3 className="card-title">Day-by-day breakdown</h3>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12.5,
                    color: "var(--text-secondary)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showWeekends}
                    onChange={(e) => setShowWeekends(e.target.checked)}
                  />
                  Show weekends
                </label>
                <button
                  className="btn btn-sm"
                  onClick={downloadDaysCsv}
                  disabled={!employee}
                >
                  <Icon name="download" size={11} />
                  XLSX
                </button>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Day</th>
                  <th>Status</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Hours</th>
                  <th>Overtime</th>
                  <th>Flags</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {range.isLoading && (
                  <tr>
                    <td
                      colSpan={9}
                      className="text-sm text-dim"
                      style={{ padding: 16 }}
                    >
                      Loading…
                    </td>
                  </tr>
                )}
                {range.isError && (
                  <tr>
                    <td
                      colSpan={9}
                      className="text-sm"
                      style={{ padding: 16, color: "var(--danger-text)" }}
                    >
                      Could not load attendance.
                    </td>
                  </tr>
                )}
                {!range.isLoading &&
                  !range.isError &&
                  visibleDates.map((d) => {
                    const it = itemByDate.get(d) ?? null;
                    return (
                      <tr key={d}>
                        <td className="mono text-sm">{d}</td>
                        <td className="text-sm">{dayName(d)}</td>
                        <td>
                          <DayStatusPill item={it} isoDate={d} />
                        </td>
                        <td className="mono text-sm">
                          {shortTime(it?.in_time ?? null)}
                        </td>
                        <td className="mono text-sm">
                          {shortTime(it?.out_time ?? null)}
                        </td>
                        <td className="mono text-sm">
                          {decimalHours(it?.total_minutes ?? null)}
                        </td>
                        <td className="mono text-sm">
                          {it && it.overtime_minutes > 0
                            ? `+${(it.overtime_minutes / 60).toFixed(1)}h`
                            : "—"}
                        </td>
                        <td className="text-xs">
                          {flagText(it)}
                        </td>
                        <td className="text-dim" style={{ textAlign: "end" }}>
                          <span aria-hidden style={{ fontSize: 14 }}>
                            ›
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </>
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
    <div ref={wrapRef} style={{ position: "relative" }}>
      <span
        aria-hidden
        style={{
          position: "absolute",
          insetInlineStart: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--text-tertiary)",
          fontSize: 14,
        }}
      >
        ⌕
      </span>
      <input
        type="text"
        value={open ? q : value !== null ? displayLabel : q}
        placeholder="Search employee by ID (e.g. OM0045) or name…"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          if (e.target.value === "") onChange(null);
        }}
        style={{
          ...inputStyle,
          width: "100%",
          paddingInlineStart: 28,
        }}
      />
      {open && q.length >= 0 && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            insetInlineStart: 0,
            insetInlineEnd: 0,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-md)",
            zIndex: 10,
            maxHeight: 280,
            overflowY: "auto",
          }}
        >
          {list.isLoading && (
            <div
              className="text-sm text-dim"
              style={{ padding: "8px 12px" }}
            >
              Searching…
            </div>
          )}
          {!list.isLoading && items.length === 0 && (
            <div
              className="text-sm text-dim"
              style={{ padding: "8px 12px" }}
            >
              {q.trim() ? "No matches." : "Type to search."}
            </div>
          )}
          {items.map((emp) => (
            <button
              key={emp.id}
              type="button"
              role="option"
              aria-selected={emp.id === value}
              onClick={() => {
                onChange(emp.id);
                setOpen(false);
                setQ("");
              }}
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background:
                  emp.id === value ? "var(--bg-sunken)" : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "start",
              }}
            >
              <Avatar
                name={emp.full_name}
                seed={emp.employee_code}
                size={28}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm" style={{ fontWeight: 500 }}>
                  {emp.full_name}
                </div>
                <div className="mono text-xs text-dim">
                  {emp.employee_code} · {emp.department.name}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  hintTone,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: string | undefined;
  hintTone?: "success" | undefined;
  tone?: "success" | "warning" | "danger" | undefined;
}) {
  const toneBg: Record<string, string> = {
    success: "var(--success-soft)",
    warning: "var(--warning-soft)",
    danger: "var(--danger-soft)",
  };
  const toneColor: Record<string, string> = {
    success: "var(--success-text)",
    warning: "var(--warning-text)",
    danger: "var(--danger-text)",
  };
  const bg = tone ? toneBg[tone] : "var(--bg-elev)";
  const labelColor = tone ? toneColor[tone] : "var(--text-tertiary)";
  return (
    <div
      className="stat"
      style={{
        background: bg,
        border: tone ? "1px solid transparent" : undefined,
      }}
    >
      <div className="stat-label" style={{ color: labelColor }}>
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {hint && (
        <div
          className="text-xs"
          style={{
            marginTop: 4,
            color:
              hintTone === "success"
                ? "var(--success-text)"
                : "var(--text-tertiary)",
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function DayStatusPill({
  item,
  isoDate,
}: {
  item: AttendanceItem | null;
  isoDate: string;
}) {
  if (!item) {
    if (isWeekend(isoDate))
      return <span className="pill pill-neutral">Weekend</span>;
    // Future date inside the range — no record yet.
    if (isoDate > todayIso())
      return <span className="pill pill-neutral">—</span>;
    return <span className="pill pill-neutral">No record</span>;
  }
  if (item.absent && item.leave_type_id !== null) {
    return <span className="pill pill-info">On leave</span>;
  }
  if (item.absent) {
    return <span className="pill pill-danger">Absent</span>;
  }
  if (item.late) {
    return <span className="pill pill-warning">Late</span>;
  }
  return <span className="pill pill-success">Present</span>;
}

function statusLabel(item: AttendanceItem | null): string {
  if (!item) return "No record";
  if (item.absent && item.leave_type_id !== null) return "On leave";
  if (item.absent) return "Absent";
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
    parts.push(`+${(item.overtime_minutes / 60).toFixed(1)}h OT`);
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

// Avatar — colored circle with up to two initials, deterministic from seed.
function Avatar({
  name,
  seed,
  size = 36,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  const initials = (() => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 0) return "?";
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (first + last).toUpperCase() || "?";
  })();
  const palette = [
    "#1f7ae0",
    "#0aa57c",
    "#d97706",
    "#c026d3",
    "#dc2626",
    "#0891b2",
    "#7c3aed",
    "#65a30d",
    "#b45309",
    "#be185d",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const bg = palette[Math.abs(hash) % palette.length] ?? palette[0];
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        color: "white",
        fontSize: Math.round(size * 0.36),
        fontWeight: 600,
        flexShrink: 0,
        letterSpacing: "0.02em",
      }}
    >
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
} {
  const [data, setData] = useState<AttendanceListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);
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
  }, [employeeId, start, end]);
  return { data, isLoading, isError };
}

const inputStyle = {
  padding: "6px 10px",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;
