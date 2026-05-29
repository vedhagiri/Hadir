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

function describeFilter(filter: ClipCleanupFilter): string {
  if (filter.older_than_hours !== undefined) {
    const h = filter.older_than_hours;
    return `older than ${h} hour${h === 1 ? "" : "s"}`;
  }
  if (filter.older_than_days !== undefined) {
    const d = filter.older_than_days;
    return `older than ${d} day${d === 1 ? "" : "s"}`;
  }
  if (filter.start_date && filter.end_date) {
    return `from ${filter.start_date} to ${filter.end_date}`;
  }
  return "matching the selected filter";
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
      setRunError(extractApiError(err, "Cleanup failed"));
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
      aria-label="Clip cleanup confirmation"
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
            Clip Video Cleanup
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
            Clips {describeFilter(filter)}
            {filter.camera_id !== undefined ? " (selected camera only)" : " across all cameras"}
            .
          </div>

          {phase === "loading_preview" && (
            <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
              Calculating impact…
            </div>
          )}

          {phase === "error" && (
            <div
              role="alert"
              style={{
                padding: 12,
                borderRadius: 6,
                background: "var(--danger-bg)",
                color: "var(--danger-text)",
                fontSize: 13,
              }}
            >
              {runError ?? extractApiError(preview.error, "Failed to load preview")}
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
              No clips match the selected filter. Nothing to delete.
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
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void startRun()}
                  disabled={previewData?.clip_count === 0}
                >
                  <Icon name="trash" size={13} />
                  Delete {previewData?.clip_count.toLocaleString()} clip
                  {previewData?.clip_count === 1 ? "" : "s"}
                </button>
              </>
            )}
            {phase === "running" && (
              <button type="button" className="btn btn-sm" disabled>
                <Icon name="refresh" size={13} />
                Working…
              </button>
            )}
            {(phase === "done" || phase === "error") && (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ data }: { data: ClipCleanupPreviewResponse }) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="stat">
          <div className="stat-label">Clips</div>
          <div className="stat-value">{data.clip_count.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Will reclaim</div>
          <div className="stat-value">{fmtBytes(data.total_bytes)}</div>
        </div>
      </div>

      {(data.oldest_clip_at || data.newest_clip_at) && (
        <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
          {data.oldest_clip_at && (
            <>Oldest: {new Date(data.oldest_clip_at).toLocaleString()}</>
          )}
          {data.oldest_clip_at && data.newest_clip_at && " · "}
          {data.newest_clip_at && (
            <>Newest: {new Date(data.newest_clip_at).toLocaleString()}</>
          )}
        </div>
      )}

      {data.by_camera.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500, marginBottom: 6 }}>
            BY CAMERA
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
        <strong>This will not affect</strong> extracted face crops,
        mapped employee images, attendance evidence, or reference photos.
        Only the raw video files are reclaimed.
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
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="stat">
          <div className="stat-label">Deleted so far</div>
          <div className="stat-value">{progress.deleted.toLocaleString()}</div>
          <div className="stat-delta delta-flat">
            of {expected.toLocaleString()}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Reclaimed</div>
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
        Batch {progress.batches}
      </div>
    </>
  );
}

function DoneBody({ progress }: { progress: RunProgress }) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="stat">
          <div className="stat-label">Deleted</div>
          <div className="stat-value">{progress.deleted.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Reclaimed</div>
          <div className="stat-value">{fmtBytes(progress.bytes)}</div>
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", display: "flex", gap: 14, flexWrap: "wrap" }}>
        <span>Files unlinked: {progress.unlinked.toLocaleString()}</span>
        {progress.missing > 0 && (
          <span>Already missing: {progress.missing.toLocaleString()}</span>
        )}
        {progress.failed > 0 && (
          <span style={{ color: "var(--danger-text)" }}>
            Failed to delete: {progress.failed.toLocaleString()}
          </span>
        )}
      </div>
    </>
  );
}
