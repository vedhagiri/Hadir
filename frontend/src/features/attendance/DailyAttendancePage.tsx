// Admin / HR / Manager Daily Attendance page.
// Layout matches docs/scripts/issues-screenshots/05-Daily_attendance_page.png:
// page-header with regenerate + download buttons, a filter row with a
// segmented scope picker, five stat cards, then a card-wrapped table
// with avatars + status pills.
//
// Backend role-scoping is the source of truth — Manager sees the
// union of department membership + manager_assignments (handled in
// the router, not here).

import { useMemo, useState } from "react";

import { useMe } from "../../auth/AuthProvider";
import { PdfOptionsModal } from "../../components/PdfOptionsModal";
import { primaryRole } from "../../types";
import { useDepartments } from "../departments/hooks";
import { useEmployeeList } from "../employees/hooks";
import { AttendanceDrawer } from "./AttendanceDrawer";
import { useAttendance, useRegenerateAttendance } from "./hooks";
import type { AttendanceItem } from "./types";

type ScopeMode = "company" | "department" | "team" | "individual";

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function DailyAttendancePage() {
  const me = useMe();
  const role = me.data ? primaryRole(me.data.roles) : "Employee";
  const isAdminLike = role === "Admin" || role === "HR";

  const [date, setDate] = useState<string>(todayIso());
  const [scopeMode, setScopeMode] = useState<ScopeMode>("company");
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [drawerItem, setDrawerItem] = useState<AttendanceItem | null>(null);
  const [regenInfo, setRegenInfo] = useState<string | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  // Wire the active scope to backend filters. "Team" is a manager-team
  // filter that we don't have a dedicated endpoint for yet — it falls
  // back to "company" so the page still shows data; the UI surfaces a
  // hint instead of pretending it filters.
  const filterDeptId = scopeMode === "department" ? departmentId : null;
  const filterEmpId = scopeMode === "individual" ? employeeId : null;

  const list = useAttendance(date, filterDeptId, filterEmpId);
  const departmentsQuery = useDepartments();
  const employeesQuery = useEmployeeList({
    q: "",
    department_id: null,
    include_inactive: false,
    page: 1,
    page_size: 200,
  });
  const regenerate = useRegenerateAttendance();

  const stats = useMemo(() => {
    const items = list.data?.items ?? [];
    // Match the StatusPill priority: leave > holiday > weekend >
    // pending > absent (no in_time) > late > present.
    const onLeave = items.filter(
      (it) => it.absent && it.leave_type_id !== null,
    ).length;
    const offDay = items.filter(
      (it) =>
        !it.in_time &&
        it.leave_type_id === null &&
        (it.is_holiday || it.is_weekend),
    ).length;
    const pending = items.filter(
      (it) =>
        it.pending &&
        it.leave_type_id === null &&
        !it.is_holiday &&
        !it.is_weekend,
    ).length;
    const absent = items.filter(
      (it) =>
        !it.in_time &&
        it.leave_type_id === null &&
        !it.pending &&
        !it.is_holiday &&
        !it.is_weekend,
    ).length;
    const late = items.filter((it) => !!it.in_time && it.late).length;
    const present = items.filter((it) => !!it.in_time && !it.late).length;
    return {
      total: items.length,
      present,
      late,
      absent,
      onLeave,
      pending,
      offDay,
    };
  }, [list.data]);

  const onRegenerate = () => {
    setRegenInfo(null);
    regenerate.mutate(date, {
      onSuccess: (resp) => {
        setRegenInfo(
          `Regenerated ${resp.rows_upserted} row${
            resp.rows_upserted === 1 ? "" : "s"
          } for ${resp.date}.`,
        );
      },
      onError: (err) => {
        setRegenInfo(`Regenerate failed: ${(err as Error).message}`);
      },
    });
  };

  const downloadReport = async (
    format: "xlsx" | "pdf",
    pdfOpts?: { includeEmployeePhotos: boolean },
  ) => {
    const path =
      format === "pdf"
        ? "/api/reports/attendance.pdf"
        : "/api/reports/attendance.xlsx";
    const body: Record<string, unknown> = { start: date, end: date };
    if (filterDeptId !== null) body.department_id = filterDeptId;
    if (filterEmpId !== null) body.employee_id = filterEmpId;
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
      setRegenInfo(`Download failed (${resp.status}).`);
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance_${date}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handlePdfRequest = () => setPdfModalOpen(true);
  const handlePdfConfirm = async (includePhotos: boolean) => {
    setPdfBusy(true);
    try {
      await downloadReport("pdf", { includeEmployeePhotos: includePhotos });
    } finally {
      setPdfBusy(false);
      setPdfModalOpen(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Daily attendance</h1>
          <p className="page-sub">
            Generate today's attendance from camera events · download XLSX ·
            filter by person, team or department
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={onRegenerate}
            disabled={regenerate.isPending || !isAdminLike}
            title={
              isAdminLike
                ? "Recompute today's attendance from current detection events"
                : "Admin/HR only"
            }
          >
            <span aria-hidden style={{ marginInlineEnd: 4 }}>↻</span>
            {regenerate.isPending ? "Regenerating…" : "Regenerate from events"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => downloadReport("xlsx")}
            disabled={!list.data}
          >
            <span aria-hidden style={{ marginInlineEnd: 4 }}>⬇</span>
            Download XLSX
          </button>
        </div>
      </div>

      {regenInfo && (
        <div
          className="card"
          style={{
            padding: "10px 14px",
            marginBottom: 12,
            background: "var(--info-soft, var(--bg-sunken))",
            borderColor: "var(--info, var(--border))",
            fontSize: 13,
          }}
        >
          {regenInfo}
        </div>
      )}

      {/* Filter row */}
      <div
        className="card"
        style={{
          padding: "12px 14px",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
            }}
          >
            Date
          </span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={selectStyle}
          />
        </div>

        <div className="seg" role="tablist" aria-label="Attendance scope">
          <SegBtn
            active={scopeMode === "company"}
            onClick={() => setScopeMode("company")}
            icon="◳"
          >
            Company
          </SegBtn>
          <SegBtn
            active={scopeMode === "department"}
            onClick={() => setScopeMode("department")}
            icon="▦"
          >
            Department
          </SegBtn>
          <SegBtn
            active={scopeMode === "team"}
            onClick={() => setScopeMode("team")}
            icon="◇"
          >
            Team
          </SegBtn>
          <SegBtn
            active={scopeMode === "individual"}
            onClick={() => setScopeMode("individual")}
            icon="◯"
          >
            Individual
          </SegBtn>
        </div>

        {scopeMode === "department" && isAdminLike && (
          <select
            value={departmentId ?? ""}
            onChange={(e) =>
              setDepartmentId(
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
            style={selectStyle}
          >
            <option value="">All departments</option>
            {(departmentsQuery.data?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}

        {scopeMode === "individual" && (
          <select
            value={employeeId ?? ""}
            onChange={(e) =>
              setEmployeeId(
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
            style={{ ...selectStyle, minWidth: 220 }}
          >
            <option value="">Select employee…</option>
            {(employeesQuery.data?.items ?? []).map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.full_name} · {emp.employee_code}
              </option>
            ))}
          </select>
        )}

        {scopeMode === "team" && (
          <span
            className="text-xs text-dim"
            style={{ fontStyle: "italic" }}
            title="Manager-team filter — currently shows the same as Company; manager picker arrives later."
          >
            Manager-team filter coming soon
          </span>
        )}

        <div style={{ flex: 1 }} />

        <span
          className="text-xs text-dim"
          style={{ whiteSpace: "nowrap" }}
        >
          {list.data
            ? `${stats.total} employee${stats.total === 1 ? "" : "s"} in scope`
            : "—"}
        </span>
      </div>

      {/* 5 stat cards */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <StatTile label="In scope" value={stats.total} />
        <StatTile label="Present" value={stats.present} tone="success" />
        <StatTile label="Late" value={stats.late} tone="warning" />
        <StatTile label="Absent" value={stats.absent} tone="danger" />
        {stats.pending > 0 && (
          <StatTile label="Waiting" value={stats.pending} tone="info" />
        )}
        {stats.offDay > 0 && (
          <StatTile label="Off day" value={stats.offDay} />
        )}
        <StatTile label="On leave" value={stats.onLeave} tone="info" />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">
              Attendance for {list.data?.date ?? date}
            </h3>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={handlePdfRequest}
              disabled={!list.data || pdfBusy}
            >
              <span aria-hidden style={{ marginInlineEnd: 4 }}>📄</span>
              PDF
            </button>
            <button
              className="btn btn-sm"
              onClick={() => downloadReport("xlsx")}
              disabled={!list.data}
            >
              <span aria-hidden style={{ marginInlineEnd: 4 }}>⬇</span>
              XLSX
            </button>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Status</th>
              <th>In</th>
              <th>Out</th>
              <th>Hours</th>
              <th>OT</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td
                  colSpan={8}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  Loading…
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={8}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  Could not load attendance.
                </td>
              </tr>
            )}
            {list.data?.items.map((it) => (
              <tr
                key={`${it.employee_id}-${it.date}`}
                onClick={() => setDrawerItem(it)}
                style={{ cursor: "pointer" }}
              >
                <td>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <Avatar name={it.full_name} seed={it.employee_code} />
                    <div>
                      <div
                        style={{
                          fontWeight: 500,
                          fontSize: 13,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          color:
                            it.employee_status === "inactive"
                              ? "var(--text-secondary)"
                              : undefined,
                          textDecoration:
                            it.employee_status === "inactive"
                              ? "line-through"
                              : undefined,
                        }}
                      >
                        {it.full_name}
                        {it.employee_status === "inactive" && (
                          <span
                            className="pill pill-neutral"
                            style={{
                              fontSize: 10,
                              textDecoration: "none",
                            }}
                          >
                            archived
                          </span>
                        )}
                      </div>
                      <div className="mono text-xs text-dim">
                        {it.employee_code}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="text-sm">{it.department.name}</td>
                <td>
                  <StatusPill item={it} />
                </td>
                <td className="mono text-sm">{shortTime(it.in_time)}</td>
                <td className="mono text-sm">{shortTime(it.out_time)}</td>
                <td className="mono text-sm">{decimalHours(it.total_minutes)}</td>
                <td className="mono text-sm">
                  {it.overtime_minutes > 0
                    ? `${(it.overtime_minutes / 60).toFixed(1)}h`
                    : "—"}
                </td>
                <td>
                  <FlagText item={it} />
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && !list.isLoading && (
              <tr>
                <td
                  colSpan={8}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  No records yet for this date. Hit{" "}
                  <em>Regenerate from events</em> after detections come in.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawerItem && (
        <AttendanceDrawer item={drawerItem} onClose={() => setDrawerItem(null)} />
      )}

      <PdfOptionsModal
        open={pdfModalOpen}
        onClose={() => {
          if (!pdfBusy) setPdfModalOpen(false);
        }}
        onConfirm={handlePdfConfirm}
        busy={pdfBusy}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SegBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`seg-btn${active ? " active" : ""}`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span aria-hidden style={{ fontSize: 11 }}>
        {icon}
      </span>
      {children}
    </button>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning" | "danger" | "info";
}) {
  const toneBg: Record<string, string> = {
    success: "var(--success-soft)",
    warning: "var(--warning-soft)",
    danger: "var(--danger-soft)",
    info: "var(--info-soft, var(--bg-sunken))",
  };
  const toneColor: Record<string, string> = {
    success: "var(--success-text)",
    warning: "var(--warning-text)",
    danger: "var(--danger-text)",
    info: "var(--info-text, var(--text-secondary))",
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
    </div>
  );
}

function StatusPill({ item }: { item: AttendanceItem }) {
  // Order matters: leave / holiday / weekend take priority over
  // workday verdicts so a row on a non-working day never reads as
  // "Absent" or falls through to "Present" with no in_time.
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
  // No in_time on a workday → Absent, regardless of the engine's
  // ``absent`` flag. Operators read "Present" as "checked in
  // today"; rows without a recorded check-in shouldn't be Present.
  if (!item.in_time) {
    return <span className="pill pill-danger">Absent</span>;
  }
  if (item.late) {
    return <span className="pill pill-warning">Late</span>;
  }
  return <span className="pill pill-success">Present</span>;
}

function FlagText({ item }: { item: AttendanceItem }) {
  const parts: string[] = [];
  if (item.early_out) parts.push("Early out");
  if (item.short_hours) parts.push("Short hours");
  if (item.overtime_minutes > 0) {
    parts.push(`OT ${(item.overtime_minutes / 60).toFixed(1)}h`);
  }
  if (parts.length === 0) {
    return <span className="text-xs text-dim">—</span>;
  }
  return <span className="text-xs">{parts.join(" · ")}</span>;
}

// Avatar — colored circle with up to two initials. Color is derived
// deterministically from ``seed`` (employee_code) so the same person
// gets the same colour across pages.
function Avatar({ name, seed }: { name: string; seed: string }) {
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
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: bg,
        color: "white",
        fontSize: 12,
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
// Helpers
// ---------------------------------------------------------------------------

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  // Server sends "HH:MM:SS"; trim seconds for display.
  return iso.length >= 5 ? iso.slice(0, 5) : iso;
}

function decimalHours(minutes: number | null): string {
  if (minutes === null) return "—";
  return `${(minutes / 60).toFixed(1)}h`;
}

const selectStyle = {
  padding: "6px 10px",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;

// Re-export FlagPills for any consumer that imports it from here
// (the AttendanceDrawer used to use it).
export function FlagPills({ item }: { item: AttendanceItem }) {
  if (item.absent && item.leave_type_id !== null) {
    return <span className="pill pill-info">on leave</span>;
  }
  if (item.pending) {
    return <span className="pill pill-info">waiting</span>;
  }
  if (item.absent) {
    return <span className="pill pill-danger">absent</span>;
  }
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {item.late && <span className="pill pill-warning">late</span>}
      {item.early_out && <span className="pill pill-warning">early</span>}
      {item.short_hours && <span className="pill pill-info">short</span>}
      {item.overtime_minutes > 0 && (
        <span className="pill pill-accent">
          OT {(item.overtime_minutes / 60).toFixed(1)}h
        </span>
      )}
      {!item.late &&
        !item.early_out &&
        !item.short_hours &&
        item.overtime_minutes === 0 && (
          <span className="pill pill-success">on time</span>
        )}
    </div>
  );
}
