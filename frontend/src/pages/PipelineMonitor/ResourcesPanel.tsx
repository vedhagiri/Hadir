// P29 — "Resources" tab on the Pipeline Monitor.
//
// Three cards stacked:
//   - System Overview (host CPU / Memory / Disk / Disk I/O / Network /
//     Swap — six doughnut tiles, plus a Backend Process strip below)
//   - Per-camera resource view (table — CPU% share / Mem MB / FPS in
//     and out / Drops / Reconnects / Bytes / Clip queue)
//   - Per-stage breakdown (table — RTSP Reader / Detection / Matching
//     / Attendance / Clip Save; shared-vs-per-camera label, avg ms,
//     queue, throughput, errors)
//
// Each card polls its own endpoint at 5 s. Inline SVG doughnuts and
// sparkline glyphs — no charting library (red line: no unauthorized
// dependencies). The design CSS classes (.card, .text-dim) are reused
// verbatim — additional layout state lives in inline styles, scoped
// to this file.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { ResourceTimeseries } from "./ResourceTimeseries";
import { TopProcessesPanel } from "./TopProcessesPanel";

// Per-row health pill — green/yellow/red dot + label. Reused by the
// per-camera and per-stage tables so the leftmost column tells the
// admin "is this row healthy?" in one glance, without scanning the
// numeric columns. Pure: no hooks, no fetches.
type Severity = "ok" | "warn" | "bad";
const sevColor: Record<Severity, { bd: string; bg: string; fg: string }> = {
  ok: {
    bd: "var(--success, #10b981)",
    bg: "var(--success-soft, #ecfdf5)",
    fg: "var(--success-text, #047857)",
  },
  warn: {
    bd: "var(--warning, #f59e0b)",
    bg: "var(--warning-soft, #fffbeb)",
    fg: "var(--warning-text, #b45309)",
  },
  bad: {
    bd: "var(--danger, #ef4444)",
    bg: "var(--danger-soft, #fef2f2)",
    fg: "var(--danger-text, #b91c1c)",
  },
};

function HealthPill({ sev, label }: { sev: Severity; label: string }) {
  const c = sevColor[sev];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: c.bd,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// API types — mirror the Pydantic shapes in
// backend/maugood/observability/router.py.
// ---------------------------------------------------------------------------

interface HostCpuMem {
  cpu_percent: number;
  cpu_per_core: number[];
  cpu_count_logical: number;
  cpu_count_physical: number;
  load_avg_1m: number | null;
  load_avg_5m: number | null;
  load_avg_15m: number | null;
  mem_used_mb: number;
  mem_total_mb: number;
  mem_available_mb: number;
  mem_percent: number;
  swap_used_mb: number;
  swap_total_mb: number;
  swap_percent: number;
  uptime_sec: number;
}

interface HostDisk {
  data_partition_path: string;
  used_gb: number;
  total_gb: number;
  percent: number;
  read_mb_s: number | null;
  write_mb_s: number | null;
  face_crops_count: number;
  face_crops_size_gb: number;
}

interface HostNetwork {
  sent_mb_s: number | null;
  recv_mb_s: number | null;
}

interface BackendProcess {
  cpu_percent: number;
  memory_mb: number;
  threads: number;
  open_files: number;
}

interface HostGpu {
  available: boolean;
  percent: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
}

interface ThreadInfo {
  name: string;
  daemon: boolean;
  alive: boolean;
  cpu_user_s: number | null;
  cpu_system_s: number | null;
}

interface ThreadCategory {
  category: string;
  display: string;
  count: number;
  cpu_user_s: number;
  cpu_system_s: number;
  threads: ThreadInfo[];
}

interface ThreadBreakdown {
  total: number;
  categories: ThreadCategory[];
}

interface ResourcesHostResponse {
  host: HostCpuMem;
  disk: HostDisk;
  network: HostNetwork;
  backend_process: BackendProcess;
  gpu: HostGpu;
  thread_breakdown: ThreadBreakdown;
  generated_at: string;
}

interface CameraResource {
  tenant_id: number;
  camera_id: number;
  camera_name: string;
  cpu_share_estimate_pct: number | null;
  memory_share_estimate_mb: number | null;
  fps_reader: number;
  fps_analyzer: number;
  reader_frames_60s: number;
  frames_analyzed_60s: number;
  frames_motion_skipped_60s: number;
  frame_drops_60s: number;
  rtsp_reconnects_60s: number;
  bytes_received_60s: number | null;
  clip_recording_active: boolean;
  clip_queue_size: number;
}

interface ResourcesCamerasResponse {
  cameras: CameraResource[];
  generated_at: string;
}

interface StageRow {
  key: string;
  display: string;
  scope: "per_camera" | "shared_backend_process";
  cpu_label: string;
  queue_size: number | null;
  avg_processing_ms: number | null;
  p95_processing_ms: number | null;
  throughput_per_min: number | null;
  error_count_5min: number;
  detail: string;
  extras: Record<string, unknown>;
}

interface ResourcesStagesResponse {
  stages: StageRow[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// TanStack Query hooks
// ---------------------------------------------------------------------------

function useResourcesHost(enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "resources", "host"],
    queryFn: () => api<ResourcesHostResponse>("/api/operations/resources/host"),
    enabled,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

function useResourcesCameras(enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "resources", "cameras"],
    queryFn: () =>
      api<ResourcesCamerasResponse>("/api/operations/resources/cameras"),
    enabled,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
}

function useResourcesStages(enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "resources", "stages"],
    queryFn: () => api<ResourcesStagesResponse>("/api/operations/resources/stages"),
    enabled,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
}

// ---------------------------------------------------------------------------
// Doughnut gauge — inline SVG, ~40 lines
// ---------------------------------------------------------------------------

function DoughnutGauge({
  pct,
  label,
  sub,
  accent,
}: {
  pct: number | null;
  label: string;
  sub?: string | undefined;
  accent?: string | undefined;
}) {
  const size = 88;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped =
    pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const fill = c * (clamped / 100);
  const accentColor =
    accent ??
    (clamped >= 85
      ? "var(--danger, #ef4444)"
      : clamped >= 65
      ? "var(--warning, #f59e0b)"
      : "var(--accent, #10b981)");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: "8px 4px",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--border, #e5e7eb)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={accentColor}
          strokeWidth={stroke}
          strokeDasharray={`${fill} ${c}`}
          strokeLinecap="round"
        />
      </svg>
      <div style={{ marginTop: -54, fontSize: 18, fontWeight: 600 }}>
        {pct === null ? "—" : `${Math.round(clamped)}%`}
      </div>
      <div
        style={{
          marginTop: 22,
          fontSize: 11,
          fontWeight: 500,
          color: "var(--text-secondary, #6b7280)",
        }}
      >
        {label}
      </div>
      {sub ? (
        <div style={{ fontSize: 10, color: "var(--text-dim, #9ca3af)" }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// System Overview card
// ---------------------------------------------------------------------------

// Bucket-style stacked bar for one category's CPU share — light-touch
// glyph next to the count. Width is the category's total CPU time over
// the max across all categories.
function ThreadCpuBar({ pct, accent }: { pct: number; accent: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      style={{
        position: "relative",
        height: 6,
        width: "100%",
        background: "var(--border-soft, #f3f4f6)",
        borderRadius: 3,
        overflow: "hidden",
      }}
      aria-hidden="true"
    >
      <div
        style={{
          position: "absolute",
          insetInlineStart: 0,
          top: 0,
          bottom: 0,
          width: `${clamped}%`,
          background: accent,
        }}
      />
    </div>
  );
}

function ThreadBreakdownBlock({ breakdown }: { breakdown: ThreadBreakdown }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  if (breakdown.categories.length === 0) return null;
  const maxCpu = Math.max(
    1,
    ...breakdown.categories.map((c) => c.cpu_user_s + c.cpu_system_s),
  );
  return (
    <div
      style={{
        marginTop: 12,
        borderTop: "1px solid var(--border, #e5e7eb)",
        paddingTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600 }}>
          {t("resources.threadsTitle")}
        </div>
        <div className="text-dim" style={{ fontSize: 10 }}>
          {t("resources.threadsNote")}
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(160px, 1.6fr) 36px 1fr 88px 28px",
          gap: 8,
          alignItems: "center",
          fontSize: 12,
        }}
      >
        {breakdown.categories.map((c) => {
          const totalCpu = c.cpu_user_s + c.cpu_system_s;
          const pct = (totalCpu / maxCpu) * 100;
          const isOpen = expanded === c.category;
          const accent =
            c.category === "camera_readers" ||
            c.category === "camera_analyzers" ||
            c.category === "clip_pipeline"
              ? "var(--accent, #10b981)"
              : c.category === "main" || c.category === "request_handlers"
              ? "var(--text-secondary, #6b7280)"
              : "var(--info, #3b82f6)";
          return (
            <div
              key={c.category}
              style={{ display: "contents" }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>
                  {t(`resources.threadCategory.${c.category}`, {
                    defaultValue: c.display,
                  })}
                </div>
              </div>
              <div
                style={{
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  textAlign: "end",
                }}
              >
                {c.count}
              </div>
              <ThreadCpuBar pct={pct} accent={accent} />
              <div
                className="text-dim"
                style={{
                  fontSize: 11,
                  fontVariantNumeric: "tabular-nums",
                  textAlign: "end",
                }}
              >
                {totalCpu.toFixed(2)}s
              </div>
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : c.category)}
                aria-expanded={isOpen}
                aria-label={t("resources.threadExpandAria", {
                  category: c.display,
                })}
                style={{
                  background: "none",
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 4,
                  padding: "2px 6px",
                  fontSize: 10,
                  cursor: "pointer",
                  color: "var(--text-secondary, #6b7280)",
                }}
              >
                {isOpen ? "−" : "+"}
              </button>
              {isOpen && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    paddingInlineStart: 12,
                    paddingBottom: 8,
                    fontSize: 11,
                    color: "var(--text-secondary, #6b7280)",
                  }}
                >
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          background: "var(--bg-sunken, #f9fafb)",
                          fontSize: 10,
                        }}
                      >
                        <th style={{ ...cellStyleTiny, textAlign: "start" }}>
                          {t("resources.threadCol.name")}
                        </th>
                        <th style={cellStyleTiny}>
                          {t("resources.threadCol.daemon")}
                        </th>
                        <th style={{ ...cellStyleTiny, textAlign: "end" }}>
                          {t("resources.threadCol.cpuUser")}
                        </th>
                        <th style={{ ...cellStyleTiny, textAlign: "end" }}>
                          {t("resources.threadCol.cpuSys")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.threads.map((th, i) => (
                        <tr key={`${th.name}-${i}`}>
                          <td style={cellStyleTiny}>{th.name}</td>
                          <td style={{ ...cellStyleTiny, textAlign: "center" }}>
                            {th.daemon ? "✓" : ""}
                          </td>
                          <td style={{ ...cellStyleTiny, textAlign: "end" }}>
                            {th.cpu_user_s === null
                              ? "—"
                              : `${th.cpu_user_s.toFixed(2)}s`}
                          </td>
                          <td style={{ ...cellStyleTiny, textAlign: "end" }}>
                            {th.cpu_system_s === null
                              ? "—"
                              : `${th.cpu_system_s.toFixed(2)}s`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const cellStyleTiny: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid var(--border-soft, #f3f4f6)",
};

function SystemOverviewCard({
  host,
  disk,
  network,
  backend_process,
  gpu,
  thread_breakdown,
}: ResourcesHostResponse) {
  const { t } = useTranslation();
  // Cap network at a soft 100 MB/s — most office boxes won't go higher,
  // and a gauge that maxes at 0.1 of one's link is uninformative. The
  // numeric label shows the real value either way.
  const NET_GAUGE_MAX_MB_S = 100;
  const netPct =
    network.recv_mb_s === null
      ? null
      : Math.min(100, (network.recv_mb_s / NET_GAUGE_MAX_MB_S) * 100);
  const DISK_IO_GAUGE_MAX = 200; // MB/s soft cap
  const diskIoPct =
    disk.read_mb_s === null && disk.write_mb_s === null
      ? null
      : Math.min(
          100,
          (((disk.read_mb_s ?? 0) + (disk.write_mb_s ?? 0)) /
            DISK_IO_GAUGE_MAX) *
            100,
        );
  return (
    <div
      className="card"
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t("resources.systemOverview")}
        </h3>
        <span className="text-dim" style={{ fontSize: 11 }}>
          {t("resources.hostWideNote")}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, 1fr)",
          gap: 4,
          marginTop: 8,
        }}
      >
        <DoughnutGauge
          pct={host.cpu_percent}
          label={t("resources.cpu")}
          sub={
            host.cpu_count_logical > 0
              ? t("resources.cpuCoreCount", { count: host.cpu_count_logical })
              : undefined
          }
        />
        <DoughnutGauge
          pct={host.mem_percent}
          label={t("resources.memory")}
          sub={t("resources.memSub", {
            used: host.mem_used_mb.toLocaleString(),
            total: host.mem_total_mb.toLocaleString(),
          })}
        />
        <DoughnutGauge
          pct={disk.percent}
          label={t("resources.disk")}
          sub={t("resources.diskSub", {
            used: disk.used_gb,
            total: disk.total_gb,
          })}
        />
        <DoughnutGauge
          pct={diskIoPct}
          label={t("resources.diskIo")}
          sub={
            disk.read_mb_s === null && disk.write_mb_s === null
              ? t("resources.sampling")
              : t("resources.diskIoSub", {
                  read: (disk.read_mb_s ?? 0).toFixed(1),
                  write: (disk.write_mb_s ?? 0).toFixed(1),
                })
          }
        />
        <DoughnutGauge
          pct={netPct}
          label={t("resources.network")}
          sub={
            network.recv_mb_s === null
              ? t("resources.sampling")
              : t("resources.networkSub", {
                  recv: (network.recv_mb_s ?? 0).toFixed(1),
                  sent: (network.sent_mb_s ?? 0).toFixed(1),
                })
          }
        />
        <DoughnutGauge
          pct={host.swap_percent}
          label={t("resources.swap")}
          sub={
            host.swap_total_mb > 0
              ? t("resources.swapSub", {
                  used: host.swap_used_mb,
                  total: host.swap_total_mb,
                })
              : t("resources.swapDisabled")
          }
        />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginTop: 12,
          fontSize: 12,
          borderTop: "1px solid var(--border, #e5e7eb)",
          paddingTop: 12,
        }}
      >
        <div>
          <div className="text-dim" style={{ fontSize: 10 }}>
            {t("resources.backendCpu")}
          </div>
          <div style={{ fontWeight: 600 }}>
            {backend_process.cpu_percent.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-dim" style={{ fontSize: 10 }}>
            {t("resources.backendMem")}
          </div>
          <div style={{ fontWeight: 600 }}>
            {backend_process.memory_mb.toFixed(0)} MB
          </div>
        </div>
        <div>
          <div className="text-dim" style={{ fontSize: 10 }}>
            {t("resources.backendThreads")}
          </div>
          <div style={{ fontWeight: 600 }}>
            {thread_breakdown.total}
            <span
              className="text-dim"
              style={{ fontSize: 10, fontWeight: 400, marginInlineStart: 4 }}
            >
              {t("resources.threadCategoriesNote", {
                count: thread_breakdown.categories.length,
              })}
            </span>
          </div>
        </div>
        <div>
          <div className="text-dim" style={{ fontSize: 10 }}>
            {t("resources.faceCrops")}
          </div>
          <div style={{ fontWeight: 600 }}>
            {disk.face_crops_count.toLocaleString()}
            <span
              className="text-dim"
              style={{ fontSize: 10, fontWeight: 400, marginInlineStart: 4 }}
            >
              ({disk.face_crops_size_gb.toFixed(2)} GB)
            </span>
          </div>
        </div>
      </div>
      <ThreadBreakdownBlock breakdown={thread_breakdown} />
      {gpu.available ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
            marginTop: 8,
            fontSize: 12,
            borderTop: "1px solid var(--border, #e5e7eb)",
            paddingTop: 12,
          }}
        >
          <div>
            <div className="text-dim" style={{ fontSize: 10 }}>
              {t("resources.gpuUtil")}
            </div>
            <div style={{ fontWeight: 600 }}>{gpu.percent}%</div>
          </div>
          <div>
            <div className="text-dim" style={{ fontSize: 10 }}>
              {t("resources.gpuMem")}
            </div>
            <div style={{ fontWeight: 600 }}>
              {gpu.memory_used_mb} / {gpu.memory_total_mb} MB
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-camera table
// ---------------------------------------------------------------------------

function fmtBytes60s(b: number | null): string {
  if (b === null) return "—";
  if (b === 0) return "0";
  // Convert to Mbps over the 60-second window.
  const mbps = (b * 8) / 60 / 1024 / 1024;
  if (mbps < 0.1) {
    return `${(b / 1024).toFixed(0)} KB`;
  }
  return `${mbps.toFixed(2)} Mbps`;
}

function CamerasResourceTable({ cameras }: ResourcesCamerasResponse) {
  const { t } = useTranslation();
  if (cameras.length === 0) {
    return (
      <div
        className="card"
        style={{ padding: 16, color: "var(--text-secondary, #6b7280)" }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t("resources.perCamera")}
        </h3>
        <p style={{ marginTop: 8, fontSize: 13 }}>
          {t("resources.noWorkers")}
        </p>
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border, #e5e7eb)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t("resources.perCamera")}
        </h3>
        <span className="text-dim" style={{ fontSize: 11 }}>
          {t("resources.perCameraNote")}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <thead>
            <tr style={{ background: "var(--bg-sunken, #f9fafb)" }}>
              <th style={cellStyle}>{t("resources.col.health")}</th>
              <th style={cellStyle}>{t("resources.col.camera")}</th>
              <th style={cellStyle}>{t("resources.col.cpuShare")}</th>
              <th style={cellStyle}>{t("resources.col.memShare")}</th>
              <th style={cellStyle}>{t("resources.col.fpsIn")}</th>
              <th style={cellStyle}>{t("resources.col.fpsOut")}</th>
              <th style={cellStyle}>{t("resources.col.drops")}</th>
              <th style={cellStyle}>{t("resources.col.reconnects")}</th>
              <th style={cellStyle}>{t("resources.col.bytes")}</th>
              <th style={cellStyle}>{t("resources.col.clipQueue")}</th>
            </tr>
          </thead>
          <tbody>
            {cameras.map((c) => {
              // Same thresholds the per-column colours below use, but
              // collapsed into a single severity for the leading pill
              // so the admin scans one column instead of four.
              const cameraSev: Severity =
                c.frame_drops_60s > 30 || c.rtsp_reconnects_60s > 2
                  ? "bad"
                  : c.frame_drops_60s > 10 ||
                    c.rtsp_reconnects_60s > 0 ||
                    c.clip_queue_size > 10
                  ? "warn"
                  : "ok";
              const cameraSevLabel = t(`resources.health.${cameraSev}`);
              return (
              <tr key={c.camera_id}>
                <td style={cellStyle}>
                  <HealthPill sev={cameraSev} label={cameraSevLabel} />
                </td>
                <td style={cellStyle}>
                  <div style={{ fontWeight: 600 }}>{c.camera_name}</div>
                  <div className="text-dim" style={{ fontSize: 10 }}>
                    #{c.camera_id}
                  </div>
                </td>
                <td style={cellStyle}>
                  {c.cpu_share_estimate_pct === null
                    ? "—"
                    : `~${c.cpu_share_estimate_pct.toFixed(1)}%`}
                </td>
                <td style={cellStyle}>
                  {c.memory_share_estimate_mb === null
                    ? "—"
                    : `~${c.memory_share_estimate_mb.toFixed(0)} MB`}
                </td>
                <td style={cellStyle}>{c.fps_reader.toFixed(1)}</td>
                <td style={cellStyle}>{c.fps_analyzer.toFixed(1)}</td>
                <td
                  style={{
                    ...cellStyle,
                    color:
                      c.frame_drops_60s > 30
                        ? "var(--danger-text, #ef4444)"
                        : c.frame_drops_60s > 10
                        ? "var(--warning-text, #f59e0b)"
                        : "inherit",
                  }}
                >
                  {c.frame_drops_60s}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    color:
                      c.rtsp_reconnects_60s > 0
                        ? "var(--warning-text, #f59e0b)"
                        : "inherit",
                  }}
                >
                  {c.rtsp_reconnects_60s}
                </td>
                <td style={cellStyle}>{fmtBytes60s(c.bytes_received_60s)}</td>
                <td style={cellStyle}>
                  {c.clip_queue_size}
                  {c.clip_recording_active ? " ●" : ""}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  textAlign: "start",
  padding: "8px 12px",
  borderBottom: "1px solid var(--border-soft, #f3f4f6)",
};

// ---------------------------------------------------------------------------
// Per-stage breakdown
// ---------------------------------------------------------------------------

function StagesBreakdownTable({ stages }: ResourcesStagesResponse) {
  const { t } = useTranslation();
  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border, #e5e7eb)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {t("resources.perStage")}
        </h3>
        <span className="text-dim" style={{ fontSize: 11 }}>
          {t("resources.perStageNote")}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <thead>
            <tr style={{ background: "var(--bg-sunken, #f9fafb)" }}>
              <th style={cellStyle}>{t("resources.col.health")}</th>
              <th style={cellStyle}>{t("resources.col.stage")}</th>
              <th style={cellStyle}>{t("resources.col.scope")}</th>
              <th style={cellStyle}>{t("resources.col.avgMs")}</th>
              <th style={cellStyle}>{t("resources.col.queue")}</th>
              <th style={cellStyle}>{t("resources.col.tput")}</th>
              <th style={cellStyle}>{t("resources.col.errors5min")}</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => {
              const stageSev: Severity =
                s.error_count_5min >= 10 || (s.queue_size ?? 0) >= 50
                  ? "bad"
                  : s.error_count_5min > 0 || (s.queue_size ?? 0) > 10
                  ? "warn"
                  : "ok";
              const stageSevLabel = t(`resources.health.${stageSev}`);
              return (
              <tr key={s.key}>
                <td style={cellStyle}>
                  <HealthPill sev={stageSev} label={stageSevLabel} />
                </td>
                <td style={cellStyle}>
                  <div style={{ fontWeight: 600 }}>
                    {t(`resources.stageName.${s.key}`, {
                      defaultValue: s.display,
                    })}
                  </div>
                  <div className="text-dim" style={{ fontSize: 10 }}>
                    {s.detail}
                  </div>
                </td>
                <td style={cellStyle}>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 12,
                      fontSize: 10,
                      background:
                        s.scope === "shared_backend_process"
                          ? "var(--bg-sunken, #f3f4f6)"
                          : "var(--accent-soft, #ecfdf5)",
                      color:
                        s.scope === "shared_backend_process"
                          ? "var(--text-secondary, #6b7280)"
                          : "var(--accent-text, #047857)",
                    }}
                  >
                    {t(`resources.scope.${s.scope}`)}
                  </span>
                </td>
                <td style={cellStyle}>
                  {s.avg_processing_ms === null
                    ? "—"
                    : `${s.avg_processing_ms.toFixed(1)} ms`}
                  {s.p95_processing_ms !== null && (
                    <span className="text-dim" style={{ fontSize: 10 }}>
                      {" "}
                      (p95 {s.p95_processing_ms.toFixed(1)})
                    </span>
                  )}
                </td>
                <td style={cellStyle}>
                  {s.queue_size === null ? "—" : s.queue_size}
                </td>
                <td style={cellStyle}>
                  {s.throughput_per_min === null
                    ? "—"
                    : `${s.throughput_per_min}/min`}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    color:
                      s.error_count_5min > 0
                        ? "var(--danger-text, #ef4444)"
                        : "inherit",
                  }}
                >
                  {s.error_count_5min}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public panel
// ---------------------------------------------------------------------------

export function ResourcesPanel({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const hostQ = useResourcesHost(isAdmin);
  const camerasQ = useResourcesCameras(isAdmin);
  const stagesQ = useResourcesStages(isAdmin);

  // Manual refresh only — every Resources query auto-poll is off. We
  // stamp "last updated" from the host query's resolution, which covers
  // both the initial page-load fetch and each Sync Now refetch.
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (hostQ.dataUpdatedAt) setLastUpdated(new Date(hostQ.dataUpdatedAt));
  }, [hostQ.dataUpdatedAt]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      // Prefix match — refetches host + cameras + stages + processes +
      // timeseries in one shot (all keyed under operations/resources).
      await queryClient.refetchQueries({
        queryKey: ["operations", "resources"],
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span className="text-sm text-dim">
          {lastUpdated
            ? t("resources.lastUpdated", {
                time: lastUpdated.toLocaleTimeString(),
              })
            : t("resources.notSynced")}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={syncNow}
          disabled={syncing || !isAdmin}
          aria-busy={syncing}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <Icon name="refresh" size={14} />
          {syncing ? t("resources.syncing") : t("resources.syncNow")}
        </button>
      </div>
      {hostQ.isLoading && (
        <div className="text-sm text-dim" style={{ padding: 16 }}>
          {t("resources.loading")}
        </div>
      )}
      <ResourceTimeseries isAdmin={isAdmin} />
      <TopProcessesPanel isAdmin={isAdmin} />
      {hostQ.data && <SystemOverviewCard {...hostQ.data} />}
      {camerasQ.data && <CamerasResourceTable {...camerasQ.data} />}
      {stagesQ.data && <StagesBreakdownTable {...stagesQ.data} />}
    </div>
  );
}
