// Admin dashboard — system-wide stats. Mirrors the system-metrics
// portion of design/dashboards.jsx::AdminDashboard, but only with
// real numbers (no synthetic time series).

import { useTranslation } from "react-i18next";

import { useMe } from "../../auth/AuthProvider";
import { useDetectionEvents } from "../camera-logs/hooks";
import { useCamerasHealth, useSystemHealth } from "../system/hooks";
import type { StorageStats } from "../system/types";
import { StatCard } from "./StatCard";
import { StatusBreakdown } from "./StatusBreakdown";

export function AdminDashboard() {
  const { t } = useTranslation();
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
            {me.data
              ? t("dashboard.admin.greeting", { name: firstName(me.data.full_name) })
              : t("dashboard.admin.title")}
          </h1>
          <p className="page-sub">
            {t("dashboard.admin.subtitle")}
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard
          label={t("dashboard.admin.stats.camerasOnline")}
          value={cams.data ? `${onlineCount}/${totalCams}` : "—"}
          sub={
            cams.data
              ? t("dashboard.admin.stats.enabledCount", {
                  count: cams.data.items.filter((c) => c.enabled).length,
                })
              : ""
          }
          icon="camera"
        />
        <StatCard
          label={t("dashboard.admin.stats.eventsToday")}
          value={
            health.data ? health.data.detection_events_today.toLocaleString() : "—"
          }
          sub={t("dashboard.admin.stats.capturedIdentified")}
          icon="activity"
        />
        <StatCard
          label={t("dashboard.admin.stats.enrolled")}
          value={
            health.data
              ? `${health.data.enrolled_employees}/${health.data.employees_active}`
              : "—"
          }
          sub={t("dashboard.admin.stats.haveEmbedding")}
          icon="users"
        />
        <StatCard
          label={t("dashboard.admin.stats.attendanceToday")}
          value={
            health.data ? String(health.data.attendance_records_today) : "—"
          }
          sub={t("dashboard.admin.stats.rowsRecomputed")}
          icon="fileText"
        />
      </div>

      {health.data?.storage && (
        <StorageSection storage={health.data.storage} />
      )}

      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">{t("dashboard.admin.recent.title")}</h3>
            <span className="text-xs text-dim">{t("dashboard.admin.recent.caption")}</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t("dashboard.admin.recent.cols.time")}</th>
                <th>{t("dashboard.admin.recent.cols.camera")}</th>
                <th>{t("dashboard.admin.recent.cols.identified")}</th>
                <th>{t("dashboard.admin.recent.cols.confidence")}</th>
              </tr>
            </thead>
            <tbody>
              {recent.isLoading && (
                <tr>
                  <td colSpan={4} className="text-sm text-dim" style={{ padding: 12 }}>
                    {t("dashboard.common.loading")}
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
                      <span className="pill pill-warning">{t("dashboard.common.unidentified")}</span>
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
                    {t("dashboard.admin.recent.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <StatusBreakdown
          title={t("dashboard.admin.capture.title")}
          caption={t("dashboard.admin.capture.now")}
          slices={[
            {
              label: t("dashboard.admin.capture.workers"),
              value: health.data?.capture_workers_running ?? 0,
              tone: "accent",
            },
            {
              label: t("dashboard.admin.capture.camerasEnabled"),
              value: health.data?.cameras_enabled ?? 0,
              tone: "neutral",
            },
            {
              label: t("dashboard.admin.capture.dbConn"),
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
  const { t } = useTranslation();
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
          label={t("dashboard.admin.storage.capturedEvents")}
          value={storage.detection_events_total.toLocaleString()}
          sub={t("dashboard.admin.storage.onDisk", { size: formatBytes(storage.face_crops_bytes) })}
          icon="activity"
        />
        <StatCard
          label={t("dashboard.admin.storage.attendanceRows")}
          value={storage.attendance_records_total.toLocaleString()}
          sub={t("dashboard.admin.storage.lifetime")}
          icon="fileText"
        />
        <StatCard
          label={t("dashboard.admin.storage.database")}
          value={formatBytes(storage.db_size_bytes)}
          sub={t("dashboard.admin.storage.postgresTotal")}
          icon="database"
        />
        <StatCard
          label={t("dashboard.admin.storage.reportsAttachments")}
          value={formatBytes(
            storage.reports_bytes +
              storage.attachments_bytes +
              storage.erp_exports_bytes,
          )}
          sub={t("dashboard.admin.storage.reportsAttachmentsDetail", {
            reports: formatBytes(storage.reports_bytes),
            attachments: formatBytes(storage.attachments_bytes),
          })}
          icon="download"
        />
      </div>
      <div
        className="text-xs text-dim"
        style={{ marginBottom: 16, marginTop: -8 }}
      >
        {t("dashboard.admin.storage.tenantSubtotal", { size: formatBytes(tenantSubtotal) })}
      </div>
    </>
  );
}

function DiskUsageCard({ storage }: { storage: StorageStats }) {
  const { t } = useTranslation();
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
            {t("dashboard.admin.disk.title")}
          </div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 22,
              marginTop: 4,
              letterSpacing: "-0.01em",
            }}
          >
            {t("dashboard.admin.disk.used", { size: formatBytes(storage.disk_used_bytes) })}{" "}
            <span style={{ color: "var(--text-secondary)" }}>
              {t("dashboard.admin.disk.free", { size: formatBytes(storage.disk_free_bytes) })}
            </span>
          </div>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {t("dashboard.admin.disk.ofTotal", {
              total: formatBytes(storage.disk_total_bytes),
              tenant: formatBytes(tenantBytes),
              pct: tenantPct,
            })}
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
        aria-label={t("dashboard.admin.disk.usedAria", { pct: usedPct })}
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
        <LegendDot color="var(--accent)" label={t("dashboard.admin.disk.legendTenant")} />
        <LegendDot color={barFill} label={t("dashboard.admin.disk.legendWhole")} />
        <LegendDot color="var(--bg-sunken)" label={t("dashboard.admin.disk.legendFree")} />
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
