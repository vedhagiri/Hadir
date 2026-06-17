// ClipCleanupModal — impact preview + confirm + progress loop.
//
// Three states:
//   1. ``loading_preview`` — fetching counts. Modal shows a spinner.
//   2. ``preview_ready``   — counts shown; operator confirms or cancels.
//   3. ``running``         — looping ``POST /clip-cleanup`` until
//                            ``has_more`` is false, accumulating totals.
//   4. ``done``            — final totals, single dismiss button.
//
// Cancellation: the operator can hit Cancel during the preview but
// not during the run (a single batch is bounded, and stopping mid-run
// would leave the operator without a tidy summary).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { extractApiError } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { useClipCleanupPreview, useRunClipCleanup } from "./hooks";
import type {
  ClipCleanupFilter,
  ClipCleanupPreviewResponse,
  ClipCleanupRunResponse,
} from "./types";

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function describeFilter(filter: ClipCleanupFilter, t: TFunction): string {
  if (filter.older_than_hours !== undefined) {
    return t("clipCleanupModal.filterHours", { count: filter.older_than_hours }) as string;
  }
  if (filter.older_than_days !== undefined) {
    return t("clipCleanupModal.filterDays", { count: filter.older_than_days }) as string;
  }
  if (filter.start_date && filter.end_date) {
    return t("clipCleanupModal.filterRange", { start: filter.start_date, end: filter.end_date }) as string;
  }
  return t("clipCleanupModal.filterMatch") as string;
}

interface RunProgress {
  batches: number;
  deleted: number;
  bytes: number;
  unlinked: number;
  missing: number;
  failed: number;
}

const ZERO: RunProgress = {
  batches: 0,
  deleted: 0,
  bytes: 0,
  unlinked: 0,
  missing: 0,
  failed: 0,
};

interface Props {
  filter: ClipCleanupFilter;
  onClose: () => void;
}

export function ClipCleanupModal({ filter, onClose }: Props) {
  const { t } = useTranslation();
  const preview = useClipCleanupPreview();
  const runCleanup = useRunClipCleanup();

  const [phase, setPhase] = useState<
    "loading_preview" | "preview_ready" | "running" | "done" | "error"
  >("loading_preview");
  const [progress, setProgress] = useState<RunProgress>(ZERO);
  const [previewData, setPreviewData] =
    useState<ClipCleanupPreviewResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Cancel a pending run loop if the operator dismisses mid-flight.
  // We don't actually stop in-flight requests (they're short by design),
  // but we stop scheduling new batches.
  const cancelled = useRef(false);

  // Fire the preview once on mount.
  useEffect(() => {
    let alive = true;
    preview.mutate(filter, {
      onSuccess: (data) => {
        if (!alive) return;
        setPreviewData(data);
        setPhase(data.clip_count === 0 ? "done" : "preview_ready");
      },
      onError: () => {
        if (!alive) return;
        setPhase("error");
      },
    });
    return () => {
      alive = false;
    };
    // mutate identity is stable for a given mutation object; running this
    // effect once on mount is the correct shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc to close (only when not actively running).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && phase !== "running") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  const expectedBatches = useMemo(() => {
    if (!previewData || previewData.cap <= 0) return 1;
    return Math.max(1, Math.ceil(previewData.clip_count / previewData.cap));
  }, [previewData]);

  const runBatch = (): Promise<ClipCleanupRunResponse> =>
    new Promise((resolve, reject) => {
      runCleanup.mutate(filter, {
        onSuccess: resolve,
        onError: (err) => reject(err),
      });
    });

  const startRun = async () => {
    setPhase("running");
    setProgress(ZERO);
    cancelled.current = false;

    let totals = ZERO;
    let batchCount = 0;
    try {
      while (true) {
        if (cancelled.current) break;
        const r = await runBatch();
        batchCount += 1;
        totals = {
          batches: batchCount,
          deleted: totals.deleted + r.deleted_count,
          bytes: totals.bytes + r.bytes_freed,
          unlinked: totals.unlinked + r.files_unlinked,
          missing: totals.missing + r.files_missing,
          failed: totals.failed + r.files_failed,
        };
        setProgress(totals);
        if (!r.has_more) break;
      }
      setPhase("done");
    } catch (err) {
      setRunError(extractApiError(err, t("clipCleanupModal.cleanupFailed") as string));
      setPhase("error");
    }
  };

  const progressPct = useMemo(() => {
    if (phase !== "running" || expectedBatches === 0) return 0;
    return Math.min(100, Math.round((progress.batches / expectedBatches) * 100));
  }, [phase, progress.batches, expectedBatches]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("clipCleanupModal.aria") as string}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && phase !== "running") {
          onClose();
        }
      }}
    >
      <div
        className="card"
        style={{
          width: "min(560px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          margin: 0,
        }}
      >
        <div className="card-head">
          <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="trash" size={16} />
            {t("clipCleanupModal.title") as string}
          </div>
        </div>

        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Filter recap */}
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-secondary)",
              padding: "8px 10px",
              borderRadius: 6,
              background: "var(--bg-sunken)",
            }}
          >
            {t("clipCleanupModal.recap", {
              filter: describeFilter(filter, t),
              scope:
                filter.camera_id !== undefined
                  ? t("clipCleanupModal.scopeCamera")
                  : t("clipCleanupModal.scopeAll"),
            }) as string}
          </div>

          {phase === "loading_preview" && (
            <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              {t("clipCleanupModal.calculating") as string}
            </div>
          )}

          {phase === "error" && (
            <div
              role="alert"
              style={{
                padding: 12,
                borderRadius: 6,
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                fontSize: 13,
              }}
            >
              {runError ?? extractApiError(preview.error, t("clipCleanupModal.loadPreviewFailed") as string)}
            </div>
          )}

          {phase === "preview_ready" && previewData !== null && (
            <PreviewBody data={previewData} />
          )}

          {phase === "running" && previewData !== null && (
            <RunningBody
              progress={progress}
              expected={previewData.clip_count}
              progressPct={progressPct}
            />
          )}

          {phase === "done" && previewData !== null && previewData.clip_count === 0 && (
            <div
              style={{
                padding: "16px 0",
                textAlign: "center",
                color: "var(--text-tertiary)",
                fontSize: 13,
              }}
            >
              {t("clipCleanupModal.nothingToDelete") as string}
            </div>
          )}

          {phase === "done" && (progress.deleted > 0 || progress.batches > 0) && (
            <DoneBody progress={progress} />
          )}

          {/* Footer */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {phase === "preview_ready" && (
              <>
                <button type="button" className="btn btn-sm" onClick={onClose}>
                  {t("common.cancel") as string}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void startRun()}
                  disabled={previewData?.clip_count === 0}
                >
                  <Icon name="trash" size={13} />
                  {t("clipCleanupModal.deleteClips", { count: previewData?.clip_count ?? 0 }) as string}
                </button>
              </>
            )}
            {phase === "running" && (
              <button type="button" className="btn btn-sm" disabled>
                <Icon name="refresh" size={13} />
                {t("clipCleanupModal.working") as string}
              </button>
            )}
            {(phase === "done" || phase === "error") && (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                {t("common.close") as string}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ data }: { data: ClipCleanupPreviewResponse }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  return (
    <>
      {/* Confirmation headline */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600 }}>
        <span aria-hidden="true" style={{ fontSize: 16 }}>⚠</span>
        {t("clipCleanupModal.confirmHeadline") as string}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="stat">
          <div className="stat-label">{t("clipCleanupModal.colClips") as string}</div>
          <div className="stat-value">{data.clip_count.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{t("clipCleanupModal.willReclaim") as string}</div>
          <div className="stat-value">{fmtBytes(data.total_bytes)}</div>
        </div>
      </div>

      {(data.oldest_clip_at || data.newest_clip_at) && (
        <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
          {data.oldest_clip_at && (
            <>{t("clipCleanupModal.oldest", { date: new Date(data.oldest_clip_at).toLocaleString(locale) }) as string}</>
          )}
          {data.oldest_clip_at && data.newest_clip_at && " · "}
          {data.newest_clip_at && (
            <>{t("clipCleanupModal.newest", { date: new Date(data.newest_clip_at).toLocaleString(locale) }) as string}</>
          )}
        </div>
      )}

      {data.by_camera.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500, marginBottom: 6 }}>
            {t("clipCleanupModal.byCamera") as string}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
            {data.by_camera.map((row) => (
              <div
                key={row.camera_id}
                style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}
              >
                <span>{row.camera_name}</span>
                <span style={{ color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
                  {row.clip_count.toLocaleString()} · {fmtBytes(row.total_bytes)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.capped && (
        <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
          {t("clipCleanupModal.cappedNote", { cap: data.cap.toLocaleString() }) as string}
        </div>
      )}

      {/* Irreversible warning */}
      <div
        role="alert"
        style={{
          padding: "10px 12px",
          fontSize: 12,
          background: "var(--danger-soft)",
          border: "1px solid var(--danger)",
          borderRadius: 6,
          color: "var(--danger-text)",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 7,
        }}
      >
        <Icon name="trash" size={14} />
        {t("clipCleanupModal.cannotUndo") as string}
      </div>

      {/* What's kept */}
      <div
        style={{
          padding: "8px 10px",
          fontSize: 11.5,
          background: "var(--bg-sunken)",
          borderRadius: 6,
          color: "var(--text-secondary)",
          lineHeight: 1.5,
        }}
      >
        <strong>{t("clipCleanupModal.notAffectLead") as string}</strong>
        {t("clipCleanupModal.notAffectRest") as string}
      </div>
    </>
  );
}

function RunningBody({
  progress,
  expected,
  progressPct,
}: {
  progress: RunProgress;
  expected: number;
  progressPct: number;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="stat">
          <div className="stat-label">{t("clipCleanupModal.deletedSoFar") as string}</div>
          <div className="stat-value">{progress.deleted.toLocaleString()}</div>
          <div className="stat-delta delta-flat">
            {t("clipCleanupModal.ofCount", { count: expected }) as string}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">{t("clipCleanupModal.reclaimed") as string}</div>
          <div className="stat-value">{fmtBytes(progress.bytes)}</div>
        </div>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--border)",
          overflow: "hidden",
        }}
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{
            height: "100%",
            width: `${progressPct}%`,
            background: "var(--accent)",
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", textAlign: "center" }}>
        {t("clipCleanupModal.batch", { count: progress.batches }) as string}
      </div>
    </>
  );
}

function DoneBody({ progress }: { progress: RunProgress }) {
  const { t } = useTranslation();
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="stat">
          <div className="stat-label">{t("clipCleanupModal.deleted") as string}</div>
          <div className="stat-value">{progress.deleted.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{t("clipCleanupModal.reclaimed") as string}</div>
          <div className="stat-value">{fmtBytes(progress.bytes)}</div>
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", display: "flex", gap: 14, flexWrap: "wrap" }}>
        <span>{t("clipCleanupModal.filesUnlinked", { count: progress.unlinked }) as string}</span>
        {progress.missing > 0 && (
          <span>{t("clipCleanupModal.alreadyMissing", { count: progress.missing }) as string}</span>
        )}
        {progress.failed > 0 && (
          <span style={{ color: "var(--danger-text)" }}>
            {t("clipCleanupModal.failedToDelete", { count: progress.failed }) as string}
          </span>
        )}
      </div>
    </>
  );
}
