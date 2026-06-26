// Admin "Clear queues" action — sibling to "Restart all workers" on
// the Pipeline Monitor header.
//
// Opening the button fetches the live queue depths, lists each queue
// with a per-row Clear button, plus a Clear All footer. Both paths
// require a confirmation step; the destructive POST goes via the
// existing query client so the Pipeline Monitor + Workers tab refresh
// immediately.
//
// **Process-wide caveat** surfaced in the modal copy: the clip-
// pipeline stage queues and the matching queue are not tenant-scoped
// — they hold every tenant's pending jobs. Clip-save (per-camera) is
// tenant-scoped via CaptureManager.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";

interface QueueRow {
  key: string;
  display: string;
  depth: number;
  scope: "process_wide" | "tenant_scoped";
  in_flight: number;
}

interface QueueSnapshotResponse {
  queues: QueueRow[];
  db_pending: number;
  generated_at: string;
}

interface ClearQueueResponse {
  cleared: Record<string, number>;
  cleared_total: number;
  db_cancelled: number;
}

function useQueuesSnapshot(enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "queues", "snapshot"],
    queryFn: () =>
      api<QueueSnapshotResponse>("/api/operations/queues/snapshot"),
    enabled,
    refetchInterval: enabled ? 3000 : false,
    refetchIntervalInBackground: false,
  });
}

function useClearQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { queue: string; reason: string }) =>
      api<ClearQueueResponse>("/api/operations/queues/clear", {
        method: "POST",
        body: { queue: vars.queue, reason: vars.reason },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operations", "queues", "snapshot"] });
      qc.invalidateQueries({ queryKey: ["pipeline-monitor"] });
      qc.invalidateQueries({ queryKey: ["operations", "workers"] });
    },
  });
}

export function ClearQueuesAction() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [lastResult, setLastResult] = useState<ClearQueueResponse | null>(null);
  // Auto-dismiss the toast after 8 seconds so it doesn't pin the
  // corner of the viewport.
  useEffect(() => {
    if (!lastResult) return;
    const id = window.setTimeout(() => setLastResult(null), 8000);
    return () => window.clearTimeout(id);
  }, [lastResult]);

  return (
    <>
      <button
        type="button"
        className="btn"
        style={{
          background: "var(--warning, #f59e0b)",
          color: "white",
          marginInlineEnd: 8,
        }}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="trash" size={12} />
        {t("queueClear.button")}
      </button>
      {open && (
        <ClearQueuesModal
          onClose={() => setOpen(false)}
          onCleared={(r) => setLastResult(r)}
        />
      )}
      {lastResult && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 16,
            insetInlineEnd: 16,
            zIndex: 70,
            padding: "12px 16px",
            background: "var(--success-bg, #ecfdf5)",
            border: "1px solid var(--success, #10b981)",
            borderRadius: 8,
            fontSize: 12.5,
            maxWidth: 360,
            color: "var(--success-text, #047857)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {t("queueClear.toast.title", {
              count: lastResult.cleared_total,
            })}
          </div>
          <div>
            {t("queueClear.toast.dbCancelled", {
              count: lastResult.db_cancelled,
            })}
          </div>
        </div>
      )}
    </>
  );
}

function ClearQueuesModal({
  onClose,
  onCleared,
}: {
  onClose: () => void;
  onCleared: (result: ClearQueueResponse) => void;
}) {
  const { t } = useTranslation();
  const q = useQueuesSnapshot(true);
  const clear = useClearQueue();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [reason, setReason] = useState("");

  function performClear(queue: string) {
    clear.mutate({ queue, reason: reason.trim() }, {
      onSuccess: (r) => {
        onCleared(r);
        setConfirmingKey(null);
        setConfirmingAll(false);
        // Leave the modal open so the operator can see the depth go
        // to zero — the snapshot refetches on 3s interval AND on
        // success invalidation.
      },
    });
  }

  const totalQueued = q.data
    ? q.data.queues.reduce((s, r) => s + r.depth, 0)
    : 0;
  const anyQueued = totalQueued > 0 || (q.data?.db_pending ?? 0) > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clear-queues-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 80,
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(680px, 100%)",
          background: "var(--bg, #fff)",
          borderRadius: 10,
          padding: 20,
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div>
            <h2
              id="clear-queues-title"
              style={{ margin: 0, fontSize: 16, fontWeight: 700 }}
            >
              {t("queueClear.modal.title")}
            </h2>
            <p
              className="text-dim"
              style={{ margin: "4px 0 0 0", fontSize: 12 }}
            >
              {t("queueClear.modal.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("queueClear.modal.closeAria")}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 20,
              padding: 0,
              color: "var(--text-secondary)",
            }}
          >
            ×
          </button>
        </div>

        {/* Process-wide caveat banner */}
        <div
          style={{
            padding: "10px 12px",
            background: "var(--warning-bg, #fffbeb)",
            border: "1px solid var(--warning, #f59e0b)",
            borderRadius: 8,
            fontSize: 11.5,
            color: "var(--warning-text, #92400e)",
            marginBottom: 12,
          }}
        >
          <strong>{t("queueClear.modal.caveatTitle")}</strong>{" "}
          {t("queueClear.modal.caveatBody")}
        </div>

        {/* Reason — recorded on every cancelled row for Queue History so
            the cleared clips can be reviewed + reprocessed later. */}
        <label style={{ display: "block", marginBottom: 12 }}>
          <span
            style={{
              display: "block",
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--text-tertiary)",
              marginBottom: 4,
            }}
          >
            Reason (optional)
          </span>
          <input
            type="text"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. backlog — reprocess overnight"
            style={{
              width: "100%",
              padding: "7px 10px",
              fontSize: 13,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-elev)",
              color: "var(--text)",
            }}
          />
          <span style={{ display: "block", fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Cleared clips are kept in Queue History and can be reprocessed later — they are not deleted.
          </span>
        </label>

        {q.isLoading && (
          <div
            className="text-sm text-dim"
            style={{ padding: 16, textAlign: "center" }}
          >
            {t("queueClear.modal.loading")}
          </div>
        )}

        {q.data && (
          <>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              <thead style={{ background: "var(--bg-sunken, #f9fafb)" }}>
                <tr>
                  <th style={cellStyleHead}>
                    {t("queueClear.modal.col.queue")}
                  </th>
                  <th style={{ ...cellStyleHead, textAlign: "end" }}>
                    {t("queueClear.modal.col.depth")}
                  </th>
                  <th style={cellStyleHead}>
                    {t("queueClear.modal.col.scope")}
                  </th>
                  <th style={{ ...cellStyleHead, textAlign: "center" }}>
                    {t("queueClear.modal.col.action")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.queues.map((row) => {
                  const isConfirming = confirmingKey === row.key;
                  const isClearing =
                    clear.isPending && clear.variables?.queue === row.key;
                  return (
                    <tr key={row.key}>
                      <td style={cellStyle}>
                        <div style={{ fontWeight: 600 }}>
                          {t(`queueClear.queueName.${row.key}`, {
                            defaultValue: row.display,
                          })}
                        </div>
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          fontVariantNumeric: "tabular-nums",
                          textAlign: "end",
                          fontWeight: row.depth > 0 ? 700 : 400,
                          color:
                            row.depth > 0
                              ? "var(--warning-text, #92400e)"
                              : "var(--text-secondary)",
                        }}
                      >
                        {row.depth.toLocaleString()}
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          fontSize: 10,
                          color: "var(--text-dim)",
                        }}
                      >
                        {t(`queueClear.scope.${row.scope}`)}
                      </td>
                      <td style={{ ...cellStyle, textAlign: "center" }}>
                        {isConfirming ? (
                          <div
                            style={{
                              display: "inline-flex",
                              gap: 4,
                              alignItems: "center",
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => performClear(row.key)}
                              disabled={isClearing}
                              style={{
                                padding: "4px 10px",
                                background: "var(--danger, #ef4444)",
                                color: "white",
                                border: "none",
                                borderRadius: 4,
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: isClearing ? "wait" : "pointer",
                              }}
                            >
                              {isClearing
                                ? t("queueClear.action.clearing")
                                : t("queueClear.action.confirm", {
                                    count: row.depth,
                                  })}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingKey(null)}
                              disabled={isClearing}
                              style={{
                                padding: "4px 10px",
                                background: "var(--bg-sunken)",
                                border: "1px solid var(--border)",
                                borderRadius: 4,
                                fontSize: 11,
                                cursor: "pointer",
                              }}
                            >
                              {t("queueClear.action.cancel")}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmingKey(row.key)}
                            disabled={row.depth === 0 || clear.isPending}
                            style={{
                              padding: "4px 10px",
                              background:
                                row.depth === 0
                                  ? "var(--bg-sunken, #f9fafb)"
                                  : "var(--bg, #fff)",
                              border: "1px solid var(--border, #e5e7eb)",
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 500,
                              cursor: row.depth === 0 ? "default" : "pointer",
                              color:
                                row.depth === 0
                                  ? "var(--text-dim)"
                                  : "var(--text)",
                            }}
                          >
                            {t("queueClear.action.clear")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div
              style={{
                padding: "8px 12px",
                background: "var(--bg-sunken, #f9fafb)",
                borderRadius: 6,
                fontSize: 11.5,
                marginBottom: 16,
                color: "var(--text-secondary)",
              }}
            >
              {t("queueClear.modal.dbPending", { count: q.data.db_pending })}
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                paddingTop: 12,
                borderTop: "1px solid var(--border, #e5e7eb)",
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "8px 16px",
                  background: "var(--bg, #fff)",
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {t("queueClear.action.close")}
              </button>
              {confirmingAll ? (
                <div
                  style={{
                    display: "inline-flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--warning-text, #92400e)",
                      fontWeight: 600,
                    }}
                  >
                    {t("queueClear.action.clearAllConfirmHint")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmingAll(false)}
                    disabled={clear.isPending}
                    style={{
                      padding: "8px 12px",
                      background: "var(--bg-sunken)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {t("queueClear.action.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => performClear("all")}
                    disabled={clear.isPending}
                    style={{
                      padding: "8px 16px",
                      background: "var(--danger, #ef4444)",
                      color: "white",
                      border: "none",
                      borderRadius: 6,
                      fontSize: 12.5,
                      fontWeight: 700,
                      cursor: clear.isPending ? "wait" : "pointer",
                    }}
                  >
                    {clear.isPending
                      ? t("queueClear.action.clearing")
                      : t("queueClear.action.clearAllConfirm", {
                          count: totalQueued,
                        })}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingAll(true)}
                  disabled={!anyQueued || clear.isPending}
                  style={{
                    padding: "8px 16px",
                    background: anyQueued
                      ? "var(--danger, #ef4444)"
                      : "var(--bg-sunken, #f9fafb)",
                    color: anyQueued ? "white" : "var(--text-dim)",
                    border: anyQueued
                      ? "none"
                      : "1px solid var(--border, #e5e7eb)",
                    borderRadius: 6,
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: anyQueued ? "pointer" : "default",
                  }}
                >
                  <Icon name="trash" size={12} /> {t("queueClear.action.clearAll")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const cellStyleHead: React.CSSProperties = {
  textAlign: "start",
  padding: "8px 10px",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary, #6b7280)",
  borderBottom: "1px solid var(--border, #e5e7eb)",
};

const cellStyle: React.CSSProperties = {
  padding: "10px 10px",
  borderBottom: "1px solid var(--border-soft, #f3f4f6)",
};
