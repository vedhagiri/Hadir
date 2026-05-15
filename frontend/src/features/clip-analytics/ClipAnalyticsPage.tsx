// Clip Analytics — minimal table of saved person event clips, with
// a per-row action menu (Edit / Delete / Identify Event).
//
// Deliberately separate from the heavy PersonClipsPage. This page is
// purely: "person was detected → clip was saved → row appears here".
//
// Face matching, face crop extraction, and UC comparison are manual:
// click ⋮ → "Identify Event" → pick UC1 / UC2 / UC3 to process.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";
import { useCameras } from "../cameras/hooks";
import {
  useClipFaceCrops,
  useClipProcessingResults,
  useDeletePersonClip,
  useReprocessFaceMatch,
  useReprocessStatus,
  useSingleClipReprocess,
} from "../person-clips/hooks";
import { ClipDetailDrawer } from "../person-clips/PersonClipsPage";
import type {
  ClipProcessingResult,
  FaceCropOut,
  PersonClipListResponse,
  PersonClipOut,
} from "../person-clips/types";

const PAGE_SIZE = 50;
const BULK_DELETE_CAP = 200;

type ProcessingFilter =
  | "all"
  | "recording"
  | "encoding"
  | "saved"
  | "processed";

type ProcessedUcFilter = "any" | "uc1" | "uc2" | "uc3" | "not_processed";

const ALL_USE_CASES = ["uc1", "uc2", "uc3"] as const;
type UseCaseCode = (typeof ALL_USE_CASES)[number];

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Processing Status reflects the full per-clip lifecycle:
//   recording_status='recording'              → "Recording"
//   recording_status='finalizing'              → "Encoding"
//   recording_status='completed' + no UC runs  → "Saved"
//   recording_status='completed' + ≥1 UC run   → "Processed"
//
// "Processed" is the only label that depends on processed_use_cases —
// the rest are pure recording-lifecycle states.
function processingStatusLabel(c: PersonClipOut): string {
  switch (c.recording_status) {
    case "recording":
      return "Recording";
    case "finalizing":
      return "Encoding";
    case "failed":
      return "Failed";
    case "abandoned":
      return "Abandoned";
    case "completed":
    default:
      return c.processed_use_cases.length > 0 ? "Processed" : "Saved";
  }
}

function processedUseCasesLabel(c: PersonClipOut): string {
  if (c.recording_status !== "completed") return "—";
  if (c.processed_use_cases.length === 0) return "Not Processed";
  return c.processed_use_cases.map((u) => u.toUpperCase()).join(", ");
}

export function ClipAnalyticsPage() {
  // ---- server-driven filters ----
  const [page, setPage] = useState(1);
  const [cameraId, setCameraId] = useState<number | null>(null);
  const [processingFilter, setProcessingFilter] =
    useState<ProcessingFilter>("all");
  const [startDate, setStartDate] = useState<string>(""); // YYYY-MM-DD
  const [endDate, setEndDate] = useState<string>("");

  // ---- client-side filters ----
  const [clipNameQ, setClipNameQ] = useState("");
  const [processedUcFilter, setProcessedUcFilter] =
    useState<ProcessedUcFilter>("any");

  // ---- selection + modals ----
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [identifyTarget, setIdentifyTarget] = useState<PersonClipOut | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<PersonClipOut | null>(null);
  const [bulkDeleteScope, setBulkDeleteScope] = useState<
    "selected" | "all" | null
  >(null);
  const [detailTarget, setDetailTarget] = useState<PersonClipOut | null>(null);
  const [liveTarget, setLiveTarget] = useState<PersonClipOut | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const batchStatus = useReprocessStatus();
  const batchRunning =
    batchStatus.data?.status === "running" ||
    batchStatus.data?.status === "starting";

  // Reset to page 1 whenever any filter changes so the operator
  // doesn't land on an empty page 4.
  useEffect(() => {
    setPage(1);
  }, [cameraId, processingFilter, startDate, endDate]);

  // Build server query string. Camera + recording_status + start +
  // end are server-side. clip_name + processed-uc + saved-vs-processed
  // split is applied client-side because the backend doesn't expose
  // a processed_use_cases query param yet — but the server still
  // narrows by recording_status so the page set is small.
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("page_size", String(PAGE_SIZE));
    if (cameraId != null) p.set("camera_id", String(cameraId));
    if (processingFilter === "recording") {
      p.set("recording_status", "recording");
    } else if (processingFilter === "encoding") {
      p.set("recording_status", "finalizing");
    } else if (processingFilter === "saved" || processingFilter === "processed") {
      // Both Saved and Processed share recording_status='completed' —
      // the client-side filter below splits them on processed_use_cases.
      p.set("recording_status", "completed");
    }
    if (startDate) p.set("start", `${startDate}T00:00:00`);
    if (endDate) p.set("end", `${endDate}T23:59:59`);
    return p.toString();
  }, [page, cameraId, processingFilter, startDate, endDate]);

  const list = useQuery({
    queryKey: ["clip-analytics", "list", qs],
    queryFn: () => api<PersonClipListResponse>(`/api/person-clips?${qs}`),
    refetchInterval: 10_000,
  });

  const camerasQuery = useCameras();
  const bulkDelete = useBulkDeletePersonClips();

  // Apply the client-side filters AFTER the server response.
  //  * clip-name search (no backend index)
  //  * Saved vs Processed (split of recording_status='completed' rows
  //    by whether processed_use_cases is empty or not)
  //  * Processed-UC dropdown
  const items = useMemo(() => {
    let rows = list.data?.items ?? [];
    if (processingFilter === "saved") {
      rows = rows.filter(
        (c) =>
          c.recording_status === "completed" &&
          c.processed_use_cases.length === 0,
      );
    } else if (processingFilter === "processed") {
      rows = rows.filter(
        (c) =>
          c.recording_status === "completed" &&
          c.processed_use_cases.length > 0,
      );
    }
    const q = clipNameQ.trim().toLowerCase();
    if (q) {
      rows = rows.filter((c) =>
        (c.clip_name || "").toLowerCase().includes(q),
      );
    }
    if (processedUcFilter === "not_processed") {
      rows = rows.filter((c) => c.processed_use_cases.length === 0);
    } else if (processedUcFilter !== "any") {
      rows = rows.filter((c) =>
        c.processed_use_cases.includes(processedUcFilter),
      );
    }
    return rows;
  }, [list.data, processingFilter, clipNameQ, processedUcFilter]);

  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const allOnPageSelected =
    items.length > 0 && items.every((c) => selected.has(c.id));

  const toggleSelectAllOnPage = () => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allOnPageSelected) {
        for (const c of items) next.delete(c.id);
      } else {
        for (const c of items) next.add(c.id);
      }
      return next;
    });
  };

  const toggleOne = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Clip Analytics</h1>
          <p className="page-sub">
            {list.data
              ? `${total} ${total === 1 ? "clip" : "clips"}`
              : "—"}
            {" · "}
            <span className="text-dim">
              Face matching and use-case processing are manual — open a
              clip's ⋮ menu and choose
              <strong> Identify Event</strong>.
            </span>
          </p>
        </div>
        <div className="page-actions">
          {/* Batch "Identify Event" — fires the overall reprocess
              worker across every saved clip with the chosen UCs +
              mode (skip-existing vs reprocess-everything). Reuses
              the same UC tile UI as the per-row modal. */}
          <button
            className="btn btn-primary"
            onClick={() => setBatchOpen(true)}
            disabled={batchRunning}
            title={
              batchRunning
                ? "A batch is already running — wait for it to finish"
                : "Run Identify Event across every saved clip"
            }
          >
            <Icon name="sparkles" size={12} />
            {batchRunning ? "Identify Event running…" : "Identify Event"}
          </button>
          {/* Single bulk-delete button. Disabled until the operator
              picks at least one row — selection is a safety gate
              that confirms they've reviewed the table before firing
              the destructive action against the active filter. */}
          <button
            className={selected.size > 0 ? "btn btn-danger" : "btn"}
            onClick={() => setBulkDeleteScope("all")}
            disabled={selected.size === 0 || total === 0}
            title={
              selected.size === 0
                ? "Select at least one clip to enable bulk delete"
                : "Delete every clip that matches the active filter (capped at 200 per request)"
            }
          >
            <Icon name="trash" size={12} />
            Delete all matching filter
          </button>
        </div>
      </div>

      {/* Live batch-progress banner. Only renders while the overall
          Identify Event worker is in flight; auto-disappears when the
          status flips back to idle / completed. Polls every 2 s via
          ``useReprocessStatus``. */}
      {batchStatus.data && batchRunning && (
        <BatchProgressBanner status={batchStatus.data} />
      )}

      <div className="card">
        {/* Sticky thead is two rows: the column titles + a per-column
            filter row. Each <th>/<td> in the sticky region carries an
            opaque background so scrolling rows don't bleed through. */}
        <table
          className="table"
          style={
            {
              ["--mg-sticky-bg" as string]: "var(--bg)",
            } as React.CSSProperties
          }
        >
          <thead
            style={{
              position: "sticky",
              top: 0,
              zIndex: 2,
              background: "var(--bg)",
              boxShadow: "0 1px 0 var(--border)",
            }}
          >
            {/* Row 1 — column titles */}
            <tr>
              <th style={{ width: 36, background: "var(--bg)" }}>
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleSelectAllOnPage}
                  aria-label="Select all clips on this page"
                />
              </th>
              <th style={{ width: 70, background: "var(--bg)" }}>ID</th>
              <th style={{ background: "var(--bg)" }}>Camera</th>
              <th style={{ background: "var(--bg)" }}>Clip Name</th>
              <th style={{ width: 160, background: "var(--bg)" }}>
                Start Time
              </th>
              <th style={{ width: 160, background: "var(--bg)" }}>
                End Time
              </th>
              <th style={{ width: 90, background: "var(--bg)" }}>
                Duration
              </th>
              <th style={{ width: 90, background: "var(--bg)" }}>
                File Size
              </th>
              <th style={{ width: 140, background: "var(--bg)" }}>
                Processing Status
              </th>
              <th style={{ width: 150, background: "var(--bg)" }}>
                Processed UCs
              </th>
              <th
                style={{
                  width: 60,
                  textAlign: "end",
                  background: "var(--bg)",
                }}
              >
                Actions
              </th>
            </tr>
            {/* Row 2 — per-column filter inputs */}
            <tr>
              <th style={{ background: "var(--bg)" }} />
              <th style={{ background: "var(--bg)" }} />
              <th style={{ background: "var(--bg)" }}>
                <select
                  value={cameraId ?? ""}
                  onChange={(e) =>
                    setCameraId(
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  style={filterControlStyle}
                  aria-label="Filter by camera"
                >
                  <option value="">All cameras</option>
                  {(camerasQuery.data?.items ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </th>
              <th style={{ background: "var(--bg)" }}>
                <input
                  type="search"
                  placeholder="Search clip name"
                  value={clipNameQ}
                  onChange={(e) => setClipNameQ(e.target.value)}
                  style={filterControlStyle}
                  aria-label="Filter by clip name"
                />
              </th>
              <th style={{ background: "var(--bg)" }}>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={filterControlStyle}
                  aria-label="Filter by start date"
                />
              </th>
              <th style={{ background: "var(--bg)" }}>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={filterControlStyle}
                  aria-label="Filter by end date"
                />
              </th>
              <th style={{ background: "var(--bg)" }} />
              <th style={{ background: "var(--bg)" }} />
              <th style={{ background: "var(--bg)" }}>
                <select
                  value={processingFilter}
                  onChange={(e) =>
                    setProcessingFilter(e.target.value as ProcessingFilter)
                  }
                  style={filterControlStyle}
                  aria-label="Filter by processing status"
                >
                  <option value="all">All</option>
                  <option value="recording">Recording</option>
                  <option value="encoding">Encoding</option>
                  <option value="saved">Saved</option>
                  <option value="processed">Processed</option>
                </select>
              </th>
              <th style={{ background: "var(--bg)" }}>
                <select
                  value={processedUcFilter}
                  onChange={(e) =>
                    setProcessedUcFilter(e.target.value as ProcessedUcFilter)
                  }
                  style={filterControlStyle}
                  aria-label="Filter by processed use cases"
                >
                  <option value="any">Any</option>
                  <option value="uc1">UC1</option>
                  <option value="uc2">UC2</option>
                  <option value="uc3">UC3</option>
                  <option value="not_processed">Not Processed</option>
                </select>
              </th>
              <th style={{ background: "var(--bg)" }} />
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td
                  colSpan={11}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  Loading…
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={11}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  Could not load clips.
                </td>
              </tr>
            )}
            {!list.isLoading && !list.isError && items.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  No clips matching the current filter. Toggle Recording
                  on a camera and walk past it — a row will appear here
                  once a person is detected and the clip lands on disk.
                </td>
              </tr>
            )}
            {items.map((c) => {
              const isSelected = selected.has(c.id);
              // Migration 0054 / 0055 — recording + finalizing clips
              // have no playable MP4 yet. Row stays non-clickable so
              // we don't open an empty video modal on the partial
              // file. ``completed`` is the only state with a stable
              // artifact on disk.
              const playable = c.recording_status === "completed";
              return (
                <tr
                  key={c.id}
                  onClick={
                    playable ? () => setDetailTarget(c) : undefined
                  }
                  title={
                    playable
                      ? "Click to view full details"
                      : `Details unavailable while clip is ${c.recording_status}`
                  }
                  style={{
                    cursor: playable ? "pointer" : "not-allowed",
                    background: isSelected
                      ? "var(--accent-soft)"
                      : undefined,
                  }}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(c.id)}
                      aria-label="Select clip"
                    />
                  </td>
                  <td className="mono text-sm" style={{ color: "var(--text-secondary)" }}>
                    #{c.id}
                  </td>
                  <td>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <div
                        className="avatar"
                        style={{
                          background: avatarBg(c.camera_name || "?"),
                          color: "var(--text-on-accent, #fff)",
                          display: "grid",
                          placeItems: "center",
                        }}
                        aria-hidden
                      >
                        <Icon name="camera" size={14} />
                      </div>
                      <div style={{ fontWeight: 500 }}>
                        {c.camera_name || "—"}
                      </div>
                    </div>
                  </td>
                  <td className="mono text-sm">{c.clip_name || "—"}</td>
                  <td className="text-sm">{fmtDateTime(c.clip_start)}</td>
                  <td className="text-sm">{fmtDateTime(c.clip_end)}</td>
                  <td className="mono text-sm">
                    {fmtDuration(c.duration_seconds)}
                  </td>
                  <td className="mono text-sm">
                    {fmtBytes(c.filesize_bytes)}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <StatusPill
                      status={processingStatusLabel(c)}
                      onClick={() => setLiveTarget(c)}
                    />
                  </td>
                  <td className="text-sm">{processedUseCasesLabel(c)}</td>
                  <td
                    onClick={(e) => e.stopPropagation()}
                    style={{ textAlign: "end" }}
                  >
                    <RowMenu
                      onViewDetails={
                        playable ? () => setDetailTarget(c) : undefined
                      }
                      onEdit={() => alert("Edit coming soon")}
                      onDelete={() => setDeleteTarget(c)}
                      onIdentify={() => setIdentifyTarget(c)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Pagination strip — mirrors EmployeesPage. Hidden when
            empty so we don't advertise pages 1-N over a blank table. */}
        {total > 0 && (
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
              Page {page} of {totalPages} · {total.toLocaleString()} total
              {selected.size > 0 && (
                <>
                  {" · "}
                  <strong>{selected.size}</strong> selected
                </>
              )}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn btn-sm"
                disabled={page <= 1 || list.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <Icon name="chevronLeft" size={11} />
                Previous
              </button>
              <button
                className="btn btn-sm"
                disabled={page >= totalPages || list.isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
                <Icon name="chevronRight" size={11} />
              </button>
            </div>
          </div>
        )}
      </div>

      {identifyTarget && (
        <IdentifyEventModal
          clip={identifyTarget}
          onClose={() => setIdentifyTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteClipModal
          clip={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      {bulkDeleteScope !== null && (
        <BulkDeleteClipsModal
          scope={bulkDeleteScope}
          selectedIds={Array.from(selected)}
          filterQs={qs}
          onClose={() => setBulkDeleteScope(null)}
          onDone={() => {
            setSelected(new Set());
            setBulkDeleteScope(null);
            void list.refetch();
          }}
          mutation={bulkDelete}
        />
      )}
      {detailTarget && (
        <ClipDetailDrawer
          clip={detailTarget}
          onClose={() => setDetailTarget(null)}
        />
      )}
      {batchOpen && (
        <BatchIdentifyEventModal onClose={() => setBatchOpen(false)} />
      )}
      {liveTarget && (
        <LiveProcessingModal
          clip={liveTarget}
          onClose={() => setLiveTarget(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bulk-delete hook + modal.
//
// Backend: POST /api/person-clips/bulk-delete with {clip_ids: int[]}.
// Capped at 200 ids per request — the modal warns when the active
// filter matches more than that.
// ---------------------------------------------------------------------------

interface BulkDeleteClipResponse {
  deleted_count: number;
  deleted_ids: number[];
}

function useBulkDeletePersonClips() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clip_ids: number[]) =>
      api<BulkDeleteClipResponse>("/api/person-clips/bulk-delete", {
        method: "POST",
        body: { clip_ids },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clip-analytics", "list"] });
    },
  });
}

function BulkDeleteClipsModal({
  scope,
  selectedIds,
  filterQs,
  onClose,
  onDone,
  mutation,
}: {
  scope: "selected" | "all";
  selectedIds: number[];
  filterQs: string;
  onClose: () => void;
  onDone: () => void;
  mutation: ReturnType<typeof useBulkDeletePersonClips>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [resolvingIds, setResolvingIds] = useState(false);

  const onConfirm = async () => {
    setError(null);
    try {
      let ids: number[] = [];
      if (scope === "selected") {
        ids = selectedIds.slice(0, BULK_DELETE_CAP);
      } else {
        setResolvingIds(true);
        const p = new URLSearchParams(filterQs);
        p.set("page", "1");
        p.set("page_size", String(BULK_DELETE_CAP));
        const res = await api<PersonClipListResponse>(
          `/api/person-clips?${p.toString()}`,
        );
        ids = res.items.map((c) => c.id);
        setResolvingIds(false);
      }
      if (ids.length === 0) {
        setError("No clips to delete.");
        return;
      }
      await mutation.mutateAsync(ids);
      onDone();
    } catch (e) {
      setResolvingIds(false);
      const message =
        e instanceof Error ? e.message : "Could not delete clips";
      setError(message);
    }
  };

  const headline =
    scope === "selected"
      ? `Delete ${selectedIds.length} selected clip${selectedIds.length === 1 ? "" : "s"}?`
      : "Delete all clips matching the active filter?";

  const overCap = scope === "selected" && selectedIds.length > BULK_DELETE_CAP;
  const busy = mutation.isPending || resolvingIds;

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Bulk delete clips"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.18))",
            width: 480,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
            {headline}
          </div>
          <div className="text-sm" style={{ color: "var(--text)" }}>
            Files on disk and any processing results will be removed.
            This cannot be undone.
          </div>
          {scope === "all" && (
            <div
              style={{
                background: "var(--warning-soft)",
                color: "var(--warning-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              Capped at {BULK_DELETE_CAP} clips per request. If more
              match the filter, run the action again.
            </div>
          )}
          {overCap && (
            <div
              style={{
                background: "var(--warning-soft)",
                color: "var(--warning-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              Only the first {BULK_DELETE_CAP} of {selectedIds.length}{" "}
              selected will be deleted in this request.
            </div>
          )}
          {error && (
            <div
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 14,
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ background: "var(--danger)", color: "white" }}
              onClick={() => void onConfirm()}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Tiny helpers shared with EmployeesPage in spirit (kept local so this
// page stays self-contained).
// ---------------------------------------------------------------------------

// Tight control style for the per-column header filter row. Width 100%
// so each control fills its <th> column.
const filterControlStyle: React.CSSProperties = {
  padding: "3px 6px",
  fontSize: 11.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
  width: "100%",
  fontWeight: 400,
};

function avatarBg(seed: string): string {
  const palette = [
    "#7c3aed",
    "#2563eb",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#06b6d4",
    "#8b5cf6",
    "#f97316",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] as string;
}

// ---------------------------------------------------------------------------
// Row action menu — 3-dot kebab with Edit / Delete / Identify Event.
// ---------------------------------------------------------------------------

function RowMenu({
  onViewDetails,
  onEdit,
  onDelete,
  onIdentify,
}: {
  // ``onViewDetails`` is gated upstream — only ``completed`` clips
  // get the prop. ``recording`` / ``finalizing`` clips render the
  // menu without that entry.
  onViewDetails?: (() => void) | undefined;
  onEdit: () => void;
  onDelete: () => void;
  onIdentify: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className="icon-btn"
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          padding: 4,
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        <Icon name="moreVertical" size={16} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            insetInlineEnd: 0,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-md, 0 4px 16px rgba(0,0,0,0.12))",
            minWidth: 180,
            padding: 4,
            zIndex: 10,
          }}
        >
          {onViewDetails && (
            <MenuItem
              label="View Details"
              iconName="eye"
              onClick={() => {
                setOpen(false);
                onViewDetails();
              }}
            />
          )}
          <MenuItem
            label="Edit"
            iconName="edit"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          />
          <MenuItem
            label="Identify Event"
            iconName="user"
            onClick={() => {
              setOpen(false);
              onIdentify();
            }}
          />
          <MenuItem
            label="Delete"
            iconName="trash"
            danger
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  iconName,
  onClick,
  danger,
}: {
  label: string;
  iconName: IconName;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px 10px",
        fontSize: 13,
        textAlign: "start",
        background: "transparent",
        border: "none",
        borderRadius: "var(--radius-sm)",
        color: danger ? "var(--danger-text)" : "var(--text)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = danger
          ? "var(--danger-soft)"
          : "var(--bg, rgba(0,0,0,0.04))")
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon name={iconName} size={14} />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Identify Event modal — UC1 / UC2 / UC3 selection + overwrite confirm.
// ---------------------------------------------------------------------------

type IdentifyStep = "pick" | "confirm-overwrite";

// ---- Identify Event — visual catalogue for the three UC tiles ----

interface UseCaseTile {
  code: UseCaseCode;
  title: string;
  subtitle: string;
  speedLabel: string;
  speedTone: "fast" | "balanced" | "thorough";
  accuracyLabel: string;
  iconName: IconName;
  accent: string;
  accentSoft: string;
}

const UC_TILES: readonly UseCaseTile[] = [
  {
    code: "uc1",
    title: "YOLO + Face",
    subtitle: "Body detection first, then face inside each box.",
    speedLabel: "Thorough",
    speedTone: "thorough",
    accuracyLabel: "Highest accuracy",
    iconName: "shield",
    accent: "#3b82f6",
    accentSoft: "rgba(59,130,246,0.12)",
  },
  {
    code: "uc2",
    title: "InsightFace + Crops",
    subtitle: "Stores face crops with pose-aware quality scoring.",
    speedLabel: "Balanced",
    speedTone: "balanced",
    accuracyLabel: "Evidence trail",
    iconName: "user",
    accent: "#8b5cf6",
    accentSoft: "rgba(139,92,246,0.12)",
  },
  {
    code: "uc3",
    title: "InsightFace Direct",
    subtitle: "Skip crop storage. Just match and report.",
    speedLabel: "Fastest",
    speedTone: "fast",
    accuracyLabel: "Lowest overhead",
    iconName: "sparkles",
    accent: "#10b981",
    accentSoft: "rgba(16,185,129,0.12)",
  },
];

// ---------------------------------------------------------------------------
// Batch Identify Event — runs the reprocess worker across every saved
// clip in this tenant. Reuses UC_TILES + UseCaseCard from the per-row
// modal; adds a mode radio (skip-existing vs reprocess-everything).
//
// Backend: POST /api/person-clips/reprocess-face-match
//   { mode: "skip_existing" | "all", use_cases: [...] }
// Progress is surfaced separately by the BatchProgressBanner via
// /api/person-clips/reprocess-status.
// ---------------------------------------------------------------------------

type BatchMode = "skip_existing" | "all";

function BatchIdentifyEventModal({ onClose }: { onClose: () => void }) {
  const reprocess = useReprocessFaceMatch();
  const status = useReprocessStatus();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<Set<UseCaseCode>>(
    () => new Set(["uc3"] as UseCaseCode[]),
  );
  const [mode, setMode] = useState<BatchMode>("skip_existing");
  const [error, setError] = useState<string | null>(null);

  const toggle = (uc: UseCaseCode) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uc)) next.delete(uc);
      else next.add(uc);
      return next;
    });

  const running =
    status.data?.status === "running" || status.data?.status === "starting";

  const onStart = async () => {
    if (selected.size === 0) {
      setError("Pick at least one use case.");
      return;
    }
    setError(null);
    try {
      const res = await reprocess.mutateAsync({
        mode,
        use_cases: Array.from(selected),
      });
      if (!res.started) {
        setError(res.message || "Could not start.");
        return;
      }
      qc.invalidateQueries({ queryKey: ["clip-analytics", "list"] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start.");
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background:
            "linear-gradient(180deg, rgba(10,12,20,0.55), rgba(10,12,20,0.72))",
          backdropFilter: "blur(2px)",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Identify Event — all clips"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "0 24px 64px rgba(10,12,20,0.35)",
            width: 720,
            maxWidth: "calc(100vw - 48px)",
            overflow: "hidden",
          }}
        >
          {/* Gradient header — distinct accent from the per-row modal
              (purple → indigo) so the operator visually registers
              they're firing a much larger action. */}
          <div
            style={{
              padding: "22px 22px 18px",
              background:
                "linear-gradient(135deg, #8b5cf6 0%, #6366f1 60%, #3b82f6 100%)",
              color: "white",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                aria-hidden
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.18)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Icon name="sparkles" size={20} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    opacity: 0.85,
                  }}
                >
                  Clip Analytics · Batch
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
                  Identify Event — overall process
                </div>
              </div>
            </div>
            <div
              style={{
                marginTop: 12,
                fontSize: 12.5,
                lineHeight: 1.55,
                opacity: 0.92,
              }}
            >
              Run the chosen use cases across <strong>every saved clip</strong> in
              this tenant. Pick what to do with clips that have already
              been processed.
            </div>
          </div>

          {/* UC selection — reuses the per-row tile catalogue. */}
          <div style={{ padding: "18px 22px 6px" }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-secondary)",
                marginBottom: 10,
              }}
            >
              Use cases to run
            </div>
            <div
              role="group"
              aria-label="Use cases"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              {UC_TILES.map((tile) => (
                <UseCaseCard
                  key={tile.code}
                  tile={tile}
                  checked={selected.has(tile.code)}
                  already={false}
                  onToggle={() => toggle(tile.code)}
                />
              ))}
            </div>
          </div>

          {/* Mode picker — the load-bearing piece for "overall process". */}
          <div style={{ padding: "16px 22px 4px" }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-secondary)",
                marginBottom: 10,
              }}
            >
              Mode
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <ModeRow
                value="skip_existing"
                active={mode === "skip_existing"}
                onPick={() => setMode("skip_existing")}
                title="Skip already processed"
                subtitle="Only run clips that don't yet have a result for the chosen use cases. Safe default — won't redo work."
              />
              <ModeRow
                value="all"
                active={mode === "all"}
                onPick={() => setMode("all")}
                title="Reprocess everything (overwrite)"
                subtitle="Run every clip in this tenant. Existing results for the chosen use cases will be overwritten."
                tone="warn"
              />
            </div>
            {running && (
              <div
                style={{
                  marginTop: 12,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "var(--warning-soft)",
                  color: "var(--warning-text)",
                  fontSize: 12.5,
                  border: "1px solid rgba(245,158,11,0.25)",
                }}
              >
                A batch is already running ({status.data?.processed_clips ?? 0} /{" "}
                {status.data?.total_clips ?? 0}). Wait for it to finish before
                starting another.
              </div>
            )}
            {error && (
              <div
                style={{
                  marginTop: 12,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  fontSize: 12.5,
                  border: "1px solid rgba(239,68,68,0.25)",
                }}
              >
                {error}
              </div>
            )}
          </div>

          <ModalFooter
            leftSlot={
              <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {selected.size === 0
                  ? "No use cases selected"
                  : `${selected.size} use case${selected.size === 1 ? "" : "s"} · ${
                      mode === "skip_existing" ? "skip existing" : "overwrite"
                    }`}
              </div>
            }
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={reprocess.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onStart()}
              disabled={
                reprocess.isPending || selected.size === 0 || running
              }
              style={
                mode === "all"
                  ? { background: "var(--danger)", color: "white" }
                  : undefined
              }
            >
              {reprocess.isPending
                ? "Starting…"
                : mode === "all"
                  ? "Reprocess everything"
                  : "Start processing"}
            </button>
          </ModalFooter>
        </div>
      </div>
    </ModalShell>
  );
}

function ModeRow({
  value,
  active,
  onPick,
  title,
  subtitle,
  tone,
}: {
  value: BatchMode;
  active: boolean;
  onPick: () => void;
  title: string;
  subtitle: string;
  tone?: "warn";
}) {
  const accent = tone === "warn" ? "var(--danger)" : "var(--accent)";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onPick}
      style={{
        textAlign: "start",
        display: "flex",
        gap: 10,
        padding: 12,
        border: active
          ? `2px solid ${accent}`
          : "1px solid var(--border)",
        background: active
          ? "rgba(99,102,241,0.06)"
          : "var(--bg)",
        borderRadius: 12,
        cursor: "pointer",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: `2px solid ${active ? accent : "var(--border)"}`,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {active && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: accent,
            }}
          />
        )}
      </div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 13.5,
            color: active ? accent : "var(--text)",
          }}
        >
          {title}
        </div>
        <div
          className="text-xs"
          style={{ marginTop: 3, color: "var(--text-secondary)", lineHeight: 1.5 }}
        >
          {subtitle}
        </div>
      </div>
      <span hidden>{value}</span>
    </button>
  );
}

// Live progress banner — only shown while the batch worker is in
// flight. Auto-disappears when status flips back to idle.
function BatchProgressBanner({
  status,
}: {
  status: {
    status: string;
    mode: string;
    use_cases: string[];
    total_clips: number;
    processed_clips: number;
    matched_total: number;
    failed_count: number;
  };
}) {
  const pct =
    status.total_clips > 0
      ? Math.min(100, (status.processed_clips / status.total_clips) * 100)
      : 0;
  const ucs = status.use_cases.map((u) => u.toUpperCase()).join(" · ");
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        margin: "0 0 12px",
        padding: "12px 14px",
        borderRadius: "var(--radius)",
        background:
          "linear-gradient(90deg, rgba(139,92,246,0.10), rgba(59,130,246,0.10))",
        border: "1px solid rgba(99,102,241,0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
        }}
      >
        <Icon name="sparkles" size={14} />
        <strong>Identify Event running</strong>
        <span
          className="mono"
          style={{ color: "var(--text-secondary)", fontSize: 12 }}
        >
          {status.processed_clips} / {status.total_clips} clips
        </span>
        <span style={{ flex: 1 }} />
        <span className="text-xs text-dim">
          {ucs} · {status.mode === "skip_existing" ? "skip existing" : "overwrite"}
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 999,
          background: "rgba(0,0,0,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background:
              "linear-gradient(90deg, #8b5cf6 0%, #6366f1 60%, #3b82f6 100%)",
            transition: "width 240ms ease",
          }}
        />
      </div>
      <div className="text-xs text-dim" style={{ display: "flex", gap: 12 }}>
        <span>
          Matched so far: <strong>{status.matched_total}</strong>
        </span>
        {status.failed_count > 0 && (
          <span style={{ color: "var(--danger-text)" }}>
            Failed: {status.failed_count}
          </span>
        )}
      </div>
    </div>
  );
}

function IdentifyEventModal({
  clip,
  onClose,
}: {
  clip: PersonClipOut;
  onClose: () => void;
}) {
  const reprocess = useSingleClipReprocess(clip.id);
  const qc = useQueryClient();
  const alreadyProcessed = new Set<UseCaseCode>(
    clip.processed_use_cases.filter((u): u is UseCaseCode =>
      (ALL_USE_CASES as readonly string[]).includes(u),
    ),
  );

  const [selected, setSelected] = useState<Set<UseCaseCode>>(new Set());
  const [step, setStep] = useState<IdentifyStep>("pick");
  const [error, setError] = useState<string | null>(null);

  const conflicts = Array.from(selected).filter((uc) =>
    alreadyProcessed.has(uc),
  );

  const toggle = (uc: UseCaseCode) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uc)) next.delete(uc);
      else next.add(uc);
      return next;
    });
  };

  const fire = async (useCases: UseCaseCode[]) => {
    setError(null);
    try {
      await reprocess.mutateAsync({ use_cases: useCases });
      // Refresh the list so the "Processed Use Cases" column updates
      // once the worker thread finishes.
      qc.invalidateQueries({ queryKey: ["clip-analytics", "list"] });
      onClose();
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not start processing";
      setError(message);
    }
  };

  const onProcessClick = () => {
    if (selected.size === 0) {
      setError("Pick at least one use case.");
      return;
    }
    if (conflicts.length > 0) {
      setStep("confirm-overwrite");
      return;
    }
    void fire(Array.from(selected));
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background:
            "linear-gradient(180deg, rgba(10,12,20,0.55), rgba(10,12,20,0.72))",
          backdropFilter: "blur(2px)",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Identify event"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "0 24px 64px rgba(10,12,20,0.35)",
            width: 720,
            maxWidth: "calc(100vw - 48px)",
            overflow: "hidden",
          }}
        >
          {step === "pick" ? (
            <PickStep
              clip={clip}
              selected={selected}
              alreadyProcessed={alreadyProcessed}
              onToggle={toggle}
              onCancel={onClose}
              onProcess={onProcessClick}
              busy={reprocess.isPending}
              error={error}
            />
          ) : (
            <OverwriteConfirmStep
              conflicts={conflicts}
              clip={clip}
              onCancel={() => setStep("pick")}
              onSkipExisting={() => {
                const fresh = Array.from(selected).filter(
                  (uc) => !alreadyProcessed.has(uc),
                );
                if (fresh.length === 0) {
                  setStep("pick");
                  setError(
                    "Nothing left after skipping already-processed use cases.",
                  );
                  return;
                }
                void fire(fresh);
              }}
              onReprocessAll={() => void fire(Array.from(selected))}
              busy={reprocess.isPending}
              error={error}
            />
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function PickStep({
  clip,
  selected,
  alreadyProcessed,
  onToggle,
  onCancel,
  onProcess,
  busy,
  error,
}: {
  clip: PersonClipOut;
  selected: Set<UseCaseCode>;
  alreadyProcessed: Set<UseCaseCode>;
  onToggle: (uc: UseCaseCode) => void;
  onCancel: () => void;
  onProcess: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <>
      <ModalHeader clip={clip} title="Identify Event" />

      <div style={{ padding: "18px 22px 6px" }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--text-secondary)",
            marginBottom: 10,
          }}
        >
          Choose use cases to run
        </div>

        <div
          role="group"
          aria-label="Use cases"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
          }}
        >
          {UC_TILES.map((tile) => (
            <UseCaseCard
              key={tile.code}
              tile={tile}
              checked={selected.has(tile.code)}
              already={alreadyProcessed.has(tile.code)}
              onToggle={() => onToggle(tile.code)}
            />
          ))}
        </div>

        {error && (
          <div
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 12.5,
              marginTop: 14,
              border: "1px solid var(--danger, rgba(239,68,68,0.25))",
            }}
          >
            {error}
          </div>
        )}
      </div>

      <ModalFooter
        leftSlot={
          <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
            {selected.size === 0
              ? "No use cases selected"
              : `${selected.size} use case${selected.size === 1 ? "" : "s"} selected`}
            {alreadyProcessed.size > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--success-text)" }}>
                  {alreadyProcessed.size} already processed
                </span>
              </>
            )}
          </div>
        }
      >
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onProcess}
          disabled={busy || selected.size === 0}
        >
          {busy ? "Starting…" : "Process"}
        </button>
      </ModalFooter>
    </>
  );
}

function OverwriteConfirmStep({
  conflicts,
  clip,
  onCancel,
  onSkipExisting,
  onReprocessAll,
  busy,
  error,
}: {
  conflicts: UseCaseCode[];
  clip: PersonClipOut;
  onCancel: () => void;
  onSkipExisting: () => void;
  onReprocessAll: () => void;
  busy: boolean;
  error: string | null;
}) {
  const conflictList = conflicts.map((u) => u.toUpperCase());
  return (
    <>
      <ModalHeader
        clip={clip}
        title="Already processed"
        tone="warning"
        iconName="info"
      />

      <div style={{ padding: "20px 22px 4px" }}>
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          {conflictList.map((code) => (
            <span
              key={code}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 999,
                background: "var(--success-soft)",
                color: "var(--success-text)",
                border: "1px solid rgba(16,185,129,0.25)",
              }}
            >
              <Icon name="check" size={12} />
              {code}
            </span>
          ))}
        </div>
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "var(--text)",
          }}
        >
          {conflicts.length === 1 ? (
            <>
              <strong>{conflictList[0]}</strong> has already been processed
              for this clip. Do you want to overwrite the existing result, or
              skip it and only run the new use cases?
            </>
          ) : (
            <>
              <strong>{conflictList.join(", ")}</strong> have already been
              processed for this clip. Do you want to overwrite the existing
              results, or skip them and only run the new use cases?
            </>
          )}
        </div>

        {error && (
          <div
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 12.5,
              marginTop: 14,
              border: "1px solid var(--danger, rgba(239,68,68,0.25))",
            }}
          >
            {error}
          </div>
        )}
      </div>

      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={onSkipExisting}
          disabled={busy}
        >
          Skip Existing
        </button>
        <button
          type="button"
          className="btn btn-primary"
          style={{ background: "var(--danger)", color: "white" }}
          onClick={onReprocessAll}
          disabled={busy}
        >
          {busy
            ? "Starting…"
            : conflicts.length === 1
              ? "Reprocess Use Case"
              : "Reprocess Use Cases"}
        </button>
      </ModalFooter>
    </>
  );
}

// ---- Modal sub-pieces ----

function ModalHeader({
  clip,
  title,
  tone,
  iconName,
}: {
  clip: PersonClipOut;
  title: string;
  tone?: "default" | "warning";
  iconName?: IconName;
}) {
  const accentBg =
    tone === "warning"
      ? "linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)"
      : "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 50%, #10b981 100%)";
  const headerIcon: IconName = iconName ?? "user";
  return (
    <div
      style={{
        padding: "22px 22px 18px",
        background: accentBg,
        color: "white",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            background: "rgba(255,255,255,0.18)",
            display: "grid",
            placeItems: "center",
            border: "1px solid rgba(255,255,255,0.25)",
          }}
        >
          <Icon name={headerIcon} size={20} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              opacity: 0.85,
            }}
          >
            Clip Analytics
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
            {title}
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <SummaryChip iconName="camera" label={clip.camera_name || "Unknown"} />
        <SummaryChip iconName="fileText" mono label={clip.clip_name || `clip-${clip.id}`} />
        <SummaryChip
          iconName="clock"
          mono
          label={fmtDuration(clip.duration_seconds)}
        />
        <SummaryChip
          iconName="download"
          mono
          label={fmtBytes(clip.filesize_bytes)}
        />
      </div>
    </div>
  );
}

function SummaryChip({
  iconName,
  label,
  mono,
}: {
  iconName: IconName;
  label: string;
  mono?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.18)",
        border: "1px solid rgba(255,255,255,0.22)",
        color: "white",
        fontSize: 12,
        fontFamily: mono
          ? "var(--font-mono, ui-monospace, SFMono-Regular, monospace)"
          : undefined,
        fontWeight: 500,
      }}
    >
      <Icon name={iconName} size={12} />
      {label}
    </span>
  );
}

function UseCaseCard({
  tile,
  checked,
  already,
  onToggle,
}: {
  tile: UseCaseTile;
  checked: boolean;
  already: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      style={{
        textAlign: "start",
        background: checked ? tile.accentSoft : "var(--bg)",
        border: checked
          ? `2px solid ${tile.accent}`
          : "1px solid var(--border)",
        borderRadius: 14,
        padding: 14,
        cursor: "pointer",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        transition: "transform 100ms ease, box-shadow 100ms ease",
        boxShadow: checked
          ? `0 8px 24px ${tile.accentSoft}`
          : "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      {already && (
        <span
          style={{
            position: "absolute",
            top: 10,
            insetInlineEnd: 10,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            background: "var(--success-soft)",
            color: "var(--success-text)",
            border: "1px solid rgba(16,185,129,0.25)",
          }}
        >
          <Icon name="check" size={10} />
          Processed
        </span>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingInlineEnd: already ? 70 : 0,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: checked ? tile.accent : tile.accentSoft,
            color: checked ? "white" : tile.accent,
            display: "grid",
            placeItems: "center",
            transition: "background 100ms ease, color 100ms ease",
          }}
        >
          <Icon name={tile.iconName} size={16} />
        </div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: checked ? tile.accent : "var(--text)",
          }}
        >
          {tile.code.toUpperCase()}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {tile.title}
        </div>
        <div
          className="text-xs"
          style={{ marginTop: 4, color: "var(--text-secondary)", lineHeight: 1.5 }}
        >
          {tile.subtitle}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <SpeedChip label={tile.speedLabel} tone={tile.speedTone} />
        <span
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11,
            background: "var(--bg-elev, var(--bg))",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
          }}
        >
          {tile.accuracyLabel}
        </span>
      </div>

      <div
        aria-hidden
        style={{
          position: "absolute",
          insetInlineStart: 0,
          top: 0,
          bottom: 0,
          width: 4,
          background: checked ? tile.accent : "transparent",
          borderStartStartRadius: 14,
          borderEndStartRadius: 14,
        }}
      />
    </button>
  );
}

function SpeedChip({
  label,
  tone,
}: {
  label: string;
  tone: "fast" | "balanced" | "thorough";
}) {
  const palette: Record<typeof tone, { bg: string; fg: string }> = {
    fast: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
    balanced: { bg: "rgba(139,92,246,0.12)", fg: "#6d28d9" },
    thorough: { bg: "rgba(59,130,246,0.12)", fg: "#1d4ed8" },
  } as const;
  const { bg, fg } = palette[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: bg,
        color: fg,
      }}
    >
      <Icon name="activity" size={10} />
      {label}
    </span>
  );
}

function ModalFooter({
  children,
  leftSlot,
}: {
  children: React.ReactNode;
  leftSlot?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "14px 22px 18px",
        borderTop: "1px solid var(--border)",
        marginTop: 14,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>{leftSlot}</div>
      <div style={{ display: "flex", gap: 8 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation modal.
// ---------------------------------------------------------------------------

function DeleteClipModal({
  clip,
  onClose,
}: {
  clip: PersonClipOut;
  onClose: () => void;
}) {
  const del = useDeletePersonClip();
  const [error, setError] = useState<string | null>(null);

  const blockedByLifecycle =
    clip.recording_status === "recording" ||
    clip.recording_status === "finalizing";

  const onConfirm = async () => {
    if (blockedByLifecycle) {
      setError(
        "Cannot delete a clip that is still recording or being encoded.",
      );
      return;
    }
    setError(null);
    try {
      await del.mutateAsync(clip.id);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not delete clip";
      setError(message);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete clip"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.18))",
            width: 420,
            maxWidth: "calc(100vw - 32px)",
            padding: 18,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            Delete clip?
          </div>
          <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {clip.camera_name} · {clip.clip_name}
          </div>
          <div
            className="text-sm"
            style={{ marginTop: 10, color: "var(--text)" }}
          >
            The MP4 + any processing results will be removed. This cannot be
            undone.
          </div>
          {blockedByLifecycle && (
            <div
              style={{
                background: "var(--warning-soft)",
                color: "var(--warning-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              The clip is still {clip.recording_status}. Wait for encoding to
              finish before deleting.
            </div>
          )}
          {error && (
            <div
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 10,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 14,
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={del.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ background: "var(--danger)", color: "white" }}
              onClick={() => void onConfirm()}
              disabled={del.isPending || blockedByLifecycle}
            >
              {del.isPending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Live Processing modal — full real-time view of a clip's processing
// state. Opened by clicking the Processing Status pill.
//
// Polls aggressively (1.5 s) for clips actively being processed; falls
// back to 5 s once everything has reached a terminal state.
// ---------------------------------------------------------------------------

type UcCode = "uc1" | "uc2" | "uc3";

const UC_LIVE_META: Record<UcCode, { label: string; accent: string; accentSoft: string }> = {
  uc1: { label: "YOLO + Face", accent: "#3b82f6", accentSoft: "rgba(59,130,246,0.12)" },
  uc2: { label: "InsightFace + Crops", accent: "#8b5cf6", accentSoft: "rgba(139,92,246,0.12)" },
  uc3: { label: "InsightFace Direct", accent: "#10b981", accentSoft: "rgba(16,185,129,0.12)" },
};

function LiveProcessingModal({
  clip,
  onClose,
}: {
  clip: PersonClipOut;
  onClose: () => void;
}) {
  const qc = useQueryClient();

  // Poll the parent clip row every 2 s so the recording_status +
  // face_matching_progress fields stay fresh. The list query has its
  // own 10 s poll, but the modal needs finer granularity.
  const clipRow = useQuery({
    queryKey: ["clip-analytics", "live", clip.id],
    queryFn: () => api<PersonClipOut>(`/api/person-clips/${clip.id}`),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    initialData: clip,
  });
  const live = clipRow.data ?? clip;

  // Per-UC progress rows + face crops. The hooks self-poll while
  // anything is still processing/pending.
  const results = useClipProcessingResults(clip.id, true);
  const uc1Crops = useClipFaceCrops(clip.id, "uc1");
  const uc2Crops = useClipFaceCrops(clip.id, "uc2");
  const uc3Crops = useClipFaceCrops(clip.id, "uc3");

  const ucResults = results.data?.results ?? [];
  const uc1 = ucResults.find((r) => r.use_case === "uc1") ?? null;
  const uc2 = ucResults.find((r) => r.use_case === "uc2") ?? null;
  const uc3 = ucResults.find((r) => r.use_case === "uc3") ?? null;

  // Esc to close.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  // Compute the current overall stage. Order: Recording → Encoding →
  // Face Extraction → Face Matching → Completed. Failed wins over all.
  const overallStage = computeOverallStage(live, ucResults);
  const totalElapsed = computeTotalElapsedMs(live, ucResults);

  // Drop any cached UC list once everything is done so the next open
  // doesn't show stale numbers if reprocess fires.
  useEffect(() => {
    return () => {
      qc.invalidateQueries({ queryKey: ["person-clips", "processing-results", clip.id] });
    };
  }, [clip.id, qc]);

  const isInFlight =
    overallStage.state !== "completed" && overallStage.state !== "failed";

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background:
            "linear-gradient(180deg, rgba(10,12,20,0.55), rgba(10,12,20,0.72))",
          backdropFilter: "blur(2px)",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Live processing details"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "0 24px 64px rgba(10,12,20,0.35)",
            width: 920,
            maxWidth: "calc(100vw - 48px)",
            maxHeight: "calc(100vh - 48px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Hero header. Pulse dot when live; static otherwise. */}
          <div
            style={{
              padding: "20px 22px 16px",
              background: isInFlight
                ? "linear-gradient(135deg, #ef4444 0%, #f59e0b 60%, #8b5cf6 100%)"
                : "linear-gradient(135deg, #10b981 0%, #3b82f6 100%)",
              color: "white",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                aria-hidden
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.18)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Icon name="activity" size={20} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    opacity: 0.85,
                  }}
                >
                  {isInFlight && <LiveDot />}
                  Clip Analytics · Live processing
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
                  {overallStage.label}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  background: "rgba(255,255,255,0.18)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  color: "white",
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  cursor: "pointer",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            <div
              style={{
                marginTop: 14,
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <SummaryChip iconName="camera" label={clip.camera_name || "—"} />
              <SummaryChip
                iconName="fileText"
                mono
                label={clip.clip_name || `clip-${clip.id}`}
              />
              <SummaryChip
                iconName="clock"
                mono
                label={`#${clip.id}`}
              />
            </div>
          </div>

          {/* Body — scroll within the modal so the header stays pinned. */}
          <div style={{ overflow: "auto", padding: "16px 22px 22px" }}>
            {/* Overall pipeline */}
            <SectionLabelLive>Pipeline</SectionLabelLive>
            <StageTrack stage={overallStage.state} live={live} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 8,
                marginTop: 10,
              }}
            >
              <LiveKpi
                label="Total elapsed"
                value={totalElapsed != null ? fmtElapsedMs(totalElapsed) : "—"}
              />
              <LiveKpi
                label="Recording status"
                value={live.recording_status}
              />
              <LiveKpi
                label="Matching status"
                value={live.matched_status}
              />
              <LiveKpi
                label="Match progress"
                value={`${live.face_matching_progress ?? 0}%`}
              />
            </div>

            {/* Per-UC tracks */}
            <SectionLabelLive style={{ marginTop: 18 }}>
              Per use case
            </SectionLabelLive>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              <UcLiveCard ucCode="uc1" result={uc1} cropsCount={uc1Crops.data?.total ?? 0} />
              <UcLiveCard ucCode="uc2" result={uc2} cropsCount={uc2Crops.data?.total ?? 0} />
              <UcLiveCard ucCode="uc3" result={uc3} cropsCount={uc3Crops.data?.total ?? 0} />
            </div>

            {/* Detected/matched persons */}
            {hasAnyMatchDetails(ucResults) && (
              <>
                <SectionLabelLive style={{ marginTop: 18 }}>
                  Detected persons
                </SectionLabelLive>
                <MatchConfidenceList ucResults={ucResults} />
              </>
            )}

            {/* Live face crops */}
            {(uc1Crops.data?.items ?? uc2Crops.data?.items ?? uc3Crops.data?.items) && (
              <>
                <SectionLabelLive style={{ marginTop: 18 }}>
                  Face crops (latest)
                </SectionLabelLive>
                <LiveCropsStrip
                  clipId={clip.id}
                  crops={[
                    ...(uc1Crops.data?.items ?? []),
                    ...(uc2Crops.data?.items ?? []),
                    ...(uc3Crops.data?.items ?? []),
                  ]}
                />
              </>
            )}

            {/* Errors */}
            {anyUcFailed(ucResults) && (
              <div
                style={{
                  marginTop: 18,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  border: "1px solid rgba(239,68,68,0.25)",
                  fontSize: 12.5,
                }}
              >
                <strong>Errors:</strong>{" "}
                {ucResults
                  .filter((r) => r.status === "failed" && r.error)
                  .map((r) => `${r.use_case.toUpperCase()}: ${r.error}`)
                  .join(" · ")}
              </div>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// ---- Overall stage computation ----

type OverallStageState =
  | "recording"
  | "encoding"
  | "extracting"
  | "matching"
  | "completed"
  | "failed";

function computeOverallStage(
  clip: PersonClipOut,
  ucs: ClipProcessingResult[],
): { state: OverallStageState; label: string } {
  if (clip.recording_status === "failed" || clip.recording_status === "abandoned") {
    return { state: "failed", label: "Recording failed" };
  }
  if (ucs.some((r) => r.status === "failed")) {
    return { state: "failed", label: "Processing failed on one or more use cases" };
  }
  if (clip.recording_status === "recording") {
    return { state: "recording", label: "Recording from camera" };
  }
  if (clip.recording_status === "finalizing") {
    return { state: "encoding", label: "Encoding MP4 — finalizing chunks" };
  }
  // Recording is completed. Inspect the UC pipeline.
  const anyProcessing = ucs.some((r) => r.status === "processing");
  if (anyProcessing) {
    // Heuristic: if any UC has finished extraction but not match, we're
    // in the matching phase; otherwise extraction.
    const extracting = ucs.some(
      (r) => r.status === "processing" && (r.face_extract_duration_ms ?? 0) === 0,
    );
    if (extracting) {
      return { state: "extracting", label: "Face crop extraction" };
    }
    return { state: "matching", label: "Face matching" };
  }
  const anyPending = ucs.some((r) => r.status === "pending");
  if (anyPending) {
    return { state: "extracting", label: "Queued for face extraction" };
  }
  if (ucs.length > 0 && ucs.every((r) => r.status === "completed")) {
    return { state: "completed", label: "Processing complete" };
  }
  // Saved but no UC has been run yet.
  return { state: "completed", label: "Saved — no use case processed yet" };
}

function computeTotalElapsedMs(
  clip: PersonClipOut,
  ucs: ClipProcessingResult[],
): number | null {
  // While recording: elapsed = now - clip_start.
  if (clip.recording_status === "recording") {
    const ts = Date.parse(clip.clip_start);
    return Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
  }
  // While encoding: elapsed = now - encoding_start_at (fall back to clip_end).
  if (clip.recording_status === "finalizing") {
    const anchor = clip.encoding_start_at ?? clip.clip_end;
    const ts = Date.parse(anchor);
    return Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
  }
  // Otherwise sum the UC durations that have landed.
  const total = ucs.reduce((acc, r) => acc + (r.duration_ms ?? 0), 0);
  return total > 0 ? total : null;
}

function anyUcFailed(ucs: ClipProcessingResult[]): boolean {
  return ucs.some((r) => r.status === "failed");
}

function hasAnyMatchDetails(ucs: ClipProcessingResult[]): boolean {
  return ucs.some(
    (r) =>
      Array.isArray(r.match_details) &&
      r.match_details.length > 0,
  );
}

// ---- Live primitives ----

function LiveDot() {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 0 0 0 rgba(255,255,255,0.7)",
        animation: "live-processing-pulse 1.4s ease-in-out infinite",
      }}
    />
  );
}

function SectionLabelLive({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 11.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-secondary)",
        marginBottom: 10,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function StageTrack({
  stage,
  live,
}: {
  stage: OverallStageState;
  live: PersonClipOut;
}) {
  // Stage order for the track. Recording is excluded from the
  // "post-record" track since the clip can only enter processing
  // after recording is complete.
  const stages: { key: OverallStageState; label: string; icon: IconName }[] = [
    { key: "recording", label: "Recording", icon: "videocam" },
    { key: "encoding", label: "Encoding", icon: "activity" },
    { key: "extracting", label: "Face extraction", icon: "user" },
    { key: "matching", label: "Face matching", icon: "shield" },
    { key: "completed", label: "Completed", icon: "check" },
  ];
  const reachedIndex = stages.findIndex((s) => s.key === stage);
  const isFailed = stage === "failed";

  const successColor = "var(--success-text)";
  const accentColor = "var(--accent, #6366f1)";
  const mutedColor = "var(--text-secondary)";
  const lineMuted = "var(--border)";
  return (
    <div
      style={{
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "18px 16px 14px",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${stages.length}, 1fr)`,
          gap: 0,
          position: "relative",
        }}
      >
        {stages.map((s, i) => {
          const active = i === reachedIndex && !isFailed;
          const past = !isFailed && i < reachedIndex;
          const segmentDone = !isFailed && i < reachedIndex; // connector to next
          const ringColor = past ? successColor : active ? accentColor : lineMuted;
          const fillColor = past ? successColor : active ? accentColor : "transparent";
          const iconColor = past || active ? "#fff" : mutedColor;
          const labelColor = active ? accentColor : past ? successColor : mutedColor;
          return (
            <div
              key={s.key}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                position: "relative",
              }}
            >
              {/* Connector line — drawn from this circle's right to the
                  next circle's left. Green when this stage is completed. */}
              {i < stages.length - 1 && (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 10, // ~ vertical center of 22px circle
                    left: "calc(50% + 14px)",
                    right: "calc(-50% + 14px)",
                    height: 3,
                    background: segmentDone ? successColor : lineMuted,
                    zIndex: 0,
                    transition: "background 200ms ease",
                  }}
                />
              )}
              {/* Circle: green-filled w/ white tick when past, accent-filled
                  when active, neutral outline when future. */}
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  border: `2px solid ${ringColor}`,
                  color: iconColor,
                  display: "grid",
                  placeItems: "center",
                  background: fillColor,
                  position: "relative",
                  zIndex: 1,
                  boxShadow: active
                    ? `0 0 0 4px rgba(99,102,241,0.15)`
                    : past
                      ? `0 0 0 3px rgba(34,197,94,0.12)`
                      : "none",
                  transition: "background 200ms ease, border-color 200ms ease",
                }}
              >
                <Icon name={past ? "check" : s.icon} size={11} />
              </span>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: labelColor,
                    letterSpacing: "0.02em",
                    textAlign: "center",
                  }}
                >
                  {s.label}
                </span>
                {active && stage === "matching" && (
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    {live.face_matching_progress ?? 0}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiveKpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-secondary)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

function UcLiveCard({
  ucCode,
  result,
  cropsCount,
}: {
  ucCode: UcCode;
  result: ClipProcessingResult | null;
  cropsCount: number;
}) {
  const meta = UC_LIVE_META[ucCode];
  const status = result?.status ?? "idle";
  const statusTone: Record<string, { bg: string; fg: string; label: string }> = {
    pending: { bg: "var(--warning-soft)", fg: "var(--warning-text)", label: "Pending" },
    processing: { bg: "rgba(99,102,241,0.12)", fg: "#4338ca", label: "Processing" },
    completed: { bg: "var(--success-soft)", fg: "var(--success-text)", label: "Completed" },
    failed: { bg: "var(--danger-soft)", fg: "var(--danger-text)", label: "Failed" },
    idle: { bg: "var(--bg-sunken)", fg: "var(--text-secondary)", label: "Not run" },
  };
  const sp = statusTone[status] ?? statusTone.idle!;
  const isLive = status === "processing" || status === "pending";

  // Live elapsed when processing: now - started_at (if available).
  const liveElapsedMs = (() => {
    if (status !== "processing") return null;
    if (!result?.started_at) return null;
    const t = Date.parse(result.started_at);
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
  })();

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          background: meta.accentSoft,
          borderBottom: `2px solid ${meta.accent}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: meta.accent,
            letterSpacing: "0.02em",
          }}
        >
          {ucCode.toUpperCase()}
        </div>
        <div
          className="text-xs"
          style={{
            color: "var(--text-secondary)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {meta.label}
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 10.5,
            fontWeight: 700,
            background: sp.bg,
            color: sp.fg,
          }}
        >
          {isLive && <LiveDot />}
          {sp.label}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 1,
          background: "var(--border)",
        }}
      >
        <UcStat label="Extract" value={fmtMaybeMs(result?.face_extract_duration_ms)} />
        <UcStat label="Match" value={fmtMaybeMs(result?.match_duration_ms)} />
        <UcStat
          label="Total"
          value={
            status === "processing" && liveElapsedMs != null
              ? `${fmtElapsedMs(liveElapsedMs)}…`
              : fmtMaybeMs(result?.duration_ms)
          }
        />
        <UcStat label="Crops" value={String(cropsCount)} />
        <UcStat
          label="Matched"
          value={String(result?.matched_employees.length ?? 0)}
          accent="var(--success-text)"
        />
        <UcStat
          label="Unknown"
          value={String(result?.unknown_count ?? 0)}
        />
      </div>
      {result?.matched_employee_names && result.matched_employee_names.length > 0 && (
        <div
          style={{
            padding: "8px 10px",
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            background: "var(--bg-elev)",
            borderTop: "1px solid var(--border)",
          }}
        >
          {result.matched_employee_names.slice(0, 4).map((n, i) => (
            <span
              key={i}
              style={{
                padding: "1px 6px",
                borderRadius: 999,
                fontSize: 10.5,
                fontWeight: 600,
                background: meta.accentSoft,
                color: meta.accent,
                border: `1px solid ${meta.accent}33`,
              }}
            >
              {n}
            </span>
          ))}
          {result.matched_employee_names.length > 4 && (
            <span className="text-xs text-dim">
              +{result.matched_employee_names.length - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function UcStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--bg)" }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: accent ?? "var(--text)",
          marginTop: 1,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MatchConfidenceList({ ucResults }: { ucResults: ClipProcessingResult[] }) {
  // Roll up best confidence per (employee, uc) across all results.
  type Entry = { name: string; employeeId: number | null; confidence: number; uc: string };
  const entries: Entry[] = [];
  for (const r of ucResults) {
    if (!Array.isArray(r.match_details)) continue;
    for (const md of r.match_details as Array<{
      employee_id?: number;
      employee_name?: string;
      confidence?: number;
    }>) {
      if (typeof md.confidence !== "number") continue;
      entries.push({
        name: md.employee_name ?? `Employee #${md.employee_id ?? "?"}`,
        employeeId: typeof md.employee_id === "number" ? md.employee_id : null,
        confidence: md.confidence,
        uc: r.use_case,
      });
    }
  }
  entries.sort((a, b) => b.confidence - a.confidence);

  if (entries.length === 0) {
    return (
      <div className="text-sm text-dim" style={{ padding: "8px 0" }}>
        No match details yet.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {entries.slice(0, 20).map((e, i) => {
        const meta = UC_LIVE_META[e.uc as UcCode];
        const pct = Math.round(e.confidence * 100);
        return (
          <span
            key={i}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: 999,
              fontSize: 11.5,
              background: meta?.accentSoft ?? "var(--bg-sunken)",
              color: meta?.accent ?? "var(--text)",
              border: `1px solid ${meta?.accent ?? "var(--border)"}33`,
            }}
          >
            <span style={{ fontWeight: 600 }}>{e.name}</span>
            <span className="mono" style={{ fontSize: 10.5 }}>
              {pct}% · {e.uc.toUpperCase()}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function LiveCropsStrip({
  clipId,
  crops,
}: {
  clipId: number;
  crops: FaceCropOut[];
}) {
  // Most recent first; cap to 20 for the modal strip.
  const sorted = [...crops]
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  if (sorted.length === 0) {
    return (
      <div className="text-sm text-dim" style={{ padding: "8px 0" }}>
        No crops captured yet.
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
        gap: 6,
      }}
    >
      {sorted.map((c) => (
        <div
          key={c.id}
          title={
            c.employee_name
              ? `${c.employee_name} · Q${c.quality_score.toFixed(2)}`
              : `Unknown · Q${c.quality_score.toFixed(2)}`
          }
          style={{
            position: "relative",
            aspectRatio: "1",
            background: "#111",
            borderRadius: 6,
            overflow: "hidden",
            border: c.employee_id
              ? "2px solid var(--success-text)"
              : "1px solid var(--border)",
          }}
        >
          <img
            src={`/api/person-clips/${clipId}/face-crops/${c.id}/image`}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
          {c.use_case && (
            <span
              className="mono"
              style={{
                position: "absolute",
                top: 2,
                insetInlineStart: 2,
                padding: "0 4px",
                background: "rgba(0,0,0,0.6)",
                color: "#fff",
                fontSize: 9,
                borderRadius: 2,
              }}
            >
              {c.use_case.toUpperCase()}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function fmtMaybeMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtElapsedMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

// Keyframes for the LiveDot pulse — injected once.
if (typeof document !== "undefined") {
  const id = "live-processing-keyframes";
  if (!document.getElementById(id)) {
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `@keyframes live-processing-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.7); }
      50% { box-shadow: 0 0 0 4px rgba(255,255,255,0); }
    }`;
    document.head.appendChild(s);
  }
}

// ---------------------------------------------------------------------------
// Status pill — colour token map for the Processing Status column.
// ---------------------------------------------------------------------------

function StatusPill({
  status,
  onClick,
}: {
  status: string;
  onClick?: () => void;
}) {
  const tone: { bg: string; fg: string } = (() => {
    switch (status) {
      case "Processed":
        // A clip that has at least one UC run — bright accent so it
        // stands out from the merely-Saved population.
        return {
          bg: "rgba(59,130,246,0.12)",
          fg: "#1d4ed8",
        };
      case "Saved":
        return { bg: "var(--success-soft)", fg: "var(--success-text)" };
      case "Recording":
        return { bg: "var(--danger-soft)", fg: "var(--danger-text)" };
      case "Encoding":
        return { bg: "var(--warning-soft)", fg: "var(--warning-text)" };
      case "Failed":
      case "Abandoned":
        return { bg: "var(--danger-soft)", fg: "var(--danger-text)" };
      default:
        return {
          bg: "var(--bg-elev, var(--bg))",
          fg: "var(--text-secondary)",
        };
    }
  })();
  // When ``onClick`` is supplied the pill renders as a button so the
  // operator can drill into the Live Processing modal — the keyboard
  // affordance + cursor cue make it obvious it's interactive.
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title="Open live processing details"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: 999,
          fontSize: 11.5,
          fontWeight: 500,
          background: tone.bg,
          color: tone.fg,
          border: "1px solid transparent",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "currentColor";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "transparent";
        }}
      >
        {status}
        <Icon name="chevronRight" size={10} />
      </button>
    );
  }
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 500,
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {status}
    </span>
  );
}
