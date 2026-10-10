// Clip Logs — one page, a segmented toggle splits between "Saved Clips"
// (cameras in save_clips mode → recorded MP4) and "Logs Only" (cameras in
// logs_only mode → presence logs, no video). Both views are flat log
// tables fed by /api/person-clips filtered on ``recording_mode``.
// Follows the AuditLog / CameraLogs page conventions for filters + table.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { UseQueryResult } from "@tanstack/react-query";

import { api } from "../../api/client";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { Pagination } from "../../components/Pagination";
import { Icon } from "../../shell/Icon";
import { dayBound } from "../../util/datetime";
import { useCameraOptions } from "../person-clips/hooks";
import type { PersonClipListResponse, PersonClipOut } from "../person-clips/types";
import { SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel, FIELD_H, FilterSelect, ResetButton, Toolbar } from "../../components/ListPageUi";

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
  // The pickers are date-only (YYYY-MM-DD). Expand to full-day bounds in the
  // viewer's LOCAL timezone (the table renders clip times in local time, so
  // the filter must use the same day boundaries — otherwise a clip shown as
  // "Jun 10 01:00 AM" local, stored as Jun 9 21:00 UTC, would leak into a
  // Jun 9 filter). The local offset is appended so the backend compares the
  // timestamptz column correctly.
  // Behaviour:
  //   * From only        → show ONLY that single day (start..end of day)
  //   * From + To        → inclusive range (start of From .. end of To)
  //   * To only          → everything up to the end of that day
  const startDay = start && !start.includes("T") ? start : null;
  const endDay = end && !end.includes("T") ? end : null;
  if (start) params.set("start", startDay ? dayBound(startDay, "00:00:00") : start);
  if (startDay && !end) {
    // Single-day filter: cap the range at the end of the chosen start day.
    params.set("end", dayBound(startDay, "23:59:59"));
  } else if (end) {
    params.set("end", endDay ? dayBound(endDay, "23:59:59") : end);
  }
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
  const { t } = useTranslation();
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

  const resetFilters = () => {
    setCameraId(null);
    setStart(null);
    setEnd(null);
    setPage(1);
  };
  // Addendum — no entries at all for this mode (no filter narrowing):
  // hide the toolbar; the card shows one EmptyPanel.
  const noRecords = !list.isLoading && !list.isError && list.data !== undefined && items.length === 0 && !hasFilter;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("clipLogs.title", { defaultValue: "Clip Logs" })}</h1>
          <p className="page-sub">
            {isSaveClips
              ? t("clipLogs.subSaved", {
                  defaultValue: "Every recorded clip from cameras in “Save Clips” mode — {{n}} in total.",
                  n: total.toLocaleString(),
                })
              : t("clipLogs.subLogs", {
                  defaultValue: "Presence logs from cameras in “Logs Only” mode (no video) — {{n}} in total.",
                  n: total.toLocaleString(),
                })}
          </p>
        </div>
        <div className="page-actions">
          {/* Segmented split toggle */}
          <div className="seg" role="tablist" aria-label={t("clipLogs.modeAria", { defaultValue: "Recording mode" })}>
            <button
              type="button"
              role="tab"
              aria-selected={isSaveClips}
              className={`seg-btn${isSaveClips ? " active" : ""}`}
              onClick={() => switchMode("save_clips")}
            >
              <Icon name="videocam" size={13} />
              {t("clipLogs.savedClips", { defaultValue: "Saved Clips" })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isSaveClips}
              className={`seg-btn${!isSaveClips ? " active" : ""}`}
              onClick={() => switchMode("logs_only")}
            >
              <Icon name="clipboard" size={13} />
              {t("clipLogs.logsOnly", { defaultValue: "Logs Only" })}
            </button>
          </div>
        </div>
      </div>

      {!noRecords && (
      <Toolbar>
        <FilterSelect
          label={t("clipLogs.camera", { defaultValue: "Camera" })}
          value={cameraId === null ? "" : String(cameraId)}
          onChange={(v) => {
            setCameraId(v === "" ? null : Number(v));
            setPage(1);
          }}
          options={[
            ["", t("clipLogs.allCameras", { defaultValue: "All cameras" })],
            ...(cameras.data?.items ?? []).map((c) => [String(c.id), c.name] as [string, string]),
          ]}
        />
        <DatePicker
          value={start ?? ""}
          onChange={(next) => {
            setStart(next || null);
            setPage(1);
          }}
          max={todayIso()}
          ariaLabel={t("clipLogs.from", { defaultValue: "From" })}
          placeholder={t("clipLogs.from", { defaultValue: "From" })}
          triggerStyle={dateTriggerStyle}
        />
        <DatePicker
          value={end ?? ""}
          onChange={(next) => {
            setEnd(next || null);
            setPage(1);
          }}
          {...(start ? { min: start } : {})}
          max={todayIso()}
          ariaLabel={t("clipLogs.to", { defaultValue: "To" })}
          placeholder={t("clipLogs.to", { defaultValue: "To" })}
          triggerStyle={dateTriggerStyle}
        />
        <ResetButton
          active={hasFilter}
          label={t("clipLogs.reset", { defaultValue: "Reset" })}
          onClick={resetFilters}
        />
      </Toolbar>
      )}

      <div className="card" style={{ padding: noRecords ? 0 : 12 }}>
        {list.isError && !list.isLoading ? (
          <EmptyPanel
            tone="danger"
            icon={<Icon name="info" size={28} />}
            title={t("clipLogs.errorTitle", { defaultValue: "Couldn’t load clip logs" })}
            body={t("clipLogs.errorBody", { defaultValue: "Something went wrong while fetching this list. Try again in a moment." })}
            actions={
              <button type="button" className="btn" onClick={() => void list.refetch()}>
                <Icon name="refresh" size={12} />
                {t("clipLogs.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        ) : !list.isLoading && items.length === 0 ? (
          hasFilter ? (
            <EmptyPanel
              icon={<Icon name="filter" size={28} />}
              title={t("clipLogs.emptyFilteredTitle", { defaultValue: "No entries match these filters" })}
              body={t("clipLogs.emptyFilteredBody", { defaultValue: "Try another camera or widen the date range." })}
              actions={
                <button type="button" className="btn" onClick={resetFilters}>
                  <Icon name="refresh" size={12} />
                  {t("clipLogs.clearFilters", { defaultValue: "Clear filters" })}
                </button>
              }
            />
          ) : (
            <EmptyPanel
              tone="accent"
              icon={<Icon name={isSaveClips ? "videocam" : "clipboard"} size={28} />}
              title={
                isSaveClips
                  ? t("clipLogs.emptySavedTitle", { defaultValue: "No saved clips yet" })
                  : t("clipLogs.emptyLogsTitle", { defaultValue: "No presence logs yet" })
              }
              body={
                isSaveClips
                  ? t("clipLogs.emptySavedBody", { defaultValue: "Cameras set to “Save Clips” mode list their recorded clips here." })
                  : t("clipLogs.emptyLogsBody", { defaultValue: "Cameras set to “Logs Only” mode list their presence logs here." })
              }
              actions={
                <Link className="btn btn-primary" to="/cameras">
                  <Icon name="camera" size={12} />
                  {t("clipLogs.goToCameras", { defaultValue: "Go to cameras" })}
                </Link>
              }
            />
          )
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("clipLogs.colCamera", { defaultValue: "Camera" })}</th>
                    <th style={{ width: 130 }}>{t("clipLogs.colDate", { defaultValue: "Date" })}</th>
                    <th style={{ width: 110 }}>{t("clipLogs.colStart", { defaultValue: "Start" })}</th>
                    <th style={{ width: 110 }}>{t("clipLogs.colEnd", { defaultValue: "End" })}</th>
                    <th style={{ width: 100 }}>{t("clipLogs.colDuration", { defaultValue: "Duration" })}</th>
                    {!isSaveClips && (
                      <th style={{ width: 90, textAlign: "center" }}>{t("clipLogs.colPersons", { defaultValue: "Persons" })}</th>
                    )}
                    {isSaveClips && <th style={{ width: 90, textAlign: "end" }}>{t("clipLogs.colSize", { defaultValue: "Size" })}</th>}
                  </tr>
                </thead>
                <tbody>
                  {list.isLoading && <SkeletonRows cols={colCount} />}
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
                        <td className="text-sm" style={{ fontWeight: 500, whiteSpace: "nowrap" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <span aria-hidden style={{ display: "inline-flex", color: "var(--text-tertiary)" }}>
                              <Icon name={isSaveClips ? "videocam" : "camera"} size={13} />
                            </span>
                            {clip.camera_name}
                          </span>
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
                        <td className="mono text-xs" style={{ whiteSpace: "nowrap" }}>{durStr}</td>
                        {!isSaveClips && (
                          <td style={{ textAlign: "center" }}>
                            <SoftCount n={pc} />
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
            </div>

            {total > 0 && (
              <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
                summary={t("clipLogs.pageSummary", {
                  defaultValue: "Page {{page}} of {{pages}} · {{rows}} rows",
                  page,
                  pages: totalPages,
                  rows: total.toLocaleString(),
                })}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

/** Soft person-count pill: neutral for 0–1, amber when 2+ people share a log. */
function SoftCount({ n }: { n: number }) {
  const multi = n >= 2;
  return (
    <span className={`pill mono ${multi ? "pill-warning" : "pill-neutral"}`} style={{ opacity: n >= 1 ? 1 : 0.55 }}>
      <span aria-hidden className="pill-dot" />
      {n}
    </span>
  );
}

const dateTriggerStyle = {
  height: FIELD_H,
  minWidth: 160,
  padding: "0 12px",
  fontSize: 13,
  borderRadius: 10,
} as const;
