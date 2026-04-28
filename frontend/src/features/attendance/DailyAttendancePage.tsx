// Admin / HR / Manager Daily Attendance page (P12).
// Date picker (defaults to today). Department filter for Admin/HR; the
// backend auto-scopes Manager → assigned departments and 403s if a
// Manager tries to filter outside that set, so the frontend doesn't
// re-enforce scope (red line).

import { useMemo, useState } from "react";

import { useMe } from "../../auth/AuthProvider";
import { primaryRole } from "../../types";
import { useDepartments } from "../departments/hooks";
import { AttendanceDrawer } from "./AttendanceDrawer";
import { useAttendance } from "./hooks";
import type { AttendanceItem } from "./types";

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
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [drawerItem, setDrawerItem] = useState<AttendanceItem | null>(null);

  const list = useAttendance(date, departmentId);
  const departmentsQuery = useDepartments();

  const stats = useMemo(() => {
    const items = list.data?.items ?? [];
    const present = items.filter((it) => !it.absent).length;
    const late = items.filter((it) => it.late && !it.absent).length;
    const absent = items.filter((it) => it.absent).length;
    const overtime = items.filter((it) => it.overtime_minutes > 0).length;
    return { present, late, absent, overtime, total: items.length };
  }, [list.data]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Daily Attendance</h1>
          <p className="page-sub">
            {list.data
              ? `${stats.total} record${stats.total === 1 ? "" : "s"} for ${list.data.date}`
              : "—"}
          </p>
        </div>
        <div className="page-actions">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={selectStyle}
          />
          {isAdminLike && (
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
        </div>
      </div>

      {/* Tiny stat strip — derived client-side from the loaded rows. */}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Tile label="Records" value={String(stats.total)} />
        <Tile label="Present" value={String(stats.present)} />
        <Tile label="Late" value={String(stats.late)} />
        <Tile label="Absent" value={String(stats.absent)} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Records</h3>
          <span className="text-xs text-dim">
            click a row for the detail drawer
          </span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>In</th>
              <th>Out</th>
              <th>Total</th>
              <th>Flags</th>
              <th>Policy</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  Loading…
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={7}
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
                  <div style={{ fontWeight: 500 }}>{it.full_name}</div>
                  <div className="mono text-xs text-dim">{it.employee_code}</div>
                </td>
                <td className="text-sm">
                  <span className="pill pill-neutral">{it.department.code}</span>
                </td>
                <td className="mono text-sm">{it.in_time ?? "—"}</td>
                <td className="mono text-sm">{it.out_time ?? "—"}</td>
                <td className="mono text-sm">
                  {it.total_minutes !== null
                    ? `${(it.total_minutes / 60).toFixed(2)}h`
                    : "—"}
                </td>
                <td>
                  <FlagPills item={it} />
                </td>
                <td className="text-xs text-dim">{it.policy.name}</td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && !list.isLoading && (
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  No records yet for this date. The 15-minute scheduler
                  will populate them as detections come in.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawerItem && (
        <AttendanceDrawer item={drawerItem} onClose={() => setDrawerItem(null)} />
      )}
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 26,
          letterSpacing: "-0.01em",
          marginTop: 4,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function FlagPills({ item }: { item: AttendanceItem }) {
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
