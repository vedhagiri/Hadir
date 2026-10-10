// Per-worker card on the Operations / Workers page.
//
// Sections (top to bottom):
//   - Header row: name + status pill + uptime + actions
//   - Pipeline stages (4 cards via PipelineStagesView)
//   - Counters strip
//   - Metadata footer

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { CameraMetadataModal } from "./CameraMetadataModal";
import { PipelineStagesView } from "./PipelineStages";
import { RecentErrorsDrawer } from "./RecentErrorsDrawer";
import type { WorkerStats, WorkerStatus } from "./types";
import { ModalPanel, SoftPill, type PillTone } from "../system/opsUi";

interface Props {
  worker: WorkerStats;
  onRestart: (cameraId: number) => void;
  restartPending: boolean;
}

export const STATUS_TONE: Record<WorkerStatus, PillTone> = {
  starting: "info",
  running: "success",
  reconnecting: "warning",
  stopped: "neutral",
  failed: "danger",
};

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatMetadataFooter(m: WorkerStats["metadata"], t: (k: string) => string): string {
  const tech: string[] = [];
  if (m.resolution_w && m.resolution_h) {
    tech.push(`${m.resolution_w}×${m.resolution_h}`);
  }
  if (m.codec) tech.push(m.codec);
  if (m.fps) tech.push(`${m.fps} fps`);
  if (m.brand) tech.push(m.brand + (m.model ? ` ${m.model}` : ""));
  if (m.mount_location) tech.push(m.mount_location);
  if (tech.length === 0) return t("operations.metadata.empty");
  return tech.join(" · ");
}

export function WorkerCard({ worker, onRestart, restartPending }: Props) {
  const { t } = useTranslation();
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  const md = worker.metadata;
  const hasMetadata = !!(md.resolution_w || md.codec || md.fps || md.brand || md.mount_location);
  const tone = STATUS_TONE[worker.status];

  return (
    <>
      <div className={`card ops-worker-card tone-${tone}`}>
        {/* Header row */}
        <div className="ops-worker-head">
          <div className="ops-cam ops-worker-head-main">
            <span className={`ops-cam-icon${worker.status === "running" ? " is-on" : ""}`} aria-hidden>
              <Icon name="camera" size={14} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="ops-cam-name">{worker.camera_name}</div>
              <div className="ops-cam-meta mono">camera_id={worker.camera_id}</div>
            </div>
          </div>
          <SoftPill tone={tone}>{t(`operations.status.${worker.status}`) as string}</SoftPill>
          <span className="text-xs text-dim mono">{worker.status === "running" ? formatUptime(worker.uptime_sec) : "—"}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setErrorsOpen(true)}
            aria-label={t("operations.actions.viewErrors") as string}
            title={t("operations.actions.viewErrors") as string}
          >
            <Icon name="bell" size={13} />
            {t("operations.actions.viewErrors") as string}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setConfirmRestart(true)}
            disabled={restartPending}
            aria-label={t("operations.actions.restart") as string}
            title={t("operations.actions.restart") as string}
          >
            <Icon name="refresh" size={13} />
            {t("operations.actions.restart") as string}
          </button>
        </div>

        {/* Pipeline stages */}
        <PipelineStagesView stages={worker.stages} />

        {/* Counters */}
        <div className="ops-counter-grid">
          <Counter label={t("operations.counters.fpsReader") as string} value={worker.fps_reader.toFixed(1)} />
          <Counter label={t("operations.counters.fpsAnalyzer") as string} value={worker.fps_analyzer.toFixed(1)} />
          <Counter label={t("operations.counters.framesAnalyzed") as string} value={String(worker.frames_analyzed_60s)} />
          <Counter label={t("operations.counters.motionSkipped") as string} value={String(worker.frames_motion_skipped_60s)} />
          <Counter label={t("operations.counters.facesSaved") as string} value={String(worker.faces_saved_60s)} />
          <Counter label={t("operations.counters.matches") as string} value={String(worker.matches_60s)} />
        </div>

        {/* Metadata footer */}
        <div className="ops-worker-foot">
          <span className="grow">{formatMetadataFooter(md, (k) => t(k) as string)}</span>
          {!hasMetadata && <span>{t("operations.metadata.add") as string}</span>}
          {md.detected_at && (
            <span className="mono">
              {t("operations.metadata.detectedAt") as string} {new Date(md.detected_at).toLocaleDateString()}
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setMetadataOpen(true)}
            aria-label={t("operations.actions.editMetadata") as string}
            title={t("operations.actions.editMetadata") as string}
          >
            <Icon name="edit" size={11} />
            {t("operations.actions.editMetadata") as string}
          </button>
        </div>
      </div>

      {confirmRestart && (
        <ConfirmRestartModal
          cameraName={worker.camera_name}
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => {
            setConfirmRestart(false);
            onRestart(worker.camera_id);
          }}
          pending={restartPending}
        />
      )}

      {errorsOpen && (
        <RecentErrorsDrawer cameraId={worker.camera_id} cameraName={worker.camera_name} onClose={() => setErrorsOpen(false)} />
      )}

      {metadataOpen && (
        <CameraMetadataModal
          cameraId={worker.camera_id}
          initial={{ brand: md.brand, model: md.model, mount_location: md.mount_location }}
          detected={{
            resolution_w: md.resolution_w,
            resolution_h: md.resolution_h,
            fps: md.fps,
            codec: md.codec,
            detected_at: md.detected_at,
          }}
          onClose={() => setMetadataOpen(false)}
        />
      )}
    </>
  );
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="ops-counter-label">{label}</div>
      <div className="ops-counter-value">{value}</div>
    </div>
  );
}

function ConfirmRestartModal({
  cameraName,
  onCancel,
  onConfirm,
  pending,
}: {
  cameraName: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const title = t("operations.restart.singleTitle", { name: cameraName }) as string;
  return (
    <ModalShell onClose={onCancel}>
      <ModalPanel
        title={title}
        ariaLabel={title}
        footer={
          <>
            <button type="button" className="btn" onClick={onCancel}>
              {t("common.cancel") as string}
            </button>
            <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={pending}>
              <Icon name="refresh" size={12} />
              {t("operations.actions.restart") as string}
            </button>
          </>
        }
      >
        <p className="text-sm" style={{ margin: 0, color: "var(--text-secondary)" }}>{t("operations.restart.singleBody") as string}</p>
      </ModalPanel>
    </ModalShell>
  );
}
