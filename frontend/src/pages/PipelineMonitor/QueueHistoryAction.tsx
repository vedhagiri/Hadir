// Queue History — clips removed from a queue via "Clear queues" are
// kept (their clip_processing_results rows are marked cancelled, not
// deleted). This surfaces them with who/when/why and lets an admin
// reprocess them later (off-peak / overnight) instead of losing them.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { ModalShell } from "../../components/DrawerShell";
import { Pagination } from "../../components/Pagination";
import { SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel } from "../../components/ListPageUi";
import { ModalPanel } from "../../features/system/opsUi";

interface HistoryRow {
  clip_id: number;
  use_case: string;
  camera_id: number | null;
  camera_name: string | null;
  queued_at: string | null;
  cleared_at: string | null;
  cleared_by_name: string | null;
  reason: string | null;
  reprocessable: boolean;
}
interface HistoryResponse {
  items: HistoryRow[];
  total: number;
  page: number;
  page_size: number;
}
interface ReprocessResponse {
  batch_id: string;
  clips_found: number;
  queued_jobs: number;
  skipped_jobs: number;
}

const PAGE_SIZE = 50;

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function useHistory(page: number, enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "queue-history", page],
    queryFn: () => api<HistoryResponse>(`/api/operations/queues/history?page=${page}&page_size=${PAGE_SIZE}`),
    enabled,
    refetchInterval: enabled ? 5000 : false,
    refetchIntervalInBackground: false,
  });
}

function useReprocess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { clip_ids?: number[] }) =>
      api<ReprocessResponse>("/api/operations/queues/history/reprocess", {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operations", "queue-history"] });
      qc.invalidateQueries({ queryKey: ["operations", "queues", "snapshot"] });
      qc.invalidateQueries({ queryKey: ["pipeline-monitor"] });
    },
  });
}

export function QueueHistoryAction() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <Icon name="clock" size={12} /> {t("pipelineMonitor.queueHistory.button", { defaultValue: "Queue history" })}
      </button>
      {open && <QueueHistoryModal onClose={() => setOpen(false)} />}
    </>
  );
}

function QueueHistoryModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [note, setNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const q = useHistory(page, true);
  const reprocess = useReprocess();

  const total = q.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = q.data?.items ?? [];

  // Selection is by clip_id, restricted to reprocessable rows (the clip
  // file still exists). Rows whose file is gone can't be re-queued.
  const selectableIds = items.filter((r) => r.reprocessable).map((r) => r.clip_id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggleOne(id: number) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllOnPage() {
    setSelected((s) => {
      const next = new Set(s);
      if (allSelected) selectableIds.forEach((id) => next.delete(id));
      else selectableIds.forEach((id) => next.add(id));
      return next;
    });
  }

  // ``requested`` lets us report how many were skipped because the clip
  // file is missing (found < requested).
  function runReprocess(body: { clip_ids?: number[] }, label: string, requested?: number) {
    setNote(null);
    reprocess.mutate(body, {
      onSuccess: (r) => {
        if (r.clips_found === 0) {
          setNote(
            requested && requested > 0
              ? t("pipelineMonitor.queueHistory.noneReprocessed", {
                  defaultValue: "None of the {{count}} selected clip(s) could be reprocessed — clip file missing.",
                  count: requested,
                })
              : t("pipelineMonitor.queueHistory.nothingToReprocess", {
                  defaultValue: "Nothing to reprocess{{label}}.",
                  label: label ? ` (${label})` : "",
                }),
          );
        } else {
          const skipped = requested ? requested - r.clips_found : 0;
          setNote(
            t("pipelineMonitor.queueHistory.requeued", {
              defaultValue: "Re-queued {{clips}} clip(s) · {{jobs}} job(s) submitted",
              clips: r.clips_found,
              jobs: r.queued_jobs,
            }) +
              (skipped > 0
                ? ` · ${t("pipelineMonitor.queueHistory.skippedMissing", { defaultValue: "{{count}} skipped (clip file missing).", count: skipped })}`
                : "."),
          );
        }
        setSelected(new Set());
      },
      onError: (e) => setNote(e instanceof Error ? e.message : t("pipelineMonitor.queueHistory.failed", { defaultValue: "Reprocess failed" })),
    });
  }

  const title = t("pipelineMonitor.queueHistory.title", { defaultValue: "Queue history" });
  const reprocessing = t("pipelineMonitor.queueHistory.reprocessing", { defaultValue: "Reprocessing…" });

  return (
    <ModalShell onClose={onClose}>
      <ModalPanel
        title={title}
        ariaLabel={title}
        wide
        flush
        sub={t("pipelineMonitor.queueHistory.subtitle", {
          defaultValue: "Cleared clips ({{total}}) — not deleted; reprocess any time.",
          total: total.toLocaleString(),
        })}
        headActions={
          <>
            {selected.size > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={reprocess.isPending}
                onClick={() => runReprocess({ clip_ids: [...selected] }, "selected", selected.size)}
              >
                <Icon name="refresh" size={11} />
                {reprocess.isPending
                  ? reprocessing
                  : t("pipelineMonitor.queueHistory.reprocessSelected", { defaultValue: "Reprocess selected ({{count}})", count: selected.size })}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={reprocess.isPending || total === 0}
              onClick={() => runReprocess({}, "all")}
              title={t("pipelineMonitor.queueHistory.reprocessAllTitle", { defaultValue: "Re-queue every reprocessable cleared clip" })}
            >
              <Icon name="refresh" size={11} />
              {reprocess.isPending ? reprocessing : t("pipelineMonitor.queueHistory.reprocessAll", { defaultValue: "Reprocess all" })}
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
              <Icon name="x" size={13} />
            </button>
          </>
        }
        footer={
          totalPages > 1 ? (
            <div style={{ flex: 1 }}>
              <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
                disabled={q.isFetching}
                summary={t("pipelineMonitor.queueHistory.pageSummary", {
                  defaultValue: "Page {{page}} of {{pages}} · {{total}} cleared",
                  page,
                  pages: totalPages,
                  total: total.toLocaleString(),
                })}
              />
            </div>
          ) : (
            <span className="text-sm text-dim" style={{ marginInlineEnd: "auto" }}>
              {t("pipelineMonitor.queueHistory.clearedCount", { defaultValue: "{{count}} cleared clips", count: total })}
            </span>
          )
        }
      >
        {note && (
          <div className="ops-modal-note" role="status">
            {note}
          </div>
        )}

        {!q.isLoading && items.length === 0 ? (
          <EmptyPanel
            tone="accent"
            icon={<Icon name="clock" size={30} />}
            title={t("pipelineMonitor.queueHistory.emptyTitle", { defaultValue: "No cleared clips" })}
            body={t("pipelineMonitor.queueHistory.emptyBody", { defaultValue: "Clips removed with “Clear queues” will appear here so you can reprocess them later." })}
          />
        ) : (
          <table className="table table-compact">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAllOnPage}
                    disabled={selectableIds.length === 0}
                    aria-label={t("pipelineMonitor.queueHistory.selectAll", { defaultValue: "Select all reprocessable on page" })}
                  />
                </th>
                <th>{t("pipelineMonitor.queueHistory.col.clip", { defaultValue: "Clip" })}</th>
                <th>{t("pipelineMonitor.queueHistory.col.camera", { defaultValue: "Camera" })}</th>
                <th>{t("pipelineMonitor.queueHistory.col.uc", { defaultValue: "UC" })}</th>
                <th>{t("pipelineMonitor.queueHistory.col.queued", { defaultValue: "Queued" })}</th>
                <th>{t("pipelineMonitor.queueHistory.col.cleared", { defaultValue: "Cleared" })}</th>
                <th>{t("pipelineMonitor.queueHistory.col.by", { defaultValue: "By" })}</th>
                <th>{t("pipelineMonitor.queueHistory.col.reason", { defaultValue: "Reason" })}</th>
                <th className="ops-num">{t("pipelineMonitor.queueHistory.col.action", { defaultValue: "Action" })}</th>
              </tr>
            </thead>
            <tbody>
              {q.isLoading && <SkeletonRows cols={9} />}
              {items.map((r) => (
                <tr key={`${r.clip_id}-${r.use_case}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(r.clip_id)}
                      onChange={() => toggleOne(r.clip_id)}
                      disabled={!r.reprocessable}
                      aria-label={t("pipelineMonitor.queueHistory.selectClip", { defaultValue: "Select clip {{id}}", id: r.clip_id })}
                    />
                  </td>
                  <td className="mono">#{r.clip_id}</td>
                  <td>{r.camera_name ?? `cam ${r.camera_id ?? "?"}`}</td>
                  <td>{r.use_case.toUpperCase()}</td>
                  <td className="mono">{fmtTime(r.queued_at)}</td>
                  <td className="mono">{fmtTime(r.cleared_at)}</td>
                  <td>{r.cleared_by_name ?? "—"}</td>
                  <td className="ops-cell-truncate" style={{ maxWidth: 200 }} title={r.reason ?? ""}>
                    {r.reason ?? "—"}
                  </td>
                  <td className="ops-num">
                    {r.reprocessable ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={reprocess.isPending}
                        onClick={() => runReprocess({ clip_ids: [r.clip_id] }, `#${r.clip_id}`, 1)}
                      >
                        <Icon name="refresh" size={10} /> {t("pipelineMonitor.queueHistory.reprocess", { defaultValue: "Reprocess" })}
                      </button>
                    ) : (
                      <span
                        className="text-xs"
                        style={{ color: "var(--danger-text)", display: "inline-flex", alignItems: "center", gap: 4 }}
                        title={t("pipelineMonitor.queueHistory.missingTitle", {
                          defaultValue: "The clip video is no longer on disk (deleted or retention-cleaned), so it can't be reprocessed.",
                        })}
                      >
                        <Icon name="info" size={11} /> {t("pipelineMonitor.queueHistory.missing", { defaultValue: "Clip file missing" })}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ModalPanel>
    </ModalShell>
  );
}
