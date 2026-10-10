// Admin System page (P11). Layout follows the design's
// dashboards.jsx::AdminDashboard system-metrics block: page-header → 4
// stat cards → 2-column with the camera fleet table on the left and a
// "system signals" card on the right.
//
// All numbers come from /api/system/{health,cameras-health}; refetch
// every 30 seconds via TanStack Query.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useCamerasHealth, useSystemHealth } from "./hooks";
import type { CameraHealthPoint } from "./types";
import { SkeletonCards, SkeletonLines, SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel } from "../../components/ListPageUi";
import { METRIC_ICON, MetricGrid, MetricTile, SoftPill } from "./opsUi";

export function SystemPage() {
  const { t } = useTranslation();
  const health = useSystemHealth();
  const cams = useCamerasHealth();

  const onlineCount = useMemo(() => {
    if (!cams.data) return 0;
    return cams.data.items.filter((c) => c.latest_reachable).length;
  }, [cams.data]);
  const enabledCount = cams.data?.items.filter((c) => c.enabled).length ?? 0;
  const camerasTone =
    !cams.data || enabledCount === 0
      ? "neutral"
      : onlineCount >= enabledCount
        ? "success"
        : onlineCount === 0
          ? "danger"
          : "warning";

  const loading = health.isLoading || cams.isLoading;
  const failed = health.isError || cams.isError;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("systemHealth.title")}</h1>
          <p className="page-sub">
            {health.data
              ? t("systemHealth.sub", {
                  uptime: formatUptime(health.data.backend_uptime_seconds),
                  pid: health.data.process_pid,
                })
              : t("systemHealth.subLoading", { defaultValue: "Live backend, camera fleet and scheduler signals." })}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void health.refetch();
              void cams.refetch();
            }}
            disabled={health.isFetching || cams.isFetching}
          >
            <Icon name="refresh" size={12} />
            {t("systemHealth.refresh", { defaultValue: "Refresh" })}
          </button>
        </div>
      </div>

      {loading && (
        <div className="ops-stack">
          <SkeletonCards count={4} />
          <div className="card ops-card-flush">
            <div className="card-head"><h3 className="card-title" style={{ margin: 0 }}>{t("systemHealth.fleetTitle")}</h3></div>
            <table className="table"><tbody><SkeletonRows cols={6} rows={3} /></tbody></table>
          </div>
        </div>
      )}

      {!loading && failed && (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={30} />}
            title={t("systemHealth.loadFailedTitle", { defaultValue: "Couldn't load system health" })}
            body={t("systemHealth.loadFailedBody", { defaultValue: "The backend didn't answer the health probe. Check that the API is reachable and try again." })}
            actions={
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void health.refetch();
                  void cams.refetch();
                }}
              >
                <Icon name="refresh" size={12} />
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      )}

      {!loading && !failed && (
        <>
          <MetricGrid>
            <MetricTile
              tone={camerasTone}
              icon={METRIC_ICON.camera}
              label={t("systemHealth.statCamerasOnline")}
              value={cams.data ? `${onlineCount} / ${cams.data.items.length}` : "—"}
              sub={cams.data ? t("systemHealth.statCamerasOnlineSub", { n: enabledCount }) : ""}
            />
            <MetricTile
              tone="info"
              icon={METRIC_ICON.activity}
              label={t("systemHealth.statEventsToday")}
              value={health.data ? formatNumber(health.data.detection_events_today) : "—"}
              sub={t("systemHealth.statEventsTodaySub")}
            />
            <MetricTile
              tone="neutral"
              icon={METRIC_ICON.users}
              label={t("systemHealth.statEnrolled")}
              value={health.data ? `${health.data.enrolled_employees} / ${health.data.employees_active}` : "—"}
              sub={t("systemHealth.statEnrolledSub")}
            />
            <MetricTile
              tone="info"
              icon={METRIC_ICON.file}
              label={t("systemHealth.statAttendance")}
              value={health.data ? formatNumber(health.data.attendance_records_today) : "—"}
              sub={t("systemHealth.statAttendanceSub")}
            />
          </MetricGrid>

          <div className="ops-split">
            <div className="card ops-card-flush">
              <div className="card-head">
                <h3 className="card-title" style={{ margin: 0 }}>{t("systemHealth.fleetTitle")}</h3>
                <span className="text-xs text-dim">{t("systemHealth.fleetLast24h")}</span>
              </div>
              {cams.data && cams.data.items.length === 0 ? (
                <EmptyPanel
                  tone="accent"
                  icon={<Icon name="camera" size={30} />}
                  title={t("systemHealth.noCamerasTitle", { defaultValue: "No cameras yet" })}
                  body={t("systemHealth.noCameras")}
                  actions={
                    <a href="/cameras" className="btn btn-primary">
                      <Icon name="plus" size={12} />
                      {t("systemHealth.addCamera", { defaultValue: "Add camera" })}
                    </a>
                  }
                />
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t("systemHealth.colCamera")}</th>
                        <th>{t("systemHealth.colHost")}</th>
                        <th>{t("systemHealth.colFrames")}</th>
                        <th>{t("systemHealth.colLastSeen")}</th>
                        <th>{t("systemHealth.col24h")}</th>
                        <th style={{ width: 110 }}>{t("systemHealth.colStatus")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cams.data?.items.map((c) => (
                        <tr key={c.camera_id}>
                          <td>
                            <div className="ops-cam">
                              <span className={`ops-cam-icon${c.latest_reachable ? " is-on" : ""}`} aria-hidden>
                                <Icon name="camera" size={13} />
                              </span>
                              <div style={{ minWidth: 0 }}>
                                <div className="ops-cam-name">{c.name}</div>
                                <div className="ops-cam-meta">{c.location || "—"}</div>
                              </div>
                            </div>
                          </td>
                          <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{c.rtsp_host}</td>
                          <td className="mono text-sm">{c.latest_frames_last_minute}</td>
                          <td className="mono text-xs text-dim" style={{ whiteSpace: "nowrap" }}>
                            {c.last_seen_at ? new Date(c.last_seen_at).toLocaleTimeString() : "—"}
                          </td>
                          <td>
                            <Sparkline series={c.series_24h} noDataLabel={t("systemHealth.noData")} />
                          </td>
                          <td>
                            <SoftPill tone={c.latest_reachable ? "success" : c.enabled ? "danger" : "neutral"}>
                              {c.latest_reachable ? t("systemHealth.online") : t("systemHealth.offline")}
                            </SoftPill>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card ops-card-flush">
              <div className="card-head">
                <h3 className="card-title" style={{ margin: 0 }}>{t("systemHealth.signalsTitle")}</h3>
              </div>
              <div className="ops-card-body is-tight">
                {!health.data ? (
                  <SkeletonLines lines={5} />
                ) : (
                  <>
                    <Signal
                      icon="database"
                      label={t("systemHealth.sigPostgres")}
                      sub={t("systemHealth.sigPostgresSub", { n: health.data.db_connections_active })}
                      ok={health.data.db_connections_active > 0}
                      okLabel={t("systemHealth.statusOk")}
                      checkLabel={t("systemHealth.statusCheck")}
                    />
                    <Signal
                      icon="activity"
                      label={t("systemHealth.sigWorkers")}
                      sub={t("systemHealth.sigWorkersSub", {
                        running: health.data.capture_workers_running,
                        enabled: health.data.cameras_enabled,
                      })}
                      ok={health.data.capture_workers_running >= health.data.cameras_enabled && health.data.cameras_enabled > 0}
                      okLabel={t("systemHealth.statusOk")}
                      checkLabel={t("systemHealth.statusCheck")}
                    />
                    <Signal
                      icon="clock"
                      label={t("systemHealth.sigAttendance")}
                      sub={health.data.attendance_scheduler_running ? t("systemHealth.sigAttendanceRunning") : t("systemHealth.sigAttendanceStopped")}
                      ok={!!health.data.attendance_scheduler_running}
                      okLabel={t("systemHealth.statusOk")}
                      checkLabel={t("systemHealth.statusCheck")}
                    />
                    <Signal
                      icon="shield"
                      label={t("systemHealth.sigRateLimit")}
                      sub={health.data.rate_limiter_running ? t("systemHealth.sigRateLimitRunning") : t("systemHealth.sigRateLimitStopped")}
                      ok={!!health.data.rate_limiter_running}
                      okLabel={t("systemHealth.statusOk")}
                      checkLabel={t("systemHealth.statusCheck")}
                    />
                    <Signal
                      icon="users"
                      label={t("systemHealth.sigEmbeddings")}
                      sub={t("systemHealth.sigEmbeddingsSub", {
                        enrolled: health.data.enrolled_employees,
                        active: health.data.employees_active,
                      })}
                      ok={health.data.enrolled_employees > 0}
                      okLabel={t("systemHealth.statusOk")}
                      checkLabel={t("systemHealth.statusCheck")}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Signal({
  icon,
  label,
  sub,
  ok,
  okLabel,
  checkLabel,
}: {
  icon: "database" | "activity" | "clock" | "shield" | "users";
  label: string;
  sub: string;
  ok: boolean;
  okLabel: string;
  checkLabel: string;
}) {
  return (
    <div className="ops-signal">
      <span className="ops-signal-icon" aria-hidden>
        <Icon name={icon} size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ops-signal-label">{label}</div>
        <div className="ops-signal-sub">{sub}</div>
      </div>
      <SoftPill tone={ok ? "success" : "warning"}>{ok ? okLabel : checkLabel}</SoftPill>
    </div>
  );
}

function Sparkline({ series, noDataLabel }: { series: CameraHealthPoint[]; noDataLabel: string }) {
  if (series.length === 0) {
    return <span className="text-xs text-dim">{noDataLabel}</span>;
  }
  const w = 88;
  const h = 22;
  const max = Math.max(1, ...series.map((p) => p.frames_last_minute));
  // Sample down to ~24 buckets so the SVG stays compact.
  const stride = Math.max(1, Math.floor(series.length / 24));
  const sampled = series.filter((_, i) => i % stride === 0);
  const stepX = w / Math.max(1, sampled.length - 1);
  const points = sampled
    .map((p, i) => `${(i * stepX).toFixed(1)},${(h - (p.frames_last_minute / max) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="ops-spark" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
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
