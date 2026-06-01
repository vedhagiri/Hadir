// TEMP-DIAGNOSTIC-2026-05-20 — Live Capture Diagnostics tab.
//
// Focused on ONE question: when the live feed fps drops below the
// camera's healthy rate, WHY? The backend measures the actual
// delivered feed fps inside the MJPEG generator and, on a
// below-threshold reading, records an ``fps_drop`` event carrying the
// full cause snapshot (reader/analyzer fps, per-stage timings, queue
// depth, CPU/mem, reconnects, classified cause). This page surfaces
// those events as cards. While fps stays healthy (>= threshold) NO
// event is logged — an empty list means the feed is fine.
//
// Reuses the shared diagnostics ring + enable/clear endpoints from the
// Frame Diagnostics tab; this view filters to ``kind=fps_drop`` and
// renders the cause-focused card layout.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";

const POLL_MS = 2000;

interface State {
  enabled: boolean;
  session_started_at: number;
  session_started_ago_s: number;
  event_count: number;
}

interface FpsDropMetrics {
  slot?: string;
  current_fps?: number;
  previous_fps?: number;
  threshold?: number;
  fps_reader?: number;
  fps_analyzer?: number;
  live_person_count?: number;
  cpu_percent?: number | null;
  memory_percent?: number | null;
  queue_depth?: number;
  clip_frames_dropped?: number;
  reconnect_count?: number;
  reconnect_delta?: number;
  t_read_ms?: number;
  t_preview_ms?: number;
  t_clip_ms?: number;
  t_detection_ms?: number;
  native_fps?: number | null;
  status?: string;
  causes?: string[];
  category?: string;
}

interface EventRow {
  ts: number;
  tenant_id: number | null;
  camera_id: number | null;
  camera_name: string | null;
  kind: string;
  reason: string;
  metrics: FpsDropMetrics;
}

const CATEGORY_LABEL: Record<string, string> = {
  delivery_pacing: "Stream delivery",
  clip_encode: "Clip encoding",
  preview_encode: "Preview encoding",
  detection: "Detection",
  decode: "Decode / read",
  queue_backlog: "Queue backlog",
  cpu_saturation: "CPU saturation",
  memory_pressure: "Memory pressure",
  rtsp_reconnect: "RTSP reconnect",
  contention: "CPU contention",
  unknown: "Unknown",
};

const CATEGORY_COLOUR: Record<string, string> = {
  delivery_pacing: "#0369a1",
  clip_encode: "#b45309",
  preview_encode: "#b45309",
  detection: "#7c3aed",
  decode: "#b45309",
  queue_backlog: "#b45309",
  cpu_saturation: "#dc2626",
  memory_pressure: "#dc2626",
  rtsp_reconnect: "#dc2626",
  contention: "#dc2626",
  unknown: "#64748b",
};

function tsToTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(undefined, { hour12: true });
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m - h * 60).toString().padStart(2, "0")}m`;
}

function ms(v: number | undefined): string {
  return v === undefined ? "—" : `${v.toFixed(0)} ms`;
}

function pct(v: number | null | undefined): string {
  return v === undefined || v === null ? "—" : `${v.toFixed(0)}%`;
}

export function LiveCaptureDiagnosticsPage() {
  const qc = useQueryClient();

  const state = useQuery<State>({
    queryKey: ["lc-diagnostics", "state"],
    queryFn: () => api<State>("/api/diagnostics/state"),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const events = useQuery<{ events: EventRow[] }>({
    queryKey: ["lc-diagnostics", "fps-drops"],
    queryFn: () =>
      api<{ events: EventRow[] }>(
        "/api/diagnostics/events?kind=fps_drop&limit=300",
      ),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const start = useMutation({
    mutationFn: () => api("/api/diagnostics/start", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lc-diagnostics"] }),
  });
  const stop = useMutation({
    mutationFn: () => api("/api/diagnostics/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lc-diagnostics"] }),
  });
  const clearLogs = useMutation({
    mutationFn: () => api("/api/diagnostics/clear", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lc-diagnostics"] }),
  });

  const [cameraFilter, setCameraFilter] = useState<string>("");

  const rows = useMemo(() => {
    const all = events.data?.events ?? [];
    return all
      .filter((e) => !cameraFilter || String(e.camera_id) === cameraFilter)
      .slice()
      .reverse(); // newest first
  }, [events.data, cameraFilter]);

  const cameraOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of events.data?.events ?? []) {
      if (e.camera_id != null) {
        seen.set(String(e.camera_id), e.camera_name ?? `CAM-${e.camera_id}`);
      }
    }
    return Array.from(seen.entries());
  }, [events.data]);

  const enabled = state.data?.enabled ?? false;

  return (
    <div style={{ padding: "24px", maxWidth: 980 }}>
      <h1 style={{ marginBottom: 4 }}>Live Capture Diagnostics</h1>
      <p style={{ color: "var(--muted-text, #64748b)", marginTop: 0 }}>
        Records an event <strong>only when the delivered feed FPS drops
        below the camera's healthy rate</strong> (≈ 92% of native, e.g.
        &lt; 23 fps for a 25 fps camera). A healthy feed logs nothing.
        Each drop captures the full cause snapshot below.
      </p>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          padding: "12px 16px",
          background: enabled ? "#ecfdf5" : "#f8fafc",
          border: `1px solid ${enabled ? "#a7f3d0" : "#e2e8f0"}`,
          borderRadius: 8,
          marginBottom: 20,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            color: enabled ? "#047857" : "#64748b",
          }}
        >
          {enabled ? "● Monitoring" : "○ Not monitoring"}
        </span>
        {enabled ? (
          <button
            className="btn btn-sm"
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
          >
            Stop monitoring
          </button>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => start.mutate()}
            disabled={start.isPending}
          >
            Start monitoring
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={() => clearLogs.mutate()}
          disabled={clearLogs.isPending}
        >
          Clear log
        </button>
        {state.data && (
          <span style={{ color: "#64748b", fontSize: 13 }}>
            Session: {fmtDuration(state.data.session_started_ago_s)} ·{" "}
            {rows.length} FPS-drop event{rows.length === 1 ? "" : "s"}
          </span>
        )}
        {cameraOptions.length > 1 && (
          <select
            value={cameraFilter}
            onChange={(e) => setCameraFilter(e.target.value)}
            style={{ marginLeft: "auto" }}
            aria-label="Filter by camera"
          >
            <option value="">All cameras</option>
            {cameraOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name} (CAM-{id})
              </option>
            ))}
          </select>
        )}
      </div>

      {!enabled && (
        <p style={{ color: "#b45309" }}>
          Monitoring is off — click <strong>Start monitoring</strong>, then
          open the Live Capture page and watch the camera for a few minutes
          during real activity. Drops are recorded here as they happen.
        </p>
      )}

      {enabled && rows.length === 0 && (
        <p style={{ color: "#047857" }}>
          ✓ No FPS drops recorded yet — the feed is delivering at or above
          threshold. Keep the camera in view; any drop will appear here.
        </p>
      )}

      {/* Event cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {rows.map((e, i) => {
          const m = e.metrics ?? {};
          const cat = m.category ?? "unknown";
          const colour = CATEGORY_COLOUR[cat] ?? "#64748b";
          return (
            <div
              key={`${e.ts}-${i}`}
              style={{
                border: "1px solid #e2e8f0",
                borderLeft: `4px solid ${colour}`,
                borderRadius: 8,
                padding: "14px 18px",
                background: "#fff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <strong style={{ fontSize: 15 }}>{tsToTime(e.ts)}</strong>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: colour,
                    background: `${colour}14`,
                    padding: "2px 8px",
                    borderRadius: 999,
                  }}
                >
                  {CATEGORY_LABEL[cat] ?? cat}
                </span>
              </div>

              <div style={{ color: "#475569", margin: "2px 0 8px" }}>
                Camera: <strong>{e.camera_name ?? "?"}</strong> (CAM-
                {e.camera_id})
              </div>

              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
                FPS dropped: {(m.previous_fps ?? 0).toFixed(0)} →{" "}
                {(m.current_fps ?? 0).toFixed(0)}
                <span
                  style={{ fontSize: 12, fontWeight: 400, color: "#94a3b8" }}
                >
                  {"  "}(threshold {(m.threshold ?? 0).toFixed(0)} fps · slot{" "}
                  {m.slot ?? "?"})
                </span>
              </div>

              {m.causes && m.causes.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, color: "#334155" }}>
                    Possible cause:
                  </div>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                    {m.causes.map((c, j) => (
                      <li key={j} style={{ color: "#475569" }}>
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Raw context grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                  gap: "4px 16px",
                  fontSize: 12.5,
                  color: "#64748b",
                  borderTop: "1px dashed #e2e8f0",
                  paddingTop: 8,
                }}
              >
                <span>Reader FPS: <b>{(m.fps_reader ?? 0).toFixed(0)}</b></span>
                <span>Analyzer FPS: <b>{(m.fps_analyzer ?? 0).toFixed(1)}</b></span>
                <span>Live persons: <b>{m.live_person_count ?? 0}</b></span>
                <span>CPU: <b>{pct(m.cpu_percent)}</b></span>
                <span>Memory: <b>{pct(m.memory_percent)}</b></span>
                <span>Queue depth: <b>{m.queue_depth ?? 0}</b></span>
                <span>Reconnects (window): <b>{m.reconnect_delta ?? 0}</b></span>
                <span>Read: <b>{ms(m.t_read_ms)}</b></span>
                <span>Preview: <b>{ms(m.t_preview_ms)}</b></span>
                <span>Clip: <b>{ms(m.t_clip_ms)}</b></span>
                <span>Detection: <b>{ms(m.t_detection_ms)}</b></span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
