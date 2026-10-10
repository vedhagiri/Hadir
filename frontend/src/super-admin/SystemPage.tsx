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
import { EmptyPanel } from "../components/ListPageUi";
import { SkeletonCards, SkeletonRows, SkeletonTable } from "../components/Skeleton";
import { Panel, PanelEmpty, SoftPill, Tile, TileGrid, nowrap } from "../features/dashboard/DashUi";
import type { Tone } from "../features/dashboard/DashUi";
import { Icon } from "../shell/Icon";
import { SectionLabel } from "./saUi";

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

  const pctTone = (v: number, warn: number, bad: number): Tone => (v > bad ? "danger" : v > warn ? "warning" : "success");
  const lvl = (v: number) => (v > 80 ? " is-danger" : v > 50 ? " is-warning" : "");

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">System</h1>
          <p className="page-sub">Host resources, the capture pipeline and per-tenant health — refreshes every 5 seconds.</p>
        </div>
      </div>

      {metrics.isLoading && (
        <div role="status" aria-label="Loading metrics" className="sa-stack">
          <SkeletonCards count={4} />
          <SkeletonCards count={3} />
          <SkeletonTable rows={3} cols={5} />
        </div>
      )}
      {metrics.isError && !m && (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={28} />}
            title="Couldn't load system metrics"
            body="The metrics endpoint did not respond. The page retries automatically every 5 seconds."
            actions={
              <button type="button" className="btn" onClick={() => void metrics.refetch()}>
                Retry now
              </button>
            }
          />
        </div>
      )}

      {m && (
        <>
          {/* Host metrics */}
          <SectionLabel>Host</SectionLabel>
          <TileGrid>
            <Tile
              tone={pctTone(m.host.cpu_percent, 50, 80)}
              icon="zap"
              label="CPU"
              value={`${m.host.cpu_percent.toFixed(1)}%`}
              sub={`${m.host.cpu_per_core.length} cores`}
              extra={
                <span className="sa-cores">
                  {m.host.cpu_per_core.map((v, i) => (
                    <span key={i} className={`sa-core${lvl(v)}`} title={`Core ${i}: ${v.toFixed(1)}%`} style={{ opacity: 0.4 + (v / 100) * 0.6 }} />
                  ))}
                </span>
              }
            />
            <Tile
              tone={pctTone(m.host.mem_percent, 65, 85)}
              icon="activity"
              label="Memory"
              value={`${m.host.mem_percent.toFixed(1)}%`}
              sub={`${Math.round(m.host.mem_used_mb / 1024)} GB / ${Math.round(m.host.mem_total_mb / 1024)} GB`}
            />
            <Tile
              tone={pctTone(m.host.disk_percent, 60, 80)}
              icon="database"
              label="Disk"
              value={`${m.host.disk_percent.toFixed(1)}%`}
              sub={`${m.host.disk_used_gb.toFixed(0)} GB / ${m.host.disk_total_gb.toFixed(0)} GB`}
            />
            <Tile
              tone="neutral"
              icon="clock"
              label="Uptime"
              value={formatUptime(m.host.uptime_sec)}
              sub={`load ${m.host.load_avg.map((l) => l.toFixed(2)).join(" / ")}`}
            />
          </TileGrid>

          {/* Capture metrics */}
          <SectionLabel>Capture</SectionLabel>
          <TileGrid>
            <Tile
              tone={m.capture.total_workers_running === m.capture.total_workers_configured ? "success" : "warning"}
              icon="camera"
              label="Workers running"
              value={`${m.capture.total_workers_running} / ${m.capture.total_workers_configured}`}
              sub={`across ${m.capture.tenants_with_workers} tenant(s)`}
            />
            <Tile
              tone={pctTone(m.capture.detector_lock_contention_60s_pct, 50, 80)}
              icon="activity"
              label="Detector lock contention (60s)"
              value={`${m.capture.detector_lock_contention_60s_pct.toFixed(1)}%`}
              sub="time the shared detector lock was held"
              extra={
                <span className="sa-meter">
                  <span
                    className={`sa-meter-fill${lvl(m.capture.detector_lock_contention_60s_pct)}`}
                    style={{ display: "block", width: `${Math.min(100, m.capture.detector_lock_contention_60s_pct)}%` }}
                  />
                </span>
              }
            />
            <Tile
              tone="neutral"
              icon="eye"
              label="Active viewers"
              value={m.capture.active_mjpeg_viewers + m.capture.active_ws_subscribers}
              sub={`${m.capture.active_mjpeg_viewers} MJPEG · ${m.capture.active_ws_subscribers} WS`}
            />
            <Tile
              tone="info"
              icon="database"
              label="DB pool"
              value={`${m.database.pool_active} / ${m.database.pool_total}`}
              sub={`${m.database.pool_idle} idle${m.database.size_mb != null ? ` · ${m.database.size_mb.toFixed(0)} MB` : ""}`}
            />
          </TileGrid>

          {/* Data partition */}
          <SectionLabel>Data partition</SectionLabel>
          <TileGrid>
            <Tile tone="neutral" icon="fileText" label="Path" value={m.data_partition.path} sub="data volume mount" />
            <Tile
              tone={pctTone(m.data_partition.percent, 60, 80)}
              icon="database"
              label="Used / total"
              value={`${m.data_partition.percent.toFixed(1)}%`}
              sub={`${m.data_partition.used_gb.toFixed(1)} GB / ${m.data_partition.total_gb.toFixed(1)} GB`}
            />
            <Tile
              tone="neutral"
              icon="user"
              label="Face crops"
              value={m.data_partition.face_crops_count.toLocaleString()}
              sub={`${m.data_partition.face_crops_size_gb.toFixed(2)} GB on disk`}
            />
            <Tile
              tone={
                m.data_partition.estimated_days_until_full == null
                  ? "neutral"
                  : m.data_partition.estimated_days_until_full < 14
                    ? "danger"
                    : m.data_partition.estimated_days_until_full < 60
                      ? "warning"
                      : "success"
              }
              icon="calendar"
              label="Days until full"
              value={m.data_partition.estimated_days_until_full ?? "—"}
              sub="at the current growth rate"
            />
          </TileGrid>

          {/* Tenants summary */}
          <SectionLabel>Tenants</SectionLabel>
          <Panel title="Tenants" sub="Capture workers and events per tenant — refreshes every 30 seconds" bodyPadding={0} className="sa-block">
            {tenants.isError ? (
              <PanelEmpty
                tone="danger"
                icon="info"
                title="Couldn't load the tenants summary"
                body="The summary endpoint did not respond."
                action={
                  <button type="button" className="btn btn-sm" onClick={() => void tenants.refetch()}>
                    Retry
                  </button>
                }
              />
            ) : tenants.data && tenants.data.tenants.length === 0 ? (
              <PanelEmpty icon="users" title="No tenants reporting" body="No tenant has capture workers configured yet." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Slug</th>
                    <th className="sa-end">Workers</th>
                    <th className="sa-end">Events / hour</th>
                    <th>Pipeline</th>
                    <th className="sa-end">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.isLoading && <SkeletonRows cols={5} />}
                  {tenants.data?.tenants.map((t) => (
                    <tr key={t.slug}>
                      <td className="mono text-sm sa-strong" style={nowrap}>
                        {t.slug}
                      </td>
                      <td className="mono text-sm sa-end">
                        {t.workers_running} / {t.workers_configured}
                      </td>
                      <td className="mono text-sm sa-end">{t.events_last_hour}</td>
                      <td>
                        {t.any_stage_red ? (
                          <SoftPill tone="danger" title="At least one worker has a pipeline stage in the red">
                            Stage red
                          </SoftPill>
                        ) : (
                          <SoftPill tone="success">Healthy</SoftPill>
                        )}
                      </td>
                      <td className="sa-end">
                        <a href={`/super-admin/tenants?slug=${t.slug}`} className="btn btn-sm btn-ghost" style={nowrap}>
                          Access as
                          <Icon name="chevronRight" size={12} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Scheduled jobs */}
          <SectionLabel>Scheduled jobs</SectionLabel>
          <Panel title="Scheduled jobs" sub="Background schedulers registered with the backend" bodyPadding={0}>
            {m.scheduled_jobs.length === 0 ? (
              <PanelEmpty icon="clock" title="No scheduled jobs reporting" body="Background schedulers register here once the backend has started them." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Next run</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {m.scheduled_jobs.map((j) => (
                    <tr key={j.name}>
                      <td className="mono text-sm">{j.name}</td>
                      <td className="text-sm text-dim" style={nowrap}>
                        {j.next_run ? new Date(j.next_run).toLocaleString() : "—"}
                      </td>
                      <td>
                        <SoftPill tone={j.status === "ok" ? "success" : j.status === "error" ? "danger" : "neutral"}>
                          {j.status === "ok" ? "OK" : j.status}
                        </SoftPill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </>
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
