// Storage Analytics — camera-based storage overview with clip counts,
// face crop match rates, and daily growth trends.
//
// Uses the design system's .stat, .card, .table, .pill, .tabs, .filter-bar,
// and .seg classes throughout — no custom CSS beyond inline layout tweaks.

import { useState } from "react";

import { Icon } from "../../shell/Icon";
import { useCameras } from "../cameras/hooks";
import { ClipCleanupCard } from "./ClipCleanupCard";
import { useStorageAnalytics } from "./hooks";
import type { CameraStorageRow, DailyStorageRow, DaysWindow } from "./types";

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtBytesCompact(bytes: number): { value: string; unit: string } {
  if (bytes < 1024) return { value: String(bytes), unit: "B" };
  if (bytes < 1024 * 1024) return { value: (bytes / 1024).toFixed(1), unit: "KB" };
  if (bytes < 1024 * 1024 * 1024)
    return { value: (bytes / (1024 * 1024)).toFixed(1), unit: "MB" };
  return { value: (bytes / (1024 * 1024 * 1024)).toFixed(2), unit: "GB" };
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function pct(num: number, total: number): number {
  return total === 0 ? 0 : Math.round((num / total) * 100);
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const now = new Date();
  const diff = Math.round((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── SVG donut ring ────────────────────────────────────────────────────────────

function DonutRing({
  pctValue,
  color,
  size = 64,
}: {
  pctValue: number;
  color: string;
  size?: number;
}) {
  const r = 22;
  const cx = size / 2;
  const circ = 2 * Math.PI * r;
  const dash = Math.min((pctValue / 100) * circ, circ);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--bg-sunken)" strokeWidth="6" />
      <circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: "stroke-dasharray 0.5s ease" }}
      />
    </svg>
  );
}

// ── Mini progress bar ─────────────────────────────────────────────────────────

function MiniBar({ value, max, color = "var(--accent)" }: { value: number; max: number; color?: string }) {
  const w = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      style={{
        height: 4,
        borderRadius: 2,
        background: "var(--border)",
        marginTop: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${w}%`,
          background: color,
          borderRadius: 2,
          transition: "width 0.4s ease",
        }}
      />
    </div>
  );
}

// ── Match rate pill ───────────────────────────────────────────────────────────

function MatchPill({ matched, total }: { matched: number; total: number }) {
  const p = pct(matched, total);
  const cls =
    p >= 70 ? "pill pill-success" : p >= 40 ? "pill pill-warning" : "pill pill-danger";
  return (
    <span className={cls}>
      <span className="pill-dot" />
      {total === 0 ? "—" : `${p}%`}
    </span>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "48px 24px",
        textAlign: "center",
        color: "var(--text-tertiary)",
        fontSize: 13,
      }}
    >
      <Icon name="database" size={28} style={{ opacity: 0.3, marginBottom: 10, display: "block", margin: "0 auto 10px" }} />
      {message}
    </div>
  );
}

// ── By Camera table ───────────────────────────────────────────────────────────

function CameraTable({ rows }: { rows: CameraStorageRow[] }) {
  const maxBytes = rows.reduce((m, r) => Math.max(m, r.total_bytes), 1);

  if (rows.length === 0) {
    return <EmptyState message="No camera data for this period." />;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Camera</th>
          <th style={{ textAlign: "end" }}>Clips</th>
          <th style={{ minWidth: 160 }}>Storage Used</th>
          <th style={{ textAlign: "end" }}>Matched</th>
          <th style={{ textAlign: "end" }}>Unmatched</th>
          <th style={{ textAlign: "end" }}>Match Rate</th>
          <th style={{ textAlign: "end" }}>Avg Duration</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.camera_id}>
            <td>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{row.camera_name}</div>
            </td>
            <td style={{ textAlign: "end", fontVariantNumeric: "tabular-nums" }}>
              {row.clip_count.toLocaleString()}
            </td>
            <td>
              <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>
                {fmtBytes(row.total_bytes)}
              </div>
              <MiniBar value={row.total_bytes} max={maxBytes} />
            </td>
            <td style={{ textAlign: "end", color: "var(--success-text)", fontVariantNumeric: "tabular-nums" }}>
              {row.matched_crops.toLocaleString()}
            </td>
            <td style={{ textAlign: "end", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
              {row.unmatched_crops.toLocaleString()}
            </td>
            <td style={{ textAlign: "end" }}>
              <MatchPill matched={row.matched_crops} total={row.matched_crops + row.unmatched_crops} />
            </td>
            <td style={{ textAlign: "end", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
              {fmtDuration(row.avg_clip_duration_sec)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── By Day table ──────────────────────────────────────────────────────────────

function DailyTable({ rows }: { rows: DailyStorageRow[] }) {
  const maxBytes = rows.reduce((m, r) => Math.max(m, r.total_bytes), 1);
  const maxClips = rows.reduce((m, r) => Math.max(m, r.clip_count), 1);
  const sorted = [...rows].reverse();

  if (sorted.length === 0) {
    return <EmptyState message="No daily data for this period." />;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Date</th>
          <th style={{ minWidth: 140 }}>Clips</th>
          <th style={{ minWidth: 160 }}>Storage Added</th>
          <th style={{ textAlign: "end" }}>New Crops</th>
          <th style={{ textAlign: "end" }}>Matched</th>
          <th style={{ textAlign: "end" }}>Match Rate</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.date}>
            <td>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{fmtDate(row.date)}</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
                {row.date}
              </div>
            </td>
            <td>
              <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>
                {row.clip_count.toLocaleString()}
              </div>
              <MiniBar value={row.clip_count} max={maxClips} />
            </td>
            <td>
              <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>
                {fmtBytes(row.total_bytes)}
              </div>
              <MiniBar value={row.total_bytes} max={maxBytes} color="var(--info-text)" />
            </td>
            <td style={{ textAlign: "end", fontVariantNumeric: "tabular-nums" }}>
              {row.new_crops.toLocaleString()}
            </td>
            <td style={{ textAlign: "end", color: "var(--success-text)", fontVariantNumeric: "tabular-nums" }}>
              {row.matched_crops.toLocaleString()}
            </td>
            <td style={{ textAlign: "end" }}>
              <MatchPill matched={row.matched_crops} total={row.new_crops} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Stacked processing bar ────────────────────────────────────────────────────

type BarSegment = { count: number; color: string; label: string };

function ProcessingBar({ segments, total }: { segments: BarSegment[]; total: number }) {
  if (total === 0) return null;
  return (
    <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 1 }}>
      {segments.map(({ count, color, label }) =>
        count > 0 ? (
          <div
            key={label}
            title={`${label}: ${count.toLocaleString()}`}
            style={{
              flex: count,
              background: color,
              transition: "flex 0.4s ease",
            }}
          />
        ) : null,
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const DAYS_OPTIONS: { value: DaysWindow; label: string }[] = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
  { value: 365, label: "1y" },
];

type TabId = "by-camera" | "by-day";

export function StorageAnalyticsPage() {
  const [days, setDays] = useState<DaysWindow>(30);
  const [cameraId, setCameraId] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>("by-camera");

  const cameras = useCameras();
  const analytics = useStorageAnalytics({ days, camera_id: cameraId });

  const ov = analytics.data?.overview;
  const matchRate = ov ? pct(ov.matched_face_crops, ov.total_face_crops) : 0;
  const matchColor =
    matchRate >= 70
      ? "var(--success)"
      : matchRate >= 40
        ? "var(--warning)"
        : "var(--danger)";

  const totalClipsCompact = ov ? fmtBytesCompact(ov.total_bytes) : null;
  const avgBytesPerClip =
    ov && ov.total_clips > 0 ? Math.round(ov.total_bytes / ov.total_clips) : 0;

  const processingSegments: BarSegment[] = [
    { count: ov?.completed_clips ?? 0, color: "var(--success)", label: "Completed" },
    { count: ov?.processing_clips ?? 0, color: "var(--warning)", label: "Processing" },
    { count: ov?.pending_clips ?? 0, color: "var(--text-quaternary)", label: "Pending" },
    { count: ov?.recording_clips ?? 0, color: "var(--danger)", label: "Recording" },
    { count: ov?.failed_clips ?? 0, color: "var(--danger-text)", label: "Failed" },
  ];

  return (
    <div className="content-wrap">
      {/* ── Page header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Storage Analytics</h1>
          <p className="page-sub">
            Clip counts, face crops, match rates and storage breakdown
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void analytics.refetch()}
            disabled={analytics.isFetching}
            aria-label="Refresh analytics"
          >
            <Icon name="refresh" size={13} />
            {analytics.isFetching ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="filter-bar">
        <div className="filter-group">
          <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>
            Window
          </span>
          <div className="seg" role="group" aria-label="Days window">
            {DAYS_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`seg-btn${days === value ? " active" : ""}`}
                onClick={() => setDays(value)}
                aria-pressed={days === value}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <Icon name="camera" size={13} style={{ color: "var(--text-tertiary)" }} />
          <select
            value={cameraId ?? ""}
            onChange={(e) =>
              setCameraId(e.target.value === "" ? null : Number(e.target.value))
            }
            style={{
              fontSize: 12.5,
              padding: "3px 8px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-elev)",
              color: "var(--text)",
            }}
            aria-label="Filter by camera"
          >
            <option value="">All cameras</option>
            {cameras.data?.items.map((cam) => (
              <option key={cam.id} value={cam.id}>
                {cam.name}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-spacer" />

        {analytics.isError && (
          <span className="pill pill-danger">
            <span className="pill-dot" />
            Failed to load
          </span>
        )}
        {analytics.isFetching && !analytics.isError && (
          <span className="pill pill-neutral">Loading…</span>
        )}
        {analytics.data && !analytics.isFetching && (
          <span className="pill pill-neutral" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
            {days}d window
            {cameraId !== null ? " · 1 camera" : ""}
          </span>
        )}
      </div>

      {/* ── Stat cards ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
          marginBottom: 12,
        }}
      >
        {/* Total clips */}
        <div className="stat">
          <div className="stat-label">Total Clips</div>
          <div className="stat-value">
            {ov ? ov.total_clips.toLocaleString() : "—"}
          </div>
          <div className="stat-delta delta-flat">
            {ov ? `avg ${fmtDuration(ov.avg_clip_duration_sec)}` : ""}
          </div>
        </div>

        {/* Storage used */}
        <div className="stat">
          <div className="stat-label">Storage Used</div>
          <div className="stat-value" style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
            {totalClipsCompact ? (
              <>
                {totalClipsCompact.value}
                <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-secondary)" }}>
                  {totalClipsCompact.unit}
                </span>
              </>
            ) : (
              "—"
            )}
          </div>
          <div className="stat-delta delta-flat">
            {avgBytesPerClip > 0 ? `${fmtBytes(avgBytesPerClip)} / clip` : ""}
          </div>
        </div>

        {/* Face crops */}
        <div className="stat">
          <div className="stat-label">Face Crops</div>
          <div className="stat-value">
            {ov ? ov.total_face_crops.toLocaleString() : "—"}
          </div>
          <div className="stat-delta delta-flat">
            {ov
              ? `${ov.matched_face_crops.toLocaleString()} matched`
              : ""}
          </div>
        </div>

        {/* Unmatched */}
        <div className="stat">
          <div className="stat-label">Unmatched</div>
          <div
            className="stat-value"
            style={{ color: ov && ov.unmatched_face_crops > 0 ? "var(--danger-text)" : undefined }}
          >
            {ov ? ov.unmatched_face_crops.toLocaleString() : "—"}
          </div>
          <div className="stat-delta delta-flat">
            {ov && ov.total_face_crops > 0
              ? `${pct(ov.unmatched_face_crops, ov.total_face_crops)}% of crops`
              : ""}
          </div>
        </div>

        {/* Match rate + donut */}
        <div className="stat" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="stat-label">Match Rate</div>
            <div
              className="stat-value"
              style={{ color: ov && ov.total_face_crops > 0 ? matchColor : undefined }}
            >
              {ov && ov.total_face_crops > 0 ? `${matchRate}%` : "—"}
            </div>
            <div className="stat-delta delta-flat">
              {ov && ov.total_face_crops > 0
                ? `${ov.matched_face_crops.toLocaleString()} / ${ov.total_face_crops.toLocaleString()}`
                : "no crops yet"}
            </div>
          </div>
          {ov && ov.total_face_crops > 0 && (
            <DonutRing pctValue={matchRate} color={matchColor} size={60} />
          )}
        </div>
      </div>

      {/* ── Clip cleanup (Admin-only; the route already gates this page) ── */}
      <ClipCleanupCard />

      {/* ── Processing status card ── */}
      {ov && ov.total_clips > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div className="card-title">Processing Status</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {ov.completed_clips > 0 && (
                <span className="pill pill-success">
                  <span className="pill-dot" />
                  {ov.completed_clips.toLocaleString()} completed
                </span>
              )}
              {ov.processing_clips > 0 && (
                <span className="pill pill-warning">
                  <span className="pill-dot" />
                  {ov.processing_clips.toLocaleString()} processing
                </span>
              )}
              {ov.pending_clips > 0 && (
                <span className="pill pill-neutral">
                  {ov.pending_clips.toLocaleString()} pending
                </span>
              )}
              {ov.recording_clips > 0 && (
                <span className="pill pill-danger">
                  <span className="pill-dot" />
                  {ov.recording_clips.toLocaleString()} recording
                </span>
              )}
              {ov.failed_clips > 0 && (
                <span className="pill pill-danger">
                  {ov.failed_clips.toLocaleString()} failed
                </span>
              )}
            </div>
          </div>
          <div className="card-body" style={{ paddingTop: 10, paddingBottom: 10 }}>
            <ProcessingBar segments={processingSegments} total={ov.total_clips} />
            <div
              style={{
                display: "flex",
                gap: 16,
                marginTop: 10,
                flexWrap: "wrap",
              }}
            >
              {processingSegments
                .filter((s) => s.count > 0)
                .map((s) => (
                  <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div
                      style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {s.label}{" "}
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>
                        {pct(s.count, ov.total_clips)}%
                      </span>
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Storage by camera overview (mini bars card) ── */}
      {analytics.data && analytics.data.by_camera.length > 0 && tab === "by-camera" && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Storage by Camera</div>
              <div className="card-sub">{analytics.data.by_camera.length} camera{analytics.data.by_camera.length !== 1 ? "s" : ""}</div>
            </div>
          </div>
          <div className="card-body">
            {(() => {
              const maxB = Math.max(...analytics.data!.by_camera.map((r) => r.total_bytes), 1);
              return analytics.data!.by_camera.map((row) => (
                <div key={row.camera_id} style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      marginBottom: 3,
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.camera_name}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-tertiary)", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>
                      {fmtBytes(row.total_bytes)} · {row.clip_count.toLocaleString()} clips
                    </span>
                  </div>
                  <MiniBar value={row.total_bytes} max={maxB} color="var(--accent)" />
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === "by-camera" ? " active" : ""}`}
          onClick={() => setTab("by-camera")}
          aria-pressed={tab === "by-camera"}
        >
          By Camera
          {analytics.data ? ` (${analytics.data.by_camera.length})` : ""}
        </button>
        <button
          type="button"
          className={`tab${tab === "by-day" ? " active" : ""}`}
          onClick={() => setTab("by-day")}
          aria-pressed={tab === "by-day"}
        >
          By Day
          {analytics.data ? ` (${analytics.data.daily.length})` : ""}
        </button>
      </div>

      {/* ── Table card ── */}
      <div className="card" style={{ overflow: "hidden" }}>
        {analytics.isLoading && (
          <div
            style={{
              padding: "40px 24px",
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
            }}
          >
            Loading analytics…
          </div>
        )}
        {!analytics.isLoading && tab === "by-camera" && (
          <CameraTable rows={analytics.data?.by_camera ?? []} />
        )}
        {!analytics.isLoading && tab === "by-day" && (
          <DailyTable rows={analytics.data?.daily ?? []} />
        )}
      </div>
    </div>
  );
}
