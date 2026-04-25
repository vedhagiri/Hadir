// Manager dashboard — scoped to the manager's own department(s).
// Backend already enforces the scope: GET /api/attendance returns rows
// only for departments the user is a member of (P3's
// require_department + P10 router). Frontend never widens.

import { useMemo } from "react";

import { useMe } from "../../auth/AuthProvider";
import { useAttendance } from "../attendance/hooks";
import { StatCard } from "./StatCard";
import { StatusBreakdown } from "./StatusBreakdown";
import { FlagPills } from "../attendance/DailyAttendancePage";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ManagerDashboard() {
  const me = useMe();
  // Backend auto-scopes: passing no department_id makes the union of
  // the manager's assigned departments. Trying to widen to a
  // department they don't belong to returns 403.
  const today = useAttendance(todayIso(), null);

  const summary = useMemo(() => {
    const items = today.data?.items ?? [];
    return {
      total: items.length,
      onTime: items.filter(
        (it) => !it.absent && !it.late && !it.early_out && !it.short_hours,
      ).length,
      late: items.filter((it) => it.late && !it.absent).length,
      absent: items.filter((it) => it.absent).length,
      overtime: items.filter((it) => it.overtime_minutes > 0).length,
    };
  }, [today.data]);

  const noDepartments =
    me.data !== null && me.data !== undefined && me.data.departments.length === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data ? `Team today, ${firstName(me.data.full_name)}` : "Team"}
          </h1>
          <p className="page-sub">
            Manager · scoped to your assigned department(s)
          </p>
        </div>
      </div>

      {noDepartments && (
        <div
          className="card"
          style={{
            padding: 14,
            marginBottom: 16,
            background: "var(--warning-soft)",
            color: "var(--warning-text)",
          }}
        >
          You are not a member of any department yet. Ask an Admin to
          assign you, then refresh this page.
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard label="Team records" value={String(summary.total)} icon="users" />
        <StatCard label="On time" value={String(summary.onTime)} icon="check" />
        <StatCard label="Late" value={String(summary.late)} icon="clock" />
        <StatCard label="Absent" value={String(summary.absent)} icon="user" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <StatusBreakdown
          title="Status breakdown · today"
          caption={today.data?.date ?? ""}
          slices={[
            { label: "On time", value: summary.onTime, tone: "success" },
            { label: "Late", value: summary.late, tone: "warning" },
            { label: "Absent", value: summary.absent, tone: "danger" },
            { label: "Overtime", value: summary.overtime, tone: "accent" },
          ]}
        />

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Team roster · today</h3>
            <span className="text-xs text-dim">
              {today.data ? `${today.data.items.length} record(s)` : ""}
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>In</th>
                <th>Out</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {today.isLoading && (
                <tr>
                  <td colSpan={4} className="text-sm text-dim" style={{ padding: 12 }}>
                    Loading…
                  </td>
                </tr>
              )}
              {today.data?.items.map((it) => (
                <tr key={`${it.employee_id}-${it.date}`}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{it.full_name}</div>
                    <div className="mono text-xs text-dim">{it.employee_code}</div>
                  </td>
                  <td className="mono text-sm">{it.in_time ?? "—"}</td>
                  <td className="mono text-sm">{it.out_time ?? "—"}</td>
                  <td>
                    <FlagPills item={it} />
                  </td>
                </tr>
              ))}
              {today.data && today.data.items.length === 0 && !today.isLoading && (
                <tr>
                  <td colSpan={4} className="text-sm text-dim" style={{ padding: 12 }}>
                    No records yet. Daily Attendance will fill in as
                    detections come through.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}
