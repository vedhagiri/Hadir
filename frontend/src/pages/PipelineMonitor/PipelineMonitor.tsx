// Pipeline Monitor — dedicated dashboard for the 4 worker stages:
// RTSP Feed / Clip Recording / Encoding / Identify Event.
//
// Polls /api/operations/pipeline every 3 s. Tabbed interface: one
// stage visible at a time. Summary chips along the top show the
// headline counts across all stages so the operator gets the
// at-a-glance number without leaving whichever tab they're on.

import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { RestartAllModal } from "../../features/operations/RestartAllModal";
import { useRestartAllAndRecover } from "../../features/operations/hooks";
import type { RestartAllAndRecoverResult } from "../../features/operations/types";
import { Icon } from "../../shell/Icon";
import { ALL_USE_CASE_CODES, useEnabledUseCases } from "../../hooks/useEnabledUseCases";
import type { IconName } from "../../shell/Icon";
import { ClearQueuesAction } from "./ClearQueuesAction";
import { QueueHistoryAction } from "./QueueHistoryAction";
import { ResourcesPanel } from "./ResourcesPanel";
import { SkeletonCards, SkeletonTable } from "../../components/Skeleton";
import { EmptyPanel } from "../../components/ListPageUi";
import {
  Banner,
  CountStrip,
  FilledTab,
  METRIC_ICON,
  MetricGrid,
  MetricTile,
  ProgressBar,
  SectionLabel,
  SoftPill,
  StatusDot,
  TabStrip,
  type PillTone,
} from "../../features/system/opsUi";

const POLL_INTERVAL_MS = 3000;

type StageKey =
  | "cameras"
  | "workers"
  | "rtsp"
  | "recording"
  | "identify"
  | "queues"
  | "resources";

interface RtspWorker {
  camera_id: number;
  camera_name: string;
  status: "starting" | "running" | "reconnecting" | "stopped" | "failed";
  uptime_sec: number;
  fps_reader: number;
  fps_analyzer: number;
  errors_5min: number;
  last_error?: string | null;
}

interface RecordingCamera {
  camera_id: number;
  camera_name: string;
  recording_active: boolean;
  current_clip_id: number | null;
  elapsed_sec: number;
  total_frames_written: number;
  chunks_completed: number;
}

interface EncodingWorker {
  camera_id: number;
  camera_name: string;
  alive: boolean;
  queue_size: number;
}

interface IdentifyUseCaseStats {
  use_case: string; // "uc1" | "uc2"
  pending: number;
  processing: number;
  completed_today: number;
  failed_today: number;
  completed_total: number;
}

interface PipelineMonitorOut {
  rtsp: {
    running: number;
    reconnecting: number;
    stopped: number;
    failed: number;
    configured: number;
    workers: RtspWorker[];
  };
  recording: {
    active: number;
    enabled_cameras: number;
    cameras: RecordingCamera[];
  };
  encoding: {
    queued: number;
    processing: number;
    completed_today: number;
    failed_today: number;
    alive_workers: number;
    total_workers: number;
    workers: EncodingWorker[];
  };
  identify: {
    running: number;
    pending: number;
    processing: number;
    completed_today: number;
    failed_today: number;
    active_clip_ids: number[];
    batch_status: string;
    use_cases: IdentifyUseCaseStats[];
  };
  generated_at: string;
}

const TABS: { key: StageKey; labelKey: string; icon: IconName }[] = [
  // "Cameras" rolls up RTSP + recording + encoding per camera so an
  // operator gets the per-device picture without switching tabs. It's
  // the default landing tab — replaces the standalone Worker Monitoring
  // page that used to live at /operations/workers.
  { key: "cameras", labelKey: "pipelineMonitor.tabs.cameras", icon: "camera" },
  { key: "workers", labelKey: "pipelineMonitor.tabs.workers", icon: "activity" },
  { key: "rtsp", labelKey: "pipelineMonitor.tabs.rtsp", icon: "camera" },
  { key: "recording", labelKey: "pipelineMonitor.tabs.recording", icon: "videocam" },
  { key: "identify", labelKey: "pipelineMonitor.tabs.identify", icon: "user" },
  { key: "queues", labelKey: "pipelineMonitor.tabs.queues", icon: "activity" },
  // P29 — Resources tab. Live host CPU/mem/disk/net + per-camera
  // resource share + per-stage breakdown. Admin-only by the same
  // ``isAdmin`` gate the rest of the page uses.
  { key: "resources", labelKey: "pipelineMonitor.tabs.resources", icon: "activity" },
];

function fmtUptime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

export function PipelineMonitor() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<StageKey>("cameras");
  const me = useMe();
  // Don't even fire the request until /api/auth/me has resolved and
  // confirms the viewer is Admin. AdminOnly already redirects
  // non-Admins, but during the brief loading window the page can
  // mount with stale cache and pre-empt the redirect — the
  // ``enabled`` guard keeps us from issuing a doomed call.
  const isAdmin = me.data?.active_role === "Admin";

  const query = useQuery({
    queryKey: ["operations", "pipeline"],
    queryFn: () => api<PipelineMonitorOut>("/api/operations/pipeline"),
    enabled: isAdmin,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => {
      // Don't burn the polling budget retrying obvious permission
      // failures — those won't change between polls.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        return false;
      }
      return failureCount < 2;
    },
  });

  const data = query.data;
  const hasCameras =
    !!data &&
    data.rtsp.workers.length + data.recording.cameras.length + data.encoding.workers.length > 0;
  const errorMessage = (() => {
    if (!query.isError) return null;
    const err = query.error;
    if (err instanceof ApiError) {
      if (err.status === 401) {
        return t("pipelineMonitor.errors.sessionExpired");
      }
      if (err.status === 403) {
        return t("pipelineMonitor.errors.adminOnly");
      }
      if (err.status >= 500) {
        return t("pipelineMonitor.errors.unavailable", { status: err.status });
      }
      return t("pipelineMonitor.errors.loadFailedStatus", { status: err.status });
    }
    return t("pipelineMonitor.errors.loadFailed");
  })();

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("pipelineMonitor.title")}</h1>
          <p className="page-sub">
            {t("pipelineMonitor.subtitle")}
            {/* The Resources tab is manual-refresh (its own Sync Now +
                Last Updated), so suppress the shared auto-refresh timer
                text there. */}
            {tab !== "resources" && (
              <>
                {" "}
                {t("pipelineMonitor.autoRefresh", {
                  seconds: POLL_INTERVAL_MS / 1000,
                })}
                {data && (
                  <>
                    {" "}
                    <span className="text-dim">
                      {t("pipelineMonitor.lastUpdate", {
                        time: new Date(data.generated_at).toLocaleTimeString(),
                      })}
                    </span>
                  </>
                )}
              </>
            )}
          </p>
        </div>
        {isAdmin && (
          <div className="page-actions">
            <ClearQueuesAction />
            <QueueHistoryAction />
            <RestartAllWorkersAction />
          </div>
        )}
      </div>

      {query.isLoading && isAdmin && (
        <div className="ops-stack" style={{ marginBottom: 16 }}>
          <SkeletonCards count={4} />
        </div>
      )}

      {/* Top summary tiles — same numbers in all tabs so the operator
          gets headline counts without switching. Clicking a tile jumps
          to that stage's tab. Hidden when no camera is in the pipeline
          at all — the Cameras tab shows the empty state instead. */}
      {data && hasCameras && (
      <MetricGrid>
        <MetricTile
          tone={
            !data
              ? "neutral"
              : data.rtsp.failed > 0
                ? "danger"
                : data.rtsp.reconnecting > 0
                  ? "warning"
                  : data.rtsp.workers.length > 0
                    ? "success"
                    : "neutral"
          }
          icon={METRIC_ICON.camera}
          label={t("pipelineMonitor.chips.rtspRunning")}
          value={data ? `${data.rtsp.running} / ${data.rtsp.workers.length}` : "—"}
          sub={
            data
              ? data.rtsp.failed + data.rtsp.reconnecting > 0
                ? t("pipelineMonitor.chips.rtspIssues", {
                    defaultValue: "{{failed}} failed · {{reconnecting}} reconnecting",
                    failed: data.rtsp.failed,
                    reconnecting: data.rtsp.reconnecting,
                  })
                : t("pipelineMonitor.chips.allHealthy", { defaultValue: "All healthy" })
              : ""
          }
          active={tab === "rtsp"}
          onClick={() => setTab("rtsp")}
        />
        <MetricTile
          tone={
            !data
              ? "neutral"
              : data.recording.enabled_cameras > 0 && data.recording.active < data.recording.enabled_cameras
                ? "warning"
                : "info"
          }
          icon={METRIC_ICON.record}
          label={t("pipelineMonitor.chips.recordingActive")}
          value={
            data
              ? `${data.recording.active} / ${data.recording.enabled_cameras}`
              : "—"
          }
          sub={t("pipelineMonitor.chips.recordingSub", { defaultValue: "Cameras recording clips" })}
          active={tab === "recording"}
          onClick={() => setTab("recording")}
        />
        <MetricTile
          tone={!data ? "neutral" : data.encoding.failed_today > 0 ? "danger" : "info"}
          icon={METRIC_ICON.queue}
          label={t("pipelineMonitor.chips.encodingQueue")}
          value={
            data
              ? t("pipelineMonitor.chips.encodingQueueValue", { queued: data.encoding.queued, processing: data.encoding.processing })
              : "—"
          }
          sub={
            data && data.encoding.failed_today > 0
              ? t("pipelineMonitor.chips.failedToday", {
                  defaultValue: "{{n}} failed today",
                  n: data.encoding.failed_today,
                })
              : t("pipelineMonitor.chips.noFailuresToday", { defaultValue: "No failures today" })
          }
          active={tab === "queues"}
          onClick={() => setTab("queues")}
        />
        <MetricTile
          tone={!data ? "neutral" : data.identify.failed_today > 0 ? "danger" : "success"}
          icon={METRIC_ICON.users}
          label={t("pipelineMonitor.chips.identifyRunning")}
          value={
            data
              ? t("pipelineMonitor.chips.identifyRunningValue", { running: data.identify.running, pending: data.identify.pending })
              : "—"
          }
          sub={
            data && data.identify.failed_today > 0
              ? t("pipelineMonitor.chips.failedToday", {
                  defaultValue: "{{n}} failed today",
                  n: data.identify.failed_today,
                })
              : t("pipelineMonitor.chips.noFailuresToday", { defaultValue: "No failures today" })
          }
          active={tab === "identify"}
          onClick={() => setTab("identify")}
        />
      </MetricGrid>
      )}

      {/* Tab strip — segmented control. */}
      <TabStrip label={t("pipelineMonitor.stagesAria")}>
        {TABS.map((tabItem) => (
          <FilledTab
            key={tabItem.key}
            id={`pm-tab-${tabItem.key}`}
            controls="pm-tabpanel"
            active={tab === tabItem.key}
            onClick={() => setTab(tabItem.key)}
          >
            <Icon name={tabItem.icon} size={14} />
            {t(tabItem.labelKey)}
          </FilledTab>
        ))}
      </TabStrip>

      <div
        className="card ops-panel"
        id="pm-tabpanel"
        role="tabpanel"
        aria-labelledby={`pm-tab-${tab}`}
      >
          {(query.isLoading || (!isAdmin && me.isLoading)) && (
            <SkeletonTable rows={3} cols={6} />
          )}
          {!me.isLoading && !isAdmin && (
            <EmptyPanel
              tone="warning"
              icon={<Icon name="shield" size={30} />}
              title={t("pipelineMonitor.adminOnlyTitle", { defaultValue: "Admins only" })}
              body={t("pipelineMonitor.adminOnlyNotice")}
            />
          )}
          {errorMessage && (
            <EmptyPanel
              tone="danger"
              icon={<Icon name="info" size={30} />}
              title={t("pipelineMonitor.errors.title", { defaultValue: "Couldn't load the pipeline" })}
              body={errorMessage}
              actions={
                <button className="btn" onClick={() => query.refetch()} disabled={query.isFetching}>
                  <Icon name="refresh" size={12} />
                  {t("pipelineMonitor.retry", { defaultValue: "Try again" })}
                </button>
              }
            />
          )}
          {data && tab === "cameras" && <CamerasPanel data={data} />}
          {data && tab === "rtsp" && <RtspPanel data={data.rtsp} />}
          {data && tab === "recording" && (
            <RecordingPanel data={data.recording} rtsp={data.rtsp} />
          )}
          {data && tab === "identify" && <IdentifyPanel data={data.identify} />}
          {tab === "queues" && <QueuePipelinePanel />}
          {tab === "workers" && <WorkersTablePanel />}
          {tab === "resources" && <ResourcesPanel isAdmin={isAdmin} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab "Cameras" — per-camera roll-up across every stage.
// One row per active camera, columns: Worker status / RTSP / Clip Saving /
// Processing. Absorbs the standalone Worker Monitoring page into a single
// operational view. Source: same /api/operations/pipeline payload that
// drives every other tab (no extra request).
// ---------------------------------------------------------------------------

interface CameraRow {
  camera_id: number;
  camera_name: string;
  rtsp: RtspWorker | null;
  recording: RecordingCamera | null;
  encoding: EncodingWorker | null;
}

function buildCameraRows(data: PipelineMonitorOut): CameraRow[] {
  // Union the camera ids surfaced across the three per-camera lists so
  // a camera whose worker is reconnecting (no recording row yet) still
  // appears. recording.cameras + encoding.workers carry the human-
  // readable camera_name when rtsp.workers doesn't.
  const byId = new Map<number, CameraRow>();
  const ensure = (id: number, name: string): CameraRow => {
    const existing = byId.get(id);
    if (existing) {
      if (!existing.camera_name && name) existing.camera_name = name;
      return existing;
    }
    const row: CameraRow = {
      camera_id: id,
      camera_name: name,
      rtsp: null,
      recording: null,
      encoding: null,
    };
    byId.set(id, row);
    return row;
  };

  for (const w of data.rtsp.workers) {
    const r = ensure(w.camera_id, w.camera_name);
    r.rtsp = w;
  }
  for (const c of data.recording.cameras) {
    const r = ensure(c.camera_id, c.camera_name);
    r.recording = c;
  }
  for (const e of data.encoding.workers) {
    const r = ensure(e.camera_id, e.camera_name);
    r.encoding = e;
  }
  return [...byId.values()].sort((a, b) => {
    // Failed first, then reconnecting, then by name. Operators see what
    // needs attention without scrolling.
    const rank = (row: CameraRow): number => {
      const s = row.rtsp?.status;
      if (s === "failed") return 0;
      if (s === "reconnecting") return 1;
      if (s === "starting") return 2;
      if (s === "running") return 3;
      return 4;
    };
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.camera_name.localeCompare(b.camera_name);
  });
}

function CamerasPanel({ data }: { data: PipelineMonitorOut }) {
  const { t } = useTranslation();
  const rows = buildCameraRows(data);

  const recordingActive = data.recording.active;
  const recordingEnabled = data.recording.enabled_cameras;

  if (rows.length === 0) {
    return (
      <EmptyPanel
        tone="accent"
        icon={<Icon name="camera" size={30} />}
        title={t("pipelineMonitor.cameras.emptyTitle", { defaultValue: "No cameras in the pipeline" })}
        body={`${t("pipelineMonitor.cameras.emptyPrefix")} ${t("pipelineMonitor.cameras.emptyLink")} ${t("pipelineMonitor.cameras.emptySuffix")}`}
        actions={
          <a href="/cameras" className="btn btn-primary">
            <Icon name="plus" size={12} />
            {t("pipelineMonitor.cameras.emptyLink")}
          </a>
        }
      />
    );
  }

  return (
    <div className="ops-stack is-tight">
      <CountStrip
        items={[
          {
            label: t("pipelineMonitor.cameras.cards.activeCameras"),
            value: rows.length,
            tone: rows.length > 0 ? "success" : "neutral",
          },
          {
            label: t("pipelineMonitor.cameras.cards.rtspRunning"),
            value: data.rtsp.running,
            tone: data.rtsp.failed > 0 ? "danger" : data.rtsp.reconnecting > 0 ? "warning" : "success",
          },
          {
            label: t("pipelineMonitor.cameras.cards.recording"),
            value: `${recordingActive} / ${recordingEnabled}`,
            tone: recordingActive > 0 ? "success" : "neutral",
          },
          {
            label: t("pipelineMonitor.cameras.cards.encodingAlive"),
            value: `${data.encoding.alive_workers} / ${data.encoding.total_workers}`,
            tone: data.encoding.alive_workers === data.encoding.total_workers ? "success" : "warning",
          },
        ]}
      />

      <div className="ops-table-wrap">
        <table className="table" style={{ minWidth: 880 }}>
          <thead>
            <tr>
              <th>{t("pipelineMonitor.cameras.cols.camera")}</th>
              <th>{t("pipelineMonitor.cameras.cols.workers")}</th>
              <th>{t("pipelineMonitor.cameras.cols.workerStatus")}</th>
              <th>{t("pipelineMonitor.cameras.cols.rtsp")}</th>
              <th>{t("pipelineMonitor.cameras.cols.recording")}</th>
              <th>{t("pipelineMonitor.cameras.cols.processing")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CameraRowView key={row.camera_id} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CameraRowView({ row }: { row: CameraRow }) {
  const { t } = useTranslation();
  // "Workers per camera": each running CaptureWorker bundles a reader
  // + analyzer thread and (optionally) a ClipWorker for encoding. We
  // report a single integer — the count of live sub-workers per
  // camera so the column matches operator intuition.
  const workersRunning = (() => {
    let n = 0;
    if (row.rtsp && row.rtsp.status !== "stopped" && row.rtsp.status !== "failed") {
      n += 1; // reader + analyzer counted as one capture worker
    }
    if (row.encoding?.alive) n += 1;
    return n;
  })();

  const rtspBlurb = (() => {
    if (!row.rtsp) return "—";
    return `${row.rtsp.fps_reader.toFixed(1)} / ${row.rtsp.fps_analyzer.toFixed(1)} fps · err ${row.rtsp.errors_5min}`;
  })();

  const clipBlurb = (() => {
    if (!row.recording) return "—";
    if (row.recording.recording_active) {
      return t("pipelineMonitor.cell.recording", {
        seconds: Math.round(row.recording.elapsed_sec),
      });
    }
    return t("pipelineMonitor.cell.idle");
  })();

  const processingBlurb = (() => {
    if (!row.encoding) return "—";
    if (!row.encoding.alive) return t("pipelineMonitor.cell.workerDown");
    return t("pipelineMonitor.cell.queue", { n: row.encoding.queue_size });
  })();

  const online = row.rtsp?.status === "running";

  return (
    <tr>
      <td>
        <div className="ops-cam">
          <span className={`ops-cam-icon${online ? " is-on" : ""}`} aria-hidden>
            <Icon name="camera" size={13} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="ops-cam-name">{row.camera_name}</div>
            <div className="ops-cam-meta mono">#{row.camera_id}</div>
          </div>
        </div>
      </td>
      <td>
        <span className="mono" style={{ fontWeight: 600, color: workersRunning === 0 ? "var(--danger-text)" : "var(--text)" }}>
          {workersRunning}
        </span>
      </td>
      <td>
        {row.rtsp ? <StatusBadge status={row.rtsp.status} lastError={row.rtsp.last_error} /> : <em className="text-dim">{t("pipelineMonitor.cell.none")}</em>}
      </td>
      <td className="mono text-sm" style={{ whiteSpace: "nowrap" }}>{rtspBlurb}</td>
      <td>
        <SoftPill tone={row.recording?.recording_active ? "success" : "neutral"}>{clipBlurb}</SoftPill>
      </td>
      <td>
        <SoftPill tone={row.encoding?.alive === false ? "danger" : "neutral"}>{processingBlurb}</SoftPill>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: RTSP Feed Worker
// ---------------------------------------------------------------------------

function RtspPanel({ data }: { data: PipelineMonitorOut["rtsp"] }) {
  const { t } = useTranslation();
  if (data.workers.length === 0) {
    return (
      <EmptyPanel
        tone="accent"
        icon={<Icon name="camera" size={30} />}
        title={t("pipelineMonitor.rtsp.emptyTitle", { defaultValue: "No RTSP workers running" })}
        body={t("pipelineMonitor.rtsp.empty")}
        actions={
          <a href="/cameras" className="btn btn-primary">
            <Icon name="plus" size={12} />
            {t("pipelineMonitor.cameras.emptyLink")}
          </a>
        }
      />
    );
  }
  return (
    <div className="ops-stack is-tight">
      <CountStrip
        items={[
          { label: t("pipelineMonitor.rtsp.cards.running"), value: data.running, tone: "success" },
          {
            label: t("pipelineMonitor.rtsp.cards.reconnecting"),
            value: data.reconnecting,
            tone: data.reconnecting > 0 ? "warning" : "neutral",
          },
          {
            label: t("pipelineMonitor.rtsp.cards.failed"),
            value: data.failed,
            tone: data.failed > 0 ? "danger" : "neutral",
          },
          { label: t("pipelineMonitor.rtsp.cards.stopped"), value: data.stopped, tone: "neutral" },
        ]}
      />
      <div className="ops-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("pipelineMonitor.rtsp.cols.camera")}</th>
              <th style={{ width: 130 }}>{t("pipelineMonitor.rtsp.cols.status")}</th>
              <th style={{ width: 100 }}>{t("pipelineMonitor.rtsp.cols.uptime")}</th>
              <th style={{ width: 110 }}>{t("pipelineMonitor.rtsp.cols.fps")}</th>
              <th style={{ width: 100 }}>{t("pipelineMonitor.rtsp.cols.errors5m")}</th>
            </tr>
          </thead>
          <tbody>
            {data.workers.map((w) => (
              <tr key={w.camera_id}>
                <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{w.camera_name}</td>
                <td>
                  <StatusBadge status={w.status} lastError={w.last_error} />
                </td>
                <td className="mono text-sm">{fmtUptime(w.uptime_sec)}</td>
                <td className="mono text-sm">
                  {w.fps_reader.toFixed(1)} / {w.fps_analyzer.toFixed(1)}
                </td>
                <td className="mono text-sm" style={{ color: w.errors_5min > 0 ? "var(--danger-text)" : undefined }}>
                  {w.errors_5min}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Clip Recording Worker
// ---------------------------------------------------------------------------

function RecordingPanel({
  data,
  rtsp,
}: {
  data: PipelineMonitorOut["recording"];
  rtsp: PipelineMonitorOut["rtsp"];
}) {
  const { t } = useTranslation();
  // A camera whose RTSP stream isn't connected (status != running) can't
  // record — surface it as "Offline" instead of "Idle" so the offline
  // cameras show here too. Build the status lookup once.
  const rtspByCam = new Map(rtsp.workers.map((w) => [w.camera_id, w]));
  const isConnected = (camId: number): boolean => rtspByCam.get(camId)?.status === "running";
  const offlineCount = data.cameras.filter((c) => !c.recording_active && !isConnected(c.camera_id)).length;
  const idleCount = Math.max(0, data.enabled_cameras - data.active - offlineCount);
  if (data.cameras.length === 0) {
    return (
      <EmptyPanel
        tone="accent"
        icon={<Icon name="videocam" size={30} />}
        title={t("pipelineMonitor.recording.emptyTitle", { defaultValue: "Nothing recording" })}
        body={t("pipelineMonitor.recording.empty")}
      />
    );
  }
  return (
    <div className="ops-stack is-tight">
      <CountStrip
        items={[
          {
            label: t("pipelineMonitor.recording.cards.currentlyRecording"),
            value: data.active,
            tone: data.active > 0 ? "success" : "neutral",
          },
          { label: t("pipelineMonitor.recording.cards.camerasEnabled"), value: data.enabled_cameras, tone: "neutral" },
          {
            label: t("pipelineMonitor.recording.cards.camerasIdle"),
            value: idleCount,
            tone: "neutral",
          },
          {
            label: t("pipelineMonitor.recording.cards.camerasOffline"),
            value: offlineCount,
            tone: offlineCount > 0 ? "warning" : "neutral",
          },
        ]}
      />
      <div className="ops-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("pipelineMonitor.recording.cols.camera")}</th>
              <th style={{ width: 130 }}>{t("pipelineMonitor.recording.cols.recording")}</th>
              <th style={{ width: 110 }}>{t("pipelineMonitor.recording.cols.clipId")}</th>
              <th style={{ width: 90 }}>{t("pipelineMonitor.recording.cols.elapsed")}</th>
              <th style={{ width: 100 }}>{t("pipelineMonitor.recording.cols.frames")}</th>
              <th style={{ width: 90 }}>{t("pipelineMonitor.recording.cols.chunks")}</th>
            </tr>
          </thead>
          <tbody>
            {data.cameras.map((c) => (
              <tr key={c.camera_id}>
                <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{c.camera_name}</td>
                <td>
                  {c.recording_active ? (
                    <SoftPill tone="danger" dot={false}>
                      <StatusDot tone="danger" pulse /> {t("pipelineMonitor.cell.recordingLabel")}
                    </SoftPill>
                  ) : isConnected(c.camera_id) ? (
                    <SoftPill tone="neutral">{t("pipelineMonitor.cell.idle")}</SoftPill>
                  ) : (
                    <SoftPill tone="neutral" title={rtspByCam.get(c.camera_id)?.last_error || undefined}>
                      {t("pipelineMonitor.cell.offline")}
                    </SoftPill>
                  )}
                </td>
                <td className="mono text-sm">{c.current_clip_id ?? "—"}</td>
                <td className="mono text-sm">{c.recording_active ? `${c.elapsed_sec.toFixed(0)}s` : "—"}</td>
                <td className="mono text-sm">{c.recording_active ? c.total_frames_written.toLocaleString() : "—"}</td>
                <td className="mono text-sm">{c.recording_active ? c.chunks_completed : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: Identify Event Worker (face-match jobs)
// ---------------------------------------------------------------------------

// Visual catalogue mirroring the UC tile design from Clip Analytics
// (Identify Event modal). Tones are design tokens so dark mode and
// tenant branding both pick up automatically.
const UC_META: Record<string, { title: string; subtitle: string; tone: PillTone; iconName: IconName }> = {
  uc1: {
    title: "Use Case 1 (High Accuracy)",
    subtitle: "Finds people first, then their faces — best for crowded or distant areas.",
    tone: "info",
    iconName: "shield",
  },
  uc2: {
    title: "Use Case 2 (Standard)",
    subtitle: "Stores face crops with pose-aware quality scoring.",
    tone: "success",
    iconName: "user",
  },
};

function IdentifyPanel({ data }: { data: PipelineMonitorOut["identify"] }) {
  const { t } = useTranslation();
  const enabledUcs = useEnabledUseCases();
  // Show only the tenant's enabled use cases (Detection & Tracker → Clip
  // processing). Empty match → fall back to all so the panel never blanks.
  const shownUcs = data.use_cases.filter((uc) => (enabledUcs as readonly string[]).includes(uc.use_case));
  const ucs = shownUcs.length ? shownUcs : data.use_cases;
  // Aggregate strip recomputed from the shown use cases so totals match
  // what's displayed (e.g. "Completed today" drops UC2's count when only
  // UC1 is enabled). ``running`` has no per-UC breakdown — keep global.
  const agg = {
    pending: ucs.reduce((a, u) => a + u.pending, 0),
    processing: ucs.reduce((a, u) => a + u.processing, 0),
    completed_today: ucs.reduce((a, u) => a + u.completed_today, 0),
    failed_today: ucs.reduce((a, u) => a + u.failed_today, 0),
  };
  return (
    <div className="ops-stack">
      {/* Aggregate strip — sum across all UCs. */}
      <CountStrip
        items={[
          {
            label: t("pipelineMonitor.identify.cards.runningNow"),
            value: data.running,
            tone: data.running > 0 ? "success" : "neutral",
          },
          {
            label: t("pipelineMonitor.identify.cards.pending"),
            value: agg.pending,
            tone: agg.pending > 0 ? "warning" : "neutral",
          },
          {
            label: t("pipelineMonitor.identify.cards.processing"),
            value: agg.processing,
            tone: agg.processing > 0 ? "success" : "neutral",
          },
          {
            label: t("pipelineMonitor.identify.cards.completedToday"),
            value: agg.completed_today,
            tone: "success",
          },
          {
            label: t("pipelineMonitor.identify.cards.failedToday"),
            value: agg.failed_today,
            tone: agg.failed_today > 0 ? "danger" : "neutral",
          },
        ]}
      />

      {/* Per-use-case breakdown — one card per UC1 / UC2. */}
      <div>
        <SectionLabel>{t("pipelineMonitor.identify.perUseCase")}</SectionLabel>
        <div className="ops-stage-grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 320px), 1fr))` }}>
          {ucs.map((uc) => (
            <UseCaseStatsCard key={uc.use_case} stats={uc} />
          ))}
        </div>
      </div>

      {/* Currently processing chip cloud. */}
      <div>
        <SectionLabel>{t("pipelineMonitor.identify.currentlyProcessing")}</SectionLabel>
        {data.active_clip_ids.length === 0 ? (
          <div className="text-sm text-dim">{t("pipelineMonitor.identify.empty")}</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {data.active_clip_ids.map((cid) => (
              <SoftPill key={cid} tone="success" dot={false} mono>
                <StatusDot tone="success" pulse />
                {t("pipelineMonitor.identify.clipChip", { defaultValue: "Clip #{{id}}", id: cid })}
              </SoftPill>
            ))}
          </div>
        )}
      </div>

      <div className="text-sm text-dim">
        {t("pipelineMonitor.identify.batchWorker", { defaultValue: "Batch worker:" })}{" "}
        <span className="mono">{data.batch_status}</span>
      </div>
    </div>
  );
}

function UseCaseStatsCard({ stats }: { stats: IdentifyUseCaseStats }) {
  const { t } = useTranslation();
  const meta = UC_META[stats.use_case] ?? {
    title: "Unknown",
    subtitle: "",
    tone: "neutral" as PillTone,
    iconName: "user" as IconName,
  };
  const activeInPipeline = stats.pending + stats.processing;
  return (
    <div className={`ops-stage tone-${meta.tone}`}>
      <div className="ops-stage-head">
        <span className="ops-stage-title">
          <span className="ops-stage-icon" aria-hidden>
            <Icon name={meta.iconName} size={15} />
          </span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {stats.use_case.toUpperCase()} · {meta.title}
          </span>
        </span>
        {activeInPipeline > 0 && (
          <SoftPill tone={meta.tone} dot={false}>
            <StatusDot tone={meta.tone} pulse />
            {t("pipelineMonitor.labels.activeCount", { n: activeInPipeline })}
          </SoftPill>
        )}
      </div>
      <div className="ops-stage-sub">{t(`pipelineMonitor.uc.${stats.use_case}`, { defaultValue: meta.subtitle })}</div>

      {/* Per-status grid. */}
      <div className="ops-stage-stats">
        <StatCell label={t("pipelineMonitor.labels.pending")} value={stats.pending} tone={stats.pending > 0 ? "warning" : "neutral"} />
        <StatCell label={t("pipelineMonitor.labels.processing")} value={stats.processing} tone={stats.processing > 0 ? "success" : "neutral"} />
        <StatCell label={t("pipelineMonitor.labels.doneToday")} value={stats.completed_today} tone={stats.completed_today > 0 ? "success" : "neutral"} />
        <StatCell label={t("pipelineMonitor.labels.failedToday")} value={stats.failed_today} tone={stats.failed_today > 0 ? "danger" : "neutral"} />
      </div>

      {/* Footer — lifetime completed total so operators can see the
          background trend without doing math across "today" windows. */}
      <div className="ops-stage-sub" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>{t("pipelineMonitor.labels.lifetimeCompleted")}</span>
        <span className="mono" style={{ fontWeight: 600, color: "var(--text)" }}>
          {stats.completed_total.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function StatCell({ label, value, tone }: { label: string; value: number; tone: PillTone }) {
  return (
    <div className="ops-stage-stat">
      <span className="ops-stage-stat-label">{label}</span>
      <span className={`ops-stage-stat-value${tone === "danger" ? " is-danger" : ""}`} style={tone === "warning" ? { color: "var(--warning-text)" } : undefined}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny shared bits.
// ---------------------------------------------------------------------------

function StatusBadge({
  status,
  lastError,
}: {
  status: RtspWorker["status"];
  lastError?: string | null | undefined;
}) {
  const { t } = useTranslation();
  const map: Record<RtspWorker["status"], PillTone> = {
    starting: "warning",
    running: "success",
    reconnecting: "warning",
    stopped: "neutral",
    failed: "danger",
  };
  // Clearer label when a camera is stopped *because the operator turned
  // auto-reconnect off* — distinguishes intentional "not retrying" from a
  // crash/failure. The reason is surfaced verbatim on hover (title) for
  // every status that carries one.
  const reconnectOff = status === "stopped" && !!lastError && lastError.toLowerCase().includes("reconnect disabled");
  const label = reconnectOff ? t("pipelineMonitor.status.reconnectOff") : t(`pipelineMonitor.status.${status}`);
  return (
    <SoftPill tone={map[status]} title={lastError || undefined}>
      {label}
    </SoftPill>
  );
}

// Queue Pipeline panel (clip_pipeline — new queue-based architecture).
//
// Polls /api/clip-pipeline/status every 1.5 s. Shows two always-on
// stages (Cropping + Matching), the in-flight job each worker is on,
// and every batch the operator has submitted today with the full
// scorecard (total / completed / skipped / failed / remaining + per-UC).
// Side-by-side with the legacy Identify Event tab — both stay until
// the migration is finalised.
// ---------------------------------------------------------------------------

interface QueueStageOut {
  queue_depth: number;
  in_flight: number;
  lifetime_processed: number;
  lifetime_failed: number;
  workers: {
    name: string;
    busy: boolean;
    current_job: string;
    running_for_s: number | null;
  }[];
}

interface QueueBatchOut {
  batch_id: string;
  submitted_at: string;
  submitted_by_email: string | null;
  clip_ids: number[];
  use_cases: string[];
  skip_existing: boolean;
  total_jobs: number;
  queued_jobs: number;
  cropping_now: number;
  matching_now: number;
  completed_jobs: number;
  skipped_jobs: number;
  failed_jobs: number;
  remaining_jobs: number;
  per_uc: Record<
    string,
    {
      total: number;
      queued: number;
      cropping: number;
      matching: number;
      completed: number;
      skipped: number;
      failed: number;
    }
  >;
  completed_at: string | null;
}

interface QueueStatusOut {
  running: boolean;
  cropping: QueueStageOut;
  matching: QueueStageOut;
  batches: QueueBatchOut[];
  config: {
    cropping_workers: number;
    matching_workers: number;
    queue_max_depth: number;
  };
}


function QueuePipelinePanel() {
  const { t } = useTranslation();
  const enabledUcs = useEnabledUseCases();
  const q = useQuery({
    queryKey: ["clip-pipeline", "status"],
    queryFn: () => api<QueueStatusOut>("/api/clip-pipeline/status"),
    refetchInterval: 1500,
    refetchIntervalInBackground: false,
  });

  if (q.isLoading) {
    return <SkeletonCards count={2} minWidth={300} />;
  }
  if (q.isError || !q.data) {
    return (
      <EmptyPanel
        tone="danger"
        icon={<Icon name="info" size={30} />}
        title={t("pipelineMonitor.queue.loadErrorTitle", { defaultValue: "Couldn't load the queue pipeline" })}
        body={t("pipelineMonitor.queue.loadError")}
        actions={
          <button type="button" className="btn" onClick={() => void q.refetch()}>
            <Icon name="refresh" size={12} />
            {t("common.retry", { defaultValue: "Retry" })}
          </button>
        }
      />
    );
  }

  const d = q.data;
  // Cropping workers are spawned per env-enabled use case (process-wide,
  // shared across tenants). Hide the rows for use cases this tenant has
  // disabled (Detection & Tracker → Clip processing) so the operator
  // only sees their active workers. Matching workers carry no UC.
  const disabledUcs = ALL_USE_CASE_CODES.filter((uc) => !enabledUcs.includes(uc));
  const croppingStage =
    disabledUcs.length === 0
      ? d.cropping
      : {
          ...d.cropping,
          workers: d.cropping.workers.filter((w) => !disabledUcs.some((uc) => w.name.includes(uc))),
        };
  return (
    <div className="ops-stack">
      {/* Pipeline status banner */}
      <Banner tone={d.running ? "success" : "danger"} icon={<StatusDot tone={d.running ? "success" : "danger"} pulse={d.running} />}>
        <strong>{d.running ? t("pipelineMonitor.queue.running") : t("pipelineMonitor.queue.stopped")}</strong>
        <span className="text-dim">
          {t("pipelineMonitor.queue.config", {
            cropping: d.config.cropping_workers,
            matching: d.config.matching_workers,
            cap: d.config.queue_max_depth,
          })}
        </span>
      </Banner>

      {/* Two stage cards side-by-side */}
      <div className="ops-two">
        <StageCard
          title={t("pipelineMonitor.queue.cropTitle")}
          subtitle={t("pipelineMonitor.queue.cropSubtitle")}
          stage={croppingStage}
          tone="info"
          icon="camera"
        />
        <StageCard
          title={t("pipelineMonitor.queue.matchTitle")}
          subtitle={t("pipelineMonitor.queue.matchSubtitle")}
          stage={d.matching}
          tone="success"
          icon="user"
        />
      </div>

      {/* Batches */}
      <div>
        <SectionLabel>{t("pipelineMonitor.queue.batchHistory")}</SectionLabel>
        {d.batches.length === 0 ? (
          <div className="text-sm text-dim" style={{ padding: "18px 12px", textAlign: "center", border: "1px dashed var(--border)", borderRadius: "var(--radius)" }}>
            {t("pipelineMonitor.queue.batchEmptyPrefix")} <code>POST /api/clip-pipeline/submit</code> {t("pipelineMonitor.queue.batchEmptySuffix")}
          </div>
        ) : (
          <div className="ops-stack is-tight">
            {d.batches.map((b) => (
              <BatchCard key={b.batch_id} batch={b} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StageCard({
  title,
  subtitle,
  stage,
  tone,
  icon,
}: {
  title: string;
  subtitle: string;
  stage: QueueStageOut;
  tone: PillTone;
  icon: IconName;
}) {
  const { t } = useTranslation();
  const capacity = Math.max(1, stage.workers.length);
  const busy = stage.workers.filter((w) => w.busy).length;
  return (
    <div className={`ops-stage tone-${tone}`}>
      <div className="ops-stage-head">
        <span className="ops-stage-title">
          <span className="ops-stage-icon" aria-hidden>
            <Icon name={icon} size={15} />
          </span>
          {title}
        </span>
        <SoftPill tone={busy > 0 ? tone : "neutral"}>
          {t("pipelineMonitor.queue.busyOf", { defaultValue: "{{busy}} / {{total}} busy", busy, total: stage.workers.length })}
        </SoftPill>
      </div>
      <div className="ops-stage-sub">{subtitle}</div>
      <ProgressBar value={(busy / capacity) * 100} tone={tone} thin label={title} />
      <div className="ops-stage-stats">
        <MiniStat label={t("pipelineMonitor.labels.queued")} value={stage.queue_depth} accent />
        <MiniStat label={t("pipelineMonitor.labels.processing")} value={stage.in_flight} accent />
        <MiniStat label={t("pipelineMonitor.labels.doneLifetime")} value={stage.lifetime_processed} />
        <MiniStat label={t("pipelineMonitor.labels.failed")} value={stage.lifetime_failed} danger={stage.lifetime_failed > 0} />
      </div>
      <div>
        <div className="ops-section-label" style={{ marginBottom: 6 }}>{t("pipelineMonitor.queue.activeWorkers")}</div>
        <div className="ops-stack" style={{ gap: 4 }}>
          {stage.workers.map((w) => (
            <div key={w.name} className={`ops-worker-row${w.busy ? " is-busy" : ""}`}>
              <StatusDot tone={w.busy ? tone : "neutral"} pulse={w.busy} />
              <span className="ops-worker-name">{w.name}</span>
              <span className="ops-worker-job">
                {w.busy ? w.current_job + (w.running_for_s != null ? ` · ${w.running_for_s.toFixed(1)}s` : "") : t("pipelineMonitor.labels.idleLower")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent = false, danger = false }: { label: string; value: number; accent?: boolean; danger?: boolean }) {
  return (
    <div className="ops-stage-stat">
      <span className="ops-stage-stat-label">{label}</span>
      <span className={`ops-stage-stat-value${danger ? " is-danger" : accent ? " is-accent" : ""}`}>{value.toLocaleString()}</span>
    </div>
  );
}

function BatchCard({ batch }: { batch: QueueBatchOut }) {
  const { t } = useTranslation();
  const pct =
    batch.total_jobs > 0
      ? Math.round(((batch.completed_jobs + batch.skipped_jobs + batch.failed_jobs) / batch.total_jobs) * 100)
      : 0;
  const done = batch.completed_at !== null;
  return (
    <div className="ops-stage tone-neutral">
      <div className="ops-stage-head">
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>#{batch.batch_id}</div>
          <div className="ops-stage-sub">
            {new Date(batch.submitted_at).toLocaleString()} · {batch.submitted_by_email ?? "—"} ·{" "}
            {t("pipelineMonitor.queue.clipCount", { defaultValue: "{{count}} clips", count: batch.clip_ids.length })} ·{" "}
            {t("pipelineMonitor.queue.ucs", { defaultValue: "UCs:" })} {batch.use_cases.map((u) => u.toUpperCase()).join(", ")}
            {batch.skip_existing ? ` · ${t("pipelineMonitor.queue.skipExisting", { defaultValue: "skip existing" })}` : ""}
          </div>
        </div>
        <SoftPill tone={done ? "success" : "info"} mono>
          {done ? t("pipelineMonitor.labels.completed") : `${pct}%`}
        </SoftPill>
      </div>

      <ProgressBar value={pct} tone={done ? "success" : "info"} label={`#${batch.batch_id}`} />

      {/* Scorecard — selected / completed / skipped / failed / remaining */}
      <div className="ops-stage-stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))" }}>
        <MiniStat label={t("pipelineMonitor.labels.selected")} value={batch.total_jobs} />
        <MiniStat label={t("pipelineMonitor.labels.completed")} value={batch.completed_jobs} />
        <MiniStat label={t("pipelineMonitor.labels.skipped")} value={batch.skipped_jobs} />
        <MiniStat label={t("pipelineMonitor.labels.failed")} value={batch.failed_jobs} danger={batch.failed_jobs > 0} />
        <MiniStat label={t("pipelineMonitor.labels.remaining")} value={batch.remaining_jobs} accent />
      </div>

      {/* In-flight counters per stage */}
      <div className="ops-stage-sub" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span>
          <strong style={{ color: "var(--text)" }}>{batch.queued_jobs}</strong> {t("pipelineMonitor.queue.waitingInQueue")}
        </span>
        <span>·</span>
        <span>
          <strong style={{ color: "var(--text)" }}>{batch.cropping_now}</strong> {t("pipelineMonitor.queue.croppingNow")}
        </span>
        <span>·</span>
        <span>
          <strong style={{ color: "var(--text)" }}>{batch.matching_now}</strong> {t("pipelineMonitor.queue.matchingNow")}
        </span>
      </div>

      {/* Per-UC strip */}
      <div className="ops-stage-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, batch.use_cases.length)}, 1fr)`, gap: 8 }}>
        {batch.use_cases.map((uc) => (
          <UcStrip key={uc} uc={uc} stats={batch.per_uc[uc] ?? null} />
        ))}
      </div>
    </div>
  );
}

function UcStrip({
  uc,
  stats,
}: {
  uc: string;
  stats:
    | {
        total: number;
        queued: number;
        cropping: number;
        matching: number;
        completed: number;
        skipped: number;
        failed: number;
      }
    | null;
}) {
  const total = stats?.total ?? 0;
  const completed = stats?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="ops-worker-row" style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.04em" }}>{uc.toUpperCase()}</span>
        <span className="mono text-xs text-dim">
          {completed} / {total}
        </span>
      </div>
      <ProgressBar value={pct} tone="info" thin label={uc} />
      <div className="text-xs text-dim" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        <span>Q {stats?.queued ?? 0}</span>
        <span>· C {stats?.cropping ?? 0}</span>
        <span>· M {stats?.matching ?? 0}</span>
        <span>· S {stats?.skipped ?? 0}</span>
        {(stats?.failed ?? 0) > 0 && <span style={{ color: "var(--danger-text)" }}>· F {stats?.failed}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

// Workers panel — unified table covering all 13 always-on workers.
//
// Polls /api/pipeline-monitor/workers every 1.5 s. Single source of
// truth for the dashboard table the operator asked for: one row per
// worker, grouped by category, with health + speed columns.
// ---------------------------------------------------------------------------

interface WorkerRow {
  name: string;
  group: string;
  status: string;
  active_jobs: number | null;
  active_unit: string | null;
  queue_count: number | null;
  processing: number | null;
  completed: number | null;
  failed: number | null;
  current_task: string;
  speed_ms: number | null;
  health: string;
  next_run: string | null;
  detail: Record<string, unknown>;
}

interface WorkersGroup {
  key: string;
  label: string;
  workers: WorkerRow[];
}

interface WorkersSnapshot {
  generated_at: string;
  took_ms: number;
  summary: {
    total_workers: number;
    running: number;
    stalled: number;
    degraded: number;
  };
  groups: WorkersGroup[];
}


function WorkersTablePanel() {
  const { t } = useTranslation();
  // Manual-refresh only — auto-polling removed at operator request.
  // The "Sync now" button below is the sole refresh path; the panel
  // also fetches once on mount and on tab switch.
  const q = useQuery({
    queryKey: ["pipeline-monitor", "workers"],
    queryFn: () => api<WorkersSnapshot>("/api/pipeline-monitor/workers"),
    refetchOnWindowFocus: false,
  });

  if (q.isLoading) {
    return <SkeletonTable rows={6} cols={8} />;
  }
  if (q.isError || !q.data) {
    return (
      <EmptyPanel
        tone="danger"
        icon={<Icon name="info" size={30} />}
        title={t("pipelineMonitor.workers.loadErrorTitle", { defaultValue: "Couldn't load workers" })}
        body={t("pipelineMonitor.workers.loadError")}
        actions={
          <button type="button" className="btn" onClick={() => void q.refetch()}>
            <Icon name="refresh" size={12} />
            {t("common.retry", { defaultValue: "Retry" })}
          </button>
        }
      />
    );
  }
  const d = q.data;
  const summaryTone: PillTone = d.summary.stalled > 0 ? "danger" : d.summary.degraded > 0 ? "warning" : "success";

  return (
    <div className="ops-stack is-tight">
      {/* Health summary chip */}
      <Banner tone={summaryTone} icon={<StatusDot tone={summaryTone} />}>
        <strong>{t("pipelineMonitor.workers.totalWorkers", { n: d.summary.total_workers })}</strong>
        <span>·</span>
        <span>{t("pipelineMonitor.workers.running", { n: d.summary.running })}</span>
        {d.summary.degraded > 0 && (
          <>
            <span>·</span>
            <span style={{ color: "var(--warning-text)" }}>{t("pipelineMonitor.workers.degraded", { n: d.summary.degraded })}</span>
          </>
        )}
        {d.summary.stalled > 0 && (
          <>
            <span>·</span>
            <span style={{ color: "var(--danger-text)" }}>{t("pipelineMonitor.workers.stalled", { n: d.summary.stalled })}</span>
          </>
        )}
        <span className="ops-banner-spacer text-dim">
          {t("pipelineMonitor.workers.updated", {
            time: new Date(d.generated_at).toLocaleTimeString(),
            ms: d.took_ms.toFixed(0),
          })}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          title={t("pipelineMonitor.workers.syncTitle")}
          aria-label={t("pipelineMonitor.workers.syncAria")}
        >
          <Icon name="refresh" size={12} {...(q.isFetching ? { className: "icon-spin" } : {})} />
          {q.isFetching ? t("pipelineMonitor.workers.syncing") : t("pipelineMonitor.workers.syncNow")}
        </button>
      </Banner>

      {/* Grouped table */}
      <div className="ops-table-wrap">
        <table className="table table-compact" style={{ minWidth: 920 }}>
          <thead>
            <tr>
              <th>{t("pipelineMonitor.labels.worker")}</th>
              <th>{t("pipelineMonitor.labels.status")}</th>
              <th className="ops-num">{t("pipelineMonitor.labels.active")}</th>
              <th className="ops-num">{t("pipelineMonitor.labels.queued")}</th>
              <th className="ops-num">{t("pipelineMonitor.labels.processing")}</th>
              <th className="ops-num">{t("pipelineMonitor.labels.completed")}</th>
              <th className="ops-num">{t("pipelineMonitor.labels.failed")}</th>
              <th>{t("pipelineMonitor.labels.currentTask")}</th>
              <th className="ops-num">{t("pipelineMonitor.labels.speed")}</th>
              <th>{t("pipelineMonitor.labels.health")}</th>
            </tr>
          </thead>
          <tbody>
            {d.groups.map((g) => (
              <Fragment key={g.key}>
                <tr className="ops-group-row">
                  <td colSpan={10}>
                    {g.label} · {g.workers.length}
                  </td>
                </tr>
                {g.workers.map((w) => (
                  <WorkerRowView key={`${g.key}-${w.name}`} worker={w} />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkerRowView({ worker }: { worker: WorkerRow }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td style={{ fontWeight: 600, color: "var(--text)" }}>{worker.name}</td>
      <td>
        <SoftPill tone={toneForStatus(worker.status)}>{worker.status}</SoftPill>
      </td>
      <td className="ops-num mono">{fmtActiveCell(worker.active_jobs, worker.active_unit)}</td>
      <td className="ops-num mono">{fmtCell(worker.queue_count)}</td>
      <td className="ops-num mono">{fmtCell(worker.processing)}</td>
      <td className="ops-num mono">{fmtCell(worker.completed)}</td>
      <td className="ops-num mono" style={{ color: (worker.failed ?? 0) > 0 ? "var(--danger-text)" : undefined }}>
        {fmtCell(worker.failed)}
      </td>
      <td className="ops-cell-truncate text-dim" title={worker.current_task || worker.next_run || ""}>
        {worker.current_task ||
          (worker.next_run
            ? t("pipelineMonitor.workers.nextRun", { defaultValue: "next {{time}}", time: new Date(worker.next_run).toLocaleTimeString() })
            : "—")}
      </td>
      <td className="ops-num mono text-dim">{worker.speed_ms != null ? fmtSpeed(worker.speed_ms) : "—"}</td>
      <td>
        <SoftPill tone={toneForHealth(worker.health)}>
          <span style={{ textTransform: "capitalize" }}>{worker.health}</span>
        </SoftPill>
      </td>
    </tr>
  );
}

function fmtCell(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString();
}

// "Active" cell — append the row's unit (cams / workers / jobs) so
// the dashboard self-explains what the number counts. Bare number
// when ``unit`` is null (e.g. on a row that doesn't carry a unit).
function fmtActiveCell(v: number | null | undefined, unit: string | null | undefined): string {
  if (v == null) return "—";
  if (!unit) return v.toLocaleString();
  return `${v.toLocaleString()} ${unit}`;
}

function fmtSpeed(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function toneForStatus(status: string): PillTone {
  switch (status) {
    case "running":
      return "success";
    case "stopped":
    case "not_started":
    case "no_jobs":
    case "idle":
      return "neutral";
    case "unknown":
    default:
      return "warning";
  }
}

function toneForHealth(health: string): PillTone {
  switch (health) {
    case "healthy":
      return "success";
    case "idle":
      return "neutral";
    case "degraded":
      return "warning";
    case "stalled":
      return "danger";
    default:
      return "neutral";
  }
}

// Pipeline Monitor's Restart All Workers action. Single Admin-only
// button + type-to-confirm modal. Calls
// ``POST /api/operations/workers/restart-all-and-recover`` which
// restarts capture workers, the clip pipeline, and the legacy
// reprocess worker AND triggers an immediate recovery sweep for
// any rows stuck in ``processing``. Per-camera restart actions on
// individual rows do NOT trigger recovery (by design — they're
// narrow operator actions).
function RestartAllWorkersAction() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [lastResult, setLastResult] = useState<RestartAllAndRecoverResult | null>(null);
  const restartAll = useRestartAllAndRecover();

  return (
    <>
      <button type="button" className="btn btn-danger" onClick={() => setOpen(true)} disabled={restartAll.isPending}>
        <Icon name="refresh" size={12} />
        {t("pipelineMonitor.actions.restartAll")}
      </button>
      {open && (
        <RestartAllModal
          workerCount={0}
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            restartAll.mutate(undefined, {
              onSuccess: (r) => setLastResult(r),
              onSettled: () => setOpen(false),
            });
          }}
          pending={restartAll.isPending}
        />
      )}
      {lastResult && (
        <div role="status" className="ops-toast">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
            <strong>{t("pipelineMonitor.workers.restartComplete")}</strong>
            <button type="button" className="icon-btn" aria-label={t("common.dismiss")} onClick={() => setLastResult(null)}>
              <Icon name="x" size={12} />
            </button>
          </div>
          <div className="text-dim" style={{ marginTop: 4 }}>
            {t("pipelineMonitor.workers.captureRestarted", {
              done: lastResult.capture_restarted,
              total: lastResult.capture_total,
            })}
          </div>
          <div className="text-dim">
            {t("pipelineMonitor.workers.recoveryLine", {
              scanned: lastResult.recovery.scanned,
              a: lastResult.recovery.class_a,
              b: lastResult.recovery.class_b,
              c: lastResult.recovery.class_c,
            })}
          </div>
        </div>
      )}
    </>
  );
}
