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

export function SystemPage() {
  const { t } = useTranslation();
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
          <h1 className="page-title">{t("systemHealth.title")}</h1>
          <p className="page-sub">
            {health.data ? (
              <>
                {t("systemHealth.sub", {
                  uptime: formatUptime(health.data.backend_uptime_seconds),
                  pid: health.data.process_pid,
                })}
              </>
            ) : (
              "—"
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard
          label={t("systemHealth.statCamerasOnline")}
          value={
            cams.data
              ? `${onlineCount}/${cams.data.items.length}`
              : "—"
          }
          sub={
            cams.data
              ? t("systemHealth.statCamerasOnlineSub", {
                  n: cams.data.items.filter((c) => c.enabled).length,
                })
              : ""
          }
          icon="camera"
        />
        <StatCard
          label={t("systemHealth.statEventsToday")}
          value={health.data ? formatNumber(health.data.detection_events_today) : "—"}
          sub={t("systemHealth.statEventsTodaySub")}
          icon="activity"
        />
        <StatCard
          label={t("systemHealth.statEnrolled")}
          value={
            health.data
              ? `${health.data.enrolled_employees}/${health.data.employees_active}`
              : "—"
          }
          sub={t("systemHealth.statEnrolledSub")}
          icon="users"
        />
        <StatCard
          label={t("systemHealth.statAttendance")}
          value={health.data ? formatNumber(health.data.attendance_records_today) : "—"}
          sub={t("systemHealth.statAttendanceSub")}
          icon="fileText"
        />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">{t("systemHealth.fleetTitle")}</h3>
            <span className="text-xs text-dim">{t("systemHealth.fleetLast24h")}</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t("systemHealth.colCamera")}</th>
                <th>{t("systemHealth.colHost")}</th>
                <th>{t("systemHealth.colFrames")}</th>
                <th>{t("systemHealth.colLastSeen")}</th>
                <th>{t("systemHealth.col24h")}</th>
                <th style={{ width: 90 }}>{t("systemHealth.colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {cams.isLoading && (
                <tr>
                  <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                    {t("systemHealth.loading")}
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
                    <Sparkline series={c.series_24h} noDataLabel={t("systemHealth.noData")} />
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        c.latest_reachable ? "pill-success" : "pill-warning"
                      }`}
                    >
                      {c.latest_reachable ? t("systemHealth.online") : t("systemHealth.offline")}
                    </span>
                  </td>
                </tr>
              ))}
              {cams.data && cams.data.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                    {t("systemHealth.noCameras")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">{t("systemHealth.signalsTitle")}</h3>
          </div>
          <div
            className="card-body"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <Signal
              icon="database"
              label={t("systemHealth.sigPostgres")}
              sub={
                health.data
                  ? t("systemHealth.sigPostgresSub", { n: health.data.db_connections_active })
                  : "—"
              }
              ok={!!health.data && health.data.db_connections_active > 0}
              okLabel={t("systemHealth.statusOk")}
              checkLabel={t("systemHealth.statusCheck")}
            />
            <Signal
              icon="activity"
              label={t("systemHealth.sigWorkers")}
              sub={
                health.data
                  ? t("systemHealth.sigWorkersSub", {
                      running: health.data.capture_workers_running,
                      enabled: health.data.cameras_enabled,
                    })
                  : "—"
              }
              ok={
                !!health.data &&
                health.data.capture_workers_running >= health.data.cameras_enabled &&
                health.data.cameras_enabled > 0
              }
              okLabel={t("systemHealth.statusOk")}
              checkLabel={t("systemHealth.statusCheck")}
            />
            <Signal
              icon="clock"
              label={t("systemHealth.sigAttendance")}
              sub={
                health.data?.attendance_scheduler_running
                  ? t("systemHealth.sigAttendanceRunning")
                  : t("systemHealth.sigAttendanceStopped")
              }
              ok={!!health.data?.attendance_scheduler_running}
              okLabel={t("systemHealth.statusOk")}
              checkLabel={t("systemHealth.statusCheck")}
            />
            <Signal
              icon="shield"
              label={t("systemHealth.sigRateLimit")}
              sub={
                health.data?.rate_limiter_running
                  ? t("systemHealth.sigRateLimitRunning")
                  : t("systemHealth.sigRateLimitStopped")
              }
              ok={!!health.data?.rate_limiter_running}
              okLabel={t("systemHealth.statusOk")}
              checkLabel={t("systemHealth.statusCheck")}
            />
            <Signal
              icon="users"
              label={t("systemHealth.sigEmbeddings")}
              sub={
                health.data
                  ? t("systemHealth.sigEmbeddingsSub", {
                      enrolled: health.data.enrolled_employees,
                      active: health.data.employees_active,
                    })
                  : "—"
              }
              ok={!!health.data && health.data.enrolled_employees > 0}
              okLabel={t("systemHealth.statusOk")}
              checkLabel={t("systemHealth.statusCheck")}
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
        {ok ? okLabel : checkLabel}
      </span>
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
