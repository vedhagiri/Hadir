// Queue History — clips removed from a queue via "Clear queues" are
// kept (their clip_processing_results rows are marked cancelled, not
// deleted). This surfaces them with who/when/why and lets an admin
// reprocess them later (off-peak / overnight) instead of losing them.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { Pagination } from "../../components/Pagination";

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
      month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function useHistory(page: number, enabled: boolean) {
  return useQuery({
    queryKey: ["operations", "queue-history", page],
    queryFn: () =>
      api<HistoryResponse>(
        `/api/operations/queues/history?page=${page}&page_size=${PAGE_SIZE}`,
      ),
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
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn"
        style={{ marginInlineEnd: 8 }}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="clock" size={12} /> Queue History
      </button>
      {open && <QueueHistoryModal onClose={() => setOpen(false)} />}
    </>
  );
}

function QueueHistoryModal({ onClose }: { onClose: () => void }) {
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
  function runReprocess(
    body: { clip_ids?: number[] },
    label: string,
    requested?: number,
  ) {
    setNote(null);
    reprocess.mutate(body, {
      onSuccess: (r) => {
        if (r.clips_found === 0) {
          setNote(
            requested && requested > 0
              ? `None of the ${requested} selected clip(s) could be reprocessed — clip file missing.`
              : `Nothing to reprocess${label ? ` (${label})` : ""}.`,
          );
        } else {
          const skipped = requested ? requested - r.clips_found : 0;
          setNote(
            `Re-queued ${r.clips_found} clip(s) · ${r.queued_jobs} job(s) submitted` +
              (skipped > 0 ? ` · ${skipped} skipped (clip file missing).` : "."),
          );
        }
        setSelected(new Set());
      },
      onError: (e) => setNote(e instanceof Error ? e.message : "Reprocess failed"),
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Queue history"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        zIndex: 80, display: "grid", placeItems: "center", padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--bg-elev)", border: "1px solid var(--border)",
          borderRadius: 14, width: 860, maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column",
          boxShadow: "0 24px 64px rgba(0,0,0,0.28)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Queue History</h2>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 1 }}>
              Cleared clips ({total.toLocaleString()}) — not deleted; reprocess any time.
            </div>
          </div>
          {selected.size > 0 && (
            <button
              className="btn btn-sm btn-primary"
              disabled={reprocess.isPending}
              onClick={() =>
                runReprocess(
                  { clip_ids: [...selected] },
                  "selected",
                  selected.size,
                )
              }
            >
              <Icon name="refresh" size={11} />
              {reprocess.isPending ? "Reprocessing…" : `Reprocess selected (${selected.size})`}
            </button>
          )}
          <button
            className="btn btn-sm"
            disabled={reprocess.isPending || total === 0}
            onClick={() => runReprocess({}, "all")}
            title="Re-queue every reprocessable cleared clip"
          >
            <Icon name="refresh" size={11} />
            {reprocess.isPending ? "Reprocessing…" : "Reprocess all"}
          </button>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close">
            <Icon name="x" size={12} />
          </button>
        </div>

        {note && (
          <div style={{ padding: "8px 20px", fontSize: 12.5, color: "var(--text-secondary)", background: "var(--bg-sunken)", borderBottom: "1px solid var(--border)" }}>
            {note}
          </div>
        )}

        <div style={{ overflowY: "auto", flex: 1 }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAllOnPage}
                    disabled={selectableIds.length === 0}
                    aria-label="Select all reprocessable on page"
                  />
                </th>
                <th>Clip</th>
                <th>Camera</th>
                <th>UC</th>
                <th>Queued</th>
                <th>Cleared</th>
                <th>By</th>
                <th>Reason</th>
                <th style={{ textAlign: "end" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {q.isLoading && (
                <tr><td colSpan={9} className="text-dim" style={{ padding: 14 }}>Loading…</td></tr>
              )}
              {!q.isLoading && items.length === 0 && (
                <tr><td colSpan={9} className="text-dim" style={{ padding: 14 }}>No cleared clips — Queue History is empty.</td></tr>
              )}
              {items.map((r) => (
                <tr key={`${r.clip_id}-${r.use_case}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(r.clip_id)}
                      onChange={() => toggleOne(r.clip_id)}
                      disabled={!r.reprocessable}
                      aria-label={`Select clip ${r.clip_id}`}
                    />
                  </td>
                  <td className="mono text-sm">#{r.clip_id}</td>
                  <td className="text-sm">{r.camera_name ?? `cam ${r.camera_id ?? "?"}`}</td>
                  <td className="text-sm">{r.use_case.toUpperCase()}</td>
                  <td className="mono text-sm">{fmtTime(r.queued_at)}</td>
                  <td className="mono text-sm">{fmtTime(r.cleared_at)}</td>
                  <td className="text-sm">{r.cleared_by_name ?? "—"}</td>
                  <td className="text-sm" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.reason ?? ""}>{r.reason ?? "—"}</td>
                  <td style={{ textAlign: "end" }}>
                    {r.reprocessable ? (
                      <button
                        className="btn btn-sm"
                        disabled={reprocess.isPending}
                        onClick={() => runReprocess({ clip_ids: [r.clip_id] }, `#${r.clip_id}`, 1)}
                      >
                        <Icon name="refresh" size={10} /> Reprocess
                      </button>
                    ) : (
                      <span
                        style={{ fontSize: 11, color: "var(--danger-text)", display: "inline-flex", alignItems: "center", gap: 4 }}
                        title="The clip video is no longer on disk (deleted or retention-cleaned), so it can't be reprocessed."
                      >
                        <Icon name="info" size={11} /> Clip file missing
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            disabled={q.isFetching}
            summary={`Page ${page} of ${totalPages} · ${total.toLocaleString()} cleared`}
          />
        ) : (
          total > 0 && (
            <div
              style={{
                padding: "10px 14px",
                borderTop: "1px solid var(--border)",
                fontSize: 12,
                color: "var(--text-tertiary)",
              }}
            >
              {total.toLocaleString()} cleared clip{total === 1 ? "" : "s"}
            </div>
          )
        )}
      </div>
    </div>
  );
}
