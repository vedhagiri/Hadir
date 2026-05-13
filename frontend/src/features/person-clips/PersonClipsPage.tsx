import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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

// ── Page ─────────────────────────────────────────────────────────────────────

type Tab = "clips" | "pipeline" | "system" | "comparison";

export function PersonClipsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("clips");
  const [filters, setFilters] = useState<PersonClipFilters>({
    camera_id: null,
    employee_id: null,
    start: null,
    end: null,
    page: 1,
    page_size: PAGE_SIZE,
  });
  const [deleteTarget, setDeleteTarget] = useState<PersonClipOut | null>(null);
  const [bulkDeleteTarget, setBulkDeleteTarget] = useState<PersonClipOut[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [reprocessDialog, setReprocessDialog] = useState(false);
  const [selectedClip, setSelectedClip] = useState<PersonClipOut | null>(null);

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
          <p className="page-sub">
            {list.data ? `${list.data.total} ${t("personClips.totalSuffix")}` : "—"}
            {stats.data && stats.data.total_clips > 0
              ? ` · ${fmtFileSize(stats.data.total_size_bytes)} ${t("personClips.totalSizeSuffix")}`
              : ""}
          </p>
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

      {/* ── Stats bar ── */}
      {stats.data && <PipelineStatsBar stats={stats.data} />}

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
    </>
  );
}

// ── PipelineStatsBar ─────────────────────────────────────────────────────────

function PipelineStatsBar({ stats }: { stats: PersonClipStats }) {
  const pills: { label: string; value: number; color?: string }[] = [
    { label: "Pending", value: stats.pending_match, color: "var(--text-secondary)" },
    { label: "Processing", value: stats.processing_match, color: "var(--accent)" },
    { label: "Completed", value: stats.completed_match, color: "#2e7d32" },
    { label: "Failed", value: stats.failed_match, color: "var(--danger-text)" },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginBottom: 12,
        flexWrap: "wrap",
      }}
    >
      {pills.map((p) => (
        <div
          key={p.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            fontSize: 12,
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
        </div>
      ))}
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

function ClipCard({
  clip,
  isSelected,
  onToggleSelect,
  onDelete,
  onOpenDetail,
}: {
  clip: PersonClipOut;
  isSelected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
  onOpenDetail: () => void;
}) {
  const [showVideo, setShowVideo] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState(false);
  const [playError, setPlayError] = useState(false);
  const thumbUrl = `/api/person-clips/${clip.id}/thumbnail`;
  const { t } = useTranslation();

  const personCount = clip.person_count ?? 0;
  const matchedCount = clip.matched_employee_names?.length ?? 0;
  const unknownCount = Math.max(0, personCount - matchedCount);
  const clipStart = new Date(clip.clip_start);
  const hourStr = clipStart.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const dateStr = clipStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

  const handlePlay = () => {
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
    >
      {/* Checkbox overlay */}
      <div style={{ position: "absolute", top: 6, left: 6, zIndex: 2 }}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select clip ${clip.id}`}
          style={{ width: 16, height: 16, cursor: "pointer", accentColor: "var(--accent)" }}
        />
      </div>

      {/* Thumbnail / Video */}
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#111",
          display: "grid",
          placeItems: "center",
          cursor: "pointer",
        }}
        onClick={handlePlay}
        role="button"
        aria-label="Play clip"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handlePlay();
          }
        }}
      >
        {showVideo && videoUrl && !playError ? (
          <video
            src={videoUrl}
            controls
            autoPlay
            style={{ width: "100%", height: "100%", display: "block" }}
            onError={() => setPlayError(true)}
          />
        ) : !thumbError ? (
          <img
            src={thumbUrl}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={() => setThumbError(true)}
          />
        ) : playError ? (
          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11 }}>Load failed</div>
        ) : null}

        {!showVideo && (
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
              <Icon name="play" size={32} strokeWidth={1} />
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                {fmtDuration(clip.duration_seconds)}
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

  const hasComparison = uc1Result !== null && uc2Result !== null;
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

          {/* Processing results */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                marginBottom: 8,
              }}
            >
              Processing Results
            </div>
            {processingResults.isLoading && (
              <div className="text-sm text-dim">Loading…</div>
            )}
            {results.length === 0 && !processingResults.isLoading && (
              <div className="text-sm text-dim">No processing results yet.</div>
            )}
            {results.map((result) => (
              <ProcessingResultCard key={result.id} result={result} />
            ))}
          </div>

          {/* Face crops — UC3 always shown; UC1/UC2 shown when available */}
          {(uc1Result !== null || uc2Result !== null || uc3Result !== null) && (
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: 8,
                }}
              >
                Face Crops{hasComparison ? " — UC1 vs UC2" : ""}
              </div>

              {/* UC1 / UC2 comparison or single */}
              {hasComparison ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: uc3Result !== null ? 12 : 0 }}>
                  <FaceCropGallery
                    clipId={clip.id}
                    cropsData={uc1Crops.data}
                    loading={uc1Crops.isLoading}
                  />
                  <FaceCropGallery
                    clipId={clip.id}
                    cropsData={uc2Crops.data}
                    loading={uc2Crops.isLoading}
                  />
                </div>
              ) : uc1Result !== null ? (
                <div style={{ marginBottom: uc3Result !== null ? 12 : 0 }}>
                  <FaceCropGallery
                    clipId={clip.id}
                    cropsData={uc1Crops.data}
                    loading={uc1Crops.isLoading}
                  />
                </div>
              ) : uc2Result !== null ? (
                <div style={{ marginBottom: uc3Result !== null ? 12 : 0 }}>
                  <FaceCropGallery
                    clipId={clip.id}
                    cropsData={uc2Crops.data}
                    loading={uc2Crops.isLoading}
                  />
                </div>
              ) : null}

              {/* UC3 always rendered when it ran — canonical pipeline, shows
                  all detected faces whether matched or unknown */}
              {uc3Result !== null && (
                <FaceCropGallery
                  clipId={clip.id}
                  cropsData={uc3Crops.data}
                  loading={uc3Crops.isLoading}
                />
              )}
            </div>
          )}
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

// ── ProcessingResultCard ──────────────────────────────────────────────────────

const UC_LABEL: Record<string, string> = {
  uc1: "UC1 — YOLO+Face",
  uc2: "UC2 — InsightFace",
  uc3: "UC3 — InsightFace (canonical)",
};

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

function ProcessingResultCard({ result }: { result: ClipProcessingResult }) {
  const isProcessing = result.status === "processing" || result.status === "pending";
  const isDone = result.status === "completed" || result.status === "failed" || result.status === "skipped";

  const extractMs = result.face_extract_duration_ms;
  const matchMs = result.match_duration_ms;
  const totalMs = result.duration_ms;

  // Which phase is currently active when status=processing?
  // Once face_extract_duration_ms is populated, we've moved to matching.
  const extractActive = isProcessing && extractMs == null;
  const matchActive = isProcessing && extractMs != null;

  const statusColor: Record<string, string> = {
    completed: "#2e7d32",
    failed: "var(--danger-text)",
    processing: "var(--accent)",
    pending: "var(--text-secondary)",
    skipped: "var(--text-secondary)",
  };
  const color = statusColor[result.status] ?? "var(--text-secondary)";

  const startTime = result.started_at ? new Date(result.started_at) : null;
  const endTime = result.ended_at ? new Date(result.ended_at) : null;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "12px 14px",
        marginBottom: 8,
      }}
    >
      {/* Header: UC label + status pill */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 12 }}>
          {UC_LABEL[result.use_case] ?? result.use_case.toUpperCase()}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color,
            background:
              result.status === "completed"
                ? "#e6f7e6"
                : result.status === "failed"
                  ? "var(--danger-soft)"
                  : result.status === "processing"
                    ? "var(--accent-soft)"
                    : "var(--bg-elev)",
            padding: "2px 8px",
            borderRadius: "var(--radius-sm)",
          }}
        >
          {result.status}
          {isProcessing && extractMs == null && " · extracting"}
          {isProcessing && extractMs != null && " · matching"}
        </span>
      </div>

      {/* Two-phase progress bars */}
      <PhaseBar
        label="Face extraction"
        durationMs={extractMs}
        totalMs={totalMs}
        isActive={extractActive}
        isDone={isDone || matchActive}
        color="var(--accent)"
      />
      <PhaseBar
        label="Face matching"
        durationMs={matchMs}
        totalMs={totalMs}
        isActive={matchActive}
        isDone={isDone}
        color="#4caf50"
      />

      {/* Timestamps */}
      {(startTime || endTime) && (
        <div
          style={{
            display: "flex",
            gap: 16,
            fontSize: 11,
            color: "var(--text-secondary)",
            marginTop: 4,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          {startTime && (
            <span>
              Start:{" "}
              {startTime.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
          {endTime && (
            <span>
              End:{" "}
              {endTime.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
          {totalMs != null && <span>Total: {fmtMs(totalMs)}</span>}
        </div>
      )}

      {/* Match results */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          fontSize: 12,
          color: "var(--text-secondary)",
          alignItems: "center",
        }}
      >
        {result.face_crop_count > 0 && (
          <span>
            {result.face_crop_count} crop{result.face_crop_count !== 1 ? "s" : ""}
          </span>
        )}
        {result.matched_employee_names.length > 0 &&
          result.matched_employee_names.map((n) => (
            <span key={n} className="pill pill-primary" style={{ fontSize: 10 }}>
              {n}
            </span>
          ))}
        {result.unknown_count > 0 && <span>+{result.unknown_count} unknown</span>}
      </div>

      {result.error && (
        <div style={{ color: "var(--danger-text)", marginTop: 6, fontSize: 11 }}>
          {result.error}
        </div>
      )}
    </div>
  );
}

// ── FaceCropImage ─────────────────────────────────────────────────────────────

function FaceCropImage({ clipId, cropId }: { clipId: number; cropId: number }) {
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

  if (failed) {
    return (
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "var(--bg-muted)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          color: "var(--text-secondary)",
        }}
      >
        ✕
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "var(--bg-muted)",
        }}
      />
    );
  }

  return (
    <img
      src={objectUrl}
      alt="face crop"
      style={{
        width: 96,
        height: 96,
        objectFit: "cover",
        borderRadius: "var(--radius)",
        border: "2px solid var(--border)",
        display: "block",
      }}
    />
  );
}

// ── FaceCropGallery ───────────────────────────────────────────────────────────
// Groups crops by matched employee (identified) vs unknown persons.

function FaceCropGallery({
  clipId,
  cropsData,
  loading,
}: {
  clipId: number;
  cropsData: FaceCropListResponse | undefined;
  loading: boolean;
}) {
  const crops = cropsData?.items ?? [];

  if (loading) {
    return (
      <div style={{ padding: "8px 0", color: "var(--text-secondary)", fontSize: 13 }}>
        Loading face crops…
      </div>
    );
  }

  if (crops.length === 0) {
    return (
      <div style={{ padding: "8px 0", color: "var(--text-secondary)", fontSize: 13 }}>
        No face crops saved. Reprocess this clip to generate crops.
      </div>
    );
  }

  // Group by employee_id (null → unknown)
  const groups = new Map<number | null, { name: string | null; crops: typeof crops }>();
  for (const crop of crops) {
    const key = crop.employee_id ?? null;
    if (!groups.has(key)) {
      groups.set(key, { name: crop.employee_name ?? null, crops: [] });
    }
    groups.get(key)!.crops.push(crop);
  }

  // Sort: matched employees first (alphabetically), then unknown last
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    const na = groups.get(a)?.name ?? "";
    const nb = groups.get(b)?.name ?? "";
    return na.localeCompare(nb);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {sortedKeys.map((key) => {
        const group = groups.get(key)!;
        const isMatched = key !== null;
        return (
          <div
            key={key ?? "unknown"}
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            {/* Group header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                background: isMatched ? "var(--accent-subtle, rgba(0,0,0,0.04))" : "var(--bg-muted)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: isMatched ? "var(--accent)" : "var(--text-secondary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  fontSize: 13,
                  color: isMatched ? "#fff" : "#fff",
                  fontWeight: 700,
                }}
              >
                {isMatched
                  ? (group.name ?? "?").charAt(0).toUpperCase()
                  : "?"}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {isMatched ? (group.name ?? `Employee #${key}`) : "Unknown Person"}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {group.crops.length} face crop{group.crops.length !== 1 ? "s" : ""}
                  {!isMatched && " · not identified"}
                </div>
              </div>
            </div>

            {/* Crop grid */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                padding: 12,
              }}
            >
              {group.crops.map((crop) => (
                <div key={crop.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <FaceCropImage clipId={clipId} cropId={crop.id} />
                  <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                    q{crop.quality_score.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
