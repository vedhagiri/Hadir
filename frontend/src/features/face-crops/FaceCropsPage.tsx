import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import {
  useCameraOptions,
  useClipsProcessingStatus,
  useFaceCropStats,
  useFaceCropsByClip,
  useStartProcessing,
} from "./hooks";
import type { ByClipFilters, ClipGroup, FaceCropInGroup } from "./types";

const PAGE_SIZE = 20;

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function fmtScore(score: number): string {
  return (score * 100).toFixed(0) + "%";
}

export function FaceCropsPage() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<ByClipFilters>({
    camera_id: null,
    page: 1,
    page_size: PAGE_SIZE,
  });
  const [previewCropId, setPreviewCropId] = useState<number | null>(null);
  const [showProcessDialog, setShowProcessDialog] = useState(false);
  const [showReprocessDialog, setShowReprocessDialog] = useState(false);

  const cameras = useCameraOptions();
  const list = useFaceCropsByClip(filters);
  const stats = useFaceCropStats();
  const clipsStatus = useClipsProcessingStatus();
  const startProcessing = useStartProcessing();

  const hasExistingCrops = (stats.data?.total_crops ?? 0) > 0;
  const isProcessing = clipsStatus.data?.is_processing ?? false;

  const totalPages = Math.max(
    1,
    Math.ceil((list.data?.total_groups ?? 0) / PAGE_SIZE),
  );

  const updateFilters = (patch: Partial<ByClipFilters>) => {
    setFilters((prev) => ({ ...prev, page: 1, ...patch }));
  };

  const handleProcess = useCallback(() => {
    if (hasExistingCrops) {
      setShowReprocessDialog(true);
    } else {
      setShowProcessDialog(true);
    }
  }, [hasExistingCrops]);

  const handleProcessConfirm = useCallback(() => {
    setShowProcessDialog(false);
    startProcessing.mutate({});
  }, [startProcessing]);

  const handleReprocess = useCallback(() => {
    setShowReprocessDialog(false);
    startProcessing.mutate({ reprocess: true });
  }, [startProcessing]);

  const handleSkipExisting = useCallback(() => {
    setShowReprocessDialog(false);
    startProcessing.mutate({});
  }, [startProcessing]);

  const clipsCount =
    (clipsStatus.data?.pending ?? 0) + (clipsStatus.data?.failed ?? 0);

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
          <h1 className="page-title">{t("faceCrops.title", "Face Crops")}</h1>
          <p className="page-sub">
            {list.data
              ? `${list.data.total_crops} ${t("faceCrops.totalSuffix", "crops")}`
              : "—"}
            {stats.data && stats.data.total_crops > 0
              ? ` · ${t("faceCrops.fromClips", "from")} ${list.data?.total_groups ?? 0} ${t("faceCrops.clips", "clips")}`
              : ""}
            {clipsStatus.data && clipsStatus.data.pending > 0
              ? ` · ${clipsStatus.data.pending} pending`
              : ""}
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleProcess}
          disabled={isProcessing}
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}
        >
          <Icon name="user" size={13} />
          {isProcessing
            ? t("faceCrops.processing", "Processing…")
            : t("faceCrops.processBtn", "Process Face Crops")}
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 className="card-title">
              {t("faceCrops.byClipTitle", "Crops by event")}
            </h3>
          </div>
          <div
            className="flex gap-2"
            style={{ alignItems: "center", flexWrap: "wrap" as const }}
          >
            {isProcessing && (
              <span
                className="text-sm"
                style={{
                  color: "var(--accent)",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    animation: "pulse 1.5s infinite",
                  }}
                />
                {t("faceCrops.processingHint", "Processing clips in background…")}
              </span>
            )}
            <select
              value={filters.camera_id ?? ""}
              onChange={(e) =>
                updateFilters({
                  camera_id: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              style={selectStyle}
              aria-label={t("faceCrops.filterCamera", "Filter by camera")}
            >
              <option value="">
                {t("faceCrops.allCameras", "All cameras")}
              </option>
              {cameras.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
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
            {t("faceCrops.loadFailed", "Could not load face crops.")}
          </div>
        )}
        {list.data &&
          list.data.groups.length === 0 &&
          !list.isLoading && (
            <div
              className="text-sm text-dim"
              style={{ padding: 16, textAlign: "center" }}
            >
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>
                <Icon name="user" size={32} />
              </div>
              {clipsCount > 0 ? (
                <>
                  <p style={{ marginBottom: 8 }}>
                    {t(
                      "faceCrops.pendingClips",
                      "{{count}} clip(s) available for processing.",
                      { count: clipsCount },
                    )}
                  </p>
                  <p>
                    {t(
                      "faceCrops.clickProcess",
                      'Click "Process Face Crops" to extract faces.',
                    )}
                  </p>
                </>
              ) : (
                <>
                  <p style={{ marginBottom: 8 }}>
                    {t("faceCrops.empty", "No face crops yet.")}
                  </p>
                  <p>
                    {t(
                      "faceCrops.emptyHint",
                      "Record person clips from cameras first.",
                    )}
                  </p>
                </>
              )}
            </div>
          )}

        {list.data && list.data.groups.length > 0 && (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 20 }}>
            {list.data.groups.map((group) => (
              <ClipGroupCard
                key={group.person_clip_id}
                group={group}
                onPreview={(cropId) => setPreviewCropId(cropId)}
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
            {t("personClips.page")} {filters.page} {t("personClips.of")}{" "}
            {totalPages}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn btn-sm"
              disabled={filters.page <= 1}
              onClick={() =>
                setFilters((prev) => ({ ...prev, page: prev.page - 1 }))
              }
            >
              <Icon name="chevronLeft" size={11} />
              {t("common.previous")}
            </button>
            <button
              className="btn btn-sm"
              disabled={filters.page >= totalPages}
              onClick={() =>
                setFilters((prev) => ({ ...prev, page: prev.page + 1 }))
              }
            >
              {t("common.next")}
              <Icon name="chevronRight" size={11} />
            </button>
          </div>
        </div>
      </div>

      {previewCropId !== null && (
        <FaceCropPreview
          cropId={previewCropId}
          onClose={() => setPreviewCropId(null)}
        />
      )}

      {showProcessDialog && (
        <ProcessConfirmDialog
          onConfirm={handleProcessConfirm}
          onClose={() => setShowProcessDialog(false)}
        />
      )}

      {showReprocessDialog && (
        <ReprocessConfirmDialog
          onReprocess={handleReprocess}
          onSkipExisting={handleSkipExisting}
          onClose={() => setShowReprocessDialog(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Clip Group Card — shows one clip/event with its extracted face crops
// ---------------------------------------------------------------------------

function ClipGroupCard({
  group,
  onPreview,
}: {
  group: ClipGroup;
  onPreview: (cropId: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-elev)",
        overflow: "hidden",
      }}
    >
      {/* Clip info header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap" as const,
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Icon name="camera" size={13} />
            {group.camera_name}
          </span>
          <span
            className="text-dim"
            style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
          >
            <Icon name="clock" size={10} />
            {group.clip_start ? fmtTimestamp(group.clip_start) : "—"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}>
          <span className="text-dim">
            {t("faceCrops.clipId", "Clip")} #{group.person_clip_id}
          </span>
          <span
            style={{
              background: "var(--accent-bg)",
              color: "var(--accent)",
              padding: "2px 6px",
              borderRadius: "var(--radius-sm)",
              fontWeight: 500,
            }}
          >
            {group.crops.length} {t("faceCrops.faces", "faces")}
          </span>
          {group.track_count > 0 && (
            <span className="text-dim">
              {group.track_count} {t("faceCrops.tracks", "tracks")}
            </span>
          )}
          {group.duration_seconds > 0 && (
            <span className="text-dim">{fmtDuration(group.duration_seconds)}</span>
          )}
        </div>
      </div>

      {/* Face crops grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 10,
          padding: 12,
        }}
      >
        {group.crops.map((crop) => (
          <FaceCropCard
            key={crop.id}
            crop={crop}
            clipId={group.person_clip_id}
            onClick={() => onPreview(crop.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Face crop card within a clip group
// ---------------------------------------------------------------------------

function FaceCropCard({
  crop,
  clipId,
  onClick,
}: {
  crop: FaceCropInGroup;
  clipId: number;
  onClick: () => void;
}) {
  const imgUrl = `/api/face-crops/${crop.id}/image`;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        background: "#111",
        cursor: "pointer",
      }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`Face ${crop.face_index} from clip ${clipId}`}
    >
      <div
        style={{
          width: "100%",
          aspectRatio: "1",
          display: "grid",
          placeItems: "center",
          overflow: "hidden",
        }}
      >
        <img
          src={imgUrl}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
          }}
        />
      </div>
      <div
        style={{
          padding: "5px 8px",
          fontSize: 10,
          lineHeight: 1.4,
          background: "var(--bg-elev)",
        }}
      >
        <div style={{ display: "flex", gap: 4, justifyContent: "space-between" }}>
          <span className="text-dim">
            #{crop.face_index} · {fmtScore(crop.quality_score)}
          </span>
          <span className="text-dim">
            {crop.width}×{crop.height}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview modal
// ---------------------------------------------------------------------------

function FaceCropPreview({
  cropId,
  onClose,
}: {
  cropId: number;
  onClose: () => void;
}) {
  const imgUrl = `/api/face-crops/${cropId}/image`;

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 24,
          background: "rgba(0,0,0,0.7)",
        }}
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label="Face crop preview"
      >
        <div
          style={{
            maxWidth: "90vw",
            maxHeight: "90vh",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={imgUrl}
            alt=""
            style={{
              maxWidth: "100%",
              maxHeight: "80vh",
              borderRadius: "var(--radius)",
              display: "block",
              objectFit: "contain",
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              color: "rgba(255,255,255,0.8)",
              fontSize: 13,
            }}
          >
            <span>Crop #{cropId}</span>
            <button
              type="button"
              className="btn btn-sm"
              style={{ background: "rgba(255,255,255,0.15)", color: "white" }}
              onClick={onClose}
            >
              <Icon name="x" size={12} /> Close
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialogs
// ---------------------------------------------------------------------------

function ProcessConfirmDialog({
  onConfirm,
  onClose,
}: {
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
          padding: 24,
          background: "rgba(0,0,0,0.6)",
        }}
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t("faceCrops.confirmProcessTitle", "Process face crops")}
      >
        <div
          style={{
            background: "var(--bg-elev)",
            borderRadius: "var(--radius)",
            padding: 24,
            maxWidth: 420,
            width: "100%",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>
            <Icon name="user" size={16} />{" "}
            {t("faceCrops.confirmProcessTitle", "Process Face Crops")}
          </h3>
          <p style={{ margin: "0 0 20px", fontSize: 13, lineHeight: 1.5 }}>
            {t(
              "faceCrops.confirmProcessBody",
              "Do you want to process all existing person clips and generate face crops?",
            )}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-sm" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-sm btn-primary" onClick={onConfirm}>
              {t("faceCrops.yesProcess", "Yes, Process")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function ReprocessConfirmDialog({
  onReprocess,
  onSkipExisting,
  onClose,
}: {
  onReprocess: () => void;
  onSkipExisting: () => void;
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
          padding: 24,
          background: "rgba(0,0,0,0.6)",
        }}
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t("faceCrops.reprocessTitle", "Reprocess face crops")}
      >
        <div
          style={{
            background: "var(--bg-elev)",
            borderRadius: "var(--radius)",
            padding: 24,
            maxWidth: 420,
            width: "100%",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>
            <Icon name="user" size={16} />{" "}
            {t("faceCrops.reprocessTitle", "Reprocess Face Crops")}
          </h3>
          <p style={{ margin: "0 0 20px", fontSize: 13, lineHeight: 1.5 }}>
            {t(
              "faceCrops.reprocessBody",
              "Face crops already exist for these clips. Do you want to reprocess them again?",
            )}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-sm" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-sm" onClick={onSkipExisting}>
              {t("faceCrops.skipExisting", "Skip Existing")}
            </button>
            <button className="btn btn-sm btn-primary" onClick={onReprocess}>
              {t("faceCrops.reprocess", "Reprocess")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
