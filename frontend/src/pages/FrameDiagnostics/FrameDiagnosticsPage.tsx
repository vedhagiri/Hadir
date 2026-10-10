// TEMP-DIAGNOSTIC-2026-05-20 — Frame Diagnostics tab.
//
// Anomaly-only event stream + live host/camera snapshot. Operator
// turns on "Logging" for 1-2 hours, watches the table populate as
// frame drops / ffmpeg restarts / detection slowness occur, then
// exports the JSON for analysis. The whole page (file, route, nav
// entry, backend module) is tagged for grep-able removal once the
// investigation is closed.
//
// Design choices:
//   * Single file (no sub-components) — easier to delete.
//   * Polls every 3 s — same cadence as Pipeline Monitor.
//   * No persistence — page state is the URL only; backend keeps
//     the ring across refreshes (until backend restart).
//   * Export downloads a blob, no server roundtrip.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { api } from "../../api/client";
import { EmptyPanel, FilterSelect, ResetButton, Toolbar } from "../../components/ListPageUi";
import { SkeletonCards, SkeletonTable } from "../../components/Skeleton";
import { Banner, METRIC_ICON, MetricGrid, MetricTile, SoftPill, StatusDot, type PillTone } from "../../features/system/opsUi";
import { Icon } from "../../shell/Icon";

const POLL_MS = 3000;

interface State {
  enabled: boolean;
  session_started_at: number;
  session_started_ago_s: number;
  event_count: number;
}

interface EventRow {
  ts: number;
  tenant_id: number | null;
  camera_id: number | null;
  camera_name: string | null;
  kind: string;
  reason: string;
  metrics: Record<string, unknown>;
}

interface CameraLive {
  tenant_id: number;
  camera_id: number;
  camera_name: string;
  status: string;
  fps_reader: number;
  fps_analyzer: number;
  motion_skipped_60s: number;
  frames_analyzed_60s: number;
  faces_saved_60s: number;
  matches_60s: number;
  native_fps: number | null;
  pipeline_stages: Record<string, string>;
}

interface SystemSnapshot {
  ts: number;
  host_cpu_percent_overall: number;
  host_cpu_percent_per_core: number[];
  host_memory_percent: number;
  host_memory_used_gb: number;
  host_memory_total_gb: number;
  process_count: number;
  thread_count: number;
  cameras: CameraLive[];
}

// Anomaly kinds map to a tone so the operator can eyeball patterns
// ("most recent burst is all ffmpeg_restart").
const KIND_TONE: Record<string, PillTone> = {
  frame_slow: "warning",
  reader_read_failed: "danger",
  rtsp_reconnect: "danger",
  ffmpeg_restart: "danger",
  segmenter_thrashing: "danger",
  detection_slow: "warning",
  analyzer_starved: "warning",
};

const STAGE_TONE: Record<string, PillTone> = {
  green: "success",
  amber: "warning",
  red: "danger",
};

function tsToTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m - h * 60).toString().padStart(2, "0")}m`;
}

function fmtMetricsInline(metrics: Record<string, unknown>): string {
  return Object.entries(metrics)
    .map(([k, v]) => {
      if (typeof v === "number") return `${k}=${v}`;
      if (v === null || v === undefined) return null;
      return `${k}=${String(v)}`;
    })
    .filter(Boolean)
    .join("  ");
}

export function FrameDiagnosticsPage() {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const [kindFilter, setKindFilter] = useState<string>("");
  const [cameraFilter, setCameraFilter] = useState<string>("");

  const state = useQuery<State>({
    queryKey: ["diagnostics", "state"],
    queryFn: () => api<State>("/api/diagnostics/state"),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const snap = useQuery<SystemSnapshot>({
    queryKey: ["diagnostics", "snapshot"],
    queryFn: () => api<SystemSnapshot>("/api/diagnostics/system-snapshot"),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const events = useQuery<{ events: EventRow[] }>({
    queryKey: ["diagnostics", "events"],
    queryFn: () => api<{ events: EventRow[] }>("/api/diagnostics/events?limit=500"),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const start = useMutation({
    mutationFn: () => api("/api/diagnostics/start", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["diagnostics"] }),
  });
  const stop = useMutation({
    mutationFn: () => api("/api/diagnostics/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["diagnostics"] }),
  });
  const clearLogs = useMutation({
    mutationFn: () => api("/api/diagnostics/clear", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["diagnostics"] }),
  });

  const filteredEvents = useMemo(() => {
    const rows = events.data?.events ?? [];
    return rows
      .filter((e) => {
        if (kindFilter && e.kind !== kindFilter) return false;
        if (cameraFilter && String(e.camera_id) !== cameraFilter) return false;
        return true;
      })
      .slice()
      .reverse(); // newest first
  }, [events.data, kindFilter, cameraFilter]);

  // Kind tallies (per-kind count of events visible after filtering)
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events.data?.events ?? []) {
      counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    }
    return counts;
  }, [events.data]);

  // Available camera filter options (from system snapshot, falls back to
  // events when snapshot is empty)
  const cameraOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const c of snap.data?.cameras ?? []) {
      set.set(String(c.camera_id), `${c.camera_name} (id ${c.camera_id})`);
    }
    for (const e of events.data?.events ?? []) {
      if (e.camera_id != null && !set.has(String(e.camera_id))) {
        set.set(String(e.camera_id), `${e.camera_name ?? "(unknown)"} (id ${e.camera_id})`);
      }
    }
    return Array.from(set.entries());
  }, [snap.data, events.data]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ state: state.data, snap: snap.data, events: events.data?.events ?? [] }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frame-diagnostics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Live "session running for" timer — UI ticks every second when
  // enabled so the operator doesn't have to refresh to see duration.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!state.data?.enabled) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [state.data?.enabled]);
  // Read-once reference to avoid "unused" lint
  void tick;

  const liveDuration = state.data
    ? state.data.session_started_ago_s +
      (state.data.enabled ? Date.now() / 1000 - (state.data.session_started_at + state.data.session_started_ago_s) : 0)
    : 0;

  const running = !!state.data?.enabled;
  const stripMark = (v: string) => v.replace(/^[●○]\s*/, "");
  const cpu = snap.data?.host_cpu_percent_overall ?? 0;
  const memPct = snap.data?.host_memory_percent ?? 0;
  const filtersActive = !!kindFilter || !!cameraFilter;
  const totalEvents = events.data?.events.length ?? 0;
  const loading = state.isLoading || snap.isLoading;
  const failed = state.isError || snap.isError || events.isError;
  const clearFilters = () => {
    setKindFilter("");
    setCameraFilter("");
  };
  const retryAll = () => void qc.invalidateQueries({ queryKey: ["diagnostics"] });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("frameDiagnostics.title", { defaultValue: "Frame Diagnostics" })}</h1>
          <p className="page-sub">
            {t("frameDiagnostics.subtitle", {
              defaultValue: "Capture frame drops, reconnects and slow detections while logging is on, then export them for analysis.",
            })}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => clearLogs.mutate()} disabled={clearLogs.isPending || totalEvents === 0}>
            <Icon name="trash" size={12} />
            {t("frameDiagnostics.clear")}
          </button>
          <button type="button" className="btn" onClick={exportJson} disabled={totalEvents === 0}>
            <Icon name="download" size={12} />
            {t("frameDiagnostics.exportJson")}
          </button>
          <button
            type="button"
            className={`btn ${running ? "btn-danger" : "btn-primary"}`}
            onClick={() => (running ? stop.mutate() : start.mutate())}
            disabled={start.isPending || stop.isPending}
          >
            <Icon name={running ? "pause" : "play"} size={12} />
            {stripMark(running ? t("frameDiagnostics.stopLogging") : t("frameDiagnostics.startLogging")).replace(/^▶\s*|^■\s*/, "")}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Banner tone="warning" role="note" icon={<Icon name="info" size={14} />}>
          <span>
            <strong>{t("frameDiagnostics.tempBadge")}</strong> {t("frameDiagnostics.tempHint")}
          </span>
        </Banner>
      </div>

      {loading && (
        <div className="ops-stack">
          <SkeletonCards count={4} />
          <SkeletonTable rows={3} cols={7} />
        </div>
      )}

      {!loading && failed && (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={30} />}
            title={t("frameDiagnostics.loadFailedTitle", { defaultValue: "Couldn't load diagnostics" })}
            body={t("frameDiagnostics.loadFailedBody", { defaultValue: "The diagnostics endpoints didn't respond. Check the backend and try again." })}
            actions={
              <button type="button" className="btn" onClick={retryAll}>
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
              tone={running ? "success" : "neutral"}
              icon={running ? METRIC_ICON.record : METRIC_ICON.clock}
              label={t("frameDiagnostics.loggingLabel", { defaultValue: "Logging" })}
              value={stripMark(running ? t("frameDiagnostics.running") : t("frameDiagnostics.stopped"))}
              sub={
                state.data
                  ? running
                    ? `${t("frameDiagnostics.session")} ${fmtDuration(liveDuration)} · ${t("frameDiagnostics.eventsCaptured", { count: state.data.event_count })}`
                    : t("frameDiagnostics.eventsInRing", { count: state.data.event_count })
                  : ""
              }
            />
            <MetricTile
              tone={cpu > 70 ? "danger" : cpu > 50 ? "warning" : "info"}
              icon={METRIC_ICON.cpu}
              label={t("frameDiagnostics.hostCpu")}
              value={`${cpu}%`}
              sub={t("frameDiagnostics.hostCpuSub", { defaultValue: "All cores, live" })}
            />
            <MetricTile
              tone={memPct > 75 ? "danger" : "info"}
              icon={METRIC_ICON.memory}
              label={t("frameDiagnostics.memory")}
              value={`${snap.data?.host_memory_used_gb ?? 0} / ${snap.data?.host_memory_total_gb ?? 0} GB`}
              sub={`${memPct}%`}
            />
            <MetricTile
              tone="neutral"
              icon={METRIC_ICON.activity}
              label={t("frameDiagnostics.processes")}
              value={String(snap.data?.process_count ?? 0)}
              sub={`${t("frameDiagnostics.threads")}: ${snap.data?.thread_count ?? 0}`}
            />
          </MetricGrid>

          {snap.data && (
            <div className="card ops-card-flush" style={{ marginBottom: 16 }}>
              <div className="card-head">
                <h3 className="card-title" style={{ margin: 0 }}>{t("frameDiagnostics.perCore", { defaultValue: "CPU per core" })}</h3>
                <span className="text-xs text-dim">{snap.data.host_cpu_percent_per_core.length} {t("frameDiagnostics.cores", { defaultValue: "cores" })}</span>
              </div>
              <div className="ops-card-body is-tight">
                <div className="ops-core-bars">
                  {snap.data.host_cpu_percent_per_core.map((c, i) => (
                    <div
                      key={i}
                      className="ops-core-bar"
                      title={`core ${i}: ${c}%`}
                      style={{ ["--tone-fg" as string]: c > 80 ? "var(--danger)" : c > 50 ? "var(--warning)" : "var(--success)" } as React.CSSProperties}
                    >
                      <span style={{ width: `${Math.min(100, c)}%` }} />
                    </div>
                  ))}
                </div>
              </div>

              {snap.data.cameras.length > 0 && (
                <div style={{ overflowX: "auto", borderTop: "1px solid var(--border)" }}>
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>{t("frameDiagnostics.col.camera")}</th>
                        <th>{t("frameDiagnostics.col.tenant")}</th>
                        <th>{t("frameDiagnostics.col.status")}</th>
                        <th>{t("frameDiagnostics.col.fpsReader")}</th>
                        <th>{t("frameDiagnostics.col.fpsAnalyzer")}</th>
                        <th>{t("frameDiagnostics.col.motionSkip")}</th>
                        <th>{t("frameDiagnostics.col.stages")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snap.data.cameras.map((c) => (
                        <tr key={`${c.tenant_id}-${c.camera_id}`}>
                          <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{c.camera_name}</td>
                          <td className="mono">{c.tenant_id}</td>
                          <td>
                            <SoftPill tone={c.status === "running" ? "success" : c.status === "reconnecting" || c.status === "starting" ? "warning" : "danger"}>
                              {c.status}
                            </SoftPill>
                          </td>
                          <td>
                            <FpsCell observed={c.fps_reader} target={c.native_fps ?? null} />
                          </td>
                          <td className="mono">{c.fps_analyzer.toFixed(1)}</td>
                          <td className="mono">{c.motion_skipped_60s}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <span style={{ display: "inline-flex", gap: 5 }}>
                              {(["rtsp", "detection", "matching", "attendance"] as const).map((stage) => {
                                const s = c.pipeline_stages[stage] ?? "unknown";
                                return (
                                  <span key={stage} title={`${stage}: ${s}`}>
                                    <StatusDot tone={STAGE_TONE[s] ?? "neutral"} />
                                  </span>
                                );
                              })}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {totalEvents === 0 ? (
            <div className="card">
              <EmptyPanel
                tone={running ? "success" : "accent"}
                icon={<Icon name="activity" size={30} />}
                title={running ? t("frameDiagnostics.emptyOnTitle", { defaultValue: "No anomalies yet" }) : t("frameDiagnostics.emptyOffTitle", { defaultValue: "Logging is off" })}
                body={running ? t("frameDiagnostics.emptyOn") : t("frameDiagnostics.emptyOff")}
                actions={
                  running ? undefined : (
                    <button type="button" className="btn btn-primary" onClick={() => start.mutate()} disabled={start.isPending}>
                      <Icon name="play" size={12} />
                      {stripMark(t("frameDiagnostics.startLogging")).replace(/^▶\s*/, "")}
                    </button>
                  )
                }
              />
            </div>
          ) : (
            <>
              {/* Kind tallies + filters */}
              <Toolbar>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{t("frameDiagnostics.anomalyKinds")}:</span>
                {Object.entries(kindCounts).map(([k, n]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kindFilter === k}
                    onClick={() => setKindFilter(kindFilter === k ? "" : k)}
                    className={`ops-kind-chip tone-${KIND_TONE[k] ?? "neutral"}`}
                  >
                    {k} <span className="count">×{n}</span>
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <FilterSelect
                  label={t("frameDiagnostics.col.camera")}
                  value={cameraFilter}
                  onChange={setCameraFilter}
                  options={[["", t("frameDiagnostics.allCameras")], ...cameraOptions]}
                />
                <ResetButton active={filtersActive} label={t("frameDiagnostics.reset", { defaultValue: "Reset" })} onClick={clearFilters} />
              </Toolbar>

              {/* Event table */}
              <div className="card ops-card-flush">
                {filteredEvents.length === 0 ? (
                  <EmptyPanel
                    tone="neutral"
                    icon={<Icon name="filter" size={30} />}
                    title={t("frameDiagnostics.emptyFilteredTitle", { defaultValue: "No events match these filters" })}
                    body={t("frameDiagnostics.emptyFilteredBody", { defaultValue: "Try another anomaly kind or camera." })}
                    actions={
                      <button type="button" className="btn" onClick={clearFilters}>
                        {t("frameDiagnostics.clearFilters", { defaultValue: "Clear filters" })}
                      </button>
                    }
                  />
                ) : (
                  <div className="ops-table-wrap is-scroll" style={{ border: 0, borderRadius: "inherit" }}>
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>{t("frameDiagnostics.col.time")}</th>
                          <th>{t("frameDiagnostics.col.kind")}</th>
                          <th>{t("frameDiagnostics.col.camera")}</th>
                          <th>{t("frameDiagnostics.col.reason")}</th>
                          <th>{t("frameDiagnostics.col.metrics")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEvents.map((e, i) => (
                          <tr key={i}>
                            <td className="mono" style={{ whiteSpace: "nowrap" }}>{tsToTime(e.ts)}</td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              <span className={`ops-kind tone-${KIND_TONE[e.kind] ?? "neutral"}`}>{e.kind}</span>
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>{e.camera_name ?? (e.camera_id != null ? `id ${e.camera_id}` : "—")}</td>
                            <td>{e.reason}</td>
                            <td className="mono text-dim">{fmtMetricsInline(e.metrics)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

// --- tiny inline components ------------------------------------------------

function FpsCell({ observed, target }: { observed: number; target: number | null }) {
  const ratio = target && target > 0 ? observed / target : 1;
  const cls = ratio >= 0.95 ? "is-ok" : ratio >= 0.7 ? "is-warn" : "is-bad";
  return (
    <span className={`mono ops-fps ${cls}`}>
      {observed.toFixed(1)}
      {target ? ` / ${target}` : ""}
    </span>
  );
}
