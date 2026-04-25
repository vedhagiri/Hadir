// Admin System page (P11). Layout follows the design's
// dashboards.jsx::AdminDashboard system-metrics block: page-header → 4
// stat cards → 2-column with the camera fleet table on the left and a
// "system signals" card on the right.
//
// All numbers come from /api/system/{health,cameras-health}; refetch
// every 30 seconds via TanStack Query.

import { useMemo } from "react";

import { Icon } from "../../shell/Icon";
import { useCamerasHealth, useSystemHealth } from "./hooks";
import type { CameraHealthPoint } from "./types";

export function SystemPage() {
  const health = useSystemHealth();
  const cams = useCamerasHealth();

  const onlineCount = useMemo(() => {
    if (!cams.data) return 0;
    return cams.data.items.filter((c) => c.latest_reachable).length;
  }, [cams.data]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">System health</h1>
          <p className="page-sub">
            {health.data ? (
              <>
                Backend uptime{" "}
                <span className="mono">{formatUptime(health.data.backend_uptime_seconds)}</span>
                {" · pid "}
                <span className="mono">{health.data.process_pid}</span>
              </>
            ) : (
              "—"
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard
          label="Cameras online"
          value={
            cams.data
              ? `${onlineCount}/${cams.data.items.length}`
              : "—"
          }
          sub={
            cams.data
              ? `${cams.data.items.filter((c) => c.enabled).length} enabled`
              : ""
          }
          icon="camera"
        />
        <StatCard
          label="Events today"
          value={health.data ? formatNumber(health.data.detection_events_today) : "—"}
          sub="captured + identified"
          icon="activity"
        />
        <StatCard
          label="Enrolled employees"
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
          value={health.data ? formatNumber(health.data.attendance_records_today) : "—"}
          sub="rows recomputed"
          icon="fileText"
        />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Camera fleet</h3>
            <span className="text-xs text-dim">last 24 h</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Camera</th>
                <th>Host</th>
                <th>Frames/min</th>
                <th>Last seen</th>
                <th>24 h</th>
                <th style={{ width: 90 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {cams.isLoading && (
                <tr>
                  <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                    Loading…
                  </td>
                </tr>
              )}
              {cams.data?.items.map((c) => (
                <tr key={c.camera_id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <div
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: 6,
                          background: "var(--bg-sunken)",
                          display: "grid",
                          placeItems: "center",
                          color: c.latest_reachable
                            ? "var(--accent)"
                            : "var(--text-tertiary)",
                        }}
                      >
                        <Icon name="camera" size={13} />
                      </div>
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{c.name}</div>
                        <div className="mono text-xs text-dim">{c.location || "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono text-sm">{c.rtsp_host}</td>
                  <td className="mono text-sm">{c.latest_frames_last_minute}</td>
                  <td className="mono text-xs text-dim">
                    {c.last_seen_at ? new Date(c.last_seen_at).toLocaleTimeString() : "—"}
                  </td>
                  <td>
                    <Sparkline series={c.series_24h} />
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        c.latest_reachable ? "pill-success" : "pill-warning"
                      }`}
                    >
                      {c.latest_reachable ? "online" : "offline"}
                    </span>
                  </td>
                </tr>
              ))}
              {cams.data && cams.data.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                    No cameras configured. Add one on the Cameras page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">System signals</h3>
          </div>
          <div
            className="card-body"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <Signal
              icon="database"
              label="PostgreSQL"
              sub={
                health.data
                  ? `${health.data.db_connections_active} active connection${health.data.db_connections_active === 1 ? "" : "s"}`
                  : "—"
              }
              ok={!!health.data && health.data.db_connections_active > 0}
            />
            <Signal
              icon="activity"
              label="Capture workers"
              sub={
                health.data
                  ? `${health.data.capture_workers_running} running of ${health.data.cameras_enabled} enabled`
                  : "—"
              }
              ok={
                !!health.data &&
                health.data.capture_workers_running >= health.data.cameras_enabled &&
                health.data.cameras_enabled > 0
              }
            />
            <Signal
              icon="clock"
              label="Attendance scheduler"
              sub={
                health.data?.attendance_scheduler_running
                  ? "running · 15 min interval"
                  : "stopped"
              }
              ok={!!health.data?.attendance_scheduler_running}
            />
            <Signal
              icon="shield"
              label="Login rate limiter"
              sub={
                health.data?.rate_limiter_running
                  ? "running · 10 attempts/10 min"
                  : "stopped"
              }
              ok={!!health.data?.rate_limiter_running}
            />
            <Signal
              icon="users"
              label="Enrolled embeddings"
              sub={
                health.data
                  ? `${health.data.enrolled_employees} of ${health.data.employees_active} active employees`
                  : "—"
              }
              ok={
                !!health.data &&
                health.data.enrolled_employees > 0
              }
            />
          </div>
        </div>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: "camera" | "activity" | "users" | "fileText";
}) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 7,
            background: "var(--bg-sunken)",
            display: "grid",
            placeItems: "center",
            color: "var(--text-secondary)",
          }}
        >
          <Icon name={icon} size={14} />
        </div>
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 28,
          letterSpacing: "-0.01em",
          marginTop: 4,
        }}
      >
        {value}
      </div>
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginTop: 6,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      {sub && (
        <div className="text-xs text-dim" style={{ marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Signal({
  icon,
  label,
  sub,
  ok,
}: {
  icon: "database" | "activity" | "clock" | "shield" | "users";
  label: string;
  sub: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center gap-3" style={{ display: "flex", gap: 12 }}>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 7,
          background: "var(--bg-sunken)",
          display: "grid",
          placeItems: "center",
          color: "var(--text-secondary)",
        }}
      >
        <Icon name={icon} size={14} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{label}</div>
        <div className="text-xs text-dim mono">{sub}</div>
      </div>
      <span className={`pill ${ok ? "pill-success" : "pill-warning"}`}>
        {ok ? "ok" : "check"}
      </span>
    </div>
  );
}

function Sparkline({ series }: { series: CameraHealthPoint[] }) {
  if (series.length === 0) {
    return <span className="text-xs text-dim">no data</span>;
  }
  const w = 88;
  const h = 22;
  const max = Math.max(1, ...series.map((p) => p.frames_last_minute));
  // Sample down to ~24 buckets so the SVG stays compact.
  const stride = Math.max(1, Math.floor(series.length / 24));
  const sampled = series.filter((_, i) => i % stride === 0);
  const stepX = w / Math.max(1, sampled.length - 1);
  const points = sampled
    .map(
      (p, i) =>
        `${(i * stepX).toFixed(1)},${(h - (p.frames_last_minute / max) * h).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block" }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m - h * 60;
  if (h < 24) return `${h}h ${rem}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h - d * 24}h`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}
