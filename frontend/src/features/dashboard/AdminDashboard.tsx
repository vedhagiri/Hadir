// Admin dashboard — system-wide stats. Mirrors the system-metrics
// portion of design/dashboards.jsx::AdminDashboard, but only with
// real numbers (no synthetic time series).

import { useMe } from "../../auth/AuthProvider";
import { useDetectionEvents } from "../camera-logs/hooks";
import { useCamerasHealth, useSystemHealth } from "../system/hooks";
import type { StorageStats } from "../system/types";
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

      {health.data?.storage && (
        <StorageSection storage={health.data.storage} />
      )}

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

// ---------------------------------------------------------------------------
// Storage section — disk usage bar + per-bucket stat cards
// ---------------------------------------------------------------------------

function StorageSection({ storage }: { storage: StorageStats }) {
  const tenantSubtotal =
    storage.face_crops_bytes +
    storage.attachments_bytes +
    storage.reports_bytes +
    storage.erp_exports_bytes +
    storage.db_size_bytes;

  return (
    <>
      <DiskUsageCard storage={storage} />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard
          label="Captured events"
          value={storage.detection_events_total.toLocaleString()}
          sub={`${formatBytes(storage.face_crops_bytes)} on disk`}
          icon="activity"
        />
        <StatCard
          label="Attendance rows"
          value={storage.attendance_records_total.toLocaleString()}
          sub="lifetime"
          icon="fileText"
        />
        <StatCard
          label="Database"
          value={formatBytes(storage.db_size_bytes)}
          sub="Postgres total"
          icon="database"
        />
        <StatCard
          label="Reports + attachments"
          value={formatBytes(
            storage.reports_bytes +
              storage.attachments_bytes +
              storage.erp_exports_bytes,
          )}
          sub={`reports ${formatBytes(storage.reports_bytes)} · attachments ${formatBytes(storage.attachments_bytes)}`}
          icon="download"
        />
      </div>
      <div
        className="text-xs text-dim"
        style={{ marginBottom: 16, marginTop: -8 }}
      >
        Tenant-scoped disk + DB use: {formatBytes(tenantSubtotal)}
      </div>
    </>
  );
}

function DiskUsageCard({ storage }: { storage: StorageStats }) {
  const total = storage.disk_total_bytes || 1;
  const usedPct = Math.min(100, Math.round((storage.disk_used_bytes / total) * 100));
  const tenantBytes =
    storage.face_crops_bytes +
    storage.attachments_bytes +
    storage.reports_bytes +
    storage.erp_exports_bytes +
    storage.db_size_bytes;
  const tenantPct = Math.min(100, Math.round((tenantBytes / total) * 100));
  const tone =
    usedPct >= 90 ? "danger" : usedPct >= 75 ? "warning" : "accent";
  const barFill = `var(--${tone}, var(--accent))`;

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div>
          <div
            className="text-xs text-dim"
            style={{
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontWeight: 500,
            }}
          >
            Storage volume
          </div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 22,
              marginTop: 4,
              letterSpacing: "-0.01em",
            }}
          >
            {formatBytes(storage.disk_used_bytes)} used ·{" "}
            <span style={{ color: "var(--text-secondary)" }}>
              {formatBytes(storage.disk_free_bytes)} free
            </span>
          </div>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            of {formatBytes(storage.disk_total_bytes)} total · this tenant
            occupies {formatBytes(tenantBytes)} ({tenantPct}%)
          </div>
        </div>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            color:
              tone === "danger"
                ? "var(--danger-text)"
                : tone === "warning"
                  ? "var(--warning-text)"
                  : "var(--accent-text)",
          }}
        >
          {usedPct}%
        </div>
      </div>
      {/* Two stacked bars: outer = whole-disk used (host-level);
          inner = this tenant's slice. Helps the operator distinguish
          "I'm 80% full" from "I'm 80% full because of this tenant". */}
      <div
        style={{
          position: "relative",
          height: 10,
          background: "var(--bg-sunken)",
          borderRadius: 5,
          overflow: "hidden",
          border: "1px solid var(--border)",
        }}
        aria-label={`Disk used: ${usedPct}%`}
        role="progressbar"
        aria-valuenow={usedPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${usedPct}%`,
            background: barFill,
            transition: "width 200ms ease",
          }}
        />
        <div
          style={{
            position: "absolute",
            insetBlock: 0,
            insetInlineStart: 0,
            width: `${tenantPct}%`,
            background: "var(--accent)",
            opacity: 0.85,
          }}
          aria-hidden
        />
      </div>
      <div
        className="text-xs text-dim"
        style={{
          display: "flex",
          gap: 12,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        <LegendDot color="var(--accent)" label="This tenant" />
        <LegendDot color={barFill} label="Whole disk used" />
        <LegendDot color="var(--bg-sunken)" label="Free" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: 2,
          background: color,
          border: "1px solid var(--border)",
        }}
      />
      {label}
    </span>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v >= 100 || i === 0
    ? `${v.toFixed(0)} ${units[i]}`
    : `${v.toFixed(1)} ${units[i]}`;
}
