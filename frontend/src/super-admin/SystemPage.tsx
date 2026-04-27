// P28.8 — Super-Admin System page.
//
// Host metrics + capture metrics + data partition + tenants summary
// + scheduled jobs. English-only — internal MTS staff (documented).
// 5s polling for metrics, 30s for tenants summary.
//
// No restart actions here. Super-Admin uses "Access as" to enter a
// tenant for operations.

import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";

interface HostMetrics {
  cpu_percent: number;
  cpu_per_core: number[];
  load_avg: number[];
  mem_used_mb: number;
  mem_total_mb: number;
  mem_percent: number;
  disk_used_gb: number;
  disk_total_gb: number;
  disk_percent: number;
  uptime_sec: number;
}

interface DataPartitionMetrics {
  path: string;
  used_gb: number;
  total_gb: number;
  percent: number;
  face_crops_count: number;
  face_crops_size_gb: number;
  estimated_days_until_full: number | null;
}

interface DatabaseMetrics {
  pool_active: number;
  pool_idle: number;
  pool_total: number;
  size_mb: number | null;
}

interface CaptureMetrics {
  total_workers_running: number;
  total_workers_configured: number;
  tenants_with_workers: number;
  detector_lock_contention_60s_pct: number;
  active_mjpeg_viewers: number;
  active_ws_subscribers: number;
}

interface ScheduledJob {
  name: string;
  last_run: string | null;
  next_run: string | null;
  status: string;
}

interface SystemMetricsResponse {
  host: HostMetrics;
  data_partition: DataPartitionMetrics;
  database: DatabaseMetrics;
  capture: CaptureMetrics;
  scheduled_jobs: ScheduledJob[];
}

interface TenantSummaryRow {
  slug: string;
  workers_running: number;
  workers_configured: number;
  events_last_hour: number;
  any_stage_red: boolean;
}

interface TenantsSummaryResponse {
  tenants: TenantSummaryRow[];
}

export function SystemPage() {
  const metrics = useQuery({
    queryKey: ["super-admin", "system", "metrics"],
    queryFn: () =>
      api<SystemMetricsResponse>("/api/super-admin/system/metrics"),
    refetchInterval: 5000,
  });
  const tenants = useQuery({
    queryKey: ["super-admin", "system", "tenants"],
    queryFn: () =>
      api<TenantsSummaryResponse>(
        "/api/super-admin/system/tenants-summary",
      ),
    refetchInterval: 30000,
  });

  const m = metrics.data;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">System</h1>
          <p className="page-sub">
            Host metrics + capture pipeline + per-tenant health.
          </p>
        </div>
      </div>

      {metrics.isLoading && (
        <div className="text-sm text-dim">Loading metrics…</div>
      )}
      {metrics.isError && (
        <div className="text-sm" style={{ color: "var(--danger-text)" }}>
          Could not load system metrics.
        </div>
      )}

      {m && (
        <>
          {/* Host metrics */}
          <SectionLabel>Host</SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <MetricCard
              label="CPU"
              value={`${m.host.cpu_percent.toFixed(1)}%`}
              tone={m.host.cpu_percent > 80 ? "danger" : m.host.cpu_percent > 50 ? "warning" : "success"}
              footer={
                <div style={{ display: "flex", gap: 2, marginTop: 6 }}>
                  {m.host.cpu_per_core.map((v, i) => (
                    <div
                      key={i}
                      title={`Core ${i}: ${v.toFixed(1)}%`}
                      style={{
                        width: 12,
                        height: 16,
                        borderRadius: 2,
                        background:
                          v > 80
                            ? "var(--danger)"
                            : v > 50
                              ? "var(--warning)"
                              : "var(--success)",
                        opacity: 0.4 + (v / 100) * 0.6,
                      }}
                    />
                  ))}
                </div>
              }
            />
            <MetricCard
              label="Memory"
              value={`${m.host.mem_percent.toFixed(1)}%`}
              tone={m.host.mem_percent > 85 ? "danger" : m.host.mem_percent > 65 ? "warning" : "success"}
              footer={
                <div className="text-xs text-dim mono" style={{ marginTop: 4 }}>
                  {Math.round(m.host.mem_used_mb / 1024)} GB /{" "}
                  {Math.round(m.host.mem_total_mb / 1024)} GB
                </div>
              }
            />
            <MetricCard
              label="Disk"
              value={`${m.host.disk_percent.toFixed(1)}%`}
              tone={m.host.disk_percent > 80 ? "danger" : m.host.disk_percent > 60 ? "warning" : "success"}
              footer={
                <div className="text-xs text-dim mono" style={{ marginTop: 4 }}>
                  {m.host.disk_used_gb.toFixed(0)} GB /{" "}
                  {m.host.disk_total_gb.toFixed(0)} GB
                </div>
              }
            />
            <MetricCard
              label="Uptime"
              value={formatUptime(m.host.uptime_sec)}
              tone="neutral"
              footer={
                <div className="text-xs text-dim mono" style={{ marginTop: 4 }}>
                  load: {m.host.load_avg.map((l) => l.toFixed(2)).join(" / ")}
                </div>
              }
            />
          </div>

          {/* Capture metrics */}
          <SectionLabel>Capture</SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <MetricCard
              label="Workers running"
              value={`${m.capture.total_workers_running} / ${m.capture.total_workers_configured}`}
              tone={
                m.capture.total_workers_running ===
                m.capture.total_workers_configured
                  ? "success"
                  : "warning"
              }
              footer={
                <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                  across {m.capture.tenants_with_workers} tenant(s)
                </div>
              }
            />
            <MetricCard
              label="Detector lock contention (60s)"
              value={`${m.capture.detector_lock_contention_60s_pct.toFixed(1)}%`}
              tone={
                m.capture.detector_lock_contention_60s_pct > 80
                  ? "danger"
                  : m.capture.detector_lock_contention_60s_pct > 50
                    ? "warning"
                    : "success"
              }
              footer={
                <ContentionBar
                  pct={m.capture.detector_lock_contention_60s_pct}
                />
              }
            />
            <MetricCard
              label="Active viewers"
              value={`${m.capture.active_mjpeg_viewers} MJPEG · ${m.capture.active_ws_subscribers} WS`}
              tone="neutral"
            />
          </div>

          {/* Data partition */}
          <SectionLabel>Data partition</SectionLabel>
          <div
            className="card"
            style={{ padding: 14, marginBottom: 16, fontSize: 13 }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 16,
              }}
            >
              <div>
                <div className="text-xs text-dim">Path</div>
                <div className="mono" style={{ marginTop: 2 }}>
                  {m.data_partition.path}
                </div>
              </div>
              <div>
                <div className="text-xs text-dim">Used / Total</div>
                <div className="mono" style={{ marginTop: 2 }}>
                  {m.data_partition.used_gb.toFixed(1)} GB /{" "}
                  {m.data_partition.total_gb.toFixed(1)} GB (
                  {m.data_partition.percent.toFixed(1)}%)
                </div>
              </div>
              <div>
                <div className="text-xs text-dim">Face crops</div>
                <div className="mono" style={{ marginTop: 2 }}>
                  {m.data_partition.face_crops_count.toLocaleString()} files ·{" "}
                  {m.data_partition.face_crops_size_gb.toFixed(2)} GB
                </div>
              </div>
              <div>
                <div className="text-xs text-dim">Days until full</div>
                <div className="mono" style={{ marginTop: 2 }}>
                  {m.data_partition.estimated_days_until_full ?? "—"}
                </div>
              </div>
            </div>
          </div>

          {/* Tenants summary */}
          <SectionLabel>Tenants</SectionLabel>
          <div className="card" style={{ marginBottom: 16 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Workers</th>
                  <th>Events / hour</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tenants.isLoading && (
                  <tr>
                    <td
                      colSpan={5}
                      className="text-sm text-dim"
                      style={{ padding: 16 }}
                    >
                      Loading…
                    </td>
                  </tr>
                )}
                {tenants.data?.tenants.map((t) => (
                  <tr key={t.slug}>
                    <td className="mono text-sm">{t.slug}</td>
                    <td className="mono text-sm">
                      {t.workers_running} / {t.workers_configured}
                    </td>
                    <td className="mono text-sm">{t.events_last_hour}</td>
                    <td>
                      {t.any_stage_red ? (
                        <span className="pill pill-danger">Stage red</span>
                      ) : (
                        <span className="pill pill-success">OK</span>
                      )}
                    </td>
                    <td>
                      <a
                        href={`/super-admin/tenants?slug=${t.slug}`}
                        className="text-xs"
                        style={{ color: "var(--accent)" }}
                      >
                        Access as →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Scheduled jobs */}
          <SectionLabel>Scheduled jobs</SectionLabel>
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Next run</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {m.scheduled_jobs.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="text-sm text-dim"
                      style={{ padding: 16 }}
                    >
                      No scheduled jobs reporting.
                    </td>
                  </tr>
                )}
                {m.scheduled_jobs.map((j) => (
                  <tr key={j.name}>
                    <td className="mono text-sm">{j.name}</td>
                    <td className="text-sm text-dim">
                      {j.next_run
                        ? new Date(j.next_run).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      <span
                        className={`pill ${
                          j.status === "ok"
                            ? "pill-success"
                            : j.status === "error"
                              ? "pill-danger"
                              : "pill-neutral"
                        }`}
                      >
                        {j.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-tertiary)",
        margin: "16px 0 8px 0",
      }}
    >
      {children}
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone,
  footer,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "danger" | "neutral";
  footer?: React.ReactNode;
}) {
  const colors: Record<string, string> = {
    success: "var(--success)",
    warning: "var(--warning)",
    danger: "var(--danger)",
    neutral: "var(--text-tertiary)",
  };
  return (
    <div
      className="card"
      style={{
        padding: 12,
        borderInlineStart: `3px solid ${colors[tone]}`,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-tertiary)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginTop: 4,
          color: "var(--text)",
        }}
      >
        {value}
      </div>
      {footer}
    </div>
  );
}

function ContentionBar({ pct }: { pct: number }) {
  const color =
    pct > 80
      ? "var(--danger)"
      : pct > 50
        ? "var(--warning)"
        : "var(--success)";
  return (
    <div
      style={{
        marginTop: 6,
        height: 4,
        background: "var(--bg-sunken)",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${Math.min(100, pct)}%`,
          height: "100%",
          background: color,
        }}
      />
    </div>
  );
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    return `${h}h`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return `${d}d ${h}h`;
}
