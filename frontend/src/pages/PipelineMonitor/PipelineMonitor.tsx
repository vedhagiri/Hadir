// Pipeline Monitor — dedicated dashboard for the 4 worker stages:
// RTSP Feed / Clip Recording / Encoding / Identify Event.
//
// Polls /api/operations/pipeline every 3 s. Tabbed interface: one
// stage visible at a time. Summary chips along the top show the
// headline counts across all stages so the operator gets the
// at-a-glance number without leaving whichever tab they're on.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";

const POLL_INTERVAL_MS = 3000;

type StageKey = "rtsp" | "recording" | "encoding" | "identify";

interface RtspWorker {
  camera_id: number;
  camera_name: string;
  status: "starting" | "running" | "reconnecting" | "stopped" | "failed";
  uptime_sec: number;
  fps_reader: number;
  fps_analyzer: number;
  errors_5min: number;
}

interface RecordingCamera {
  camera_id: number;
  camera_name: string;
  recording_enabled: boolean;
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
  use_case: string; // "uc1" | "uc2" | "uc3"
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

const TABS: { key: StageKey; label: string; icon: IconName }[] = [
  { key: "rtsp", label: "RTSP Feed", icon: "camera" },
  { key: "recording", label: "Clip Recording", icon: "videocam" },
  { key: "encoding", label: "Encoding", icon: "activity" },
  { key: "identify", label: "Identify Event", icon: "user" },
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
  const [tab, setTab] = useState<StageKey>("rtsp");

  const query = useQuery({
    queryKey: ["operations", "pipeline"],
    queryFn: () => api<PipelineMonitorOut>("/api/operations/pipeline"),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const data = query.data;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Pipeline Monitor</h1>
          <p className="page-sub">
            Real-time view of every stage: RTSP feed → clip recording →
            encoding → identify event. Refreshes every {POLL_INTERVAL_MS / 1000} s.
            {data && (
              <>
                {" "}
                <span className="text-dim">
                  Last update: {new Date(data.generated_at).toLocaleTimeString()}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Top summary chips — same numbers in all tabs so the operator
          gets headline counts without switching. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <SummaryCard
          icon="camera"
          label="RTSP running"
          value={data ? `${data.rtsp.running} / ${data.rtsp.workers.length}` : "—"}
          accent="#3b82f6"
          warn={!!data && data.rtsp.failed + data.rtsp.reconnecting > 0}
          warnLabel={
            data
              ? `${data.rtsp.failed} failed · ${data.rtsp.reconnecting} reconnecting`
              : undefined
          }
        />
        <SummaryCard
          icon="videocam"
          label="Recording active"
          value={
            data
              ? `${data.recording.active} / ${data.recording.enabled_cameras}`
              : "—"
          }
          accent="#ef4444"
        />
        <SummaryCard
          icon="activity"
          label="Encoding queue"
          value={
            data
              ? `${data.encoding.queued} queued · ${data.encoding.processing} processing`
              : "—"
          }
          accent="#f59e0b"
          warn={!!data && data.encoding.failed_today > 0}
          warnLabel={
            data && data.encoding.failed_today > 0
              ? `${data.encoding.failed_today} failed today`
              : undefined
          }
        />
        <SummaryCard
          icon="user"
          label="Identify running"
          value={
            data
              ? `${data.identify.running} · ${data.identify.pending} pending`
              : "—"
          }
          accent="#10b981"
          warn={!!data && data.identify.failed_today > 0}
          warnLabel={
            data && data.identify.failed_today > 0
              ? `${data.identify.failed_today} failed today`
              : undefined
          }
        />
      </div>

      {/* Tab strip */}
      <div className="card" style={{ overflow: "hidden" }}>
        <div
          role="tablist"
          aria-label="Pipeline stages"
          style={{
            display: "flex",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-sunken)",
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              style={{
                flex: 1,
                padding: "12px 16px",
                background: tab === t.key ? "var(--bg-elev)" : "transparent",
                border: "none",
                borderBottom:
                  tab === t.key
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                color: tab === t.key ? "var(--text)" : "var(--text-secondary)",
                fontWeight: tab === t.key ? 600 : 500,
                fontSize: 13,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                transition: "background 120ms ease",
              }}
            >
              <Icon name={t.icon} size={14} />
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ padding: 16 }}>
          {query.isLoading && (
            <div className="text-sm text-dim" style={{ padding: 16 }}>
              Loading pipeline state…
            </div>
          )}
          {query.isError && (
            <div
              className="text-sm"
              style={{ padding: 16, color: "var(--danger-text)" }}
            >
              Could not load pipeline. The endpoint requires Admin role.
            </div>
          )}
          {data && tab === "rtsp" && <RtspPanel data={data.rtsp} />}
          {data && tab === "recording" && (
            <RecordingPanel data={data.recording} />
          )}
          {data && tab === "encoding" && <EncodingPanel data={data.encoding} />}
          {data && tab === "identify" && <IdentifyPanel data={data.identify} />}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Summary card — one chip per stage along the top.
// ---------------------------------------------------------------------------

function SummaryCard({
  icon,
  label,
  value,
  accent,
  warn,
  warnLabel,
}: {
  icon: IconName;
  label: string;
  value: string;
  accent: string;
  warn?: boolean;
  warnLabel?: string | undefined;
}) {
  return (
    <div
      className="card"
      style={{
        padding: 14,
        borderLeft: `4px solid ${accent}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--text-secondary)",
          fontSize: 11.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        <Icon name={icon} size={14} />
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text)" }}>
        {value}
      </div>
      {warn && warnLabel && (
        <div
          style={{
            fontSize: 11,
            color: "var(--danger-text)",
            background: "var(--danger-soft)",
            padding: "2px 6px",
            borderRadius: 999,
            display: "inline-flex",
            alignSelf: "flex-start",
          }}
        >
          {warnLabel}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: RTSP Feed Worker
// ---------------------------------------------------------------------------

function RtspPanel({ data }: { data: PipelineMonitorOut["rtsp"] }) {
  return (
    <>
      <CountStrip
        items={[
          { label: "Running", value: data.running, tone: "ok" },
          {
            label: "Reconnecting",
            value: data.reconnecting,
            tone: data.reconnecting > 0 ? "warn" : "neutral",
          },
          {
            label: "Failed",
            value: data.failed,
            tone: data.failed > 0 ? "danger" : "neutral",
          },
          { label: "Stopped", value: data.stopped, tone: "neutral" },
        ]}
      />
      <table className="table" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Camera</th>
            <th style={{ width: 110 }}>Status</th>
            <th style={{ width: 100 }}>Uptime</th>
            <th style={{ width: 110 }}>FPS (read / analyze)</th>
            <th style={{ width: 100 }}>Errors / 5m</th>
          </tr>
        </thead>
        <tbody>
          {data.workers.length === 0 && (
            <tr>
              <td colSpan={5} className="text-sm text-dim" style={{ padding: 16 }}>
                No RTSP workers running.
              </td>
            </tr>
          )}
          {data.workers.map((w) => (
            <tr key={w.camera_id}>
              <td style={{ fontWeight: 500 }}>{w.camera_name}</td>
              <td>
                <StatusBadge status={w.status} />
              </td>
              <td className="mono text-sm">{fmtUptime(w.uptime_sec)}</td>
              <td className="mono text-sm">
                {w.fps_reader.toFixed(1)} / {w.fps_analyzer.toFixed(1)}
              </td>
              <td
                className="mono text-sm"
                style={{
                  color: w.errors_5min > 0 ? "var(--danger-text)" : undefined,
                }}
              >
                {w.errors_5min}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Clip Recording Worker
// ---------------------------------------------------------------------------

function RecordingPanel({
  data,
}: {
  data: PipelineMonitorOut["recording"];
}) {
  return (
    <>
      <CountStrip
        items={[
          {
            label: "Currently recording",
            value: data.active,
            tone: data.active > 0 ? "ok" : "neutral",
          },
          { label: "Cameras enabled", value: data.enabled_cameras, tone: "neutral" },
          {
            label: "Cameras idle",
            value: Math.max(0, data.enabled_cameras - data.active),
            tone: "neutral",
          },
        ]}
      />
      <table className="table" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Camera</th>
            <th style={{ width: 110 }}>Recording</th>
            <th style={{ width: 110 }}>Clip ID</th>
            <th style={{ width: 90 }}>Elapsed</th>
            <th style={{ width: 100 }}>Frames</th>
            <th style={{ width: 90 }}>Chunks</th>
          </tr>
        </thead>
        <tbody>
          {data.cameras.length === 0 && (
            <tr>
              <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                No active capture workers — nothing to report on.
              </td>
            </tr>
          )}
          {data.cameras.map((c) => (
            <tr key={c.camera_id}>
              <td style={{ fontWeight: 500 }}>{c.camera_name}</td>
              <td>
                {c.recording_active ? (
                  <Pill tone="danger">
                    <PulseDot /> Recording
                  </Pill>
                ) : c.recording_enabled ? (
                  <Pill tone="neutral">Idle</Pill>
                ) : (
                  <Pill tone="neutral">Disabled</Pill>
                )}
              </td>
              <td className="mono text-sm">
                {c.current_clip_id ?? "—"}
              </td>
              <td className="mono text-sm">
                {c.recording_active ? `${c.elapsed_sec.toFixed(0)}s` : "—"}
              </td>
              <td className="mono text-sm">
                {c.recording_active ? c.total_frames_written.toLocaleString() : "—"}
              </td>
              <td className="mono text-sm">
                {c.recording_active ? c.chunks_completed : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: Encoding Worker (ClipWorker queues + ffmpeg)
// ---------------------------------------------------------------------------

function EncodingPanel({ data }: { data: PipelineMonitorOut["encoding"] }) {
  const totalInPipeline = data.queued + data.processing;
  return (
    <>
      <CountStrip
        items={[
          {
            label: "Pending queue",
            value: data.queued,
            tone: data.queued > 0 ? "warn" : "neutral",
          },
          {
            label: "Processing",
            value: data.processing,
            tone: data.processing > 0 ? "ok" : "neutral",
          },
          {
            label: "Completed today",
            value: data.completed_today,
            tone: "ok",
          },
          {
            label: "Failed today",
            value: data.failed_today,
            tone: data.failed_today > 0 ? "danger" : "neutral",
          },
        ]}
      />

      {/* Per-worker queue depth — one row per camera's ClipWorker. */}
      <table className="table" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Camera</th>
            <th style={{ width: 130 }}>Worker</th>
            <th style={{ width: 150 }}>Queue depth</th>
            <th style={{ width: 110 }}>Utilization</th>
          </tr>
        </thead>
        <tbody>
          {data.workers.length === 0 && (
            <tr>
              <td colSpan={4} className="text-sm text-dim" style={{ padding: 16 }}>
                No encoding workers running.
              </td>
            </tr>
          )}
          {data.workers.map((w) => {
            const pct = totalInPipeline === 0 ? 0 : (w.queue_size / Math.max(1, totalInPipeline)) * 100;
            return (
              <tr key={w.camera_id}>
                <td style={{ fontWeight: 500 }}>{w.camera_name}</td>
                <td>
                  {w.alive ? (
                    <Pill tone="ok">Alive</Pill>
                  ) : (
                    <Pill tone="danger">Stopped</Pill>
                  )}
                </td>
                <td className="mono text-sm">{w.queue_size}</td>
                <td>
                  <ProgressBar pct={pct} tone={w.queue_size > 8 ? "warn" : "ok"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 4: Identify Event Worker (face-match jobs)
// ---------------------------------------------------------------------------

// Visual catalogue mirroring the UC tile design from Clip Analytics
// (Identify Event modal). Same accent colours for visual continuity.
const UC_META: Record<
  string,
  { title: string; subtitle: string; accent: string; accentSoft: string; iconName: IconName }
> = {
  uc1: {
    title: "YOLO + Face",
    subtitle: "Body detection first, then face inside each box.",
    accent: "#3b82f6",
    accentSoft: "rgba(59,130,246,0.12)",
    iconName: "shield",
  },
  uc2: {
    title: "InsightFace + Crops",
    subtitle: "Stores face crops with pose-aware quality scoring.",
    accent: "#8b5cf6",
    accentSoft: "rgba(139,92,246,0.12)",
    iconName: "user",
  },
  uc3: {
    title: "InsightFace Direct",
    subtitle: "Skip crop storage. Just match and report.",
    accent: "#10b981",
    accentSoft: "rgba(16,185,129,0.12)",
    iconName: "sparkles",
  },
};

function IdentifyPanel({ data }: { data: PipelineMonitorOut["identify"] }) {
  return (
    <>
      {/* Aggregate strip — sum across all UCs. */}
      <CountStrip
        items={[
          {
            label: "Running now",
            value: data.running,
            tone: data.running > 0 ? "ok" : "neutral",
          },
          {
            label: "Pending",
            value: data.pending,
            tone: data.pending > 0 ? "warn" : "neutral",
          },
          {
            label: "Processing",
            value: data.processing,
            tone: data.processing > 0 ? "ok" : "neutral",
          },
          {
            label: "Completed today",
            value: data.completed_today,
            tone: "ok",
          },
          {
            label: "Failed today",
            value: data.failed_today,
            tone: data.failed_today > 0 ? "danger" : "neutral",
          },
        ]}
      />

      {/* Per-use-case breakdown — one card per UC1 / UC2 / UC3. */}
      <div
        style={{
          marginTop: 14,
          fontSize: 11.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-secondary)",
          marginBottom: 8,
        }}
      >
        Per use case
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        {data.use_cases.map((uc) => (
          <UseCaseStatsCard key={uc.use_case} stats={uc} />
        ))}
      </div>

      {/* Currently processing chip cloud — same as before. */}
      <div
        className="card"
        style={{
          marginTop: 14,
          padding: 14,
          background: "var(--bg-sunken)",
          border: "1px dashed var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--text-secondary)",
            marginBottom: 6,
          }}
        >
          Currently processing
        </div>
        {data.active_clip_ids.length === 0 ? (
          <div className="text-sm text-dim">
            No Identify Event jobs running. Trigger one from the Clip
            Analytics page (⋮ → Identify Event) and it will appear here
            in real time.
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {data.active_clip_ids.map((cid) => (
              <span
                key={cid}
                className="mono"
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  fontSize: 12,
                  background: "var(--success-soft)",
                  color: "var(--success-text)",
                  border: "1px solid rgba(16,185,129,0.25)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <PulseDot color="var(--success-text)" />
                Clip #{cid}
              </span>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        Batch worker:{" "}
        <span className="mono">{data.batch_status}</span>
      </div>
    </>
  );
}

function UseCaseStatsCard({ stats }: { stats: IdentifyUseCaseStats }) {
  const meta = UC_META[stats.use_case] ?? {
    title: "Unknown",
    subtitle: "",
    accent: "var(--text)",
    accentSoft: "var(--bg-sunken)",
    iconName: "user" as IconName,
  };
  const activeInPipeline = stats.pending + stats.processing;
  return (
    <div
      className="card"
      style={{
        padding: 0,
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      {/* Coloured header band so each UC is instantly recognisable. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: meta.accentSoft,
          borderBottom: `2px solid ${meta.accent}`,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: meta.accent,
            color: "#fff",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Icon name={meta.iconName} size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: meta.accent,
              letterSpacing: "0.02em",
            }}
          >
            {stats.use_case.toUpperCase()} · {meta.title}
          </div>
          <div
            className="text-xs"
            style={{
              color: "var(--text-secondary)",
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {meta.subtitle}
          </div>
        </div>
        {activeInPipeline > 0 && (
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: meta.accent,
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <PulseDot color="#fff" />
            {activeInPipeline} active
          </span>
        )}
      </div>

      {/* Per-status grid. 2x2 layout keeps the card a consistent height. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 1,
          background: "var(--border)",
        }}
      >
        <StatCell
          label="Pending"
          value={stats.pending}
          tone={stats.pending > 0 ? "warn" : "neutral"}
        />
        <StatCell
          label="Processing"
          value={stats.processing}
          tone={stats.processing > 0 ? "ok" : "neutral"}
        />
        <StatCell
          label="Done today"
          value={stats.completed_today}
          tone={stats.completed_today > 0 ? "ok" : "neutral"}
        />
        <StatCell
          label="Failed today"
          value={stats.failed_today}
          tone={stats.failed_today > 0 ? "danger" : "neutral"}
        />
      </div>

      {/* Footer — lifetime completed total so operators can see the
          background trend without doing math across "today" windows. */}
      <div
        style={{
          padding: "8px 14px",
          fontSize: 11.5,
          color: "var(--text-secondary)",
          background: "var(--bg-elev)",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>Lifetime completed</span>
        <span className="mono" style={{ fontWeight: 600, color: "var(--text)" }}>
          {stats.completed_total.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function StatCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: Tone;
}) {
  const p = paletteFor(tone);
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: p.fg }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny shared bits.
// ---------------------------------------------------------------------------

type Tone = "ok" | "warn" | "danger" | "neutral";

function CountStrip({
  items,
}: {
  items: { label: string; value: number; tone: Tone }[];
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${items.length}, 1fr)`,
        gap: 10,
      }}
    >
      {items.map((item) => {
        const palette = paletteFor(item.tone);
        return (
          <div
            key={item.label}
            style={{
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-elev)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                fontWeight: 600,
              }}
            >
              {item.label}
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: palette.fg,
              }}
            >
              {item.value.toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: RtspWorker["status"];
}) {
  const map: Record<RtspWorker["status"], Tone> = {
    starting: "warn",
    running: "ok",
    reconnecting: "warn",
    stopped: "neutral",
    failed: "danger",
  };
  return <Pill tone={map[status]}>{status}</Pill>;
}

function Pill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  const p = paletteFor(tone);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 999,
        background: p.bg,
        color: p.fg,
        fontSize: 11.5,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}

function PulseDot({ color }: { color?: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color ?? "var(--danger-text)",
        boxShadow: `0 0 0 0 ${color ?? "var(--danger-text)"}`,
        animation: "pipeline-pulse 1.4s ease-in-out infinite",
        display: "inline-block",
      }}
    />
  );
}

function ProgressBar({ pct, tone }: { pct: number; tone: Tone }) {
  const p = paletteFor(tone);
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div
      style={{
        width: "100%",
        height: 8,
        borderRadius: 999,
        background: "var(--bg-sunken)",
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          width: `${width}%`,
          height: "100%",
          background: p.fg,
          transition: "width 240ms ease",
        }}
      />
    </div>
  );
}

function paletteFor(tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case "ok":
      return {
        bg: "var(--success-soft)",
        fg: "var(--success-text)",
      };
    case "warn":
      return {
        bg: "var(--warning-soft)",
        fg: "var(--warning-text)",
      };
    case "danger":
      return {
        bg: "var(--danger-soft)",
        fg: "var(--danger-text)",
      };
    case "neutral":
    default:
      return {
        bg: "var(--bg-sunken)",
        fg: "var(--text-secondary)",
      };
  }
}

// CSS keyframes for the pulsing dot — injected once via a global
// style element so the component stays self-contained.
if (typeof document !== "undefined") {
  const id = "pipeline-monitor-keyframes";
  if (!document.getElementById(id)) {
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `@keyframes pipeline-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); }
      50% { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
    }`;
    document.head.appendChild(s);
  }
}
