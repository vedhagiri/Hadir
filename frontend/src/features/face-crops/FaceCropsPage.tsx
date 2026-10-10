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
import { SkeletonCards, SkeletonGrid } from "../../components/Skeleton";
import { EmptyPanel, FilterSelect, ResetButton, StatGrid, Toolbar } from "../../components/ListPageUi";
import { StatTile, TILE_ICON } from "../person-clips/StatTile";
import "../person-clips/clips.css";

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

  const st = clipsStatus.data;
  const totalCrops = list.data?.total_crops ?? stats.data?.total_crops ?? 0;
  const cameraFilterActive = filters.camera_id !== null;
  // Addendum — "no records at all": no crops and no filter narrowing.
  // Hides the stat grid + toolbar; the card below shows one EmptyPanel
  // carrying the page's primary action (Process Face Crops).
  const noRecords =
    !list.isLoading && !list.isError && list.data !== undefined && list.data.groups.length === 0 && !cameraFilterActive;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("faceCrops.title", "Face Crops")}</h1>
          <p className="page-sub">
            {t("faceCrops.pageSub", {
              defaultValue: "Faces extracted from recorded clips, grouped by the event they came from.",
            })}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={handleProcess}
            disabled={isProcessing}
          >
            <Icon name="user" size={13} />
            {isProcessing
              ? t("faceCrops.processing", "Processing…")
              : t("faceCrops.processBtn", "Process Face Crops")}
          </button>
        </div>
      </div>

      {stats.isLoading || clipsStatus.isLoading ? (
        <div style={{ marginBottom: 14 }}>
          <SkeletonCards count={4} minWidth={220} />
        </div>
      ) : noRecords ? null : (
        <StatGrid>
          <StatTile
            tone="info"
            icon={TILE_ICON.face}
            label={t("faceCrops.stats.crops", { defaultValue: "Face crops" })}
            value={totalCrops.toLocaleString()}
            sub={t("faceCrops.stats.cropsSub", {
              defaultValue: "across {{n}} events",
              n: (list.data?.total_groups ?? 0).toLocaleString(),
            })}
          />
          <StatTile
            tone="success"
            icon={TILE_ICON.check}
            label={t("faceCrops.stats.processed", { defaultValue: "Clips processed" })}
            value={(st?.processed ?? 0).toLocaleString()}
            sub={t("faceCrops.stats.ofTotal", { defaultValue: "of {{n}} clips", n: (st?.total ?? 0).toLocaleString() })}
          />
          <StatTile
            tone="warning"
            icon={TILE_ICON.clock}
            label={t("faceCrops.stats.pending", { defaultValue: "Pending" })}
            value={((st?.pending ?? 0) + (st?.processing ?? 0)).toLocaleString()}
            sub={
              isProcessing
                ? t("faceCrops.stats.pendingRunning", { defaultValue: "processing now" })
                : t("faceCrops.stats.pendingSub", { defaultValue: "waiting for extraction" })
            }
          />
          <StatTile
            tone="danger"
            icon={TILE_ICON.alert}
            label={t("faceCrops.stats.failed", { defaultValue: "Failed" })}
            value={(st?.failed ?? 0).toLocaleString()}
            sub={t("faceCrops.stats.failedSub", { defaultValue: "retried on next run" })}
          />
        </StatGrid>
      )}

      {!noRecords && (
      <Toolbar>
        <FilterSelect
          label={t("faceCrops.cameraLabel", { defaultValue: "Camera" })}
          value={filters.camera_id === null ? "" : String(filters.camera_id)}
          onChange={(v) => updateFilters({ camera_id: v === "" ? null : Number(v) })}
          options={[
            ["", t("faceCrops.allCameras", "All cameras")],
            ...(cameras.data?.items ?? []).map((c) => [String(c.id), c.name] as [string, string]),
          ]}
        />
        {isProcessing && (
          <span role="status" className="pill pill-accent">
            <span aria-hidden className="pill-dot cl-live-dot" />
            {t("faceCrops.processingHint", "Processing clips in background…")}
          </span>
        )}
        <ResetButton
          active={cameraFilterActive}
          label={t("faceCrops.reset", { defaultValue: "Reset" })}
          onClick={() => updateFilters({ camera_id: null })}
        />
      </Toolbar>
      )}

      <div className="card" style={{ padding: noRecords ? 0 : 14 }}>
        {list.isLoading && <SkeletonGrid count={12} />}
        {list.isError && (
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={28} />}
            title={t("faceCrops.loadFailed", "Could not load face crops.")}
            body={t("faceCrops.loadFailedBody", { defaultValue: "Something went wrong while fetching face crops. Try again in a moment." })}
            actions={
              <button type="button" className="btn" onClick={() => void list.refetch()}>
                <Icon name="refresh" size={12} />
                {t("faceCrops.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        )}
        {list.data && list.data.groups.length === 0 && !list.isLoading && (
          cameraFilterActive && hasExistingCrops ? (
            <EmptyPanel
              icon={<Icon name="filter" size={28} />}
              title={t("faceCrops.emptyFilteredTitle", { defaultValue: "No face crops from this camera" })}
              body={t("faceCrops.emptyFilteredBody", { defaultValue: "Pick another camera or show crops from every camera." })}
              actions={
                <button type="button" className="btn" onClick={() => updateFilters({ camera_id: null })}>
                  <Icon name="refresh" size={12} />
                  {t("faceCrops.showAll", { defaultValue: "Show all cameras" })}
                </button>
              }
            />
          ) : clipsCount > 0 ? (
            <EmptyPanel
              tone="accent"
              icon={<Icon name="user" size={30} />}
              title={t("faceCrops.pendingClips", "{{count}} clip(s) available for processing.", { count: clipsCount })}
              body={t("faceCrops.clickProcess", 'Click "Process Face Crops" to extract faces.')}
              actions={
                <button type="button" className="btn btn-primary" onClick={handleProcess} disabled={isProcessing}>
                  <Icon name="user" size={12} />
                  {t("faceCrops.processBtn", "Process Face Crops")}
                </button>
              }
            />
          ) : (
            <EmptyPanel
              tone="accent"
              icon={<Icon name="user" size={30} />}
              title={t("faceCrops.empty", "No face crops yet.")}
              body={t("faceCrops.emptyHint", "Record person clips from cameras first.")}
            />
          )
        )}

        {list.data && list.data.groups.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {list.data.groups.map((group) => (
              <ClipGroupCard
                key={group.person_clip_id}
                group={group}
                onPreview={(cropId) => setPreviewCropId(cropId)}
              />
            ))}
          </div>
        )}

        {(list.data?.total_groups ?? 0) > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "12px 4px 2px",
              marginTop: 12,
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
        )}
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
    <div className="cl-group">
      {/* Clip info header */}
      <div className="cl-group-head">
        <div className="cl-group-meta">
          <span className="cl-group-title">
            <Icon name="camera" size={13} />
            {group.camera_name}
          </span>
          <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Icon name="clock" size={10} />
            {group.clip_start ? fmtTimestamp(group.clip_start) : "—"}
          </span>
        </div>
        <div className="cl-group-meta">
          <span className="mono">
            {t("faceCrops.clipId", "Clip")} #{group.person_clip_id}
          </span>
          <span className="pill pill-accent">
            {group.crops.length} {t("faceCrops.faces", "faces")}
          </span>
          {group.track_count > 0 && (
            <span>
              {group.track_count} {t("faceCrops.tracks", "tracks")}
            </span>
          )}
          {group.duration_seconds > 0 && (
            <span className="mono">{fmtDuration(group.duration_seconds)}</span>
          )}
        </div>
      </div>

      {/* Face crops grid */}
      <div className="cl-crop-grid">
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
  const { t } = useTranslation();
  const imgUrl = `/api/face-crops/${crop.id}/image`;
  const score = crop.quality_score;
  const scoreTone = score >= 0.75 ? "pill-success" : score >= 0.5 ? "pill-neutral" : "pill-warning";

  return (
    <div
      className="cl-media-card"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={t("faceCrops.cropAria", { defaultValue: "Face {{face}} from clip {{clip}}", face: crop.face_index, clip: clipId })}
    >
      <div className="cl-media-thumb is-square">
        <img className="cl-media-img-fade" src={imgUrl} alt="" />
      </div>
      <div className="cl-crop-caption">
        <span className={`pill ${scoreTone} mono`} title={t("faceCrops.qualityTitle", { defaultValue: "Quality score" })}>
          #{crop.face_index} · {fmtScore(score)}
        </span>
        <span className="cl-media-id">
          {crop.width}×{crop.height}
        </span>
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
  const { t } = useTranslation();
  const imgUrl = `/api/face-crops/${cropId}/image`;

  return (
    <ModalShell onClose={onClose}>
      <div
        className="cl-lightbox"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t("faceCrops.previewAria", { defaultValue: "Face crop preview" })}
      >
        <div className="cl-lightbox-inner" onClick={(e) => e.stopPropagation()}>
          <img src={imgUrl} alt="" />
          <div className="cl-lightbox-bar">
            <span className="mono">{t("faceCrops.cropLabel", { defaultValue: "Crop #{{id}}", id: cropId })}</span>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              <Icon name="x" size={12} /> {t("common.close")}
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
