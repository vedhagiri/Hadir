import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { DrawerShell, ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import {
  useBulkDeletePersonClips,
  useCameraOptions,
  useClipFaceCrops,
  useClipProcessingResults,
  useDeletePersonClip,
  usePersonClipStats,
  usePersonClips,
  useReprocessFaceMatch,
  useReprocessStatus,
  useSingleClipReprocess,
  useSystemStats,
} from "./hooks";
import type {
  ClipMatchedStatusFilter,
  ClipProcessingResult,
  ClipQueueStats,
  FaceCropListResponse,
  PersonClipFilters,
  PersonClipOut,
  PersonClipStats,
  PipelineStats,
  ReprocessFaceMatchStatus,
  StorageStats,
  SystemResourceStats,
} from "./types";

const PAGE_SIZE = 24;

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function personCountColor(count: number): string {
  if (count >= 3) return "var(--danger-text, #e53935)";
  if (count >= 2) return "var(--accent, #f59e0b)";
  return "var(--text-secondary, #888)";
}

// ── Shared style helpers ─────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
};

// Migration 0055 — headline summary band shown at the top of the
// Person Clips page. Four stat tiles in a responsive grid: total
// clips, total storage, live-now count (animated red when > 0),
// and the number of cameras that have produced clips. Designed to
// give the operator a "command center" at-a-glance read without
// scrolling.
function ClipSummaryBand({
  stats,
  liveCount,
  hasActiveFilters,
  liveActive,
  onResetAll,
  onToggleLive,
}: {
  stats: PersonClipStats | null;
  liveCount: number;
  hasActiveFilters: boolean;
  liveActive: boolean;
  onResetAll: () => void;
  onToggleLive: () => void;
}) {
  const { t } = useTranslation();
  const totalClips = stats?.total_clips ?? 0;
  const totalBytes = stats?.total_size_bytes ?? 0;
  const cameraCount = stats?.per_camera?.length ?? 0;
  const isLive = liveCount > 0;

  const tile: React.CSSProperties = {
    background: "var(--bg-elev)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "14px 16px",
    display: "flex",
    alignItems: "center",
    gap: 14,
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    minHeight: 76,
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
  };

  // Tiles that drive filters render as buttons so they're
  // keyboard-accessible. ``activeBorder`` highlights the tile when
  // its corresponding filter is the active list query.
  const interactiveTile = (
    extra: React.CSSProperties,
    isActiveTile: boolean,
  ): React.CSSProperties => ({
    ...tile,
    ...extra,
    cursor: "pointer",
    border: isActiveTile
      ? "1px solid var(--accent, #0b6e4f)"
      : (extra.border ?? tile.border),
    boxShadow: isActiveTile
      ? "0 0 0 2px var(--accent-soft, rgba(11, 110, 79, 0.18))"
      : tile.boxShadow,
    fontFamily: "var(--font-sans)",
    textAlign: "start",
  });

  const iconWrap: React.CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: 10,
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
  };

  const bigNumber: React.CSSProperties = {
    fontSize: 26,
    fontWeight: 700,
    lineHeight: 1.05,
    color: "var(--text)",
    fontFamily: "var(--font-sans)",
    letterSpacing: "-0.02em",
  };

  const subLabel: React.CSSProperties = {
    fontSize: 11,
    color: "var(--text-secondary)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginTop: 3,
    fontWeight: 500,
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: 12,
        marginBottom: 14,
      }}
    >
      {/* Total clips — click clears every active filter (back to all). */}
      <button
        type="button"
        onClick={onResetAll}
        aria-pressed={!hasActiveFilters}
        aria-label={t("personClips.summary.showAll") as string}
        title={t("personClips.summary.showAll") as string}
        style={interactiveTile({}, !hasActiveFilters)}
      >
        <div
          style={{
            ...iconWrap,
            background: "var(--accent-soft, rgba(11, 110, 79, 0.10))",
            color: "var(--accent, #0b6e4f)",
          }}
        >
          <Icon name="videocam" size={22} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={bigNumber}>{totalClips.toLocaleString()}</div>
          <div style={subLabel}>
            {t("personClips.summary.totalClips")}
          </div>
        </div>
      </button>

      {/* Storage used — informational; click also clears filters. */}
      <button
        type="button"
        onClick={onResetAll}
        aria-label={t("personClips.summary.showAll") as string}
        title={t("personClips.summary.showAll") as string}
        style={interactiveTile({}, false)}
      >
        <div
          style={{
            ...iconWrap,
            background: "rgba(99, 102, 241, 0.12)",
            color: "rgb(99, 102, 241)",
          }}
        >
          <Icon name="database" size={22} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={bigNumber}>{fmtFileSize(totalBytes)}</div>
          <div style={subLabel}>
            {t("personClips.summary.storage")}
          </div>
        </div>
      </button>

      {/* Live recording right now — click filters to recording rows. */}
      <button
        type="button"
        onClick={onToggleLive}
        aria-pressed={liveActive}
        aria-label={
          liveActive
            ? (t("personClips.summary.clearLiveFilter") as string)
            : (t("personClips.summary.showLiveOnly") as string)
        }
        title={
          liveActive
            ? (t("personClips.summary.clearLiveFilter") as string)
            : (t("personClips.summary.showLiveOnly") as string)
        }
        style={interactiveTile(
          {
            background: isLive
              ? "linear-gradient(135deg, rgba(220,38,38,0.06), var(--bg-elev))"
              : tile.background,
            border: isLive
              ? "1px solid rgba(220,38,38,0.35)"
              : "1px solid var(--border)",
          },
          liveActive,
        )}
      >
        <div
          style={{
            ...iconWrap,
            background: isLive
              ? "rgba(220,38,38,0.15)"
              : "rgba(148,163,184,0.12)",
            color: isLive ? "rgb(220,38,38)" : "var(--text-secondary)",
          }}
        >
          {isLive ? (
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "rgb(220,38,38)",
                animation: "maugood-live-pulse 1.4s ease-in-out infinite",
              }}
              aria-hidden
            />
          ) : (
            <Icon name="pause" size={22} />
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              ...bigNumber,
              color: isLive ? "rgb(220,38,38)" : "var(--text)",
            }}
          >
            {liveCount}
          </div>
          <div style={subLabel}>
            {t("personClips.summary.liveNow")}
          </div>
        </div>
      </button>

      {/* Active cameras — click clears filters. */}
      <button
        type="button"
        onClick={onResetAll}
        aria-label={t("personClips.summary.showAll") as string}
        title={t("personClips.summary.showAll") as string}
        style={interactiveTile({}, false)}
      >
        <div
          style={{
            ...iconWrap,
            background: "rgba(234, 179, 8, 0.12)",
            color: "rgb(202, 138, 4)",
          }}
        >
          <Icon name="camera" size={22} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={bigNumber}>{cameraCount}</div>
          <div style={subLabel}>
            {t("personClips.summary.cameras")}
          </div>
        </div>
      </button>
    </div>
  );
}

// Phase C — segmented control for the clip detection-source filter
// (migration 0052). "all" omits the query param so legacy face-mode
// clips still appear; the others map directly to the backend filter.
function SourceFilter({
  value,
  onChange,
}: {
  value: "all" | "face" | "body" | "both";
  onChange: (v: "all" | "face" | "body" | "both") => void;
}) {
  const { t } = useTranslation();
  const options: Array<{
    key: "all" | "face" | "body" | "both";
    label: string;
  }> = [
    { key: "all", label: t("personClips.source.all") },
    { key: "face", label: t("personClips.source.face") },
    { key: "body", label: t("personClips.source.body") },
    { key: "both", label: t("personClips.source.both") },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t("personClips.source.label") as string}
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        background: "var(--bg-elev)",
      }}
    >
      {options.map((o, idx) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          style={{
            padding: "6px 10px",
            fontSize: 12,
            border: "none",
            borderInlineStart:
              idx === 0 ? "none" : "1px solid var(--border)",
            background:
              value === o.key ? "var(--bg-active, var(--accent-soft))" : "transparent",
            color:
              value === o.key
                ? "var(--text)"
                : "var(--text-secondary)",
            fontWeight: value === o.key ? 600 : 400,
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Phase C — small chip badge that surfaces ``detection_source`` on
// each clip card. Plain text + a coloured dot is enough; we don't
// want a third icon set in the design system.
function SourceBadge({
  source,
  chunkCount,
}: {
  source: "face" | "body" | "both";
  chunkCount: number;
}) {
  const { t } = useTranslation();
  const colour =
    source === "face"
      ? "var(--accent)"
      : source === "body"
        ? "var(--info-text, #2563eb)"
        : "var(--warning-text, #b45309)";
  const label =
    source === "face"
      ? t("personClips.source.face")
      : source === "body"
        ? t("personClips.source.body")
        : t("personClips.source.both");
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        padding: "2px 6px",
        borderRadius: 10,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        color: "var(--text-secondary)",
      }}
      title={String(label)}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: colour,
        }}
      />
      {label}
      {chunkCount > 1 && (
        <span
          className="mono"
          style={{ marginInlineStart: 4, color: "var(--text-tertiary)" }}
        >
          ×{chunkCount}
        </span>
      )}
    </span>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

type Tab = "clips" | "pipeline" | "system" | "comparison";

export function PersonClipsPage() {
  const { t } = useTranslation();
  useEffect(() => {
    ensureLiveStyleInjected();
  }, []);
  const [activeTab, setActiveTab] = useState<Tab>("clips");
  const [filters, setFilters] = useState<PersonClipFilters>({
    camera_id: null,
    employee_id: null,
    start: null,
    end: null,
    detection_source: "all",
    matched_status: null,
    recording_status: null,
    page: 1,
    page_size: PAGE_SIZE,
  });
  const [deleteTarget, setDeleteTarget] = useState<PersonClipOut | null>(null);
  const [bulkDeleteTarget, setBulkDeleteTarget] = useState<PersonClipOut[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [reprocessDialog, setReprocessDialog] = useState(false);
  const [selectedClip, setSelectedClip] = useState<PersonClipOut | null>(null);
  // Migration 0054 — MJPEG live-preview modal for in-progress clips.
  const [liveClip, setLiveClip] = useState<PersonClipOut | null>(null);

  const cameras = useCameraOptions();
  const list = usePersonClips(filters);
  const stats = usePersonClipStats();
  const systemStats = useSystemStats();
  const del = useDeletePersonClip();
  const bulkDel = useBulkDeletePersonClips();
  const reprocess = useReprocessFaceMatch();
  const reprocessStatus = useReprocessStatus();

  const isReprocessing =
    reprocessStatus.data?.status === "running" ||
    reprocessStatus.data?.status === "starting";
  const reprocessData = reprocessStatus.data;
  const totalPages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  const updateFilters = (patch: Partial<PersonClipFilters>) => {
    setSelectedIds(new Set());
    setFilters((prev) => ({ ...prev, page: 1, ...patch }));
  };

  const handlePageChange = (page: number) => {
    setSelectedIds(new Set());
    setFilters((prev) => ({ ...prev, page }));
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!list.data) return;
    setSelectedIds(new Set(list.data.items.map((c) => c.id)));
  };

  const deselectAll = () => setSelectedIds(new Set());

  const selectedClips = list.data
    ? list.data.items.filter((c) => selectedIds.has(c.id))
    : [];

  return (
    <>
      {/* ── Page header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("personClips.title")}</h1>
          <p className="page-sub">{t("personClips.headerSub")}</p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setReprocessDialog(true)}
          disabled={isReprocessing}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
          aria-label={t("personClips.reprocessBtn")}
        >
          <Icon name="refresh" size={12} />
          {isReprocessing ? t("personClips.reprocessRunning") : t("personClips.reprocessBtn")}
        </button>
      </div>

      {/* ── Headline summary band (clips count + storage + live + cams) ──
          Tiles are clickable filters: Total/Storage/Cameras clear all
          active filters; Live Now toggles a recording_status=recording
          filter on the list query. */}
      <ClipSummaryBand
        stats={stats.data ?? null}
        liveCount={
          list.data?.items.filter(
            (c) =>
              c.recording_status === "recording" ||
              c.recording_status === "finalizing",
          ).length ?? 0
        }
        hasActiveFilters={
          filters.camera_id !== null ||
          filters.employee_id !== null ||
          filters.start !== null ||
          filters.end !== null ||
          filters.detection_source !== "all" ||
          filters.matched_status !== null ||
          filters.recording_status !== null
        }
        liveActive={filters.recording_status === "recording"}
        onResetAll={() =>
          updateFilters({
            camera_id: null,
            employee_id: null,
            start: null,
            end: null,
            detection_source: "all",
            matched_status: null,
            recording_status: null,
          })
        }
        onToggleLive={() =>
          updateFilters({
            recording_status:
              filters.recording_status === "recording" ? null : "recording",
          })
        }
      />

      {/* ── Pipeline (face-match) progress pills ──
          Each pill is a clickable filter mapped to ``matched_status``.
          Clicking the active pill again clears the filter. */}
      {stats.data && (
        <PipelineStatsBar
          stats={stats.data}
          active={filters.matched_status}
          onSelect={(next) => updateFilters({ matched_status: next })}
        />
      )}

      {/* ── Reprocess progress ── */}
      {reprocessData &&
        (isReprocessing ||
          reprocessData.status === "completed" ||
          reprocessData.status === "failed" ||
          reprocessData.status === "cancelled") && (
          <ReprocessStatusBar data={reprocessData} />
        )}

      {/* ── Tab navigation ── */}
      <div
        style={{
          display: "flex",
          gap: 2,
          marginBottom: 12,
          borderBottom: "1px solid var(--border)",
          paddingBottom: 0,
        }}
        role="tablist"
        aria-label="Person Clips sections"
      >
        {(["clips", "pipeline", "system", "comparison"] as Tab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: activeTab === tab ? 600 : 400,
              color: activeTab === tab ? "var(--text)" : "var(--text-secondary)",
              background: "none",
              border: "none",
              borderBottom: activeTab === tab ? "2px solid var(--text)" : "2px solid transparent",
              cursor: "pointer",
              marginBottom: -1,
              transition: "color 0.15s, border-color 0.15s",
              fontFamily: "var(--font-sans)",
            }}
          >
            {tab === "clips" && t("personClips.tabClips")}
            {tab === "pipeline" && t("personClips.tabPipeline")}
            {tab === "system" && t("personClips.tabSystem")}
            {tab === "comparison" && t("personClips.tabComparison")}
          </button>
        ))}
      </div>

      {/* ── Clips tab ── */}
      {activeTab === "clips" && (
        <ClipsTab
          filters={filters}
          list={list}
          cameras={cameras}
          selectedIds={selectedIds}
          selectedClips={selectedClips}
          totalPages={totalPages}
          onUpdateFilters={updateFilters}
          onPageChange={handlePageChange}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onDeleteTarget={setDeleteTarget}
          onBulkDeleteTarget={setBulkDeleteTarget}
          onOpenDetail={setSelectedClip}
          onOpenLive={setLiveClip}
        />
      )}

      {/* ── Pipeline tab ── */}
      {activeTab === "pipeline" && (
        <PipelineTab
          pipeline={systemStats.data?.pipeline ?? null}
          queue={systemStats.data?.clip_queue ?? null}
          reprocessStatus={reprocessData ?? null}
          loading={systemStats.isLoading}
        />
      )}

      {/* ── System Monitor tab ── */}
      {activeTab === "system" && (
        <SystemTab
          resources={systemStats.data?.resources ?? null}
          storage={systemStats.data?.storage ?? null}
          queue={systemStats.data?.clip_queue ?? null}
          loading={systemStats.isLoading}
        />
      )}

      {/* ── Use Case Comparison tab ── */}
      {activeTab === "comparison" && (
        <ComparisonTab
          pipeline={systemStats.data?.pipeline ?? null}
          loading={systemStats.isLoading}
        />
      )}

      {/* ── Modals ── */}
      {deleteTarget && (
        <DeleteClipModal
          clip={deleteTarget}
          busy={del.isPending}
          onConfirm={() => {
            del.mutate(deleteTarget.id, {
              onSuccess: () => setDeleteTarget(null),
            });
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {bulkDeleteTarget && bulkDeleteTarget.length > 0 && (
        <BulkDeleteClipModal
          count={bulkDeleteTarget.length}
          busy={bulkDel.isPending}
          onConfirm={() => {
            bulkDel.mutate(
              bulkDeleteTarget.map((c) => c.id),
              {
                onSuccess: () => {
                  setBulkDeleteTarget(null);
                  setSelectedIds(new Set());
                },
              },
            );
          }}
          onClose={() => setBulkDeleteTarget(null)}
        />
      )}

      {reprocessDialog && (
        <ReprocessDialog
          busy={reprocess.isPending}
          onStart={(req) => {
            reprocess.mutate(req, {
              onSuccess: () => setReprocessDialog(false),
            });
          }}
          onClose={() => setReprocessDialog(false)}
        />
      )}

      {selectedClip && (
        <ClipDetailDrawer clip={selectedClip} onClose={() => setSelectedClip(null)} />
      )}

      {liveClip && (
        <LiveMjpegModal
          clip={liveClip}
          onClose={() => setLiveClip(null)}
        />
      )}
    </>
  );
}

// Migration 0054 — LIVE badge pulse animation. Injected once at the
// document level. Cheap, idempotent (the browser ignores duplicate
// rule keys); we'd normally put this in a CSS file but the design
// CSS bundle is verbatim per the project's red lines.
function ensureLiveStyleInjected(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("maugood-live-pulse-style")) return;
  const style = document.createElement("style");
  style.id = "maugood-live-pulse-style";
  style.textContent = `
@keyframes maugood-live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
@keyframes maugood-spin {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
/* Surveillance-style scanline drift on live tiles — extremely
   subtle, only visible against dark RTSP frames. */
@keyframes maugood-scanline {
  0%   { background-position: 0 0; }
  100% { background-position: 0 8px; }
}
/* Streaming-player play button hover affordance. The tile's
   onClick handles the play action; the scale is purely visual. */
[role="button"]:hover > div > div > .clip-play-btn,
[role="button"]:focus-visible > div > div > .clip-play-btn {
  transform: scale(1.08);
}
/* Live surveillance tile hover affordance — slight zoom on the
   feed + watch button reveals brighter accent. */
.clip-tile-live > img {
  transition: transform 0.5s ease;
}
.clip-tile-live:hover > img,
.clip-tile-live:focus-visible > img {
  transform: scale(1.025);
}
.clip-tile-live:hover .clip-watch-btn,
.clip-tile-live:focus-visible .clip-watch-btn {
  transform: scale(1.08);
  background: rgba(255,255,255,0.32) !important;
  border-color: rgba(255,255,255,0.85) !important;
}
.clip-tile-live .clip-watch-btn { transform: scale(1); }
`;
  document.head.appendChild(style);
}

// Migration 0054 — Modal that overlays the camera's live MJPEG
// feed for an in-progress clip. Reuses the existing
// /api/cameras/{camera_id}/live.mjpg endpoint (P28.5a). Cookies
// flow with the same-origin request so no auth header plumbing.
function LiveMjpegModal({
  clip,
  onClose,
}: {
  clip: PersonClipOut;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  // Migration 0054 — poll live-stats at 1 Hz so the in-modal counter
  // tracks the user's visual perception. Independent of the
  // PersonClipsPage list polling (5 s); also doesn't bloat the list
  // payload. ``placeholderData`` keeps the last value while the next
  // poll is in flight so the counter doesn't flicker.
  const liveStatsPath = `/api/cameras/${clip.camera_id}/live-stats`;
  type _LiveStats = {
    live_person_count: number;
    fps_reader: number;
    fps_analyzer: number;
    motion_skipped: number;
  };
  const stats = useQuery<_LiveStats>({
    queryKey: ["live-stats", clip.camera_id],
    queryFn: () => api<_LiveStats>(liveStatsPath),
    refetchInterval: 1_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    staleTime: 0,
  });
  const livePersons = stats.data?.live_person_count ?? clip.person_count;
  const fpsReader = stats.data?.fps_reader ?? 0;
  const fpsAnalyzer = stats.data?.fps_analyzer ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Migration 0055 — persons-only MJPEG variant. Server-side overlay
  // draws YOLO body boxes only (no face boxes, no employee labels)
  // because the Person Clips view is body-presence based — face
  // matching isn't relevant here. Cache bust on every open keeps a
  // previously-disconnected stream from re-using a stale handle.
  const src = `/api/cameras/${clip.camera_id}/live-persons.mjpg?_t=${clip.id}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("personClips.live.modalTitle") as string}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.75)",
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg)",
          borderRadius: "var(--radius-md)",
          maxWidth: "90vw",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--danger-text, #c0392b)",
                animation: "maugood-live-pulse 1.4s ease-in-out infinite",
              }}
            />
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              {clip.camera_name}
            </span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 4,
                background: "var(--danger-text, #c0392b)",
                color: "#fff",
                fontWeight: 700,
                letterSpacing: "0.04em",
              }}
            >
              {t("personClips.live.badge")}
            </span>
            {/* Migration 0054 — real-time occupancy pill, polled 1 Hz
                via live-stats. Updates as people enter / leave frame
                without waiting on the list-endpoint refetch. */}
            <span
              className="mono"
              style={{
                fontSize: 12,
                padding: "2px 8px",
                borderRadius: 4,
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 600,
              }}
              aria-label={t("personClips.live.peopleCountAria") as string}
              title={t("personClips.live.peopleCountAria") as string}
            >
              <Icon name="users" size={12} />
              {livePersons}
            </span>
            {/* Migration 0057 — frame-rate stats pills. Reader fps is
                how fast frames are being pulled off RTSP; analyzer
                fps is how often detection actually runs (motion-skip
                drops this on quiet scenes). High reader / low
                analyzer is normal; low reader is a red flag for
                lagging clips. */}
            <span
              className="mono"
              style={{
                fontSize: 11,
                padding: "2px 7px",
                borderRadius: 4,
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                color: "var(--text-secondary)",
              }}
              aria-label={
                t("personClips.live.fpsAria", {
                  reader: fpsReader.toFixed(1),
                  analyzer: fpsAnalyzer.toFixed(1),
                }) as string
              }
              title={
                t("personClips.live.fpsAria", {
                  reader: fpsReader.toFixed(1),
                  analyzer: fpsAnalyzer.toFixed(1),
                }) as string
              }
            >
              <Icon name="zap" size={11} />
              {fpsReader.toFixed(0)}
              <span style={{ opacity: 0.4 }}>/</span>
              {fpsAnalyzer.toFixed(0)}
              <span style={{ opacity: 0.5, fontSize: 10 }}>fps</span>
            </span>
            <span className="text-xs text-dim" style={{ marginInlineStart: 4 }}>
              {t("personClips.live.modalHint")}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label={t("common.close") as string}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            background: "#000",
            display: "grid",
            placeItems: "center",
            minWidth: 480,
            minHeight: 270,
          }}
        >
          <img
            src={src}
            alt={t("personClips.live.modalTitle") as string}
            style={{
              maxWidth: "85vw",
              maxHeight: "75vh",
              display: "block",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ── PipelineStatsBar ─────────────────────────────────────────────────────────

function PipelineStatsBar({
  stats,
  active,
  onSelect,
}: {
  stats: PersonClipStats;
  active: ClipMatchedStatusFilter;
  onSelect: (next: ClipMatchedStatusFilter) => void;
}) {
  const { t } = useTranslation();
  // Migration 0058 — relabelled. These pills are the FACE-MATCHING
  // pipeline status (matched_status), NOT clip video availability.
  // Operators kept reading "Pending 24" as "24 unplayable clips" —
  // the prefix + suffix on each pill makes the actual meaning
  // unambiguous: body-source clips skip auto face-match, so a high
  // "match pending" count is expected + clips are fully playable.
  //
  // Pills are clickable buttons: clicking filters the clip list to
  // that matched_status; clicking the active pill again clears the
  // filter. ``key`` maps to the DB ``matched_status`` enum
  // (pending / processing / processed / failed) — note "matched"
  // maps to the DB value "processed".
  const pills: {
    key: NonNullable<ClipMatchedStatusFilter>;
    label: string;
    value: number;
    color?: string;
  }[] = [
    {
      key: "pending",
      label: t("personClips.facePipeline.pending"),
      value: stats.pending_match,
      color: "var(--text-secondary)",
    },
    {
      key: "processing",
      label: t("personClips.facePipeline.processing"),
      value: stats.processing_match,
      color: "var(--accent)",
    },
    {
      key: "processed",
      label: t("personClips.facePipeline.matched"),
      value: stats.completed_match,
      color: "#2e7d32",
    },
    {
      key: "failed",
      label: t("personClips.facePipeline.failed"),
      value: stats.failed_match,
      color: "var(--danger-text)",
    },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        marginBottom: 12,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-tertiary)",
          fontWeight: 600,
        }}
        title={t("personClips.facePipeline.helpTitle") as string}
      >
        {t("personClips.facePipeline.heading")}
      </span>
      {pills.map((p) => {
        const isActive = active === p.key;
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onSelect(isActive ? null : p.key)}
            aria-pressed={isActive}
            title={
              isActive
                ? (t("personClips.facePipeline.clearFilter") as string)
                : (t("personClips.facePipeline.applyFilter") as string)
            }
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              background: isActive
                ? "var(--accent-soft, rgba(11, 110, 79, 0.10))"
                : "var(--bg-elev)",
              border: isActive
                ? `1px solid ${p.color ?? "var(--text)"}`
                : "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              cursor: "pointer",
              transition: "background 0.15s, border-color 0.15s",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: p.color ?? "var(--text)",
                flexShrink: 0,
              }}
            />
            <span style={{ color: "var(--text-secondary)" }}>{p.label}</span>
            <span style={{ fontWeight: 600, color: p.color ?? "var(--text)" }}>
              {p.value}
            </span>
          </button>
        );
      })}
      <span
        className="text-xs text-dim"
        style={{ marginInlineStart: 2 }}
      >
        {t("personClips.facePipeline.helpInline")}
      </span>
    </div>
  );
}

// ── ClipsTab ─────────────────────────────────────────────────────────────────

function ClipsTab({
  filters,
  list,
  cameras,
  selectedIds,
  selectedClips,
  totalPages,
  onUpdateFilters,
  onPageChange,
  onToggleSelect,
  onSelectAll,
  onDeselectAll,
  onDeleteTarget,
  onBulkDeleteTarget,
  onOpenDetail,
  onOpenLive,
}: {
  filters: PersonClipFilters;
  list: ReturnType<typeof usePersonClips>;
  cameras: ReturnType<typeof useCameraOptions>;
  selectedIds: Set<number>;
  selectedClips: PersonClipOut[];
  totalPages: number;
  onUpdateFilters: (p: Partial<PersonClipFilters>) => void;
  onPageChange: (p: number) => void;
  onToggleSelect: (id: number) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDeleteTarget: (c: PersonClipOut) => void;
  onBulkDeleteTarget: (cs: PersonClipOut[]) => void;
  onOpenDetail: (c: PersonClipOut) => void;
  // Migration 0054 — open the live MJPEG modal for a recording clip.
  onOpenLive: (c: PersonClipOut) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="card">
      <div className="card-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {list.data && list.data.items.length > 0 && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11.5,
                cursor: "pointer",
                color: "var(--text-secondary)",
              }}
              aria-label="Select all"
            >
              <input
                type="checkbox"
                checked={
                  list.data.items.length > 0 &&
                  selectedIds.size === list.data.items.length
                }
                onChange={() => {
                  if (selectedIds.size === list.data!.items.length) {
                    onDeselectAll();
                  } else {
                    onSelectAll();
                  }
                }}
                style={{ accentColor: "var(--accent)" }}
              />
              All
            </label>
          )}
          <h3 className="card-title">{t("personClips.listTitle")}</h3>
        </div>
        <div className="flex gap-2" style={{ alignItems: "center", flexWrap: "wrap" as const }}>
          <select
            value={filters.camera_id ?? ""}
            onChange={(e) =>
              onUpdateFilters({
                camera_id: e.target.value === "" ? null : Number(e.target.value),
              })
            }
            style={selectStyle}
            aria-label={t("personClips.filterCamera")}
          >
            <option value="">{t("personClips.allCameras")}</option>
            {cameras.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <SourceFilter
            value={filters.detection_source}
            onChange={(detection_source) =>
              onUpdateFilters({ detection_source })
            }
          />
          <input
            type="datetime-local"
            value={filters.start ?? ""}
            onChange={(e) => onUpdateFilters({ start: e.target.value || null })}
            style={selectStyle}
            title={t("personClips.from")}
            aria-label={t("personClips.from")}
          />
          <input
            type="datetime-local"
            value={filters.end ?? ""}
            onChange={(e) => onUpdateFilters({ end: e.target.value || null })}
            style={selectStyle}
            title={t("personClips.to")}
            aria-label={t("personClips.to")}
          />
        </div>
      </div>

      {list.isLoading && (
        <div className="text-sm text-dim" style={{ padding: 16 }}>
          {t("common.loading")}
        </div>
      )}
      {list.isError && (
        <div className="text-sm" style={{ padding: 16, color: "var(--danger-text)" }}>
          {t("personClips.loadFailed")}
        </div>
      )}
      {list.data && list.data.items.length === 0 && !list.isLoading && (
        <div className="text-sm text-dim" style={{ padding: 16 }}>
          {t("personClips.empty")}
        </div>
      )}

      {list.data && list.data.items.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 12,
            padding: 12,
          }}
        >
          {selectedIds.size > 0 && (
            <div
              style={{
                gridColumn: "1 / -1",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: "var(--accent-soft)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
              }}
            >
              <Icon name="check" size={13} />
              <span style={{ fontWeight: 500 }}>{selectedIds.size} selected</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={onDeselectAll}
                style={{ marginLeft: "auto" }}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{ background: "var(--danger)", color: "white" }}
                onClick={() => onBulkDeleteTarget(selectedClips)}
              >
                <Icon name="trash" size={11} /> Delete selected
              </button>
            </div>
          )}
          {list.data.items.map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              isSelected={selectedIds.has(clip.id)}
              onToggleSelect={() => onToggleSelect(clip.id)}
              onDelete={() => onDeleteTarget(clip)}
              onOpenDetail={() => onOpenDetail(clip)}
              onOpenLive={onOpenLive}
            />
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          borderTop: "1px solid var(--border)",
          fontSize: 12,
        }}
      >
        <span className="text-dim">
          {t("personClips.page")} {filters.page} {t("personClips.of")} {totalPages}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="btn btn-sm"
            disabled={filters.page <= 1}
            onClick={() => onPageChange(filters.page - 1)}
          >
            <Icon name="chevronLeft" size={11} />
            {t("common.previous")}
          </button>
          <button
            className="btn btn-sm"
            disabled={filters.page >= totalPages}
            onClick={() => onPageChange(filters.page + 1)}
          >
            {t("common.next")}
            <Icon name="chevronRight" size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── PipelineTab ──────────────────────────────────────────────────────────────

function PipelineTab({
  pipeline,
  queue,
  reprocessStatus,
  loading,
}: {
  pipeline: PipelineStats | null;
  queue: ClipQueueStats | null;
  reprocessStatus: ReprocessFaceMatchStatus | null;
  loading: boolean;
}) {
  if (loading && !pipeline) {
    return <div className="text-sm text-dim" style={{ padding: 16 }}>Loading…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Processing lifecycle funnel */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Processing Lifecycle</h3>
        </div>
        <div style={{ padding: 16 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 8,
            }}
          >
            {[
              { label: "Total Clips", value: pipeline?.total_clips ?? 0, color: "var(--text)" },
              { label: "Pending", value: pipeline?.clips_pending ?? 0, color: "var(--text-secondary)" },
              { label: "Processing", value: pipeline?.clips_processing ?? 0, color: "var(--accent)" },
              { label: "Completed", value: pipeline?.clips_completed ?? 0, color: "#2e7d32" },
              { label: "Failed", value: pipeline?.clips_failed ?? 0, color: "var(--danger-text)" },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  padding: "14px 16px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 700,
                    color: item.color,
                    lineHeight: 1,
                    marginBottom: 4,
                  }}
                >
                  {item.value}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {item.label}
                </div>
              </div>
            ))}
          </div>

          {/* Progress bar */}
          {pipeline && pipeline.total_clips > 0 && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginBottom: 4,
                }}
              >
                <span>Overall completion</span>
                <span>
                  {Math.round((pipeline.clips_completed / pipeline.total_clips) * 100)}%
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  background: "var(--border)",
                  borderRadius: 4,
                  overflow: "hidden",
                  display: "flex",
                }}
              >
                <div
                  style={{
                    width: `${(pipeline.clips_completed / pipeline.total_clips) * 100}%`,
                    background: "#2e7d32",
                    transition: "width 0.5s ease",
                  }}
                />
                <div
                  style={{
                    width: `${(pipeline.clips_processing / pipeline.total_clips) * 100}%`,
                    background: "var(--accent)",
                    transition: "width 0.5s ease",
                  }}
                />
                <div
                  style={{
                    width: `${(pipeline.clips_failed / pipeline.total_clips) * 100}%`,
                    background: "var(--danger-text)",
                    transition: "width 0.5s ease",
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Clip worker queue */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Clip Worker Queue</h3>
          {queue && (
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {queue.alive_workers}/{queue.total_workers} workers alive ·{" "}
              {queue.total_queue_depth} queued
            </span>
          )}
        </div>
        {queue && queue.workers.length > 0 ? (
          <div style={{ padding: "8px 12px 12px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: 8,
              }}
            >
              {queue.workers.map((w) => (
                <div
                  key={w.camera_id}
                  style={{
                    padding: "10px 12px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: w.is_alive ? "#2e7d32" : "var(--danger-text)",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {w.camera_name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {w.is_alive ? "alive" : "stopped"} · queue: {w.queue_size}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-sm text-dim" style={{ padding: 16 }}>
            No clip workers running.
          </div>
        )}
      </div>

      {/* Reprocess status */}
      {reprocessStatus && reprocessStatus.status !== "idle" && (
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Reprocess Status</h3>
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: "var(--radius-sm)",
                background:
                  reprocessStatus.status === "running"
                    ? "var(--accent-soft)"
                    : reprocessStatus.status === "completed"
                      ? "#e6f7e6"
                      : "var(--danger-soft)",
                color:
                  reprocessStatus.status === "running"
                    ? "var(--accent)"
                    : reprocessStatus.status === "completed"
                      ? "#2e7d32"
                      : "var(--danger-text)",
                fontWeight: 500,
              }}
            >
              {reprocessStatus.status}
            </span>
          </div>
          <div style={{ padding: "8px 16px 16px", fontSize: 13 }}>
            <div
              style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}
            >
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                  Processed
                </div>
                <div style={{ fontWeight: 600, fontSize: 18 }}>
                  {reprocessStatus.processed_clips} / {reprocessStatus.total_clips}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                  Matched
                </div>
                <div style={{ fontWeight: 600, fontSize: 18, color: "#2e7d32" }}>
                  {reprocessStatus.matched_total}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                  Errors
                </div>
                <div style={{ fontWeight: 600, fontSize: 18, color: "var(--danger-text)" }}>
                  {reprocessStatus.failed_count}
                </div>
              </div>
            </div>
            {reprocessStatus.use_cases.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                {reprocessStatus.use_cases.map((uc) => (
                  <span key={uc} className="pill pill-neutral" style={{ fontSize: 10 }}>
                    {uc.toUpperCase()}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── SystemTab ────────────────────────────────────────────────────────────────

function SystemTab({
  resources,
  storage,
  queue,
  loading,
}: {
  resources: SystemResourceStats | null;
  storage: StorageStats | null;
  queue: ClipQueueStats | null;
  loading: boolean;
}) {
  if (loading && !resources) {
    return <div className="text-sm text-dim" style={{ padding: 16 }}>Loading…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* CPU + Memory */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">CPU & Memory</h3>
          {resources && (
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              CPU {resources.cpu_percent_total.toFixed(1)}% ·{" "}
              RAM {resources.memory_percent.toFixed(1)}%
            </span>
          )}
        </div>
        {resources && (
          <div style={{ padding: 16 }}>
            {/* CPU per-core bars */}
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginBottom: 8,
                  fontWeight: 500,
                }}
              >
                CPU per core
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(60px, 1fr))",
                  gap: 6,
                }}
              >
                {resources.cpu_percent_per_core.map((pct, i) => (
                  <div key={i} style={{ textAlign: "center" }}>
                    <div
                      style={{
                        height: 40,
                        background: "var(--border)",
                        borderRadius: 3,
                        overflow: "hidden",
                        display: "flex",
                        alignItems: "flex-end",
                        marginBottom: 3,
                      }}
                    >
                      <div
                        style={{
                          width: "100%",
                          height: `${Math.max(2, pct)}%`,
                          background:
                            pct > 80
                              ? "var(--danger-text)"
                              : pct > 50
                                ? "var(--accent)"
                                : "#2e7d32",
                          transition: "height 0.5s ease",
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-secondary)" }}>
                      C{i}
                    </div>
                    <div style={{ fontSize: 9, fontWeight: 600 }}>
                      {pct.toFixed(0)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Memory bar */}
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginBottom: 4,
                }}
              >
                <span style={{ fontWeight: 500 }}>Memory</span>
                <span>
                  {(resources.memory_used_mb / 1024).toFixed(1)} GB /{" "}
                  {(resources.memory_total_mb / 1024).toFixed(1)} GB
                </span>
              </div>
              <BarGauge
                value={resources.memory_used_mb}
                total={resources.memory_total_mb}
                color={resources.memory_percent > 85 ? "var(--danger-text)" : "var(--accent)"}
              />
            </div>
          </div>
        )}
      </div>

      {/* GPU */}
      {resources && resources.gpu_available && (
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">GPU</h3>
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                    fontWeight: 500,
                  }}
                >
                  GPU utilisation
                </div>
                <BarGauge
                  value={resources.gpu_percent ?? 0}
                  total={100}
                  label={`${(resources.gpu_percent ?? 0).toFixed(1)}%`}
                  color="var(--accent)"
                />
              </div>
              {resources.gpu_memory_total_mb != null && (
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-secondary)",
                      marginBottom: 4,
                      fontWeight: 500,
                    }}
                  >
                    GPU memory
                  </div>
                  <BarGauge
                    value={resources.gpu_memory_used_mb ?? 0}
                    total={resources.gpu_memory_total_mb}
                    label={`${((resources.gpu_memory_used_mb ?? 0) / 1024).toFixed(1)} / ${(resources.gpu_memory_total_mb / 1024).toFixed(1)} GB`}
                    color="var(--accent)"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Storage */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Clip Storage</h3>
          {storage && (
            <span
              style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace" }}
            >
              {storage.clips_root}
            </span>
          )}
        </div>
        {storage && (
          <div style={{ padding: 16 }}>
            <div
              style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 16 }}
            >
              {[
                { label: "Total", value: `${storage.total_gb.toFixed(1)} GB` },
                { label: "Used", value: `${storage.used_gb.toFixed(1)} GB` },
                { label: "Free", value: `${storage.free_gb.toFixed(1)} GB` },
                { label: "Clip files", value: `${storage.clip_files_count}` },
                { label: "Clip data", value: `${(storage.clip_files_total_mb / 1024).toFixed(2)} GB` },
              ].map((item) => (
                <div key={item.label} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{item.value}</div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {item.label}
                  </div>
                </div>
              ))}
            </div>
            <BarGauge
              value={storage.used_gb}
              total={storage.total_gb}
              color={
                storage.used_gb / storage.total_gb > 0.9
                  ? "var(--danger-text)"
                  : storage.used_gb / storage.total_gb > 0.75
                    ? "var(--accent)"
                    : "#2e7d32"
              }
            />
          </div>
        )}
      </div>

      {/* Queue summary */}
      {queue && (
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Worker Queue</h3>
          </div>
          <div
            style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}
          >
            {[
              { label: "Total workers", value: queue.total_workers },
              { label: "Alive workers", value: queue.alive_workers },
              { label: "Queue depth", value: queue.total_queue_depth },
            ].map((item) => (
              <div key={item.label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{item.value}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {item.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BarGauge({
  value,
  total,
  color,
  label,
}: {
  value: number;
  total: number;
  color: string;
  label?: string;
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div>
      <div
        style={{
          height: 10,
          background: "var(--border)",
          borderRadius: 5,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(2, pct)}%`,
            height: "100%",
            background: color,
            borderRadius: 5,
            transition: "width 0.5s ease",
          }}
        />
      </div>
      {label && (
        <div
          style={{
            fontSize: 10,
            color: "var(--text-secondary)",
            marginTop: 3,
            textAlign: "right",
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

// ── ComparisonTab ─────────────────────────────────────────────────────────────

function ComparisonTab({
  pipeline,
  loading,
}: {
  pipeline: PipelineStats | null;
  loading: boolean;
}) {
  if (loading && !pipeline) {
    return <div className="text-sm text-dim" style={{ padding: 16 }}>Loading…</div>;
  }

  const ucs = [
    {
      id: "UC1",
      desc: "YOLO + Face detection, crop save",
      completed: pipeline?.uc1_completed ?? 0,
      avgMs: pipeline?.avg_uc1_duration_ms ?? null,
    },
    {
      id: "UC2",
      desc: "InsightFace Buffalo, crop save",
      completed: pipeline?.uc2_completed ?? 0,
      avgMs: pipeline?.avg_uc2_duration_ms ?? null,
    },
    {
      id: "UC3",
      desc: "InsightFace Buffalo, direct match",
      completed: pipeline?.uc3_completed ?? 0,
      avgMs: pipeline?.avg_uc3_duration_ms ?? null,
    },
  ];

  const maxCompleted = Math.max(...ucs.map((u) => u.completed), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Use Case Comparison</h3>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            UC1 · UC2 · UC3 — side-by-side
          </span>
        </div>
        <div style={{ padding: 16 }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Use Case", "Description", "Completed", "Avg Duration", "Throughput"].map(
                  (h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "8px 12px",
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {ucs.map((uc) => {
                const throughputPct =
                  pipeline && pipeline.total_clips > 0
                    ? (uc.completed / pipeline.total_clips) * 100
                    : 0;
                return (
                  <tr
                    key={uc.id}
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <td style={{ padding: "12px 12px" }}>
                      <span
                        className="pill pill-neutral"
                        style={{ fontSize: 11, fontWeight: 600 }}
                      >
                        {uc.id}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "12px 12px",
                        color: "var(--text-secondary)",
                        fontSize: 12,
                      }}
                    >
                      {uc.desc}
                    </td>
                    <td style={{ padding: "12px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div
                          style={{
                            width: 80,
                            height: 8,
                            background: "var(--border)",
                            borderRadius: 4,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${(uc.completed / maxCompleted) * 100}%`,
                              height: "100%",
                              background: "#2e7d32",
                              borderRadius: 4,
                              transition: "width 0.5s ease",
                            }}
                          />
                        </div>
                        <span style={{ fontWeight: 600 }}>{uc.completed}</span>
                      </div>
                    </td>
                    <td
                      style={{
                        padding: "12px 12px",
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                    >
                      {fmtMs(uc.avgMs)}
                    </td>
                    <td style={{ padding: "12px 12px", fontSize: 12 }}>
                      {pipeline && pipeline.total_clips > 0
                        ? `${throughputPct.toFixed(1)}% of clips`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Mode Notes</h3>
        </div>
        <div style={{ padding: 16 }}>
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}
          >
            {[
              {
                id: "UC1",
                title: "UC1 — YOLO + Face",
                points: [
                  "Person detection via YOLOv8",
                  "InsightFace inside YOLO boxes",
                  "Face crops saved to DB",
                  "Best for: high-traffic, crowds",
                ],
              },
              {
                id: "UC2",
                title: "UC2 — InsightFace Direct + Crops",
                points: [
                  "Full-frame InsightFace detection",
                  "Face crops saved to DB",
                  "Best for: close-range, single entry",
                ],
              },
              {
                id: "UC3",
                title: "UC3 — InsightFace No Crops",
                points: [
                  "Full-frame InsightFace detection",
                  "No crop storage — faster",
                  "Updates legacy matched_status",
                  "Best for: quick identification",
                ],
              },
            ].map((card) => (
              <div
                key={card.id}
                style={{
                  padding: 14,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  {card.title}
                </div>
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {card.points.map((p) => (
                    <li
                      key={p}
                      style={{
                        fontSize: 11.5,
                        color: "var(--text-secondary)",
                        paddingLeft: 12,
                        position: "relative",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          left: 0,
                          color: "var(--accent)",
                        }}
                      >
                        ·
                      </span>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ClipCard ─────────────────────────────────────────────────────────────────

// Migration 0058 — cadence of the card thumbnail-poll loop. 3 s
// trades smooth motion for a ~100× drop in network + CPU vs
// continuous MJPEG. Modal stays on full MJPEG for smooth video.
const CARD_THUMB_REFRESH_MS = 3000;

// Migration 0058 — polled <img> for the Person Clips card preview.
// Fetches a fresh JPEG from /live-persons.jpg every
// CARD_THUMB_REFRESH_MS; on transient errors it just leaves the
// last good frame on screen until the next poll succeeds. No
// persistent MJPEG connection, no viewer-slot consumed, no
// continuous browser decode load.
//
// Cache-bust via timestamp query param so the browser doesn't 304
// us back stale frames; the server also sets no-store, but the
// query param is cheap belt-and-braces.
function PolledLivePersonsImage({ cameraId }: { cameraId: number }) {
  const [src, setSrc] = useState(
    () => `/api/cameras/${cameraId}/live-persons.jpg?t=${Date.now()}`
  );
  useEffect(() => {
    // Refresh the cache-bust token on a timer. React re-renders the
    // <img> with the new src; the browser fires a fresh GET. Old
    // <img> contents stay on screen until the new image lands —
    // i.e. there is no flash to black between polls.
    const id = window.setInterval(() => {
      setSrc(
        `/api/cameras/${cameraId}/live-persons.jpg?t=${Date.now()}`
      );
    }, CARD_THUMB_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [cameraId]);
  return (
    <img
      src={src}
      alt=""
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        filter: "saturate(1.05)",
      }}
      onError={(e) => {
        // Transient errors (503 cold-start, network blip) shouldn't
        // hide the previous good frame — only nuke the img on
        // permanent breakage. We can't tell from onError which
        // case this is, but the next poll will replace src and the
        // browser will re-try. Leaving the element visible.
        (e.target as HTMLImageElement).style.visibility = "hidden";
        window.setTimeout(() => {
          (e.target as HTMLImageElement).style.visibility = "visible";
        }, CARD_THUMB_REFRESH_MS);
      }}
    />
  );
}

// Migration 0055 — surveillance-style corner brackets. Renders four
// L-shapes around the live preview to evoke a CCTV/security-monitor
// frame. Pure CSS borders so it's effectively free at render time.
function CornerBrackets() {
  const bracketSize = 14;
  const bracketThickness = 1.5;
  const bracketColour = "rgba(255,255,255,0.65)";
  const inset = 8;
  const common: React.CSSProperties = {
    position: "absolute",
    width: bracketSize,
    height: bracketSize,
    pointerEvents: "none",
  };
  return (
    <>
      {/* top-left */}
      <span
        aria-hidden
        style={{
          ...common,
          top: inset,
          left: inset,
          borderTop: `${bracketThickness}px solid ${bracketColour}`,
          borderLeft: `${bracketThickness}px solid ${bracketColour}`,
        }}
      />
      {/* top-right */}
      <span
        aria-hidden
        style={{
          ...common,
          top: inset,
          right: inset,
          borderTop: `${bracketThickness}px solid ${bracketColour}`,
          borderRight: `${bracketThickness}px solid ${bracketColour}`,
        }}
      />
      {/* bottom-left */}
      <span
        aria-hidden
        style={{
          ...common,
          bottom: inset,
          left: inset,
          borderBottom: `${bracketThickness}px solid ${bracketColour}`,
          borderLeft: `${bracketThickness}px solid ${bracketColour}`,
        }}
      />
      {/* bottom-right */}
      <span
        aria-hidden
        style={{
          ...common,
          bottom: inset,
          right: inset,
          borderBottom: `${bracketThickness}px solid ${bracketColour}`,
          borderRight: `${bracketThickness}px solid ${bracketColour}`,
        }}
      />
    </>
  );
}

// Migration 0058 — right-click context menu for clip cards.
// Opens at cursor on right-click; closes on outside click / Esc.
// Auto-clamps to viewport so a click at the bottom-right of the
// screen doesn't push the menu off-screen.
function ClipContextMenu({
  x,
  y,
  onClose,
  onProcess,
  processBusy,
}: {
  x: number;
  y: number;
  onClose: () => void;
  // Fires one use case at a time so the operator can run UC1 / UC2 /
  // UC3 independently — the backend daemon thread handles whichever
  // single use case the menu picked.
  onProcess: (useCase: "uc1" | "uc2" | "uc3") => void;
  processBusy: boolean;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      // Outside-click handler. The menu itself stops propagation so
      // clicks inside don't dismiss it.
      onClose();
      void e;
    };
    document.addEventListener("keydown", onKey);
    // Use 'click' (not 'mousedown') so the menu item's own onClick
    // fires before this outside-click handler closes it.
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [onClose]);

  // Three separate use cases, three separate menu items.
  const items: {
    key: "uc1" | "uc2" | "uc3";
    label: string;
    hint: string;
  }[] = [
    {
      key: "uc1",
      label: t("personClips.contextMenu.uc1") as string,
      hint: t("personClips.contextMenu.uc1Hint") as string,
    },
    {
      key: "uc2",
      label: t("personClips.contextMenu.uc2") as string,
      hint: t("personClips.contextMenu.uc2Hint") as string,
    },
    {
      key: "uc3",
      label: t("personClips.contextMenu.uc3") as string,
      hint: t("personClips.contextMenu.uc3Hint") as string,
    },
  ];

  // Clamp to viewport so the menu never spills off-screen.
  const MENU_W = 260;
  const MENU_H = 56 + items.length * 50;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.min(x, vw - MENU_W - 8);
  const top = Math.min(y, vh - MENU_H - 8);

  return (
    <div
      role="menu"
      aria-label={t("personClips.contextMenu.title") as string}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 200,
        minWidth: MENU_W,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
        padding: 4,
        fontSize: 13,
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Small header so the operator knows what this menu is. */}
      <div
        style={{
          padding: "6px 10px 4px",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-tertiary)",
          fontWeight: 600,
        }}
      >
        {t("personClips.contextMenu.title")}
      </div>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          onClick={() => {
            onProcess(item.key);
            onClose();
          }}
          disabled={processBusy}
          style={{
            width: "100%",
            textAlign: "start",
            padding: "8px 12px",
            border: "none",
            background: "transparent",
            color: "var(--text)",
            cursor: processBusy ? "wait" : "pointer",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: "var(--font-sans)",
            fontSize: 13,
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.background =
              "var(--bg-elev)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.background =
              "transparent")
          }
        >
          <Icon name="sparkles" size={14} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontWeight: 500 }}>{item.label}</span>
            <span className="text-xs text-dim">{item.hint}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function ClipCard({
  clip,
  isSelected,
  onToggleSelect,
  onDelete,
  onOpenDetail,
  onOpenLive,
}: {
  clip: PersonClipOut;
  isSelected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
  onOpenDetail: () => void;
  onOpenLive: (clip: PersonClipOut) => void;
}) {
  const [showVideo, setShowVideo] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState(false);
  const [playError, setPlayError] = useState(false);
  // Migration 0058 — right-click context menu state.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const reprocess = useSingleClipReprocess(clip.id);
  // Migration 0055 — only fetch the thumbnail once the clip has been
  // encoded. While 'recording' / 'finalizing' the endpoint correctly
  // 410s (no MP4, no thumb) — but the <img> would catch that as an
  // error and set ``thumbError`` sticky, so when the clip later
  // transitions to 'completed' the thumbnail still wouldn't render.
  const thumbUrl =
    clip.recording_status === "completed"
      ? `/api/person-clips/${clip.id}/thumbnail`
      : null;
  const { t } = useTranslation();

  // Migration 0054 / 0055 — in-flight states have no playable MP4
  // yet; clicking the tile opens the live MJPEG modal of the source
  // camera. ``recording`` = reader is actively writing frames;
  // ``finalizing`` = reader handed off and ClipWorker is encoding
  // (can take minutes for a long clip at native resolution).
  const isRecording = clip.recording_status === "recording";
  const isFinalizing = clip.recording_status === "finalizing";
  const isInFlight = isRecording || isFinalizing;

  const personCount = clip.person_count ?? 0;
  const matchedCount = clip.matched_employee_names?.length ?? 0;
  const unknownCount = Math.max(0, personCount - matchedCount);
  const clipStart = new Date(clip.clip_start);
  const clipEnd = new Date(clip.clip_end);
  const hourStr = clipStart.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const dateStr = clipStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  // Precise hh:mm:ss for the start/end row on the card. 12-hour
  // format with AM/PM to match the locale-default times shown on the
  // rest of the card (the date row already renders e.g. "02:48 PM").
  // For 'recording' rows the clip_end is a placeholder equal to
  // clip_start; we render "Recording…" instead of a meaningless
  // equal-time pair.
  const startHms = clipStart.toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });
  const endHms = clipEnd.toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });
  const isMatched = matchedCount > 0;
  const hasUnknown = unknownCount > 0;
  const matchProgress = clip.face_matching_progress ?? 0;
  const isMatching = matchProgress > 0 && matchProgress < 100;
  const matchDuration = clip.face_matching_duration_ms;
  const personStart = clip.person_start ? new Date(clip.person_start) : null;
  const personEnd = clip.person_end ? new Date(clip.person_end) : null;

  // Pipeline metadata
  const fps = clip.fps_recorded ?? (clip.duration_seconds > 0 ? clip.frame_count / clip.duration_seconds : null);
  const res = clip.resolution_w && clip.resolution_h ? `${clip.resolution_w}×${clip.resolution_h}` : null;
  const encMs =
    clip.encoding_start_at && clip.encoding_end_at
      ? new Date(clip.encoding_end_at).getTime() - new Date(clip.encoding_start_at).getTime()
      : null;

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Migration 0055 — reset thumbnail / play error state when the
  // clip's recording_status changes. The same ClipCard instance
  // survives the in-flight → completed transition (React reuses it
  // by ``key={clip.id}``); without this reset, a 410 the <img>
  // caught while the clip was still in-flight would leave
  // ``thumbError = true`` forever and the thumbnail would never
  // render after encode finishes.
  useEffect(() => {
    setThumbError(false);
    setPlayError(false);
  }, [clip.recording_status]);

  const handlePlay = () => {
    // Migration 0055 — finalizing clips have no playable artifact:
    // the reader is done writing frames but ClipWorker is still
    // encoding the MP4. Showing the live MJPEG here would be
    // misleading (the camera might be recording the NEXT clip), and
    // the partial encode isn't decodable. The tile renders a
    // spinner instead of an action; clicks are no-ops.
    if (isFinalizing) {
      return;
    }
    // Recording — camera is actively capturing THIS clip. Live view
    // is meaningful and matches what's being written to disk.
    if (isRecording) {
      onOpenLive(clip);
      return;
    }
    if (videoUrl) {
      setShowVideo(true);
      return;
    }
    fetch(`/api/person-clips/${clip.id}/stream`)
      .then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        setVideoUrl(url);
        setShowVideo(true);
      })
      .catch(() => setPlayError(true));
  };

  return (
    <div
      style={{
        position: "relative",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        background: "var(--bg-elev)",
        display: "flex",
        flexDirection: "column",
      }}
      // Migration 0058 — right-click on a completed clip opens the
      // Process menu. In-flight clips (recording / finalizing) skip
      // the menu since they have no MP4 to process yet — let the
      // native browser context menu through so the operator can
      // still inspect the page.
      onContextMenu={
        isInFlight
          ? undefined
          : (e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY });
            }
      }
    >
      {/* Checkbox overlay */}
      <div style={{ position: "absolute", top: 6, left: 6, zIndex: 2 }}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          disabled={isInFlight}
          aria-label={`Select clip ${clip.id}`}
          style={{
            width: 16,
            height: 16,
            cursor: isInFlight ? "not-allowed" : "pointer",
            accentColor: "var(--accent)",
            opacity: isInFlight ? 0.4 : 1,
          }}
          title={
            isInFlight
              ? (t("personClips.live.deleteDisabled") as string)
              : undefined
          }
        />
      </div>

      {/* Migration 0054 / 0055 — premium in-flight status pill.
          Recording: red gradient + pulsing dot, surveillance feel.
          Finalizing: amber gradient + spinning hint.
          The pill sits above the live preview so the MJPEG underneath
          doesn't fight with it visually. */}
      {isInFlight && (
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            zIndex: 3,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 9px 4px 8px",
            borderRadius: 999,
            background: isRecording
              ? "linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)"
              : "linear-gradient(135deg, #f59e0b 0%, #b45309 100%)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            boxShadow: isRecording
              ? "0 4px 14px rgba(239,68,68,0.5), 0 0 0 1px rgba(255,255,255,0.18) inset"
              : "0 4px 14px rgba(245,158,11,0.45), 0 0 0 1px rgba(255,255,255,0.15) inset",
            backdropFilter: "blur(6px)",
          }}
          aria-label={
            isRecording
              ? "Recording in progress"
              : "Encoding in progress"
          }
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 0 0 2px rgba(255,255,255,0.25)",
              animation: "maugood-live-pulse 1.4s ease-in-out infinite",
            }}
          />
          {isRecording
            ? t("personClips.live.badge")
            : t("personClips.live.finalizing")}
        </div>
      )}

      {/* Thumbnail / Video */}
      <div
        className={isRecording ? "clip-tile-live" : undefined}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#0b0f14",
          display: "grid",
          placeItems: "center",
          // Migration 0055 — finalizing tiles are inert: the file
          // isn't decodable yet and the camera might be recording
          // the NEXT clip, so live-view here would be misleading.
          cursor: isFinalizing ? "default" : "pointer",
          overflow: "hidden",
        }}
        onClick={isFinalizing ? undefined : handlePlay}
        role={isFinalizing ? undefined : "button"}
        aria-label={
          isFinalizing
            ? undefined
            : isRecording
              ? (t("personClips.live.watchLive") as string)
              : "Play clip"
        }
        tabIndex={isFinalizing ? -1 : 0}
        onKeyDown={
          isFinalizing
            ? undefined
            : (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handlePlay();
                }
              }
        }
      >
        {showVideo && videoUrl && !playError ? (
          <video
            src={videoUrl}
            controls
            autoPlay
            style={{ width: "100%", height: "100%", display: "block" }}
            onError={() => setPlayError(true)}
          />
        ) : isRecording ? (
          /* Migration 0055 + 0058 — surveillance-style live preview
             tile in thumbnail-poll mode. The card refreshes a single
             JPEG every ``CARD_THUMB_REFRESH_MS`` (3 s) instead of
             streaming MJPEG, cutting card-level network + CPU by
             ~100× vs continuous video. The modal still uses smooth
             MJPEG for the full Watch-Live experience; this tile is
             just the "is something happening?" affordance. */
          <>
            <PolledLivePersonsImage cameraId={clip.camera_id} />
            <CornerBrackets />
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                background:
                  "linear-gradient(180deg, transparent 0%, transparent 55%, rgba(0,0,0,0.55) 100%)",
              }}
            />
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                pointerEvents: "none",
              }}
            >
              <span
                className="clip-watch-btn"
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.18)",
                  border: "1.5px solid rgba(255,255,255,0.55)",
                  backdropFilter: "blur(8px) saturate(140%)",
                  display: "grid",
                  placeItems: "center",
                  color: "#fff",
                  boxShadow:
                    "0 4px 16px rgba(0,0,0,0.45), 0 0 0 4px rgba(255,255,255,0.06)",
                  transition: "transform 0.15s ease, background 0.15s ease",
                  paddingInlineStart: 2,
                }}
              >
                <Icon
                  name="play"
                  size={18}
                  strokeWidth={0}
                  style={{ fill: "currentColor" }}
                />
              </span>
            </div>
          </>
        ) : thumbUrl && !thumbError ? (
          <img
            src={thumbUrl}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={() => setThumbError(true)}
          />
        ) : playError ? (
          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11 }}>Load failed</div>
        ) : null}

        {/* Migration 0055 — the legacy icon overlay only runs for
            completed + finalizing clips. Recording clips have their
            own surveillance-style overlay built into the live
            preview branch above. */}
        {!showVideo && !isRecording && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "grid",
                placeItems: "center",
                gap: 8,
                color: "rgba(255,255,255,0.7)",
              }}
            >
              {/* Migration 0055 — three overlay states:
                  - recording  → videocam + "Watch live"
                  - finalizing → spinning loader + "Encoding…" (no click)
                  - completed  → minimal circular play button
                                 (white round button, black filled
                                  triangle, soft shadow — streaming-
                                  player aesthetic) + duration */}
              {isFinalizing ? (
                <span
                  style={{
                    display: "inline-grid",
                    placeItems: "center",
                    animation: "maugood-spin 1.2s linear infinite",
                  }}
                  aria-label={t("personClips.live.finalizing") as string}
                >
                  <Icon name="refresh" size={32} strokeWidth={1.5} />
                </span>
              ) : isRecording ? (
                <Icon name="videocam" size={32} strokeWidth={1} />
              ) : (
                <span
                  className="clip-play-btn"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "#fff",
                    display: "grid",
                    placeItems: "center",
                    boxShadow:
                      "0 4px 14px rgba(0, 0, 0, 0.3), " +
                      "0 1px 4px rgba(0, 0, 0, 0.18)",
                    color: "#000",
                    // Optical correction: the triangle's visual mass
                    // sits left of its geometric center, so a small
                    // right-shift makes the icon look centered.
                    paddingInlineStart: 2,
                    transition: "transform 0.15s ease",
                  }}
                  aria-hidden
                >
                  <Icon
                    name="play"
                    size={16}
                    strokeWidth={0}
                    style={{ fill: "currentColor" }}
                  />
                </span>
              )}
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                {isFinalizing
                  ? t("personClips.live.encodingProgress")
                  : isRecording
                    ? t("personClips.live.watchLive")
                    : fmtDuration(clip.duration_seconds)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Matching progress bar */}
      {isMatching && (
        <div style={{ padding: "6px 12px 0" }}>
          <div
            style={{
              width: "100%",
              height: 4,
              background: "rgba(0,0,0,0.06)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.max(2, matchProgress)}%`,
                height: "100%",
                background: "var(--accent)",
                borderRadius: 2,
                transition: "width 0.5s ease",
              }}
            />
          </div>
          <span style={{ fontSize: 9, color: "var(--text-secondary)", marginTop: 2, display: "block" }}>
            Matching {matchProgress}%
          </span>
        </div>
      )}

      {/* Camera + ID */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 12px 4px",
        }}
      >
        <span className="pill pill-neutral" style={{ fontSize: 10, fontWeight: 500 }}>
          {clip.camera_name}
        </span>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono, monospace)",
            letterSpacing: "0.3px",
          }}
        >
          #{clip.id}
        </span>
      </div>

      {/* Timestamp + duration */}
      <div
        style={{
          padding: "0 12px 8px",
          fontSize: 11,
          color: "var(--text-secondary)",
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span>
          {dateStr} {hourStr}
        </span>
        <span style={{ opacity: 0.4 }}>|</span>
        <span>{fmtDuration(clip.duration_seconds)}</span>
        {personStart && personEnd && (
          <>
            <span style={{ opacity: 0.4 }}>|</span>
            <span>
              Person{" "}
              {personStart.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              &ndash;
              {personEnd.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
          </>
        )}
        {/* Phase C — surface which detector triggered this clip,
            plus chunk_count when >1 (long recordings). */}
        <SourceBadge
          source={clip.detection_source}
          chunkCount={clip.chunk_count}
        />
      </div>

      {/* Precise clip start → end times. Mono for alignment; matches
          the on-disk filename's HHMMSS-HHMMSS format so an operator
          can grep a path back to the row by eye. */}
      <div
        className="mono"
        style={{
          padding: "0 12px 8px",
          fontSize: 11,
          color: "var(--text-secondary)",
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
        title={
          isRecording
            ? (t("personClips.startEnd.titleRecording") as string)
            : (t("personClips.startEnd.titleCompleted") as string)
        }
      >
        <span>{startHms}</span>
        <span style={{ opacity: 0.45 }}>→</span>
        <span>
          {/* While 'recording' clip_end is the start sentinel, so we
              render "Recording…" instead of an equal-time pair.
              While 'finalizing' clip_end has been updated to the real
              last-frame timestamp (see reader._mark_recording_finalizing),
              so the real time renders fine. */}
          {isRecording ? t("personClips.startEnd.recording") : endHms}
        </span>
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "0 12px" }} />

      {/* Person count + names */}
      <div style={{ padding: "8px 12px 4px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              fontWeight: 700,
              fontSize: 22,
              color: personCountColor(personCount),
              lineHeight: 1,
            }}
          >
            {personCount}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            {personCount === 1 ? "person" : "persons"}
          </span>
        </div>

        {isMatched && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {clip.matched_employee_names.map((name) => (
              <span
                key={name}
                className="pill pill-primary"
                style={{ fontSize: 10, lineHeight: "16px" }}
              >
                {name}
              </span>
            ))}
          </div>
        )}

        {hasUnknown && (
          <div
            style={{
              fontSize: 10,
              color: "var(--text-secondary)",
              marginTop: 4,
              opacity: 0.7,
            }}
          >
            +{unknownCount} unknown
          </div>
        )}

        {!isMatched && !hasUnknown && personCount > 0 && (
          <div
            style={{
              fontSize: 10,
              color: isMatching ? "var(--accent)" : "var(--text-secondary)",
              marginTop: 4,
            }}
          >
            {isMatching ? "Matching…" : t("personClips.pendingMatch")}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "0 12px" }} />

      {/* Footer metadata */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 12px 8px",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 8,
            fontSize: 10,
            color: "var(--text-secondary)",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span>{fmtFileSize(clip.filesize_bytes)}</span>
          {res && (
            <>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>{res}</span>
            </>
          )}
          {fps !== null && (
            <>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>{fps.toFixed(1)} fps</span>
            </>
          )}
          {encMs !== null && (
            <>
              <span style={{ opacity: 0.3 }}>·</span>
              <span title="Encoding duration">{fmtMs(encMs)} enc</span>
            </>
          )}
          {matchDuration !== null && matchDuration !== undefined && (
            <>
              <span style={{ opacity: 0.3 }}>·</span>
              <span title="Face matching duration">{fmtMs(matchDuration)} match</span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {matchProgress >= 100 && isMatched && (
            <span
              style={{
                fontSize: 9,
                color: "var(--success-text, #2e7d32)",
                background: "var(--success-soft, #e6f7e6)",
                padding: "1px 6px",
                borderRadius: "var(--radius-sm)",
                fontWeight: 500,
              }}
            >
              Matched
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="View clip details"
            title="View details"
            onClick={onOpenDetail}
            style={{ opacity: 0.6 }}
          >
            <Icon name="eye" size={11} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Delete clip"
            title="Delete clip"
            onClick={onDelete}
            style={{ color: "var(--danger-text)", opacity: 0.5, marginLeft: 2 }}
          >
            <Icon name="trash" size={11} />
          </button>
        </div>
      </div>
      {ctxMenu && (
        <ClipContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          processBusy={reprocess.isPending}
          onProcess={(useCase) => {
            // Run a single use case at a time so each context-menu
            // pick fires independently. The single-clip reprocess
            // backend accepts a list of ``use_cases``; here we pass
            // exactly one. Per-UC results land in
            // ``clip_processing_results`` and surface in the detail
            // drawer's Pipeline section.
            reprocess.mutate({ use_cases: [useCase] });
          }}
        />
      )}
    </div>
  );
}

// ── Delete modals ────────────────────────────────────────────────────────────

function DeleteClipModal({
  clip,
  busy,
  onConfirm,
  onClose,
}: {
  clip: PersonClipOut;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("personClips.deleteTitle")}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg)",
            width: 420,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "var(--danger-soft)",
                display: "grid",
                placeItems: "center",
                color: "var(--danger-text)",
              }}
            >
              <Icon name="trash" size={14} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{t("personClips.deleteTitle")}</div>
          </div>
          <div className="text-sm text-dim" style={{ marginBottom: 16, lineHeight: 1.5 }}>
            {t("personClips.deleteBody", {
              camera: clip.camera_name,
              time: fmtTimestamp(clip.clip_start),
              person_count: clip.person_count ?? 0,
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ background: "var(--danger)", color: "white" }}
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? t("personClips.deleting") : t("personClips.deleteConfirm")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function BulkDeleteClipModal({
  count,
  busy,
  onConfirm,
  onClose,
}: {
  count: number;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete multiple clips"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg)",
            width: 420,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "var(--danger-soft)",
                display: "grid",
                placeItems: "center",
                color: "var(--danger-text)",
              }}
            >
              <Icon name="trash" size={14} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{t("personClips.deleteTitle")}</div>
          </div>
          <div className="text-sm text-dim" style={{ marginBottom: 16, lineHeight: 1.5 }}>
            {t("personClips.bulkDeleteBody", { count })}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ background: "var(--danger)", color: "white" }}
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? t("personClips.deleting") : t("personClips.bulkDeleteConfirm", { count })}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Reprocess progress bar ────────────────────────────────────────────────────

function ReprocessStatusBar({ data }: { data: ReprocessFaceMatchStatus }) {
  const { t } = useTranslation();
  const isRunning = data.status === "running" || data.status === "starting";
  const frac = data.total_clips > 0 ? data.processed_clips / data.total_clips : 0;
  const pct = Math.round(frac * 100);

  let bg = "var(--accent-soft)";
  let textColor = "var(--accent)";
  if (data.status === "failed") {
    bg = "var(--danger-soft)";
    textColor = "var(--danger-text)";
  } else if (data.status === "completed") {
    bg = "#e6f7e6";
    textColor = "#2e7d32";
  } else if (data.status === "cancelled") {
    bg = "#fff8e1";
    textColor = "#f57f17";
  }

  return (
    <div
      style={{
        background: bg,
        borderRadius: "var(--radius)",
        padding: "12px 16px",
        marginBottom: 12,
        fontSize: 13,
        color: textColor,
      }}
      role="status"
      aria-live="polite"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: isRunning ? 8 : 0,
        }}
      >
        <span style={{ fontWeight: 500 }}>
          {isRunning && t("personClips.reprocessRunning")}
          {data.status === "completed" && t("personClips.reprocessCompleted")}
          {data.status === "failed" && t("personClips.reprocessFailed")}
          {data.status === "cancelled" && t("personClips.reprocessCancelled")}
        </span>
        <span>
          {t("personClips.reprocessProgress", {
            processed: data.processed_clips,
            total: data.total_clips,
          })}
        </span>
      </div>

      {isRunning && (
        <div
          style={{
            width: "100%",
            height: 6,
            background: "rgba(0,0,0,0.08)",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.max(2, pct)}%`,
              height: "100%",
              background: textColor,
              borderRadius: 3,
              transition: "width 0.5s ease",
            }}
          />
        </div>
      )}

      <div style={{ display: "flex", gap: 16, marginTop: isRunning ? 8 : 4, fontSize: 12 }}>
        <span>{t("personClips.reprocessMatched", { count: data.matched_total })}</span>
        {data.failed_count > 0 && (
          <span>{t("personClips.reprocessErrors", { count: data.failed_count })}</span>
        )}
        {data.use_cases.length > 0 && (
          <span style={{ display: "flex", gap: 4 }}>
            {data.use_cases.map((uc) => (
              <span key={uc} className="pill pill-neutral" style={{ fontSize: 10 }}>
                {uc.toUpperCase()}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Reprocess dialog ──────────────────────────────────────────────────────────

function ReprocessDialog({
  busy,
  onStart,
  onClose,
}: {
  busy: boolean;
  onStart: (req: { mode: "all" | "skip_existing"; use_cases: string[] }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"all" | "skip_existing">("all");
  const [selectedUcs, setSelectedUcs] = useState<Set<string>>(new Set(["uc3"]));

  const toggleUc = (uc: string) => {
    setSelectedUcs((prev) => {
      const next = new Set(prev);
      if (next.has(uc)) next.delete(uc);
      else next.add(uc);
      return next;
    });
  };

  const canStart = selectedUcs.size > 0;

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("personClips.reprocessConfirmTitle")}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg)",
            width: 460,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "var(--accent-soft)",
                display: "grid",
                placeItems: "center",
                color: "var(--accent)",
              }}
            >
              <Icon name="refresh" size={14} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {t("personClips.reprocessConfirmTitle")}
            </div>
          </div>

          {/* Mode selection */}
          <div style={{ marginBottom: 14 }}>
            <div
              style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500, marginBottom: 6 }}
            >
              Mode
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(["all", "skip_existing"] as const).map((m) => (
                <label
                  key={m}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <input
                    type="radio"
                    name="reprocess-mode"
                    value={m}
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    style={{ marginTop: 2, accentColor: "var(--accent)" }}
                  />
                  <div>
                    <div style={{ fontWeight: 500 }}>
                      {m === "all" ? "Reprocess all clips" : "Skip already matched"}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {m === "all"
                        ? "Overwrites any existing results"
                        : "Only processes clips with no match yet"}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Use-case selection */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500, marginBottom: 6 }}
            >
              Use cases
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["uc1", "uc2", "uc3"].map((uc) => (
                <label
                  key={uc}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 10px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                    background: selectedUcs.has(uc) ? "var(--accent-soft)" : "var(--bg)",
                    fontSize: 12,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedUcs.has(uc)}
                    onChange={() => toggleUc(uc)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <span style={{ fontWeight: 600 }}>{uc.toUpperCase()}</span>
                  <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                    {uc === "uc1" ? "YOLO+Face" : uc === "uc2" ? "InsightFace+crops" : "InsightFace"}
                  </span>
                </label>
              ))}
            </div>
            {selectedUcs.size === 0 && (
              <div style={{ fontSize: 11, color: "var(--danger-text)", marginTop: 4 }}>
                Select at least one use case.
              </div>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onStart({ mode, use_cases: Array.from(selectedUcs) })}
              disabled={busy || !canStart}
            >
              {busy ? t("personClips.reprocessRunning") : t("personClips.reprocessYesStart")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ── UC metadata + helpers ────────────────────────────────────────────────────

// One source of truth for per-use-case presentation. Each UC gets a
// label, a one-line description of the processing pipeline, an accent
// colour for the section, and a single-letter glyph for the chip.
const UC_META: Record<
  string,
  { label: string; mode: string; accent: string; glyph: string }
> = {
  uc1: {
    label: "Use Case 1",
    mode: "YOLO + Face crops",
    accent: "#2563eb",
    glyph: "1",
  },
  uc2: {
    label: "Use Case 2",
    mode: "InsightFace + crops",
    accent: "#7c3aed",
    glyph: "2",
  },
  uc3: {
    label: "Use Case 3",
    mode: "InsightFace direct match",
    accent: "#0b6e4f",
    glyph: "3",
  },
};

// ── FaceCropLightbox ─────────────────────────────────────────────────────────
// Large preview modal opened by clicking a crop tile. Shows the full
// image plus a metadata side panel; arrow keys + Esc work.

interface LightboxCrop {
  id: number;
  width: number;
  height: number;
  employee_id: number | null;
  employee_name: string | null;
  quality_score: number;
  detection_score: number;
  event_timestamp: string;
  use_case: string | null;
  // Per-employee best confidence resolved from the UC's match_details
  // (the per-crop confidence isn't persisted today — this is the best
  // we have without rerunning).
  match_confidence: number | null;
}

function FaceCropLightbox({
  clipId,
  crops,
  startIndex,
  onClose,
  ucLabel,
  ucMode,
  ucAccent,
}: {
  clipId: number;
  crops: LightboxCrop[];
  startIndex: number;
  onClose: () => void;
  ucLabel: string;
  ucMode: string;
  ucAccent: string;
}) {
  const [index, setIndex] = useState(startIndex);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const crop = crops[index];

  // Load full-size image for the active crop.
  useEffect(() => {
    if (!crop) return;
    let revoked = false;
    setObjectUrl(null);
    setFailed(false);
    fetch(`/api/person-clips/${clipId}/face-crops/${crop.id}/image`, {
      credentials: "same-origin",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (revoked) return;
        setObjectUrl(URL.createObjectURL(blob));
      })
      .catch(() => {
        if (!revoked) setFailed(true);
      });
    return () => {
      revoked = true;
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [clipId, crop]);

  // Keyboard nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft")
        setIndex((i) => (i > 0 ? i - 1 : crops.length - 1));
      else if (e.key === "ArrowRight")
        setIndex((i) => (i < crops.length - 1 ? i + 1 : 0));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [crops.length, onClose]);

  if (!crop) return null;

  const ts = new Date(crop.event_timestamp);
  const isMatched = crop.employee_id !== null;
  const conf = crop.match_confidence;

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Face crop preview"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(2, 6, 23, 0.78)",
        backdropFilter: "blur(6px)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg)",
          borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
          maxWidth: "min(92vw, 1080px)",
          width: "100%",
          maxHeight: "92vh",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 1fr)",
          overflow: "hidden",
          fontFamily: "var(--font-sans)",
        }}
      >
        {/* Left — image with prev/next overlays */}
        <div
          style={{
            position: "relative",
            background: "#0b1220",
            display: "grid",
            placeItems: "center",
            minHeight: 360,
            padding: 18,
          }}
        >
          {failed ? (
            <div style={{ color: "#94a3b8", fontSize: 13 }}>
              Image failed to load.
            </div>
          ) : !objectUrl ? (
            <div
              style={{
                width: 220,
                height: 220,
                borderRadius: 12,
                background: "rgba(255,255,255,0.06)",
              }}
            />
          ) : (
            <img
              src={objectUrl}
              alt="face crop"
              style={{
                maxWidth: "100%",
                maxHeight: "80vh",
                objectFit: "contain",
                borderRadius: 10,
                boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
              }}
            />
          )}

          {/* Prev / Next */}
          {crops.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setIndex(index > 0 ? index - 1 : crops.length - 1)}
                aria-label="Previous"
                style={{
                  position: "absolute",
                  left: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.10)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 18,
                  display: "grid",
                  placeItems: "center",
                  fontFamily: "var(--font-sans)",
                }}
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => setIndex(index < crops.length - 1 ? index + 1 : 0)}
                aria-label="Next"
                style={{
                  position: "absolute",
                  right: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.10)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 18,
                  display: "grid",
                  placeItems: "center",
                  fontFamily: "var(--font-sans)",
                }}
              >
                ›
              </button>
            </>
          )}

          {/* Position pill */}
          {crops.length > 1 && (
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: "50%",
                transform: "translateX(-50%)",
                background: "rgba(0,0,0,0.5)",
                color: "#fff",
                fontSize: 11,
                padding: "4px 10px",
                borderRadius: 999,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {index + 1} / {crops.length}
            </div>
          )}
        </div>

        {/* Right — metadata panel */}
        <div
          style={{
            padding: "20px 22px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            overflowY: "auto",
          }}
        >
          {/* UC chip + close */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 10px",
                borderRadius: 999,
                background: `${ucAccent}1a`,
                color: ucAccent,
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {ucLabel}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              {ucMode}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                fontSize: 22,
                lineHeight: 1,
                cursor: "pointer",
                padding: 4,
              }}
            >
              ×
            </button>
          </div>

          {/* Name + status */}
          <div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                lineHeight: 1.2,
                color: "var(--text)",
              }}
            >
              {isMatched
                ? crop.employee_name || `Employee #${crop.employee_id}`
                : "Unknown Person"}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 12,
                color: isMatched ? "#2e7d32" : "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              {isMatched ? "Matched" : "Not identified"}
            </div>
          </div>

          {/* Confidence bar */}
          {isMatched && conf !== null && (
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginBottom: 4,
                }}
              >
                <span>Match confidence</span>
                <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                  {(conf * 100).toFixed(1)}%
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: "var(--bg-elev)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${Math.max(2, Math.min(100, conf * 100))}%`,
                    background: `linear-gradient(90deg, ${ucAccent} 0%, ${ucAccent}cc 100%)`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Metadata grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              fontSize: 12,
            }}
          >
            <MetaCell label="Quality" value={crop.quality_score.toFixed(3)} />
            <MetaCell
              label="Detection score"
              value={crop.detection_score.toFixed(3)}
            />
            <MetaCell
              label="Dimensions"
              value={`${crop.width}×${crop.height}px`}
            />
            <MetaCell
              label="Time"
              value={ts.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            />
            <MetaCell
              label="Date"
              value={ts.toLocaleDateString(undefined, {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
            />
            <MetaCell label="Crop ID" value={`#${crop.id}`} />
          </div>

          {/* Footer hint */}
          {crops.length > 1 && (
            <div
              style={{
                marginTop: "auto",
                fontSize: 11,
                color: "var(--text-tertiary, var(--text-secondary))",
                paddingTop: 8,
                borderTop: "1px solid var(--border)",
              }}
            >
              ← → to navigate · Esc to close
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-secondary)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 3,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ── FaceCropTile ─────────────────────────────────────────────────────────────
// Clickable crop card with image, name overlay, quality pill.

function FaceCropTile({
  clipId,
  cropId,
  name,
  quality,
  matched,
  onClick,
}: {
  clipId: number;
  cropId: number;
  name: string | null;
  quality: number;
  matched: boolean;
  onClick: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    setObjectUrl(null);
    setFailed(false);
    fetch(`/api/person-clips/${clipId}/face-crops/${cropId}/image`, {
      credentials: "same-origin",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (revoked) return;
        setObjectUrl(URL.createObjectURL(blob));
      })
      .catch(() => {
        if (!revoked) setFailed(true);
      });
    return () => {
      revoked = true;
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [clipId, cropId]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        matched ? `Open ${name ?? "matched"} face crop` : "Open unknown face crop"
      }
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "1 / 1",
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
        padding: 0,
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        transition: "transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.transform = "translateY(-2px)";
        el.style.boxShadow = "0 8px 20px rgba(0,0,0,0.12)";
        el.style.borderColor = matched ? "var(--accent)" : "var(--text-secondary)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        el.style.transform = "translateY(0)";
        el.style.boxShadow = "none";
        el.style.borderColor = "var(--border)";
      }}
    >
      {/* Image */}
      {failed ? (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "grid",
            placeItems: "center",
            color: "var(--text-secondary)",
            fontSize: 20,
          }}
        >
          ✕
        </div>
      ) : !objectUrl ? (
        <div style={{ width: "100%", height: "100%", background: "var(--bg-muted)" }} />
      ) : (
        <img
          src={objectUrl}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      )}

      {/* Quality pill (top-right) */}
      <span
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          fontSize: 10,
          fontWeight: 600,
          padding: "2px 7px",
          borderRadius: 999,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.02em",
        }}
        aria-hidden
      >
        q{quality.toFixed(2)}
      </span>

      {/* Status dot (top-left) */}
      <span
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: matched ? "#22c55e" : "rgba(255,255,255,0.55)",
          boxShadow: "0 0 0 2px rgba(0,0,0,0.35)",
        }}
        aria-hidden
      />

      {/* Name overlay (bottom) */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "6px 8px",
          background:
            "linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.78) 100%)",
          color: "#fff",
          fontSize: 11,
          fontWeight: 600,
          textAlign: "start",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {matched ? name ?? "Matched" : "Unknown"}
      </div>
    </button>
  );
}

// ── UseCaseResultSection ─────────────────────────────────────────────────────
// One dashboard-style card per UC: header strip, KPI row, crop grid.

function UseCaseResultSection({
  useCase,
  result,
  cropsData,
  loading,
  clipId,
}: {
  useCase: "uc1" | "uc2" | "uc3";
  result: ClipProcessingResult | null;
  cropsData: FaceCropListResponse | undefined;
  loading: boolean;
  clipId: number;
}) {
  const meta = UC_META[useCase];
  if (!meta) return null;
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Resolve per-employee best confidence from match_details so the
  // lightbox can show a "match confidence" bar even though per-crop
  // confidence isn't persisted at the row level.
  const confByEmployee = new Map<number, number>();
  if (result?.match_details) {
    for (const m of result.match_details as { employee_id?: number; confidence?: number }[]) {
      if (typeof m.employee_id === "number" && typeof m.confidence === "number") {
        const prev = confByEmployee.get(m.employee_id);
        if (prev === undefined || m.confidence > prev) {
          confByEmployee.set(m.employee_id, m.confidence);
        }
      }
    }
  }

  const crops = cropsData?.items ?? [];
  // Stable order: matched first (by employee name), then unknown,
  // each group ordered by quality desc.
  const ordered = [...crops].sort((a, b) => {
    const am = a.employee_id !== null ? 0 : 1;
    const bm = b.employee_id !== null ? 0 : 1;
    if (am !== bm) return am - bm;
    if (a.employee_id !== null && b.employee_id !== null) {
      const cmp = (a.employee_name ?? "").localeCompare(b.employee_name ?? "");
      if (cmp !== 0) return cmp;
    }
    return b.quality_score - a.quality_score;
  });

  const lightboxCrops: LightboxCrop[] = ordered.map((c) => ({
    id: c.id,
    width: c.width,
    height: c.height,
    employee_id: c.employee_id,
    employee_name: c.employee_name,
    quality_score: c.quality_score,
    detection_score: c.detection_score,
    event_timestamp: c.event_timestamp,
    use_case: c.use_case,
    match_confidence:
      c.employee_id !== null ? confByEmployee.get(c.employee_id) ?? null : null,
  }));

  const matchedCount = ordered.filter((c) => c.employee_id !== null).length;
  const unknownCount = ordered.length - matchedCount;

  // Status pill style.
  const status = result?.status ?? "pending";
  const statusStyles: Record<string, { bg: string; fg: string; label: string }> = {
    completed: { bg: "#dcfce7", fg: "#15803d", label: "Completed" },
    processing: { bg: "#dbeafe", fg: "#1d4ed8", label: "Processing" },
    pending: { bg: "var(--bg-elev)", fg: "var(--text-secondary)", label: "Pending" },
    failed: { bg: "#fee2e2", fg: "#b91c1c", label: "Failed" },
    skipped: { bg: "var(--bg-elev)", fg: "var(--text-secondary)", label: "Skipped" },
  };
  const sp = statusStyles[status] ?? statusStyles.pending!;

  // Per-phase durations for the mini-stat row.
  const totalMs = result?.duration_ms;
  const extractMs = result?.face_extract_duration_ms;
  const matchMs = result?.match_duration_ms;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 14,
        overflow: "hidden",
        background: "var(--bg)",
        marginBottom: 14,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      {/* Header strip — accent gradient */}
      <div
        style={{
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: `linear-gradient(135deg, ${meta.accent}14 0%, transparent 100%)`,
          borderBottom: "1px solid var(--border)",
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
            fontWeight: 700,
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          {meta.glyph}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            {meta.label}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            {meta.mode}
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            background: sp.bg,
            color: sp.fg,
            padding: "3px 10px",
            borderRadius: 999,
          }}
        >
          {sp.label}
        </span>
      </div>

      {/* If processing — show phase bars (existing) */}
      {result && (status === "processing" || status === "pending") && (
        <div style={{ padding: "12px 16px" }}>
          <PhaseBar
            label="Face extraction"
            durationMs={extractMs}
            totalMs={totalMs}
            isActive={status === "processing" && extractMs == null}
            isDone={status === "processing" && extractMs != null}
            color={meta.accent}
          />
          <PhaseBar
            label="Face matching"
            durationMs={matchMs}
            totalMs={totalMs}
            isActive={status === "processing" && extractMs != null}
            isDone={false}
            color="#4caf50"
          />
        </div>
      )}

      {/* KPI strip — only when something to report */}
      {result && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 8,
            padding: "10px 16px",
            borderBottom: ordered.length > 0 ? "1px solid var(--border)" : "none",
          }}
        >
          <Kpi label="Faces saved" value={String(result.face_crop_count)} />
          <Kpi label="Matched" value={String(matchedCount)} accent="#15803d" />
          <Kpi label="Unknown" value={String(unknownCount)} />
          <Kpi
            label="Extract"
            value={extractMs != null ? fmtMs(extractMs) : "—"}
          />
          <Kpi
            label="Match"
            value={matchMs != null ? fmtMs(matchMs) : "—"}
          />
          <Kpi
            label="Total"
            value={totalMs != null ? fmtMs(totalMs) : "—"}
          />
        </div>
      )}

      {/* Empty / loading / grid */}
      {loading && (
        <div
          style={{
            padding: 20,
            fontSize: 12,
            color: "var(--text-secondary)",
            textAlign: "center",
          }}
        >
          Loading face crops…
        </div>
      )}
      {!loading && result && ordered.length === 0 && (
        <div
          style={{
            padding: 20,
            fontSize: 12,
            color: "var(--text-secondary)",
            textAlign: "center",
          }}
        >
          No face crops saved for this run.
        </div>
      )}
      {!loading && !result && (
        <div
          style={{
            padding: 20,
            fontSize: 12,
            color: "var(--text-secondary)",
            textAlign: "center",
          }}
        >
          Not yet processed for {meta.label}. Right-click the clip card
          or use Reprocess to run.
        </div>
      )}

      {!loading && ordered.length > 0 && (
        <div
          style={{
            padding: "12px 16px 16px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
            gap: 10,
          }}
        >
          {ordered.map((c, i) => (
            <FaceCropTile
              key={c.id}
              clipId={clipId}
              cropId={c.id}
              name={c.employee_name}
              quality={c.quality_score}
              matched={c.employee_id !== null}
              onClick={() => setLightboxIndex(i)}
            />
          ))}
        </div>
      )}

      {/* Error */}
      {result?.error && (
        <div
          style={{
            padding: "8px 16px 14px",
            fontSize: 12,
            color: "var(--danger-text)",
          }}
        >
          {result.error}
        </div>
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <FaceCropLightbox
          clipId={clipId}
          crops={lightboxCrops}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          ucLabel={meta.label}
          ucMode={meta.mode}
          ucAccent={meta.accent}
        />
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-secondary)",
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 3,
          fontSize: 16,
          fontWeight: 700,
          color: accent ?? "var(--text)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ── ClipDetailDrawer ──────────────────────────────────────────────────────────

function ClipDetailDrawer({ clip, onClose }: { clip: PersonClipOut; onClose: () => void }) {
  const [showReprocessForm, setShowReprocessForm] = useState(false);
  const [selectedUcs, setSelectedUcs] = useState<Set<string>>(new Set(["uc3"]));
  const [thumbError, setThumbError] = useState(false);

  const processingResults = useClipProcessingResults(clip.id, true);
  const results = processingResults.data?.results ?? [];

  const uc1Result = results.find((r) => r.use_case === "uc1") ?? null;
  const uc2Result = results.find((r) => r.use_case === "uc2") ?? null;
  const uc3Result = results.find((r) => r.use_case === "uc3") ?? null;

  const uc1Crops = useClipFaceCrops(uc1Result ? clip.id : null, "uc1");
  const uc2Crops = useClipFaceCrops(uc2Result ? clip.id : null, "uc2");
  const uc3Crops = useClipFaceCrops(uc3Result ? clip.id : null, "uc3");

  const reprocess = useSingleClipReprocess(clip.id);

  const res =
    clip.resolution_w && clip.resolution_h
      ? `${clip.resolution_w}×${clip.resolution_h}`
      : null;
  const fps =
    clip.fps_recorded ??
    (clip.duration_seconds > 0 ? clip.frame_count / clip.duration_seconds : null);

  const toggleUc = (uc: string) => {
    setSelectedUcs((prev) => {
      const next = new Set(prev);
      if (next.has(uc)) next.delete(uc);
      else next.add(uc);
      return next;
    });
  };

  const handleRunReprocess = () => {
    if (selectedUcs.size === 0) return;
    reprocess.mutate(
      { use_cases: Array.from(selectedUcs) },
      {
        onSuccess: () => setShowReprocessForm(false),
      },
    );
  };

  return (
    <DrawerShell open onClose={onClose}>
      <div className="drawer">
        {/* Header */}
        <div className="drawer-head">
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Clip #{clip.id}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {clip.camera_name} · {fmtTimestamp(clip.clip_start)}
            </div>
          </div>
          <button className="icon-btn" aria-label="Close drawer" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="drawer-body">
          {/* Thumbnail */}
          {!thumbError && (
            <img
              src={`/api/person-clips/${clip.id}/thumbnail`}
              alt=""
              onError={() => setThumbError(true)}
              style={{
                width: "100%",
                aspectRatio: "16 / 9",
                objectFit: "cover",
                borderRadius: "var(--radius-sm)",
                background: "#111",
                marginBottom: 14,
                display: "block",
              }}
            />
          )}

          {/* Basic stats row */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              marginBottom: 14,
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            {[
              fmtDuration(clip.duration_seconds),
              fmtFileSize(clip.filesize_bytes),
              res,
              fps !== null ? `${fps.toFixed(1)} fps` : null,
              `${clip.frame_count} frames`,
            ]
              .filter((v): v is string => v !== null)
              .map((v) => (
                <span key={v}>{v}</span>
              ))}
          </div>

          {/* Person / match summary */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span
                style={{
                  fontWeight: 700,
                  fontSize: 20,
                  color: personCountColor(clip.person_count ?? 0),
                }}
              >
                {clip.person_count ?? 0}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {(clip.person_count ?? 0) === 1 ? "person" : "persons"}
              </span>
            </div>
            {clip.matched_employee_names.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {clip.matched_employee_names.map((n) => (
                  <span key={n} className="pill pill-primary" style={{ fontSize: 10 }}>
                    {n}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Inline reprocess form */}
          {showReprocessForm && (
            <div
              style={{
                border: "1px solid var(--accent-soft)",
                borderRadius: "var(--radius-sm)",
                padding: "12px 14px",
                marginBottom: 14,
                background: "var(--accent-soft)",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  marginBottom: 8,
                }}
              >
                Select use cases
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                {(["uc1", "uc2", "uc3"] as const).map((uc) => (
                  <label
                    key={uc}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 9px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      background: selectedUcs.has(uc) ? "var(--bg-elev)" : "var(--bg)",
                      fontSize: 12,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedUcs.has(uc)}
                      onChange={() => toggleUc(uc)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    <span style={{ fontWeight: 600 }}>{uc.toUpperCase()}</span>
                    <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                      {uc === "uc1" ? "YOLO+Face" : uc === "uc2" ? "InsightFace+crops" : "InsightFace"}
                    </span>
                  </label>
                ))}
              </div>
              {selectedUcs.size === 0 && (
                <div style={{ fontSize: 11, color: "var(--danger-text)", marginBottom: 8 }}>
                  Select at least one use case.
                </div>
              )}
              {reprocess.data?.running && (
                <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 8 }}>
                  A reprocess is already running for this clip.
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowReprocessForm(false)}
                  disabled={reprocess.isPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleRunReprocess}
                  disabled={reprocess.isPending || selectedUcs.size === 0}
                >
                  {reprocess.isPending ? "Starting…" : "Run"}
                </button>
              </div>
            </div>
          )}

          {/* Use case sections — one dashboard card per UC. Each card
              owns its own header strip, KPI row, crop grid and
              lightbox. Phase bars render in place while a run is in
              progress. Sections always render in UC1 → UC2 → UC3
              order; not-yet-processed UCs show an empty-state hint. */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                marginBottom: 10,
              }}
            >
              Use Case Results
            </div>
            {processingResults.isLoading && (
              <div className="text-sm text-dim">Loading…</div>
            )}
            <UseCaseResultSection
              useCase="uc1"
              result={uc1Result}
              cropsData={uc1Crops.data}
              loading={uc1Crops.isLoading}
              clipId={clip.id}
            />
            <UseCaseResultSection
              useCase="uc2"
              result={uc2Result}
              cropsData={uc2Crops.data}
              loading={uc2Crops.isLoading}
              clipId={clip.id}
            />
            <UseCaseResultSection
              useCase="uc3"
              result={uc3Result}
              cropsData={uc3Crops.data}
              loading={uc3Crops.isLoading}
              clipId={clip.id}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="drawer-foot">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          {!showReprocessForm && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ display: "flex", alignItems: "center", gap: 6 }}
              onClick={() => setShowReprocessForm(true)}
            >
              <Icon name="refresh" size={12} /> Reprocess clip
            </button>
          )}
        </div>
      </div>
    </DrawerShell>
  );
}

// ── PhaseBar — shared by UseCaseResultSection for in-flight progress ─────────

function PhaseBar({
  label,
  durationMs,
  totalMs,
  isActive,
  isDone,
  color,
}: {
  label: string;
  durationMs: number | null | undefined;
  totalMs: number | null | undefined;
  isActive: boolean;
  isDone: boolean;
  color: string;
}) {
  const pct =
    durationMs != null && totalMs != null && totalMs > 0
      ? Math.min(100, Math.round((durationMs / totalMs) * 100))
      : null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--text-secondary)",
          marginBottom: 3,
        }}
      >
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
          {durationMs != null ? fmtMs(durationMs) : isActive ? "running…" : isDone ? "—" : "waiting…"}
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "rgba(0,0,0,0.07)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {isDone && pct !== null ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: "100%",
              width: `${pct}%`,
              background: color,
              borderRadius: 3,
              transition: "width 0.3s ease",
            }}
          />
        ) : isActive ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: "100%",
              width: "40%",
              background: color,
              borderRadius: 3,
              opacity: 0.7,
              animation: "processingSlide 1.4s ease-in-out infinite",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
