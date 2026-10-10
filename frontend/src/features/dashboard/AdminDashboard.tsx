// Admin dashboard — system-wide stats. Mirrors the system-metrics
// portion of design/dashboards.jsx::AdminDashboard, but only with
// real numbers (no synthetic time series).
//
// Layout: greeting header → 4 KPI cards → two-column row (recent
// events table | capture pipeline) → storage card (segmented bar +
// four mini stats).

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useMe } from "../../auth/AuthProvider";
import { SkeletonCards, SkeletonRows } from "../../components/Skeleton";
import { useDetectionEvents } from "../camera-logs/hooks";
import { useCamerasHealth, useSystemHealth } from "../system/hooks";
import type { StorageStats } from "../system/types";
import { Panel, PanelEmpty, PanelError, SegmentBar, SoftPill, Tile, TileGrid, firstName, nowrap } from "./DashUi";
import type { Tone } from "./DashUi";
import { StatusBreakdown } from "./StatusBreakdown";

export function AdminDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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

  const onlineCount = cams.data ? cams.data.items.filter((c) => c.latest_reachable).length : 0;
  const totalCams = cams.data?.items.length ?? 0;
  const enabledCams = cams.data ? cams.data.items.filter((c) => c.enabled).length : 0;
  const camTone: Tone =
    totalCams === 0 ? "neutral" : onlineCount === totalCams ? "success" : onlineCount === 0 ? "danger" : "warning";
  const enrolledPct =
    health.data && health.data.employees_active > 0
      ? Math.round((100 * health.data.enrolled_employees) / health.data.employees_active)
      : null;

  const retryLabel = t("dashboard.common.retry", { defaultValue: "Retry" });
  const loadFailedBody = t("dashboard.common.loadFailedBody", { defaultValue: "The API did not respond. Try again in a moment." });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data ? t("dashboard.admin.greeting", { name: firstName(me.data.full_name) }) : t("dashboard.admin.title")}
          </h1>
          <p className="page-sub">{t("dashboard.admin.subtitle")}</p>
        </div>
      </div>

      {health.isLoading || cams.isLoading ? (
        <div style={{ marginBottom: 20 }}>
          <SkeletonCards count={4} />
        </div>
      ) : (
        <TileGrid>
          <Tile
            tone={camTone}
            icon="camera"
            label={t("dashboard.admin.stats.camerasOnline")}
            value={cams.data ? `${onlineCount}/${totalCams}` : "—"}
            sub={cams.data ? t("dashboard.admin.stats.enabledCount", { count: enabledCams }) : ""}
            onClick={() => navigate("/cameras")}
          />
          <Tile
            tone="info"
            icon="activity"
            label={t("dashboard.admin.stats.eventsToday")}
            value={health.data ? health.data.detection_events_today.toLocaleString() : "—"}
            sub={t("dashboard.admin.stats.capturedIdentified")}
            onClick={() => navigate("/camera-logs")}
          />
          <Tile
            tone={enrolledPct !== null && enrolledPct < 50 ? "warning" : "accent"}
            icon="users"
            label={t("dashboard.admin.stats.enrolled")}
            value={health.data ? `${health.data.enrolled_employees}/${health.data.employees_active}` : "—"}
            sub={t("dashboard.admin.stats.haveEmbedding")}
            onClick={() => navigate("/employees")}
          />
          <Tile
            tone="success"
            icon="fileText"
            label={t("dashboard.admin.stats.attendanceToday")}
            value={health.data ? health.data.attendance_records_today.toLocaleString() : "—"}
            sub={t("dashboard.admin.stats.rowsRecomputed")}
            onClick={() => navigate("/daily-attendance")}
          />
        </TileGrid>
      )}

      <div className="dsh-row-2">
        <Panel
          title={t("dashboard.admin.recent.title")}
          sub={t("dashboard.admin.recent.caption")}
          bodyPadding={0}
          actions={
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("/camera-logs")}>
              {t("dashboard.admin.recent.viewAll", { defaultValue: "View all" })}
            </button>
          }
        >
          {recent.isError ? (
            <PanelError
              title={t("dashboard.admin.recent.loadFailed", { defaultValue: "Couldn't load recent events" })}
              body={loadFailedBody}
              retryLabel={retryLabel}
              onRetry={() => void recent.refetch()}
            />
          ) : recent.data && recent.data.items.length === 0 ? (
            <PanelEmpty
              tone="accent"
              icon="camera"
              title={t("dashboard.admin.recent.emptyTitle", { defaultValue: "No detections yet" })}
              body={t("dashboard.admin.recent.empty")}
              action={
                <button type="button" className="btn btn-sm" onClick={() => navigate("/cameras")}>
                  {t("dashboard.admin.recent.goCameras", { defaultValue: "Open cameras" })}
                </button>
              }
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("dashboard.admin.recent.cols.time")}</th>
                  <th>{t("dashboard.admin.recent.cols.camera")}</th>
                  <th>{t("dashboard.admin.recent.cols.identified")}</th>
                  <th className="dsh-end">{t("dashboard.admin.recent.cols.confidence")}</th>
                </tr>
              </thead>
              <tbody>
                {recent.isLoading && <SkeletonRows cols={4} rows={5} />}
                {recent.data?.items.map((ev) => (
                  <tr key={ev.id}>
                    <td className="mono text-sm" style={nowrap}>
                      {new Date(ev.captured_at).toLocaleTimeString()}
                    </td>
                    <td className="text-sm" style={nowrap}>
                      {ev.camera_name}
                    </td>
                    <td className="text-sm">
                      {ev.employee_id ? (
                        <span className="dsh-strong">{ev.employee_name}</span>
                      ) : (
                        <SoftPill tone="warning">{t("dashboard.common.unidentified")}</SoftPill>
                      )}
                    </td>
                    <td className="mono text-sm dsh-end">{ev.confidence !== null ? `${(ev.confidence * 100).toFixed(0)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <StatusBreakdown
          title={t("dashboard.admin.capture.title")}
          caption={t("dashboard.admin.capture.now")}
          slices={[
            { label: t("dashboard.admin.capture.workers"), value: health.data?.capture_workers_running ?? 0, tone: "accent" },
            { label: t("dashboard.admin.capture.camerasEnabled"), value: health.data?.cameras_enabled ?? 0, tone: "neutral" },
            { label: t("dashboard.admin.capture.dbConn"), value: health.data?.db_connections_active ?? 0, tone: "info" },
          ]}
        />
      </div>

      {health.isError && (
        <Panel title={t("dashboard.admin.storage.title", { defaultValue: "Storage & data" })}>
          <PanelError
            title={t("dashboard.admin.storage.loadFailed", { defaultValue: "Couldn't load storage stats" })}
            body={loadFailedBody}
            retryLabel={retryLabel}
            onRetry={() => void health.refetch()}
          />
        </Panel>
      )}
      {health.data?.storage && <StorageSection storage={health.data.storage} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Storage section — disk usage bar + per-bucket mini stats
// ---------------------------------------------------------------------------

function StorageSection({ storage }: { storage: StorageStats }) {
  const { t } = useTranslation();
  const total = storage.disk_total_bytes || 1;
  const tenantBytes =
    storage.face_crops_bytes + storage.attachments_bytes + storage.reports_bytes + storage.erp_exports_bytes + storage.db_size_bytes;
  const usedPct = Math.min(100, Math.round((storage.disk_used_bytes / total) * 100));
  const tenantPct = Math.min(100, Math.round((tenantBytes / total) * 100));
  const otherUsed = Math.max(0, storage.disk_used_bytes - tenantBytes);
  const free = Math.max(0, storage.disk_total_bytes - storage.disk_used_bytes);
  const tone: Tone = usedPct >= 90 ? "danger" : usedPct >= 75 ? "warning" : "accent";

  return (
    <Panel
      title={t("dashboard.admin.storage.title", { defaultValue: "Storage & data" })}
      sub={t("dashboard.admin.storage.tenantSubtotal", { size: formatBytes(tenantBytes) })}
    >
      <div className="dsh-storage-head">
        <div>
          <div className="mg-stat-label">{t("dashboard.admin.disk.title")}</div>
          <div className="dsh-storage-figure">
            {t("dashboard.admin.disk.used", { size: formatBytes(storage.disk_used_bytes) })}{" "}
            <span>{t("dashboard.admin.disk.free", { size: formatBytes(storage.disk_free_bytes) })}</span>
          </div>
          <div className="mg-stat-sub">
            {t("dashboard.admin.disk.ofTotal", { total: formatBytes(storage.disk_total_bytes), tenant: formatBytes(tenantBytes), pct: tenantPct })}
          </div>
        </div>
        <div className="dsh-storage-pct">
          <div className="mg-stat-label">{t("dashboard.admin.disk.usedLabel", { defaultValue: "Disk used" })}</div>
          <div className={`mg-stat-value is-${tone}`}>{usedPct}%</div>
        </div>
      </div>
      {/* Segments: this tenant · rest of the disk · free. Helps the
          operator distinguish "I'm 80% full" from "I'm 80% full
          because of this tenant". */}
      <SegmentBar
        label={t("dashboard.admin.disk.usedAria", { pct: usedPct })}
        segments={[
          { tone: "accent", value: tenantBytes, title: `${t("dashboard.admin.disk.legendTenant")} — ${formatBytes(tenantBytes)}` },
          { tone: tone === "accent" ? "neutral" : tone, value: otherUsed, title: `${t("dashboard.admin.disk.legendWhole")} — ${formatBytes(storage.disk_used_bytes)}` },
          { tone: "free", value: free, title: `${t("dashboard.admin.disk.legendFree")} — ${formatBytes(free)}` },
        ]}
      />
      <div className="dsh-legend-inline">
        <span>
          <span aria-hidden className="dsh-legend-dot is-accent" />
          {t("dashboard.admin.disk.legendTenant")}
        </span>
        <span>
          <span aria-hidden className={`dsh-legend-dot is-${tone === "accent" ? "neutral" : tone}`} />
          {t("dashboard.admin.disk.legendWhole")}
        </span>
        <span>
          <span aria-hidden className="dsh-legend-dot is-free" />
          {t("dashboard.admin.disk.legendFree")}
        </span>
      </div>

      <div className="dsh-mini-grid dsh-storage-mini">
        <Tile
          tone="neutral"
          icon="activity"
          label={t("dashboard.admin.storage.capturedEvents")}
          value={storage.detection_events_total.toLocaleString()}
          sub={t("dashboard.admin.storage.onDisk", { size: formatBytes(storage.face_crops_bytes) })}
        />
        <Tile
          tone="neutral"
          icon="fileText"
          label={t("dashboard.admin.storage.attendanceRows")}
          value={storage.attendance_records_total.toLocaleString()}
          sub={t("dashboard.admin.storage.lifetime")}
        />
        <Tile
          tone="neutral"
          icon="database"
          label={t("dashboard.admin.storage.database")}
          value={formatBytes(storage.db_size_bytes)}
          sub={t("dashboard.admin.storage.postgresTotal")}
        />
        <Tile
          tone="neutral"
          icon="download"
          label={t("dashboard.admin.storage.reportsAttachments")}
          value={formatBytes(storage.reports_bytes + storage.attachments_bytes + storage.erp_exports_bytes)}
          sub={t("dashboard.admin.storage.reportsAttachmentsDetail", {
            reports: formatBytes(storage.reports_bytes),
            attachments: formatBytes(storage.attachments_bytes),
          })}
        />
      </div>
    </Panel>
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
  return v >= 100 || i === 0 ? `${v.toFixed(0)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}
