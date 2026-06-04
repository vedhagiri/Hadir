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

// Soft palette — anomaly kinds get distinct accent borders so the
// operator can eyeball patterns ("most recent burst is all
// ffmpeg_restart").
const KIND_COLOUR: Record<string, string> = {
  frame_slow: "#b45309",
  reader_read_failed: "#dc2626",
  rtsp_reconnect: "#dc2626",
  ffmpeg_restart: "#dc2626",
  segmenter_thrashing: "#7c2d12",
  detection_slow: "#b45309",
  analyzer_starved: "#b45309",
};

function tsToTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(undefined, { hour12: false }) +
    "." + String(d.getMilliseconds()).padStart(3, "0");
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
    queryFn: () => api<{ events: EventRow[] }>(
      "/api/diagnostics/events?limit=500",
    ),
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
    return rows.filter((e) => {
      if (kindFilter && e.kind !== kindFilter) return false;
      if (cameraFilter && String(e.camera_id) !== cameraFilter) return false;
      return true;
    }).slice().reverse(); // newest first
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
        set.set(
          String(e.camera_id),
          `${e.camera_name ?? "(unknown)"} (id ${e.camera_id})`,
        );
      }
    }
    return Array.from(set.entries());
  }, [snap.data, events.data]);

  const exportJson = () => {
    const blob = new Blob(
      [JSON.stringify({ state: state.data, snap: snap.data,
        events: events.data?.events ?? [] }, null, 2)],
      { type: "application/json" },
    );
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
    ? state.data.session_started_ago_s
      + (state.data.enabled ? (Date.now() / 1000) - (state.data.session_started_at + state.data.session_started_ago_s) : 0)
    : 0;

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1400 }}>
      <div style={{
        marginBottom: 16,
        background: "rgba(245, 158, 11, 0.08)",
        border: "1px solid #f59e0b",
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 13,
      }}>
        <strong>{t("frameDiagnostics.tempBadge")}</strong>{" "}
        {t("frameDiagnostics.tempHint")}
      </div>

      {/* Controls */}
      <div style={{
        display: "flex", gap: 8, marginBottom: 16, alignItems: "center",
        flexWrap: "wrap",
      }}>
        <button
          className="btn btn-sm"
          onClick={() => (state.data?.enabled ? stop.mutate() : start.mutate())}
          disabled={start.isPending || stop.isPending}
          style={{
            background: state.data?.enabled ? "#dc2626" : "#0b6e4f",
            color: "white", fontWeight: 600,
            border: "none", padding: "6px 14px", borderRadius: 6,
          }}
        >
          {state.data?.enabled
            ? t("frameDiagnostics.stopLogging")
            : t("frameDiagnostics.startLogging")}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => clearLogs.mutate()}
          disabled={clearLogs.isPending}
        >{t("frameDiagnostics.clear")}</button>
        <button className="btn btn-sm" onClick={exportJson}>{t("frameDiagnostics.exportJson")}</button>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {state.data?.enabled ? (
            <>
              <span style={{ color: "#0b6e4f", fontWeight: 600 }}>{t("frameDiagnostics.running")}</span>
              {" — "}{t("frameDiagnostics.session")}{" "}{fmtDuration(liveDuration)}{" — "}
              {t("frameDiagnostics.eventsCaptured", { count: state.data.event_count })}
            </>
          ) : (
            <>
              <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{t("frameDiagnostics.stopped")}</span>
              {state.data ? ` — ${t("frameDiagnostics.eventsInRing", { count: state.data.event_count })}` : ""}
            </>
          )}
        </div>
      </div>

      {/* Live system snapshot */}
      <div style={{
        background: "var(--bg-elev)", border: "1px solid var(--border)",
        borderRadius: 8, padding: 14, marginBottom: 16,
      }}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Stat label={t("frameDiagnostics.hostCpu")} value={`${snap.data?.host_cpu_percent_overall ?? 0}%`}
            warn={(snap.data?.host_cpu_percent_overall ?? 0) > 70} />
          <Stat label={t("frameDiagnostics.memory")} value={`${snap.data?.host_memory_used_gb ?? 0} / ${snap.data?.host_memory_total_gb ?? 0} GB`}
            warn={(snap.data?.host_memory_percent ?? 0) > 75} />
          <Stat label={t("frameDiagnostics.processes")} value={String(snap.data?.process_count ?? 0)} />
          <Stat label={t("frameDiagnostics.threads")} value={String(snap.data?.thread_count ?? 0)} />
        </div>
        {/* Per-core CPU bars */}
        {snap.data && (
          <div style={{ marginTop: 10, display: "flex", gap: 4, flexWrap: "wrap" }}>
            {snap.data.host_cpu_percent_per_core.map((c, i) => (
              <div key={i} style={{
                flex: "1 0 60px", height: 6, background: "var(--border)",
                borderRadius: 3, overflow: "hidden", position: "relative",
              }}
                title={`core ${i}: ${c}%`}>
                <div style={{
                  width: `${Math.min(100, c)}%`, height: "100%",
                  background: c > 80 ? "#dc2626" : c > 50 ? "#f59e0b" : "#0b6e4f",
                }} />
              </div>
            ))}
          </div>
        )}
        {/* Per-camera live stats */}
        {snap.data && snap.data.cameras.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                  <th style={th}>{t("frameDiagnostics.col.camera")}</th>
                  <th style={th}>{t("frameDiagnostics.col.tenant")}</th>
                  <th style={th}>{t("frameDiagnostics.col.status")}</th>
                  <th style={th}>{t("frameDiagnostics.col.fpsReader")}</th>
                  <th style={th}>{t("frameDiagnostics.col.fpsAnalyzer")}</th>
                  <th style={th}>{t("frameDiagnostics.col.motionSkip")}</th>
                  <th style={th}>{t("frameDiagnostics.col.stages")}</th>
                </tr>
              </thead>
              <tbody>
                {snap.data.cameras.map((c) => (
                  <tr key={`${c.tenant_id}-${c.camera_id}`}>
                    <td style={td}><strong>{c.camera_name}</strong></td>
                    <td style={td}>{c.tenant_id}</td>
                    <td style={td}>
                      <span style={{
                        color: c.status === "running" ? "#0b6e4f" : "#dc2626",
                        fontWeight: 600,
                      }}>{c.status}</span>
                    </td>
                    <td style={td}>
                      <FpsCell observed={c.fps_reader} target={c.native_fps ?? null} />
                    </td>
                    <td style={td}>{c.fps_analyzer.toFixed(1)}</td>
                    <td style={td}>{c.motion_skipped_60s}</td>
                    <td style={td}>
                      {(["rtsp", "detection", "matching", "attendance"] as const).map((stage) => (
                        <StageDot key={stage} state={c.pipeline_stages[stage] ?? "unknown"} />
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Kind tallies + filters */}
      <div style={{
        display: "flex", gap: 12, alignItems: "center",
        marginBottom: 12, flexWrap: "wrap",
      }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t("frameDiagnostics.anomalyKinds")}:</span>
        {Object.entries(kindCounts).length === 0 && (
          <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
            {state.data?.enabled ? t("frameDiagnostics.waiting") : t("frameDiagnostics.loggingStopped")}
          </span>
        )}
        {Object.entries(kindCounts).map(([k, n]) => (
          <button key={k}
            onClick={() => setKindFilter(kindFilter === k ? "" : k)}
            style={{
              border: `1px solid ${KIND_COLOUR[k] ?? "var(--border)"}`,
              background: kindFilter === k ? (KIND_COLOUR[k] ?? "var(--border)") : "transparent",
              color: kindFilter === k ? "white" : (KIND_COLOUR[k] ?? "var(--text)"),
              padding: "2px 10px", borderRadius: 999,
              fontSize: 11, fontWeight: 600, cursor: "pointer",
            }}
          >{k} <span style={{ opacity: 0.8 }}>×{n}</span></button>
        ))}
        <div style={{ flex: 1 }} />
        <select value={cameraFilter} onChange={(e) => setCameraFilter(e.target.value)}
          style={{ fontSize: 12, padding: "4px 8px", border: "1px solid var(--border)" }}>
          <option value="">{t("frameDiagnostics.allCameras")}</option>
          {cameraOptions.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </div>

      {/* Event table */}
      <div style={{
        background: "var(--bg)", border: "1px solid var(--border)",
        borderRadius: 8, overflow: "hidden",
      }}>
        <div style={{ maxHeight: 600, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg-elev)" }}>
              <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                <th style={th}>{t("frameDiagnostics.col.time")}</th>
                <th style={th}>{t("frameDiagnostics.col.kind")}</th>
                <th style={th}>{t("frameDiagnostics.col.camera")}</th>
                <th style={th}>{t("frameDiagnostics.col.reason")}</th>
                <th style={th}>{t("frameDiagnostics.col.metrics")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.length === 0 && (
                <tr><td colSpan={5} style={{ ...td, textAlign: "center", padding: 24, color: "var(--text-secondary)" }}>
                  {state.data?.enabled
                    ? t("frameDiagnostics.emptyOn")
                    : t("frameDiagnostics.emptyOff")}
                </td></tr>
              )}
              {filteredEvents.map((e, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...td, whiteSpace: "nowrap", fontFamily: "monospace" }}>
                    {tsToTime(e.ts)}
                  </td>
                  <td style={td}>
                    <span style={{
                      color: KIND_COLOUR[e.kind] ?? "var(--text)",
                      fontWeight: 600,
                    }}>{e.kind}</span>
                  </td>
                  <td style={td}>
                    {e.camera_name ?? (e.camera_id != null ? `id ${e.camera_id}` : "—")}
                  </td>
                  <td style={td}>{e.reason}</td>
                  <td style={{ ...td, fontFamily: "monospace", color: "var(--text-secondary)" }}>
                    {fmtMetricsInline(e.metrics)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// --- tiny inline components ------------------------------------------------

const th = { padding: "6px 10px", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.04em" };
const td = { padding: "6px 10px", verticalAlign: "top" as const };

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--text-secondary)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: warn ? "#dc2626" : "var(--text)" }}>{value}</div>
    </div>
  );
}

function FpsCell({ observed, target }: { observed: number; target: number | null }) {
  const ratio = target && target > 0 ? observed / target : 1;
  const colour = ratio >= 0.95 ? "#0b6e4f" : ratio >= 0.7 ? "#b45309" : "#dc2626";
  return (
    <span style={{ color: colour, fontWeight: 600, fontFamily: "monospace" }}>
      {observed.toFixed(1)}{target ? ` / ${target}` : ""}
    </span>
  );
}

function StageDot({ state }: { state: string }) {
  const color =
    state === "green" ? "#0b6e4f"
    : state === "amber" ? "#f59e0b"
    : state === "red" ? "#dc2626"
    : "var(--border)";
  return (
    <span title={state} style={{
      display: "inline-block",
      width: 10, height: 10, borderRadius: "50%",
      background: color, marginRight: 4,
    }} />
  );
}
