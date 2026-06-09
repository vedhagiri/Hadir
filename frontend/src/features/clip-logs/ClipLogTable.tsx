// Clip Logs — one page, a segmented toggle splits between "Saved Clips"
// (cameras in save_clips mode → recorded MP4) and "Logs Only" (cameras in
// logs_only mode → presence logs, no video). Both views are flat log
// tables fed by /api/person-clips filtered on ``recording_mode``.
// Follows the AuditLog / CameraLogs page conventions for filters + table.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { useCameraOptions } from "../person-clips/hooks";
import type { PersonClipListResponse, PersonClipOut } from "../person-clips/types";

const PAGE_SIZE = 50;

type Mode = "save_clips" | "logs_only";

function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Dedicated fetch — builds the query with ``recording_mode`` directly so
// it doesn't depend on the shared ``PersonClipFilters`` shape.
function useClipLog(
  mode: Mode,
  cameraId: number | null,
  start: string | null,
  end: string | null,
  page: number,
): UseQueryResult<PersonClipListResponse, Error> {
  const params = new URLSearchParams();
  params.set("recording_mode", mode);
  if (cameraId !== null) params.set("camera_id", String(cameraId));
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  params.set("page", String(page));
  params.set("page_size", String(PAGE_SIZE));
  const path = `/api/person-clips?${params.toString()}`;
  return useQuery({
    queryKey: ["clip-log", mode, cameraId, start, end, page],
    queryFn: () => api<PersonClipListResponse>(path),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function ClipLogsPage() {
  const [mode, setMode] = useState<Mode>("save_clips");
  const [cameraId, setCameraId] = useState<number | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const cameras = useCameraOptions();
  const list = useClipLog(mode, cameraId, start, end, page);
  const items: PersonClipOut[] = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isSaveClips = mode === "save_clips";
  const hasFilter = cameraId !== null || start !== null || end !== null;
  const colCount = 6;

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setPage(1);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Clip Logs</h1>
          <p className="page-sub">
            {isSaveClips
              ? `${total.toLocaleString()} recorded clip${total === 1 ? "" : "s"}`
              : `${total.toLocaleString()} presence log${total === 1 ? "" : "s"}`}
          </p>
        </div>
        {/* Segmented split toggle */}
        <div className="seg" role="tablist" aria-label="Recording mode">
          <button
            type="button"
            role="tab"
            aria-selected={isSaveClips}
            className={`seg-btn${isSaveClips ? " active" : ""}`}
            onClick={() => switchMode("save_clips")}
          >
            <Icon name="videocam" size={13} />
            Saved Clips
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isSaveClips}
            className={`seg-btn${!isSaveClips ? " active" : ""}`}
            onClick={() => switchMode("logs_only")}
          >
            <Icon name="clipboard" size={13} />
            Logs Only
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">
            {isSaveClips ? "Saved Clips" : "Presence Logs"}
          </h3>
          <div className="flex gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={cameraId ?? ""}
              onChange={(e) => {
                setCameraId(e.target.value === "" ? null : Number(e.target.value));
                setPage(1);
              }}
              style={selectStyle}
              aria-label="Filter by camera"
            >
              <option value="">All cameras</option>
              {cameras.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="datetime-local"
              value={start ?? ""}
              onChange={(e) => {
                setStart(e.target.value || null);
                setPage(1);
              }}
              style={selectStyle}
              title="From"
              aria-label="From"
            />
            <input
              type="datetime-local"
              value={end ?? ""}
              onChange={(e) => {
                setEnd(e.target.value || null);
                setPage(1);
              }}
              style={selectStyle}
              title="To"
              aria-label="To"
            />
            {hasFilter && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setCameraId(null);
                  setStart(null);
                  setEnd(null);
                  setPage(1);
                }}
              >
                <Icon name="x" size={11} /> Clear
              </button>
            )}
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Camera</th>
              <th style={{ width: 130 }}>Date</th>
              <th style={{ width: 100 }}>Start</th>
              <th style={{ width: 100 }}>End</th>
              <th style={{ width: 90 }}>Duration</th>
              {!isSaveClips && (
                <th style={{ width: 80, textAlign: "center" }}>Persons</th>
              )}
              {isSaveClips && <th style={{ width: 90, textAlign: "end" }}>Size</th>}
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={colCount} className="text-sm text-dim" style={{ padding: 16 }}>
                  Loading…
                </td>
              </tr>
            )}
            {list.isError && !list.isLoading && (
              <tr>
                <td
                  colSpan={colCount}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  Failed to load.
                </td>
              </tr>
            )}
            {!list.isLoading && !list.isError && items.length === 0 && (
              <tr>
                <td colSpan={colCount} style={{ padding: "32px 16px", textAlign: "center" }}>
                  <div style={{ opacity: 0.4, marginBottom: 6 }}>
                    <Icon name={isSaveClips ? "videocam" : "clipboard"} size={26} />
                  </div>
                  <div className="text-sm text-dim">
                    {isSaveClips ? "No saved clips yet." : "No presence logs yet."}
                  </div>
                  <div className="text-xs text-dim" style={{ marginTop: 3 }}>
                    {isSaveClips
                      ? "Cameras set to “Save Clips” mode list recorded clips here."
                      : "Cameras set to “Logs Only” mode list presence logs here."}
                  </div>
                </td>
              </tr>
            )}
            {items.map((clip) => {
              const s = new Date(clip.clip_start);
              const e = new Date(clip.clip_end);
              const dateStr = s.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              });
              const startStr = s.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
              const endStr = e.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
              const dur = clip.duration_seconds;
              const durStr =
                dur > 0 ? `${Math.floor(dur / 60)}m ${Math.round(dur % 60)}s` : "—";
              const pc = clip.person_count ?? 0;
              return (
                <tr key={clip.id}>
                  <td className="text-sm" style={{ fontWeight: 500 }}>
                    {clip.camera_name}
                  </td>
                  <td className="text-sm text-dim" style={{ whiteSpace: "nowrap" }}>
                    {dateStr}
                  </td>
                  <td className="mono text-xs" style={{ whiteSpace: "nowrap" }}>
                    {startStr}
                  </td>
                  <td className="mono text-xs" style={{ whiteSpace: "nowrap" }}>
                    {endStr}
                  </td>
                  <td className="mono text-xs">{durStr}</td>
                  {!isSaveClips && (
                    <td style={{ textAlign: "center" }}>
                      <span
                        className={pc >= 2 ? "pill pill-warning" : "pill pill-neutral"}
                        style={{ fontVariantNumeric: "tabular-nums", opacity: pc >= 1 ? 1 : 0.45 }}
                      >
                        {pc}
                      </span>
                    </td>
                  )}
                  {isSaveClips && (
                    <td
                      className="mono text-xs text-dim"
                      style={{ whiteSpace: "nowrap", textAlign: "end" }}
                    >
                      {clip.filesize_bytes > 0 ? fmtFileSize(clip.filesize_bytes) : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

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
              Page {page} of {totalPages} · {total.toLocaleString()} rows
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn btn-sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <Icon name="chevronLeft" size={11} /> Prev
              </button>
              <button
                className="btn btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next <Icon name="chevronRight" size={11} />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const selectStyle = {
  padding: "6px 10px",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;
