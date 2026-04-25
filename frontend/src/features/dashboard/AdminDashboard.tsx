// Admin dashboard — system-wide stats. Mirrors the system-metrics
// portion of design/dashboards.jsx::AdminDashboard, but only with
// real numbers (no synthetic time series).

import { useMe } from "../../auth/AuthProvider";
import { useDetectionEvents } from "../camera-logs/hooks";
import { useCamerasHealth, useSystemHealth } from "../system/hooks";
import { StatCard } from "./StatCard";
import { StatusBreakdown } from "./StatusBreakdown";

export function AdminDashboard() {
  const me = useMe();
  const health = useSystemHealth();
  const cams = useCamerasHealth();
  // Last 5 events for the recent-activity card.
  const recent = useDetectionEvents({
    camera_id: null,
    employee_id: null,
    identified: null,
    start: null,
    end: null,
    page: 1,
    page_size: 5,
  });

  const onlineCount = cams.data
    ? cams.data.items.filter((c) => c.latest_reachable).length
    : 0;
  const totalCams = cams.data?.items.length ?? 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data ? `Good day, ${firstName(me.data.full_name)}` : "Dashboard"}
          </h1>
          <p className="page-sub">
            Admin · system-wide overview · live counts from the API
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard
          label="Cameras online"
          value={cams.data ? `${onlineCount}/${totalCams}` : "—"}
          sub={
            cams.data
              ? `${cams.data.items.filter((c) => c.enabled).length} enabled`
              : ""
          }
          icon="camera"
        />
        <StatCard
          label="Events today"
          value={
            health.data ? health.data.detection_events_today.toLocaleString() : "—"
          }
          sub="captured + identified"
          icon="activity"
        />
        <StatCard
          label="Enrolled"
          value={
            health.data
              ? `${health.data.enrolled_employees}/${health.data.employees_active}`
              : "—"
          }
          sub="have a face embedding"
          icon="users"
        />
        <StatCard
          label="Attendance today"
          value={
            health.data ? String(health.data.attendance_records_today) : "—"
          }
          sub="rows recomputed"
          icon="fileText"
        />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Recent detection events</h3>
            <span className="text-xs text-dim">latest 5</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Camera</th>
                <th>Identified</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {recent.isLoading && (
                <tr>
                  <td colSpan={4} className="text-sm text-dim" style={{ padding: 12 }}>
                    Loading…
                  </td>
                </tr>
              )}
              {recent.data?.items.map((ev) => (
                <tr key={ev.id}>
                  <td className="mono text-sm">
                    {new Date(ev.captured_at).toLocaleTimeString()}
                  </td>
                  <td className="text-sm">{ev.camera_name}</td>
                  <td className="text-sm">
                    {ev.employee_id ? (
                      ev.employee_name
                    ) : (
                      <span className="pill pill-warning">Unidentified</span>
                    )}
                  </td>
                  <td className="mono text-sm">
                    {ev.confidence !== null ? `${(ev.confidence * 100).toFixed(0)}%` : "—"}
                  </td>
                </tr>
              ))}
              {recent.data && recent.data.items.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-sm text-dim" style={{ padding: 12 }}>
                    No events yet. Add a camera and walk past it.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <StatusBreakdown
          title="Capture pipeline"
          caption="now"
          slices={[
            {
              label: "Capture workers",
              value: health.data?.capture_workers_running ?? 0,
              tone: "accent",
            },
            {
              label: "Cameras enabled",
              value: health.data?.cameras_enabled ?? 0,
              tone: "neutral",
            },
            {
              label: "DB connections",
              value: health.data?.db_connections_active ?? 0,
              tone: "info",
            },
          ]}
        />
      </div>
    </>
  );
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}
