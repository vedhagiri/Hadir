// HR dashboard — attendance summary + active policy. Mirrors the
// summary band of design/dashboards.jsx::HRDashboard but pinned to
// real /api/attendance counts for today.

import { useMemo } from "react";

import { useMe } from "../../auth/AuthProvider";
import { useAttendance } from "../attendance/hooks";
import { useSystemHealth } from "../system/hooks";
import { StatCard } from "./StatCard";
import { StatusBreakdown } from "./StatusBreakdown";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function HrDashboard() {
  const me = useMe();
  const today = useAttendance(todayIso(), null);
  const health = useSystemHealth();

  const summary = useMemo(() => {
    const items = today.data?.items ?? [];
    const present = items.filter((it) => !it.absent).length;
    const late = items.filter((it) => it.late && !it.absent).length;
    const absent = items.filter((it) => it.absent).length;
    const overtime = items.filter((it) => it.overtime_minutes > 0).length;
    const onTime = items.filter(
      (it) =>
        !it.absent && !it.late && !it.early_out && !it.short_hours,
    ).length;
    return { present, late, absent, overtime, onTime, total: items.length };
  }, [today.data]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data ? `Hello, ${firstName(me.data.full_name)}` : "HR Dashboard"}
          </h1>
          <p className="page-sub">
            HR · today's attendance summary
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard
          label="Records today"
          value={String(summary.total)}
          sub={
            health.data ? `${health.data.employees_active} active employees` : ""
          }
          icon="fileText"
        />
        <StatCard
          label="On time"
          value={String(summary.onTime)}
          sub="no flags"
          icon="check"
        />
        <StatCard
          label="Late arrivals"
          value={String(summary.late)}
          sub="past grace window"
          icon="clock"
        />
        <StatCard
          label="Absent"
          value={String(summary.absent)}
          sub="no events all day"
          icon="user"
        />
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
            <h3 className="card-title">Active shift policy</h3>
            <span className="text-xs text-dim">pilot · single-policy</span>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {today.data?.items[0] ? (
              <>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {today.data.items[0].policy.name}
                </div>
                <div className="text-sm text-dim">
                  Applied to every active employee in tenant 1. Edit
                  policies via the Shift Policies page (deferred to
                  v1.0).
                </div>
              </>
            ) : (
              <div className="text-sm text-dim">
                No attendance rows yet today. The 15-minute scheduler will
                populate them as detections come in.
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}
