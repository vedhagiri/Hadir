// Pipeline Monitor — dedicated dashboard for the 4 worker stages:
// RTSP Feed / Clip Recording / Encoding / Identify Event.
//
// Polls /api/operations/pipeline every 3 s. Tabbed interface: one
// stage visible at a time. Summary chips along the top show the
// headline counts across all stages so the operator gets the
// at-a-glance number without leaving whichever tab they're on.

import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import type { CSSProperties } from "react";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";

const POLL_INTERVAL_MS = 3000;

type StageKey = "workers" | "rtsp" | "recording" | "encoding" | "identify" | "queues";

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
  { key: "workers", label: "Workers", icon: "activity" },
  { key: "rtsp", label: "RTSP Feed", icon: "camera" },
  { key: "recording", label: "Clip Recording", icon: "videocam" },
  { key: "encoding", label: "Encoding", icon: "activity" },
  { key: "identify", label: "Identify Event", icon: "user" },
  { key: "queues", label: "Queue Pipeline", icon: "activity" },
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
  const [tab, setTab] = useState<StageKey>("workers");

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
          {tab === "queues" && <QueuePipelinePanel />}
          {tab === "workers" && <WorkersTablePanel />}
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
    }
    @keyframes pipeline-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    .icon-spin {
      animation: pipeline-spin 0.9s linear infinite;
      transform-origin: 50% 50%;
    }`;
    document.head.appendChild(s);
  }
}


// ---------------------------------------------------------------------------
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
  const q = useQuery({
    queryKey: ["clip-pipeline", "status"],
    queryFn: () => api<QueueStatusOut>("/api/clip-pipeline/status"),
    refetchInterval: 1500,
    refetchIntervalInBackground: false,
  });

  if (q.isLoading) {
    return (
      <div className="text-sm text-dim" style={{ padding: 16 }}>
        Loading queue pipeline…
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div
        className="text-sm"
        style={{ padding: 16, color: "var(--danger-text)" }}
      >
        Could not load the queue pipeline. Requires Admin/HR role.
      </div>
    );
  }

  const d = q.data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Pipeline status banner */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "8px 12px",
          background: d.running
            ? "rgba(16,185,129,0.10)"
            : "rgba(239,68,68,0.10)",
          border: `1px solid ${
            d.running ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)"
          }`,
          borderRadius: 8,
          fontSize: 12,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: d.running ? "#10b981" : "#ef4444",
          }}
        />
        <span style={{ fontWeight: 600 }}>
          {d.running ? "Pipeline running" : "Pipeline stopped"}
        </span>
        <span style={{ color: "var(--text-secondary)" }}>
          · Cropping workers: {d.config.cropping_workers} · Matching workers:{" "}
          {d.config.matching_workers} · Queue cap: {d.config.queue_max_depth}
        </span>
      </div>

      {/* Two stage cards side-by-side */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <StageCard
          title="Face Cropping Queue"
          subtitle="Decodes the clip + runs detection per UC; emits face_crops + a match job."
          stage={d.cropping}
          accent="#6366f1"
          icon="camera"
        />
        <StageCard
          title="Face Matching Queue"
          subtitle="Runs matcher_cache against the just-extracted embeddings and finalises clip_processing_results."
          stage={d.matching}
          accent="#10b981"
          icon="user"
        />
      </div>

      {/* Batches */}
      <div>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginBottom: 8,
          }}
        >
          Batch History
        </div>
        {d.batches.length === 0 ? (
          <div
            className="text-sm text-dim"
            style={{
              padding: "20px 12px",
              textAlign: "center",
              border: "1px dashed var(--border)",
              borderRadius: 8,
            }}
          >
            No batches submitted yet. Submit one via{" "}
            <code>POST /api/clip-pipeline/submit</code> or from the
            forthcoming Clip Analytics action.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
  accent,
  icon,
}: {
  title: string;
  subtitle: string;
  stage: QueueStageOut;
  accent: string;
  icon: IconName;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          background: `linear-gradient(135deg, ${accent}14 0%, transparent 100%)`,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 700,
            color: "var(--text)",
          }}
        >
          <span style={{ color: accent, display: "inline-flex" }}>
            <Icon name={icon} size={14} />
          </span>
          {title}
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: 11,
            color: "var(--text-secondary)",
            lineHeight: 1.4,
          }}
        >
          {subtitle}
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 1,
          background: "var(--border)",
        }}
      >
        <MiniStat label="Queued" value={stage.queue_depth} accent={accent} />
        <MiniStat label="Processing" value={stage.in_flight} accent={accent} />
        <MiniStat label="Done (lifetime)" value={stage.lifetime_processed} />
        <MiniStat
          label="Failed"
          value={stage.lifetime_failed}
          accent={stage.lifetime_failed > 0 ? "var(--danger-text)" : undefined}
        />
      </div>
      <div style={{ padding: "10px 14px" }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginBottom: 6,
          }}
        >
          Active workers
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {stage.workers.map((w) => (
            <div
              key={w.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                background: w.busy
                  ? `${accent}10`
                  : "var(--bg-sunken)",
                border: `1px solid ${
                  w.busy ? `${accent}33` : "var(--border)"
                }`,
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: w.busy ? accent : "var(--text-tertiary)",
                  ...(w.busy ? { animation: "pipeline-pulse 1.6s infinite" } : {}),
                }}
              />
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                {w.name}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {w.busy
                  ? w.current_job +
                    (w.running_for_s != null ? ` · ${w.running_for_s.toFixed(1)}s` : "")
                  : "idle"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


function MiniStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string | undefined;
}) {
  return (
    <div
      style={{
        background: "var(--bg)",
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          marginTop: 2,
          fontSize: 18,
          fontWeight: 700,
          color: accent ?? "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}


function BatchCard({ batch }: { batch: QueueBatchOut }) {
  const pct =
    batch.total_jobs > 0
      ? Math.round(
          ((batch.completed_jobs + batch.skipped_jobs + batch.failed_jobs) /
            batch.total_jobs) *
            100,
        )
      : 0;
  const done = batch.completed_at !== null;
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg)",
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
            }}
          >
            #{batch.batch_id}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              marginTop: 2,
            }}
          >
            {new Date(batch.submitted_at).toLocaleString()} ·{" "}
            {batch.submitted_by_email ?? "—"} ·{" "}
            {batch.clip_ids.length} clip{batch.clip_ids.length === 1 ? "" : "s"} ·{" "}
            UCs: {batch.use_cases.map((u) => u.toUpperCase()).join(", ")}
            {batch.skip_existing ? " · skip_existing" : ""}
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 10px",
            borderRadius: 999,
            color: done ? "var(--success-text)" : "var(--accent, #6366f1)",
            background: done ? "var(--success-soft)" : "rgba(99,102,241,0.10)",
          }}
        >
          {done ? "Completed" : `${pct}%`}
        </span>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 6,
          background: "var(--bg-sunken)",
          borderRadius: 3,
          overflow: "hidden",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: done ? "var(--success-text)" : "var(--accent, #6366f1)",
            transition: "width 0.4s ease",
          }}
        />
      </div>

      {/* Scorecard — selected / completed / skipped / failed / remaining */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <ScoreCell label="Selected" value={batch.total_jobs} />
        <ScoreCell
          label="Completed"
          value={batch.completed_jobs}
          accent="var(--success-text)"
        />
        <ScoreCell
          label="Skipped"
          value={batch.skipped_jobs}
          accent="var(--text-secondary)"
        />
        <ScoreCell
          label="Failed"
          value={batch.failed_jobs}
          accent={batch.failed_jobs > 0 ? "var(--danger-text)" : undefined}
        />
        <ScoreCell
          label="Remaining"
          value={batch.remaining_jobs}
          accent="var(--accent, #6366f1)"
        />
      </div>

      {/* In-flight counters per stage */}
      <div
        style={{
          display: "flex",
          gap: 12,
          fontSize: 11,
          color: "var(--text-secondary)",
          marginBottom: 10,
        }}
      >
        <span>
          <strong style={{ color: "var(--text)" }}>{batch.queued_jobs}</strong>{" "}
          waiting in queue
        </span>
        <span>·</span>
        <span>
          <strong style={{ color: "var(--text)" }}>{batch.cropping_now}</strong>{" "}
          cropping now
        </span>
        <span>·</span>
        <span>
          <strong style={{ color: "var(--text)" }}>{batch.matching_now}</strong>{" "}
          matching now
        </span>
      </div>

      {/* Per-UC strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${batch.use_cases.length}, 1fr)`,
          gap: 8,
        }}
      >
        {batch.use_cases.map((uc) => (
          <UcStrip key={uc} uc={uc} stats={batch.per_uc[uc] ?? null} />
        ))}
      </div>
    </div>
  );
}


function ScoreCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string | undefined;
}) {
  return (
    <div
      style={{
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "6px 8px",
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          marginTop: 1,
          fontSize: 15,
          fontWeight: 700,
          color: accent ?? "var(--text)",
        }}
      >
        {value}
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
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "8px 10px",
        background: "var(--bg-sunken)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 5,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.04em",
          }}
        >
          {uc.toUpperCase()}
        </span>
        <span
          className="mono"
          style={{ fontSize: 11, color: "var(--text-secondary)" }}
        >
          {completed} / {total}
        </span>
      </div>
      <div
        style={{
          height: 4,
          background: "var(--bg)",
          borderRadius: 2,
          overflow: "hidden",
          marginBottom: 5,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "var(--accent, #6366f1)",
            transition: "width 0.4s ease",
          }}
        />
      </div>
      <div
        style={{
          fontSize: 10,
          color: "var(--text-secondary)",
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <span>Q {stats?.queued ?? 0}</span>
        <span>· C {stats?.cropping ?? 0}</span>
        <span>· M {stats?.matching ?? 0}</span>
        <span>· S {stats?.skipped ?? 0}</span>
        {(stats?.failed ?? 0) > 0 && (
          <span style={{ color: "var(--danger-text)" }}>
            · F {stats?.failed}
          </span>
        )}
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
  const q = useQuery({
    queryKey: ["pipeline-monitor", "workers"],
    queryFn: () => api<WorkersSnapshot>("/api/pipeline-monitor/workers"),
    refetchInterval: 1500,
    refetchIntervalInBackground: false,
  });

  if (q.isLoading) {
    return (
      <div className="text-sm text-dim" style={{ padding: 16 }}>
        Loading workers…
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div
        className="text-sm"
        style={{ padding: 16, color: "var(--danger-text)" }}
      >
        Could not load worker snapshot. Endpoint requires Admin or HR role.
      </div>
    );
  }
  const d = q.data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Health summary chip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg-sunken)",
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 700 }}>
          {d.summary.total_workers} workers
        </span>
        <span>·</span>
        <span style={{ color: "var(--success-text)" }}>
          {d.summary.running} running
        </span>
        {d.summary.degraded > 0 && (
          <>
            <span>·</span>
            <span style={{ color: "var(--warning-text)" }}>
              {d.summary.degraded} degraded
            </span>
          </>
        )}
        {d.summary.stalled > 0 && (
          <>
            <span>·</span>
            <span style={{ color: "var(--danger-text)" }}>
              {d.summary.stalled} stalled
            </span>
          </>
        )}
        <span style={{ marginInlineStart: "auto", color: "var(--text-secondary)" }}>
          Updated {new Date(d.generated_at).toLocaleTimeString()} ·{" "}
          {d.took_ms.toFixed(0)} ms
        </span>
        <button
          type="button"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          title="Force an immediate refresh — bypasses the 1.5 s polling interval."
          aria-label="Sync workers now"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text)",
            cursor: q.isFetching ? "wait" : "pointer",
            fontSize: 11.5,
            fontWeight: 600,
            opacity: q.isFetching ? 0.6 : 1,
          }}
        >
          <Icon
            name="refresh"
            size={12}
            {...(q.isFetching ? { className: "icon-spin" } : {})}
          />
          {q.isFetching ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {/* Grouped table */}
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12.5,
            minWidth: 920,
          }}
        >
          <thead style={{ background: "var(--bg-sunken)" }}>
            <tr>
              <th style={thStyle}>Worker</th>
              <th style={thStyle}>Status</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Active</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Queue</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Processing</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Completed</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Failed</th>
              <th style={thStyle}>Current Task</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Speed</th>
              <th style={thStyle}>Health</th>
            </tr>
          </thead>
          <tbody>
            {d.groups.map((g) => (
              <Fragment key={g.key}>
                <tr>
                  <td
                    colSpan={10}
                    style={{
                      padding: "8px 12px",
                      background: "var(--bg-elev)",
                      borderTop: "1px solid var(--border)",
                      borderBottom: "1px solid var(--border)",
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--text-secondary)",
                    }}
                  >
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


const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 10.5,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderTop: "1px solid var(--border)",
  fontVariantNumeric: "tabular-nums",
};


function WorkerRowView({ worker }: { worker: WorkerRow }) {
  const statusPalette = paletteForStatus(worker.status);
  const healthPalette = paletteForHealth(worker.health);
  return (
    <tr>
      <td style={{ ...tdStyle, fontWeight: 600, color: "var(--text)" }}>
        {worker.name}
      </td>
      <td style={tdStyle}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: 999,
            background: statusPalette.bg,
            color: statusPalette.fg,
            fontWeight: 600,
            fontSize: 11,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: statusPalette.dot,
            }}
          />
          {worker.status}
        </span>
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        {fmtActiveCell(worker.active_jobs, worker.active_unit)}
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        {fmtCell(worker.queue_count)}
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        {fmtCell(worker.processing)}
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        {fmtCell(worker.completed)}
      </td>
      <td
        style={{
          ...tdStyle,
          textAlign: "right",
          color: (worker.failed ?? 0) > 0 ? "var(--danger-text)" : undefined,
        }}
      >
        {fmtCell(worker.failed)}
      </td>
      <td
        style={{
          ...tdStyle,
          color: "var(--text-secondary)",
          maxWidth: 240,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={worker.current_task || worker.next_run || ""}
      >
        {worker.current_task || (worker.next_run
          ? `next ${new Date(worker.next_run).toLocaleTimeString()}`
          : "—")}
      </td>
      <td
        style={{
          ...tdStyle,
          textAlign: "right",
          color: "var(--text-secondary)",
        }}
      >
        {worker.speed_ms != null ? fmtSpeed(worker.speed_ms) : "—"}
      </td>
      <td style={tdStyle}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: 999,
            background: healthPalette.bg,
            color: healthPalette.fg,
            fontWeight: 600,
            fontSize: 11,
            textTransform: "capitalize",
          }}
        >
          {worker.health}
        </span>
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
function fmtActiveCell(
  v: number | null | undefined,
  unit: string | null | undefined,
): string {
  if (v == null) return "—";
  if (!unit) return v.toLocaleString();
  return `${v.toLocaleString()} ${unit}`;
}


function fmtSpeed(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}


function paletteForStatus(status: string): { bg: string; fg: string; dot: string } {
  switch (status) {
    case "running":
      return { bg: "var(--success-soft)", fg: "var(--success-text)", dot: "#10b981" };
    case "stopped":
    case "not_started":
      return { bg: "var(--bg-sunken)", fg: "var(--text-secondary)", dot: "#94a3b8" };
    case "no_jobs":
    case "idle":
      return { bg: "var(--bg-sunken)", fg: "var(--text-secondary)", dot: "#94a3b8" };
    case "unknown":
    default:
      return { bg: "var(--warning-soft)", fg: "var(--warning-text)", dot: "#f59e0b" };
  }
}


function paletteForHealth(health: string): { bg: string; fg: string } {
  switch (health) {
    case "healthy":
      return { bg: "var(--success-soft)", fg: "var(--success-text)" };
    case "idle":
      return { bg: "var(--bg-sunken)", fg: "var(--text-secondary)" };
    case "degraded":
      return { bg: "var(--warning-soft)", fg: "var(--warning-text)" };
    case "stalled":
      return { bg: "var(--danger-soft)", fg: "var(--danger-text)" };
    default:
      return { bg: "var(--bg-sunken)", fg: "var(--text-secondary)" };
  }
}
