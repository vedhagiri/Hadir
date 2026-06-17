// Storage Analytics — camera-based storage overview with clip counts,
// face crop match rates, and daily growth trends.
//
// Uses the design system's .stat, .card, .table, .pill, .tabs, .filter-bar,
// and .seg classes throughout — no custom CSS beyond inline layout tweaks.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useCameras } from "../cameras/hooks";
import { ClipCleanupDialog } from "./ClipCleanupDialog";
import { DateRangePicker } from "./DateRangePicker";
import { extractApiError } from "../../api/client";
import type { StorageAnalyticsFilters } from "./hooks";
import {
  useAutoDeleteSetting,
  useStorageAnalytics,
  useUpdateAutoDeleteSetting,
} from "./hooks";
import type {
  CameraStorageRow,
  DailyStorageRow,
  StorageWindowMode,
} from "./types";

function todayIso(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

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

function fmtDate(iso: string, today: string, yesterday: string, locale: string): string {
  const d = new Date(iso + "T00:00:00");
  const now = new Date();
  const diff = Math.round((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return today;
  if (diff === 1) return yesterday;
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
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
  const { t } = useTranslation();
  const maxBytes = rows.reduce((m, r) => Math.max(m, r.total_bytes), 1);

  if (rows.length === 0) {
    return <EmptyState message={t("storageAnalytics.emptyCamera")} />;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t("storageAnalytics.col.camera")}</th>
          <th style={{ textAlign: "end" }}>{t("storageAnalytics.col.clips")}</th>
          <th style={{ minWidth: 160 }}>{t("storageAnalytics.col.storageUsed")}</th>
          <th style={{ textAlign: "end" }}>{t("storageAnalytics.col.matched")}</th>
          <th style={{ textAlign: "end" }}>{t("storageAnalytics.col.unmatched")}</th>
          <th style={{ textAlign: "end" }}>{t("storageAnalytics.col.matchRate")}</th>
          <th style={{ textAlign: "end" }}>{t("storageAnalytics.col.avgDuration")}</th>
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
  const { t, i18n } = useTranslation();
  const maxBytes = rows.reduce((m, r) => Math.max(m, r.total_bytes), 1);
  const maxClips = rows.reduce((m, r) => Math.max(m, r.clip_count), 1);
  const sorted = [...rows].reverse();
  const today = t("storageAnalytics.today");
  const yesterday = t("storageAnalytics.yesterday");
  const locale = i18n.language;

  if (sorted.length === 0) {
    return <EmptyState message={t("storageAnalytics.emptyDaily")} />;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t("storageAnalytics.col.date")}</th>
          <th style={{ minWidth: 140 }}>{t("storageAnalytics.col.clips")}</th>
          <th style={{ minWidth: 160 }}>{t("storageAnalytics.col.storageAdded")}</th>
          <th style={{ textAlign: "end" }}>{t("storageAnalytics.col.newCrops")}</th>
          <th style={{ textAlign: "end" }}>{t("storageAnalytics.col.matched")}</th>
          <th style={{ textAlign: "end" }}>{t("storageAnalytics.col.matchRate")}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.date}>
            <td>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{fmtDate(row.date, today, yesterday, locale)}</div>
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

// Window presets shown as a segmented control. "overall" = all-time,
// "range" = custom From/To date pickers; the rest are day lookbacks.
const WINDOW_OPTIONS: { value: StorageWindowMode; labelKey: string }[] = [
  { value: "overall", labelKey: "storageAnalytics.win.overall" },
  { value: "7", labelKey: "storageAnalytics.win.7d" },
  { value: "14", labelKey: "storageAnalytics.win.14d" },
  { value: "30", labelKey: "storageAnalytics.win.30d" },
  { value: "range", labelKey: "storageAnalytics.win.range" },
];

type TabId = "by-camera" | "by-day";

export function StorageAnalyticsPage() {
  const { t, i18n } = useTranslation();
  const [winMode, setWinMode] = useState<StorageWindowMode>("30");
  const [startDate, setStartDate] = useState<string>(daysAgoIso(7));
  const [endDate, setEndDate] = useState<string>(todayIso());
  const [cameraId, setCameraId] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>("by-camera");
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const autoDelete = useAutoDeleteSetting();
  const updateAutoDelete = useUpdateAutoDeleteSetting();
  // Target value awaiting Yes/No confirmation (null = no prompt open).
  const [pendingAutoDelete, setPendingAutoDelete] = useState<boolean | null>(null);

  const autoDeleteOn = autoDelete.data?.auto_delete_clip_after_processing ?? false;

  // Only prompt when the click would actually change the value.
  const requestAutoDelete = (value: boolean) => {
    if (value === autoDeleteOn) return;
    setPendingAutoDelete(value);
  };

  const confirmAutoDelete = () => {
    if (pendingAutoDelete !== null) {
      updateAutoDelete.mutate({ auto_delete_clip_after_processing: pendingAutoDelete });
    }
    setPendingAutoDelete(null);
  };

  const rangeInvalid =
    winMode === "range" && (!startDate || !endDate || startDate > endDate);

  const filters = useMemo<StorageAnalyticsFilters>(() => {
    if (winMode === "range") {
      return { days: 30, camera_id: cameraId, start: startDate, end: endDate };
    }
    if (winMode === "overall") {
      return { days: 0, camera_id: cameraId };
    }
    return { days: Number(winMode), camera_id: cameraId };
  }, [winMode, startDate, endDate, cameraId]);

  const cameras = useCameras();
  const analytics = useStorageAnalytics(filters, { enabled: !rangeInvalid });

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
    { count: ov?.completed_clips ?? 0, color: "var(--success)", label: t("storageAnalytics.proc.completed") },
    { count: ov?.processing_clips ?? 0, color: "var(--warning)", label: t("storageAnalytics.proc.processing") },
    { count: ov?.pending_clips ?? 0, color: "var(--text-quaternary)", label: t("storageAnalytics.proc.pending") },
    { count: ov?.recording_clips ?? 0, color: "var(--danger)", label: t("storageAnalytics.proc.recording") },
    { count: ov?.failed_clips ?? 0, color: "var(--danger-text)", label: t("storageAnalytics.proc.failed") },
  ];

  return (
    <div className="content-wrap">
      {/* ── Page header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("storageAnalytics.title")}</h1>
          <p className="page-sub">
            {t("storageAnalytics.subtitle")}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void analytics.refetch()}
            disabled={analytics.isFetching}
            aria-label={t("storageAnalytics.refreshAria")}
          >
            <Icon name="refresh" size={13} />
            {analytics.isFetching ? t("storageAnalytics.loading") : t("storageAnalytics.refresh")}
          </button>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="filter-bar">
        <div className="filter-group">
          <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>
            {t("storageAnalytics.window")}
          </span>
          <div className="seg" role="group" aria-label={t("storageAnalytics.daysWindowAria")}>
            {WINDOW_OPTIONS.map(({ value, labelKey }) => (
              <button
                key={value}
                type="button"
                className={`seg-btn${winMode === value ? " active" : ""}`}
                onClick={() => setWinMode(value)}
                aria-pressed={winMode === value}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        {winMode === "range" && (
          <div className="filter-group">
            <DateRangePicker
              start={startDate}
              end={endDate}
              maxDate={todayIso()}
              onChange={(s, e) => {
                setStartDate(s);
                setEndDate(e);
              }}
            />
          </div>
        )}

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
            aria-label={t("storageAnalytics.filterByCamera")}
          >
            <option value="">{t("storageAnalytics.allCameras")}</option>
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
            {t("storageAnalytics.failed")}
          </span>
        )}
        {analytics.isFetching && !analytics.isError && (
          <span className="pill pill-neutral">{t("storageAnalytics.loading")}</span>
        )}
        {analytics.data && !analytics.isFetching && (
          <span className="pill pill-neutral" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
            {winMode === "overall"
              ? t("storageAnalytics.win.overall")
              : winMode === "range"
                ? `${new Date(startDate + "T00:00:00").toLocaleDateString(i18n.language, { month: "short", day: "numeric" })} – ${new Date(endDate + "T00:00:00").toLocaleDateString(i18n.language, { month: "short", day: "numeric" })}`
                : t("storageAnalytics.daysWindow", { days: Number(winMode) })}
            {cameraId !== null ? ` · ${t("storageAnalytics.oneCamera")}` : ""}
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
          <div className="stat-label">{t("storageAnalytics.stat.totalClips")}</div>
          <div className="stat-value">
            {ov ? ov.total_clips.toLocaleString() : "—"}
          </div>
          <div className="stat-delta delta-flat">
            {ov ? t("storageAnalytics.stat.avgDuration", { duration: fmtDuration(ov.avg_clip_duration_sec) }) : ""}
          </div>
        </div>

        {/* Storage used */}
        <div className="stat">
          <div className="stat-label">{t("storageAnalytics.stat.storageUsed")}</div>
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
            {avgBytesPerClip > 0 ? t("storageAnalytics.stat.perClip", { size: fmtBytes(avgBytesPerClip) }) : ""}
          </div>
        </div>

        {/* Face crops */}
        <div className="stat">
          <div className="stat-label">{t("storageAnalytics.stat.faceCrops")}</div>
          <div className="stat-value">
            {ov ? ov.total_face_crops.toLocaleString() : "—"}
          </div>
          <div className="stat-delta delta-flat">
            {ov
              ? t("storageAnalytics.stat.matchedCount", { count: ov.matched_face_crops })
              : ""}
          </div>
        </div>

        {/* Unmatched */}
        <div className="stat">
          <div className="stat-label">{t("storageAnalytics.stat.unmatched")}</div>
          <div
            className="stat-value"
            style={{ color: ov && ov.unmatched_face_crops > 0 ? "var(--danger-text)" : undefined }}
          >
            {ov ? ov.unmatched_face_crops.toLocaleString() : "—"}
          </div>
          <div className="stat-delta delta-flat">
            {ov && ov.total_face_crops > 0
              ? t("storageAnalytics.stat.pctOfCrops", { pct: pct(ov.unmatched_face_crops, ov.total_face_crops) })
              : ""}
          </div>
        </div>

        {/* Match rate + donut */}
        <div className="stat" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="stat-label">{t("storageAnalytics.stat.matchRate")}</div>
            <div
              className="stat-value"
              style={{ color: ov && ov.total_face_crops > 0 ? matchColor : undefined }}
            >
              {ov && ov.total_face_crops > 0 ? `${matchRate}%` : "—"}
            </div>
            <div className="stat-delta delta-flat">
              {ov && ov.total_face_crops > 0
                ? `${ov.matched_face_crops.toLocaleString()} / ${ov.total_face_crops.toLocaleString()}`
                : t("storageAnalytics.stat.noCropsYet")}
            </div>
          </div>
          {ov && ov.total_face_crops > 0 && (
            <DonutRing pctValue={matchRate} color={matchColor} size={60} />
          )}
        </div>
      </div>

      {/* ── Clip cleanup launcher (Admin-only; the route already gates this page) ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 14px",
          marginBottom: 16,
          borderRadius: 10,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 7 }}>
            <Icon name="trash" size={15} style={{ color: "var(--text-tertiary)" }} />
            {t("clipCleanup.title")}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 3 }}>
            {t("clipCleanup.subtitle")}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0, flexWrap: "wrap" }}>
          {/* Auto-delete after processing — On/Off, outside the popup */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ textAlign: "end" }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>
                {t("clipCleanup.autoDeleteTitle")}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>
                {t("clipCleanup.autoDeleteHint")}
              </div>
            </div>
            <div className="seg" role="group" aria-label={t("clipCleanup.autoDeleteAria")}>
              <button
                type="button"
                className={`seg-btn${!autoDeleteOn ? " active" : ""}`}
                onClick={() => requestAutoDelete(false)}
                aria-pressed={!autoDeleteOn}
                disabled={updateAutoDelete.isPending || autoDelete.isLoading}
              >
                {t("clipCleanup.autoDeleteOff")}
              </button>
              <button
                type="button"
                className={`seg-btn${autoDeleteOn ? " active" : ""}`}
                onClick={() => requestAutoDelete(true)}
                aria-pressed={autoDeleteOn}
                disabled={updateAutoDelete.isPending || autoDelete.isLoading}
              >
                {t("clipCleanup.autoDeleteOn")}
              </button>
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setCleanupOpen(true)}
            aria-label={t("clipCleanup.openAria")}
          >
            <Icon name="trash" size={13} />
            {t("clipCleanup.open")}
          </button>
        </div>
      </div>

      {updateAutoDelete.isError && (
        <div role="alert" style={{ fontSize: 11.5, color: "var(--danger-text)", margin: "-8px 2px 12px" }}>
          {extractApiError(updateAutoDelete.error, t("clipCleanup.couldNotSave"))}
        </div>
      )}

      {cleanupOpen && <ClipCleanupDialog onClose={() => setCleanupOpen(false)} />}

      {pendingAutoDelete !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("clipCleanup.autoDeleteTitle")}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 110,
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingAutoDelete(null);
          }}
        >
          <div className="card" style={{ width: "min(420px, 100%)", margin: 0 }}>
            <div className="card-head">
              <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="trash" size={15} />
                {t("clipCleanup.autoDeleteTitle")}
              </div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                {pendingAutoDelete
                  ? t("clipCleanup.autoDeleteConfirmOn")
                  : t("clipCleanup.autoDeleteConfirmOff")}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn btn-sm" onClick={() => setPendingAutoDelete(null)}>
                  {t("common.no")}
                </button>
                <button type="button" className="btn btn-primary" onClick={confirmAutoDelete}>
                  {t("common.yes")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Processing status card ── */}
      {ov && ov.total_clips > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <div className="card-title">{t("storageAnalytics.processingStatus")}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {ov.completed_clips > 0 && (
                <span className="pill pill-success">
                  <span className="pill-dot" />
                  {t("storageAnalytics.pill.completed", { count: ov.completed_clips })}
                </span>
              )}
              {ov.processing_clips > 0 && (
                <span className="pill pill-warning">
                  <span className="pill-dot" />
                  {t("storageAnalytics.pill.processing", { count: ov.processing_clips })}
                </span>
              )}
              {ov.pending_clips > 0 && (
                <span className="pill pill-neutral">
                  {t("storageAnalytics.pill.pending", { count: ov.pending_clips })}
                </span>
              )}
              {ov.recording_clips > 0 && (
                <span className="pill pill-danger">
                  <span className="pill-dot" />
                  {t("storageAnalytics.pill.recording", { count: ov.recording_clips })}
                </span>
              )}
              {ov.failed_clips > 0 && (
                <span className="pill pill-danger">
                  {t("storageAnalytics.pill.failed", { count: ov.failed_clips })}
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

      {/* ── Tabs ── */}
      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === "by-camera" ? " active" : ""}`}
          onClick={() => setTab("by-camera")}
          aria-pressed={tab === "by-camera"}
        >
          {t("storageAnalytics.tab.byCamera")}
          {analytics.data ? ` (${analytics.data.by_camera.length})` : ""}
        </button>
        <button
          type="button"
          className={`tab${tab === "by-day" ? " active" : ""}`}
          onClick={() => setTab("by-day")}
          aria-pressed={tab === "by-day"}
        >
          {t("storageAnalytics.tab.byDay")}
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
            {t("storageAnalytics.loadingAnalytics")}
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
