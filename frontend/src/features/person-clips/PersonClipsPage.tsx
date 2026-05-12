import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import {
  useBulkDeletePersonClips,
  useCameraOptions,
  useDeletePersonClip,
  usePersonClipStats,
  usePersonClips,
  useReprocessFaceMatch,
  useReprocessStatus,
} from "./hooks";
import type { PersonClipFilters, PersonClipOut, ReprocessFaceMatchStatus } from "./types";

const PAGE_SIZE = 24;

function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function personCountColor(count: number): string {
  if (count >= 3) return "var(--danger-text, #e53935)";
  if (count >= 2) return "var(--accent, #f59e0b)";
  return "var(--text-secondary, #888)";
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

export function PersonClipsPage() {
  const { t } = useTranslation();
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
  const [reprocessDialog, setReprocessDialog] = useState<"none" | "initial" | "existing-data">("none");

  const cameras = useCameraOptions();
  const list = usePersonClips(filters);
  const stats = usePersonClipStats();
  const del = useDeletePersonClip();
  const bulkDel = useBulkDeletePersonClips();
  const reprocess = useReprocessFaceMatch();
  const reprocessStatus = useReprocessStatus();

  const hasExistingMatchData = list.data?.items.some((c) => c.matched_employees.length > 0) ?? false;
  const isReprocessing = reprocessStatus.data?.status === "running" || reprocessStatus.data?.status === "starting";
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
    const all = new Set(list.data.items.map((c) => c.id));
    setSelectedIds(all);
  };

  const deselectAll = () => setSelectedIds(new Set());

  const selectedClips = list.data
    ? list.data.items.filter((c) => selectedIds.has(c.id))
    : [];

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

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("personClips.title")}</h1>
          <p className="page-sub">
            {list.data
              ? `${list.data.total} ${t("personClips.totalSuffix")}`
              : "—"}
            {stats.data && stats.data.total_clips > 0
              ? ` · ${fmtFileSize(stats.data.total_size_bytes)} ${t("personClips.totalSizeSuffix")}`
              : ""}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setReprocessDialog(hasExistingMatchData ? "existing-data" : "initial")}
          disabled={isReprocessing}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
          aria-label={t("personClips.reprocessBtn")}
        >
          <Icon name="refresh" size={12} />
          {isReprocessing ? t("personClips.reprocessRunning") : t("personClips.reprocessBtn")}
        </button>
      </div>

      {reprocessData && (isReprocessing || reprocessData.status === "completed" || reprocessData.status === "failed" || reprocessData.status === "cancelled") && (
        <ReprocessStatusBar data={reprocessData} />
      )}

      <div className="card">
        <div className="card-head">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
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
                    if (selectedIds.size === list.data.items.length) {
                      deselectAll();
                    } else {
                      selectAll();
                    }
                  }}
                  style={{ accentColor: "var(--accent)" }}
                />
                All
              </label>
            )}
            <h3 className="card-title">{t("personClips.listTitle")}</h3>
          </div>
          <div
            className="flex gap-2"
            style={{ alignItems: "center", flexWrap: "wrap" as const }}
          >
            <select
              value={filters.camera_id ?? ""}
              onChange={(e) =>
                updateFilters({
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
              onChange={(e) => updateFilters({ start: e.target.value || null })}
              style={selectStyle}
              title={t("personClips.from")}
              aria-label={t("personClips.from")}
            />
            <input
              type="datetime-local"
              value={filters.end ?? ""}
              onChange={(e) => updateFilters({ end: e.target.value || null })}
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
          <div
            className="text-sm"
            style={{ padding: 16, color: "var(--danger-text)" }}
          >
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
                <span style={{ fontWeight: 500 }}>
                  {selectedIds.size} selected
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={deselectAll}
                  style={{ marginLeft: "auto" }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ background: "var(--danger)", color: "white" }}
                  onClick={() =>
                    setBulkDeleteTarget(selectedClips)
                  }
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
                onToggleSelect={() => toggleSelect(clip.id)}
                onDelete={() => setDeleteTarget(clip)}
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
              onClick={() => handlePageChange(filters.page - 1)}
            >
              <Icon name="chevronLeft" size={11} />
              {t("common.previous")}
            </button>
            <button
              className="btn btn-sm"
              disabled={filters.page >= totalPages}
              onClick={() => handlePageChange(filters.page + 1)}
            >
              {t("common.next")}
              <Icon name="chevronRight" size={11} />
            </button>
          </div>
        </div>
      </div>

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

      {reprocessDialog !== "none" && (
        <ReprocessFaceMatchDialogs
          mode={reprocessDialog}
          busy={reprocess.isPending}
          onStart={() => {
            reprocess.mutate("all", {
              onSuccess: () => setReprocessDialog("none"),
            });
          }}
          onClose={() => setReprocessDialog("none")}
          {...(reprocessDialog === "existing-data"
            ? {
                onSkipExisting: () => {
                  reprocess.mutate("skip_existing", {
                    onSuccess: () => setReprocessDialog("none"),
                  });
                },
              }
            : {})}
        />
      )}
    </>
  );
}

function ClipCard({
  clip,
  isSelected,
  onToggleSelect,
  onDelete,
}: {
  clip: PersonClipOut;
  isSelected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
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
  const approxFps = clip.duration_seconds > 0 ? Math.round(clip.frame_count / clip.duration_seconds) : 0;
  const isMatched = matchedCount > 0;
  const hasUnknown = unknownCount > 0;
  const matchProgress = clip.face_matching_progress ?? 0;
  const isMatching = matchProgress > 0 && matchProgress < 100;
  const matchDuration = clip.face_matching_duration_ms;
  const personStart = clip.person_start ? new Date(clip.person_start) : null;
  const personEnd = clip.person_end ? new Date(clip.person_end) : null;

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
      <div
        style={{
          position: "absolute",
          top: 6,
          left: 6,
          zIndex: 2,
        }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select clip ${clip.id}`}
          style={{
            width: 16,
            height: 16,
            cursor: "pointer",
            accentColor: "var(--accent)",
          }}
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
            style={{
              width: "100%",
              height: "100%",
              display: "block",
            }}
            onError={() => setPlayError(true)}
          />
        ) : !thumbError ? (
          <img
            src={thumbUrl}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
            onError={() => setThumbError(true)}
          />
        ) : playError ? (
          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11 }}>
            Load failed
          </div>
        ) : null}

        {/* Play overlay when showing thumbnail */}
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

      {/* Face matching progress bar */}
      {isMatching && (
        <div
          style={{
            padding: "6px 12px 0",
          }}
        >
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

      {/* Header row: Camera name + Event ID */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 12px 4px",
        }}
      >
        <span
          className="pill pill-neutral"
          style={{ fontSize: 10, fontWeight: 500 }}
        >
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

        {/* Timestamp + duration row */}
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
          <span>{dateStr} {hourStr}</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>{fmtDuration(clip.duration_seconds)}</span>
          {personStart && personEnd && (
            <>
              <span style={{ opacity: 0.4 }}>|</span>
              <span>
                Person {personStart.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                &ndash;
                {personEnd.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </span>
            </>
          )}
        </div>

      {/* Separator */}
      <div style={{ height: 1, background: "var(--border)", margin: "0 12px" }} />

      {/* Person count + names */}
      <div style={{ padding: "8px 12px 4px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
          }}
        >
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
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              marginTop: 6,
            }}
          >
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

      {/* Separator */}
      <div style={{ height: 1, background: "var(--border)", margin: "0 12px" }} />

      {/* Footer metadata bar */}
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
            gap: 10,
            fontSize: 10,
            color: "var(--text-secondary)",
            alignItems: "center",
          }}
        >
          <span>{fmtFileSize(clip.filesize_bytes)}</span>
          <span style={{ opacity: 0.3 }}>·</span>
          <span>{clip.frame_count} frames</span>
          {approxFps > 0 && (
            <>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>{approxFps} fps</span>
            </>
          )}
          {matchDuration !== null && matchDuration !== undefined && (
            <>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>{matchDuration < 1000 ? `${matchDuration}ms` : `${(matchDuration / 1000).toFixed(1)}s`}</span>
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
            }}
          >
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
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {t("personClips.deleteTitle")}
            </div>
          </div>
          <div
            className="text-sm text-dim"
            style={{ marginBottom: 16, lineHeight: 1.5 }}
          >
            {t("personClips.deleteBody", {
              camera: clip.camera_name,
              time: fmtTimestamp(clip.clip_start),
              person_count: clip.person_count ?? 0,
            })}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={busy}
            >
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
            }}
          >
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
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {t("personClips.deleteTitle")}
            </div>
          </div>
          <div
            className="text-sm text-dim"
            style={{ marginBottom: 16, lineHeight: 1.5 }}
          >
            {t("personClips.bulkDeleteBody", { count })}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={busy}
            >
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

/** Reprocess progress/completion bar shown between header and card. */
function ReprocessStatusBar({ data }: { data: ReprocessFaceMatchStatus }) {
  const { t } = useTranslation();
  const isRunning = data.status === "running" || data.status === "starting";
  const frac = data.total_clips > 0 ? data.processed_clips / data.total_clips : 0;
  const pct = Math.round(frac * 100);
  const isRed = data.status === "failed";
  const isGreen = data.status === "completed";
  const isYellow = data.status === "cancelled";

  let bg = "var(--accent-soft)";
  let textColor = "var(--accent)";
  if (isRed) { bg = "var(--danger-soft)"; textColor = "var(--danger-text)"; }
  if (isGreen) { bg = "#e6f7e6"; textColor = "#2e7d32"; }
  if (isYellow) { bg = "#fff8e1"; textColor = "#f57f17"; }

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

      <div
        style={{
          display: "flex",
          gap: 16,
          marginTop: isRunning ? 8 : 4,
          fontSize: 12,
        }}
      >
        <span>
          {t("personClips.reprocessMatched", { count: data.matched_total })}
        </span>
        {data.failed_count > 0 && (
          <span>
            {t("personClips.reprocessErrors", { count: data.failed_count })}
          </span>
        )}
      </div>
    </div>
  );
}

/** Confirmation dialogs for triggering reprocess. */
function ReprocessFaceMatchDialogs({
  mode,
  busy,
  onStart,
  onSkipExisting,
  onClose,
}: {
  mode: "initial" | "existing-data";
  busy: boolean;
  onStart: () => void;
  onSkipExisting?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const isDataExists = mode === "existing-data";

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
          aria-label={
            isDataExists
              ? t("personClips.reprocessDataExistsTitle")
              : t("personClips.reprocessConfirmTitle")
          }
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg)",
            width: 440,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
            }}
          >
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
              {isDataExists
                ? t("personClips.reprocessDataExistsTitle")
                : t("personClips.reprocessConfirmTitle")}
            </div>
          </div>

          <div
            className="text-sm text-dim"
            style={{ marginBottom: 16, lineHeight: 1.5 }}
          >
            {isDataExists
              ? t("personClips.reprocessDataExistsBody")
              : t("personClips.reprocessConfirmBody")}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            {isDataExists && onSkipExisting && (
              <button
                type="button"
                className="btn"
                onClick={onSkipExisting}
                disabled={busy}
              >
                {t("personClips.reprocessSkipExisting")}
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={onStart}
              disabled={busy}
            >
              {isDataExists
                ? t("personClips.reprocessAll")
                : t("personClips.reprocessYesStart")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
