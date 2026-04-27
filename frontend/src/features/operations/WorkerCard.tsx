// Per-worker card on the Operations / Workers page.
//
// Sections (top to bottom):
//   - Header row: name + status pill + uptime + actions
//   - Pipeline stages (4 pills via PipelineStagesView)
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

interface Props {
  worker: WorkerStats;
  onRestart: (cameraId: number) => void;
  restartPending: boolean;
}

const STATUS_PILL: Record<WorkerStatus, string> = {
  starting: "pill-info",
  running: "pill-success",
  reconnecting: "pill-warning",
  stopped: "pill-neutral",
  failed: "pill-danger",
};

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatMetadataFooter(
  m: WorkerStats["metadata"],
  t: (k: string) => string,
): string {
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
  const hasMetadata = !!(
    md.resolution_w ||
    md.codec ||
    md.fps ||
    md.brand ||
    md.mount_location
  );

  return (
    <>
      <div
        className="card"
        style={{ padding: 16, marginBottom: 12 }}
      >
        {/* Header row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {worker.camera_name}
            </div>
            <div className="text-xs text-dim mono">
              camera_id={worker.camera_id}
            </div>
          </div>
          <span className={`pill ${STATUS_PILL[worker.status]}`}>
            {t(`operations.status.${worker.status}`) as string}
          </span>
          <span className="text-xs text-dim">
            {worker.status === "running"
              ? formatUptime(worker.uptime_sec)
              : "—"}
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setErrorsOpen(true)}
            aria-label={t("operations.actions.viewErrors") as string}
            title={t("operations.actions.viewErrors") as string}
          >
            <Icon name="bell" size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setConfirmRestart(true)}
            disabled={restartPending}
            aria-label={t("operations.actions.restart") as string}
            title={t("operations.actions.restart") as string}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>

        {/* Pipeline stages */}
        <PipelineStagesView stages={worker.stages} />

        {/* Counters */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: 8,
            marginTop: 12,
            padding: "8px 10px",
            background: "var(--bg-sunken)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <Counter
            label={t("operations.counters.fpsReader") as string}
            value={worker.fps_reader.toFixed(1)}
          />
          <Counter
            label={t("operations.counters.fpsAnalyzer") as string}
            value={worker.fps_analyzer.toFixed(1)}
          />
          <Counter
            label={t("operations.counters.framesAnalyzed") as string}
            value={String(worker.frames_analyzed_60s)}
          />
          <Counter
            label={t("operations.counters.motionSkipped") as string}
            value={String(worker.frames_motion_skipped_60s)}
          />
          <Counter
            label={t("operations.counters.facesSaved") as string}
            value={String(worker.faces_saved_60s)}
          />
          <Counter
            label={t("operations.counters.matches") as string}
            value={String(worker.matches_60s)}
          />
        </div>

        {/* Metadata footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            fontSize: 11.5,
            color: "var(--text-tertiary)",
          }}
        >
          <span style={{ flex: 1 }}>{formatMetadataFooter(md, (k) => t(k) as string)}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setMetadataOpen(true)}
            aria-label={t("operations.actions.editMetadata") as string}
            title={t("operations.actions.editMetadata") as string}
          >
            <Icon name="edit" size={11} />
          </button>
          {!hasMetadata && (
            <span style={{ color: "var(--text-secondary)" }}>
              {t("operations.metadata.add") as string}
            </span>
          )}
          {md.detected_at && (
            <span className="mono" style={{ fontSize: 10.5 }}>
              {t("operations.metadata.detectedAt") as string}{" "}
              {new Date(md.detected_at).toLocaleDateString()}
            </span>
          )}
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
        <RecentErrorsDrawer
          cameraId={worker.camera_id}
          cameraName={worker.camera_name}
          onClose={() => setErrorsOpen(false)}
        />
      )}

      {metadataOpen && (
        <CameraMetadataModal
          cameraId={worker.camera_id}
          initial={{
            brand: md.brand,
            model: md.model,
            mount_location: md.mount_location,
          }}
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
      <div
        style={{
          fontSize: 9.5,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 14,
          fontWeight: 600,
          marginTop: 2,
          color: "var(--text)",
        }}
      >
        {value}
      </div>
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
  return (
    <ModalShell onClose={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          top: "50%",
          insetInlineStart: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 51,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          width: 420,
          maxWidth: "calc(100vw - 32px)",
          padding: 18,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {t("operations.restart.singleTitle", { name: cameraName }) as string}
        </h3>
        <p
          className="text-sm text-dim"
          style={{ marginTop: 8, marginBottom: 14 }}
        >
          {t("operations.restart.singleBody") as string}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={onCancel}>
            {t("common.cancel") as string}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={pending}
          >
            {t("operations.actions.restart") as string}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
