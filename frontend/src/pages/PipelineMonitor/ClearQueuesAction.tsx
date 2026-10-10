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
import { ModalShell } from "../../components/DrawerShell";
import { EmptyPanel } from "../../components/ListPageUi";
import { SkeletonLines } from "../../components/Skeleton";
import { Banner, ModalPanel, SoftPill } from "../../features/system/opsUi";

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
      <button type="button" className="btn" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <Icon name="trash" size={12} />
        {t("queueClear.button")}
      </button>
      {open && <ClearQueuesModal onClose={() => setOpen(false)} onCleared={(r) => setLastResult(r)} />}
      {lastResult && (
        <div role="status" className="ops-toast">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{t("queueClear.toast.title", { count: lastResult.cleared_total })}</div>
          <div className="text-dim">{t("queueClear.toast.dbCancelled", { count: lastResult.db_cancelled })}</div>
        </div>
      )}
    </>
  );
}

function ClearQueuesModal({ onClose, onCleared }: { onClose: () => void; onCleared: (result: ClearQueueResponse) => void }) {
  const { t } = useTranslation();
  const q = useQueuesSnapshot(true);
  const clear = useClearQueue();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [reason, setReason] = useState("");

  function performClear(queue: string) {
    clear.mutate(
      { queue, reason: reason.trim() },
      {
        onSuccess: (r) => {
          onCleared(r);
          setConfirmingKey(null);
          setConfirmingAll(false);
          // Leave the modal open so the operator can see the depth go
          // to zero — the snapshot refetches on 3s interval AND on
          // success invalidation.
        },
      },
    );
  }

  const totalQueued = q.data ? q.data.queues.reduce((s, r) => s + r.depth, 0) : 0;
  const anyQueued = totalQueued > 0 || (q.data?.db_pending ?? 0) > 0;
  const title = t("queueClear.modal.title");

  return (
    <ModalShell onClose={onClose}>
      <ModalPanel
        title={<span id="clear-queues-title">{title}</span>}
        ariaLabel={title}
        sub={t("queueClear.modal.subtitle")}
        wide
        headActions={
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("queueClear.modal.closeAria")}>
            <Icon name="x" size={13} />
          </button>
        }
        footer={
          <>
            <button type="button" className="btn" onClick={onClose} style={{ marginInlineEnd: "auto" }}>
              {t("queueClear.action.close")}
            </button>
            {q.data &&
              (confirmingAll ? (
                <>
                  <span className="text-sm" style={{ color: "var(--warning-text)", fontWeight: 600 }}>
                    {t("queueClear.action.clearAllConfirmHint")}
                  </span>
                  <button type="button" className="btn" onClick={() => setConfirmingAll(false)} disabled={clear.isPending}>
                    {t("queueClear.action.cancel")}
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => performClear("all")} disabled={clear.isPending}>
                    {clear.isPending ? t("queueClear.action.clearing") : t("queueClear.action.clearAllConfirm", { count: totalQueued })}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-danger" onClick={() => setConfirmingAll(true)} disabled={!anyQueued || clear.isPending}>
                  <Icon name="trash" size={12} /> {t("queueClear.action.clearAll")}
                </button>
              ))}
          </>
        }
      >
        {/* Process-wide caveat banner */}
        <Banner tone="warning" icon={<Icon name="info" size={14} />}>
          <span>
            <strong>{t("queueClear.modal.caveatTitle")}</strong> {t("queueClear.modal.caveatBody")}
          </span>
        </Banner>

        {/* Reason — recorded on every cancelled row for Queue History so
            the cleared clips can be reviewed + reprocessed later. */}
        <div className="field" style={{ margin: "16px 0" }}>
          <label className="field-label" htmlFor="clear-queues-reason">
            {t("queueClear.modal.reasonLabel", { defaultValue: "Reason (optional)" })}
          </label>
          <input
            id="clear-queues-reason"
            type="text"
            className="input"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("queueClear.modal.reasonPlaceholder", { defaultValue: "e.g. backlog — reprocess overnight" })}
            style={{ width: "100%" }}
          />
          <span className="field-help">
            {t("queueClear.modal.reasonHelp", {
              defaultValue: "Cleared clips are kept in Queue history and can be reprocessed later — they are not deleted.",
            })}
          </span>
        </div>

        {q.isLoading && <SkeletonLines lines={4} />}

        {q.isError && (
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={30} />}
            title={t("queueClear.modal.loadFailedTitle", { defaultValue: "Couldn't load queue depths" })}
            body={t("queueClear.modal.loadFailedBody", { defaultValue: "The queue snapshot request failed." })}
            actions={
              <button type="button" className="btn" onClick={() => void q.refetch()}>
                <Icon name="refresh" size={12} />
                {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        )}

        {q.data && (
          <>
            <div className="ops-table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t("queueClear.modal.col.queue")}</th>
                    <th className="ops-num">{t("queueClear.modal.col.depth")}</th>
                    <th>{t("queueClear.modal.col.scope")}</th>
                    <th className="ops-num">{t("queueClear.modal.col.action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.queues.map((row) => {
                    const isConfirming = confirmingKey === row.key;
                    const isClearing = clear.isPending && clear.variables?.queue === row.key;
                    return (
                      <tr key={row.key}>
                        <td style={{ fontWeight: 600 }}>{t(`queueClear.queueName.${row.key}`, { defaultValue: row.display })}</td>
                        <td
                          className="ops-num mono"
                          style={{
                            fontWeight: row.depth > 0 ? 700 : 400,
                            color: row.depth > 0 ? "var(--warning-text)" : "var(--text-secondary)",
                          }}
                        >
                          {row.depth.toLocaleString()}
                        </td>
                        <td>
                          <SoftPill tone={row.scope === "tenant_scoped" ? "info" : "neutral"} dot={false}>
                            {t(`queueClear.scope.${row.scope}`)}
                          </SoftPill>
                        </td>
                        <td className="ops-num">
                          {isConfirming ? (
                            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <button type="button" className="btn btn-sm btn-danger" onClick={() => performClear(row.key)} disabled={isClearing}>
                                {isClearing ? t("queueClear.action.clearing") : t("queueClear.action.confirm", { count: row.depth })}
                              </button>
                              <button type="button" className="btn btn-sm" onClick={() => setConfirmingKey(null)} disabled={isClearing}>
                                {t("queueClear.action.cancel")}
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => setConfirmingKey(row.key)}
                              disabled={row.depth === 0 || clear.isPending}
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
            </div>

            <div style={{ marginTop: 12 }}>
              <Banner tone="neutral" icon={<Icon name="database" size={14} />}>
                {t("queueClear.modal.dbPending", { count: q.data.db_pending })}
              </Banner>
            </div>
          </>
        )}
      </ModalPanel>
    </ModalShell>
  );
}
