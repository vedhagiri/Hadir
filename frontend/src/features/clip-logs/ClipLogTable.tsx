// Clip Logs — one page, two tabs: "Saved clips" (cameras in save_clips
// mode → recorded MP4) and "Logs only" (cameras in logs_only mode →
// presence logs, no video file). Both are fed by /api/person-clips
// filtered on ``recording_mode``. The page groups rows by day, draws a
// 24-hour activity strip per day, and opens a detail drawer (with a
// player for saved clips) on click.

import { useMemo, useState } from "react";
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
import { SkeletonCards, SkeletonLine } from "../../components/Skeleton";
import {
  EmptyPanel,
  FIELD_H,
  FilterSelect,
  ResetButton,
  StatGrid,
  Toolbar,
  ViewToggle,
  useViewMode,
} from "../../components/ListPageUi";
import { ClipLogDrawer } from "./ClipLogDrawer";
import { Chips, ClipThumb, ModeIcon, StaticStat, useClipChips, useClipTimeFmt } from "./ClipLogUi";
import {
  detectPreset,
  fmtDuration,
  fmtFileSize,
  groupByDay,
  localDayKey,
  presetRange,
  secondsOfDay,
} from "./clipLogUtil";
import type { DatePreset, DayGroup, Mode } from "./clipLogUtil";
import "./clip-logs.css";

const PAGE_SIZE = 50;

function buildPath(
  mode: Mode,
  cameraId: number | null,
  start: string | null,
  end: string | null,
  page: number,
  pageSize: number,
): string {
  const params = new URLSearchParams();
  params.set("recording_mode", mode);
  if (cameraId !== null) params.set("camera_id", String(cameraId));
  // The pickers are date-only (YYYY-MM-DD). Expand to full-day bounds in the
  // viewer's LOCAL timezone (the list renders clip times in local time, so
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
  params.set("page_size", String(pageSize));
  return `/api/person-clips?${params.toString()}`;
}

function useClipLog(
  mode: Mode,
  cameraId: number | null,
  start: string | null,
  end: string | null,
  page: number,
): UseQueryResult<PersonClipListResponse, Error> {
  const path = buildPath(mode, cameraId, start, end, page, PAGE_SIZE);
  return useQuery({
    queryKey: ["clip-log", mode, cameraId, start, end, page],
    queryFn: () => api<PersonClipListResponse>(path),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

/** Count-only probe for the inactive tab's badge (page_size=1, same
 *  filters). The active tab's count comes from the list's ``total``. */
function useClipLogCount(
  mode: Mode,
  cameraId: number | null,
  start: string | null,
  end: string | null,
): UseQueryResult<number, Error> {
  const path = buildPath(mode, cameraId, start, end, 1, 1);
  return useQuery({
    queryKey: ["clip-log", "count", mode, cameraId, start, end],
    queryFn: async () => (await api<PersonClipListResponse>(path)).total,
    staleTime: 15_000,
    refetchInterval: 30_000,
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
  const [customOpen, setCustomOpen] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [view, setView] = useViewMode("maugood.clipLogs.view");

  const cameras = useCameraOptions();
  const list = useClipLog(mode, cameraId, start, end, page);
  const otherMode: Mode = mode === "save_clips" ? "logs_only" : "save_clips";
  const otherCount = useClipLogCount(otherMode, cameraId, start, end);
  const items: PersonClipOut[] = useMemo(() => list.data?.items ?? [], [list.data]);
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isSaveClips = mode === "save_clips";
  const hasFilter = cameraId !== null || start !== null || end !== null;
  const preset: DatePreset = customOpen ? "custom" : detectPreset(start, end);
  const effectiveView = isSaveClips ? view : "list";

  const counts: Record<Mode, number | null> = {
    save_clips: isSaveClips ? (list.data ? total : null) : (otherCount.data ?? null),
    logs_only: !isSaveClips ? (list.data ? total : null) : (otherCount.data ?? null),
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setPage(1);
    setOpenId(null);
  };

  const resetFilters = () => {
    setCameraId(null);
    setStart(null);
    setEnd(null);
    setCustomOpen(false);
    setPage(1);
  };

  const applyPreset = (p: DatePreset) => {
    if (p === "custom") {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    if (p === "all") {
      setStart(null);
      setEnd(null);
    } else {
      const r = presetRange(p);
      setStart(r.start);
      setEnd(r.end);
    }
    setPage(1);
  };

  // Addendum — no entries at all for this mode (no filter narrowing):
  // hide the stats + toolbar; the card shows one EmptyPanel.
  const noRecords = !list.isLoading && !list.isError && list.data !== undefined && items.length === 0 && !hasFilter;

  // ---- Summary (from the API's total + the rows on this page) ----------
  const isPartial = total > items.length;
  const pageSeconds = items.reduce((s, c) => s + Math.max(0, c.duration_seconds || 0), 0);
  const pageBytes = items.reduce((s, c) => s + Math.max(0, c.filesize_bytes || 0), 0);
  const pagePeople = items.reduce((s, c) => s + Math.max(0, c.person_count || 0), 0);
  const camCount = new Set(items.map((c) => c.camera_id)).size;
  const avgSeconds = items.length ? pageSeconds / items.length : 0;
  const showSize = isSaveClips && items.some((c) => c.filesize_bytes > 0);
  const maxDur = items.reduce((m, c) => Math.max(m, c.duration_seconds || 0), 0);
  const scopeSub = isPartial
    ? t("clipLogs.stats.onPage", { defaultValue: "Latest {{n}} of {{total}} on this page", n: items.length, total: total.toLocaleString() })
    : t("clipLogs.stats.allInRange", { defaultValue: "All clips in range" });

  const groups = useMemo(() => groupByDay(items), [items]);
  const openIdx = openId === null ? -1 : items.findIndex((c) => c.id === openId);
  const openClip = openIdx >= 0 ? items[openIdx] : undefined;

  const rangeLabel = (() => {
    if (preset === "all") return t("clipLogs.range.all", { defaultValue: "all time" });
    if (preset === "today") return t("clipLogs.preset.today", { defaultValue: "Today" }).toLowerCase();
    if (preset === "yesterday") return t("clipLogs.preset.yesterday", { defaultValue: "Yesterday" }).toLowerCase();
    if (preset === "last7") return t("clipLogs.preset.last7", { defaultValue: "Last 7 days" }).toLowerCase();
    return t("clipLogs.range.custom", { defaultValue: "the selected range" });
  })();

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
      </div>

      <div className="tabs clg-tabs" role="tablist" aria-label={t("clipLogs.modeAria", { defaultValue: "Recording mode" })}>
        {(["save_clips", "logs_only"] as Mode[]).map((m) => {
          const on = m === mode;
          const n = counts[m];
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={on}
              className={`tab${on ? " active" : ""}`}
              onClick={() => switchMode(m)}
            >
              <ModeIcon mode={m} size={15} />
              {m === "save_clips"
                ? t("clipLogs.tabSaved", { defaultValue: "Saved clips" })
                : t("clipLogs.tabLogs", { defaultValue: "Logs only" })}
              {n !== null && <span className="clg-tab-count">{n.toLocaleString()}</span>}
            </button>
          );
        })}
      </div>
      <p className="clg-mode-hint">
        <Icon name="info" size={13} />
        {isSaveClips
          ? t("clipLogs.hintSaved", {
              defaultValue:
                "Saved clips keep a video file you can play back. Cameras in “Save clips” mode record one clip each time a person is seen.",
            })
          : t("clipLogs.hintLogs", {
              defaultValue:
                "Logs only records that a person was seen — when, for how long and how many — without keeping a video file.",
            })}
      </p>

      {!noRecords && !list.isError && (
        list.isLoading ? (
          <SkeletonCards count={4} minWidth={210} />
        ) : (
          <StatGrid>
            <StaticStat
              tone="info"
              icon={<ModeIcon mode={mode} size={20} />}
              label={
                isSaveClips
                  ? t("clipLogs.stats.clips", { defaultValue: "Clips in range" })
                  : t("clipLogs.stats.logs", { defaultValue: "Logs in range" })
              }
              value={total.toLocaleString()}
              sub={t("clipLogs.stats.rangeSub", { defaultValue: "Matching {{range}}", range: rangeLabel })}
            />
            <StaticStat
              tone="success"
              icon="clock"
              label={t("clipLogs.stats.recorded", { defaultValue: "Recorded time" })}
              value={fmtDuration(pageSeconds)}
              sub={scopeSub}
            />
            {isSaveClips ? (
              showSize ? (
                <StaticStat
                  tone="neutral"
                  icon="database"
                  label={t("clipLogs.stats.size", { defaultValue: "Total size" })}
                  value={fmtFileSize(pageBytes)}
                  sub={scopeSub}
                />
              ) : null
            ) : pagePeople > 0 ? (
              <StaticStat
                tone="warning"
                icon="users"
                label={t("clipLogs.stats.people", { defaultValue: "People seen" })}
                value={pagePeople.toLocaleString()}
                sub={scopeSub}
              />
            ) : null}
            <StaticStat
              tone="neutral"
              icon="camera"
              label={t("clipLogs.stats.cameras", { defaultValue: "Cameras" })}
              value={camCount.toLocaleString()}
              sub={
                isPartial
                  ? t("clipLogs.stats.camerasPage", { defaultValue: "With activity on this page" })
                  : t("clipLogs.stats.camerasAll", { defaultValue: "With activity in range" })
              }
            />
            <StaticStat
              tone="info"
              icon="activity"
              label={t("clipLogs.stats.avg", { defaultValue: "Average length" })}
              value={fmtDuration(avgSeconds)}
              sub={scopeSub}
            />
          </StatGrid>
        )
      )}

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
          <div className="seg clg-presets" role="group" aria-label={t("clipLogs.presetAria", { defaultValue: "Date range" })}>
            {(["all", "today", "yesterday", "last7", "custom"] as DatePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                className={`seg-btn${preset === p ? " active" : ""}`}
                aria-pressed={preset === p}
                onClick={() => applyPreset(p)}
              >
                {p === "all"
                  ? t("clipLogs.preset.all", { defaultValue: "All time" })
                  : p === "today"
                    ? t("clipLogs.preset.today", { defaultValue: "Today" })
                    : p === "yesterday"
                      ? t("clipLogs.preset.yesterday", { defaultValue: "Yesterday" })
                      : p === "last7"
                        ? t("clipLogs.preset.last7", { defaultValue: "Last 7 days" })
                        : t("clipLogs.preset.custom", { defaultValue: "Custom" })}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <>
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
              <span className="clg-range-arrow" aria-hidden>→</span>
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
            </>
          )}
          <ResetButton
            active={hasFilter || customOpen}
            label={t("clipLogs.reset", { defaultValue: "Reset" })}
            onClick={resetFilters}
          />
          {isSaveClips && (
            <ViewToggle
              value={view}
              onChange={setView}
              listLabel={t("clipLogs.viewList", { defaultValue: "List view" })}
              gridLabel={t("clipLogs.viewGrid", { defaultValue: "Grid view" })}
            />
          )}
        </Toolbar>
      )}

      <div className={`card clg-card${noRecords ? " is-empty" : ""}`}>
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
        ) : list.isLoading ? (
          <ListSkeleton grid={effectiveView === "grid"} />
        ) : items.length === 0 ? (
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
              icon={<ModeIcon mode={mode} size={28} />}
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
            {groups.map((g) => (
              <DayBlock
                key={g.key}
                group={g}
                isPartial={isPartial}
                grid={effectiveView === "grid"}
                showSize={showSize}
                maxDur={maxDur}
                onOpen={setOpenId}
              />
            ))}

            {total > 0 && (
              <div className="clg-pager">
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
              </div>
            )}
          </>
        )}
      </div>

      {openClip && (
        <ClipLogDrawer
          clip={openClip}
          onClose={() => setOpenId(null)}
          onPrev={openIdx > 0 ? () => setOpenId(items[openIdx - 1]?.id ?? null) : null}
          onNext={openIdx < items.length - 1 ? () => setOpenId(items[openIdx + 1]?.id ?? null) : null}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Day group: header + 24h strip + rows / cards
// ---------------------------------------------------------------------------

function DayBlock({
  group,
  isPartial,
  grid,
  showSize,
  maxDur,
  onOpen,
}: {
  group: DayGroup;
  isPartial: boolean;
  grid: boolean;
  showSize: boolean;
  maxDur: number;
  onOpen: (id: number) => void;
}) {
  const { t } = useTranslation();
  const today = todayIso();
  const yKey = localDayKey(new Date(Date.now() - 86_400_000));
  const rel =
    group.key === today
      ? t("clipLogs.preset.today", { defaultValue: "Today" })
      : group.key === yKey
        ? t("clipLogs.preset.yesterday", { defaultValue: "Yesterday" })
        : null;
  const dayLabel = group.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const n = group.clips.length;
  const countLabel = isPartial
    ? t("clipLogs.day.countPage", { defaultValue: "{{n}} on this page", n })
    : t("clipLogs.day.count", { defaultValue: "{{count}} clips", count: n });

  return (
    <section className="clg-day" aria-label={dayLabel}>
      <header className="clg-day-head">
        <div className="clg-day-title">
          <Icon name="calendar" size={14} />
          <strong>{rel ? `${rel} · ${dayLabel}` : dayLabel}</strong>
          <span className="clg-day-meta">
            {countLabel} · {t("clipLogs.day.recorded", { defaultValue: "{{d}} recorded", d: fmtDuration(group.totalSeconds) })}
          </span>
        </div>
        <DayStrip group={group} />
      </header>
      {grid ? (
        <div className="clg-grid">
          {group.clips.map((c) => (
            <ClipCard key={c.id} clip={c} onOpen={() => onOpen(c.id)} />
          ))}
        </div>
      ) : (
        <ul className="clg-rows">
          {group.clips.map((c) => (
            <li key={c.id}>
              <ClipRow clip={c} showSize={showSize} maxDur={maxDur} onOpen={() => onOpen(c.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Pure-CSS 24-hour strip showing where this day's clips (on this page)
 *  fall. Decorative; the rows below carry the same information. */
function DayStrip({ group }: { group: DayGroup }) {
  const fmtTime = useClipTimeFmt();
  return (
    <div className="clg-strip" aria-hidden>
      <div className="clg-strip-track">
        {[6, 12, 18].map((h) => (
          <span key={h} className="clg-strip-tick" style={{ insetInlineStart: `${(h / 24) * 100}%` }} />
        ))}
        {group.clips.map((c) => {
          const s = new Date(c.clip_start);
          const startPct = (secondsOfDay(s) / 86_400) * 100;
          const widthPct = Math.min(100 - startPct, Math.max(0.35, ((c.duration_seconds || 0) / 86_400) * 100));
          return (
            <span
              key={c.id}
              className="clg-strip-mark"
              title={`${c.camera_name} · ${fmtTime(s)}`}
              style={{ insetInlineStart: `${startPct}%`, inlineSize: `${widthPct}%` }}
            />
          );
        })}
      </div>
      <div className="clg-strip-labels">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  );
}

function ClipRow({
  clip,
  showSize,
  maxDur,
  onOpen,
}: {
  clip: PersonClipOut;
  showSize: boolean;
  maxDur: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const fmtTime = useClipTimeFmt();
  const chipsFor = useClipChips();
  const dur = clip.duration_seconds || 0;
  const barPct = maxDur > 0 ? Math.max(3, (dur / maxDur) * 100) : 0;
  const s = fmtTime(clip.clip_start);
  const e = fmtTime(clip.clip_end);
  return (
    <button
      type="button"
      className={`clg-row${showSize ? " has-size" : ""}`}
      onClick={onOpen}
      aria-label={t("clipLogs.rowAria", {
        defaultValue: "{{camera}}, {{start}} to {{end}}, {{dur}}. Open details",
        camera: clip.camera_name,
        start: s,
        end: e,
        dur: fmtDuration(dur),
      })}
    >
      <ClipThumb clip={clip} />
      <span className="clg-row-cam">
        <span className="clg-row-name">{clip.camera_name}</span>
        {clip.resolution_w && clip.resolution_h ? (
          <span className="clg-row-sub mono">{`${clip.resolution_w}×${clip.resolution_h}`}</span>
        ) : null}
      </span>
      <span className="clg-row-time mono">
        {s}
        <span className="clg-arrow" aria-hidden>→</span>
        {e}
      </span>
      <span className="clg-row-dur">
        <span className="mono">{fmtDuration(dur)}</span>
        <span className="clg-bar" aria-hidden>
          <span style={{ inlineSize: `${barPct}%` }} />
        </span>
      </span>
      {showSize && (
        <span className="clg-row-size mono">{clip.filesize_bytes > 0 ? fmtFileSize(clip.filesize_bytes) : "—"}</span>
      )}
      <span className="clg-row-chips">
        <Chips chips={chipsFor(clip)} />
      </span>
      <span className="clg-row-go" aria-hidden>
        <Icon name="chevronRight" size={14} />
      </span>
    </button>
  );
}

function ClipCard({ clip, onOpen }: { clip: PersonClipOut; onOpen: () => void }) {
  const { t } = useTranslation();
  const fmtTime = useClipTimeFmt();
  const chipsFor = useClipChips();
  const s = fmtTime(clip.clip_start);
  const e = fmtTime(clip.clip_end);
  return (
    <button
      type="button"
      className="clg-gcard"
      onClick={onOpen}
      aria-label={t("clipLogs.rowAria", {
        defaultValue: "{{camera}}, {{start}} to {{end}}, {{dur}}. Open details",
        camera: clip.camera_name,
        start: s,
        end: e,
        dur: fmtDuration(clip.duration_seconds),
      })}
    >
      <span className="clg-gcard-media">
        <ClipThumb clip={clip} size="card" />
        <span className="clg-gcard-play" aria-hidden>
          <Icon name="play" size={16} />
        </span>
        <span className="clg-gcard-dur mono">{fmtDuration(clip.duration_seconds)}</span>
      </span>
      <span className="clg-gcard-body">
        <span className="clg-row-name">{clip.camera_name}</span>
        <span className="clg-row-time mono">
          {s}
          <span className="clg-arrow" aria-hidden>→</span>
          {e}
        </span>
        <Chips chips={chipsFor(clip)} />
      </span>
    </button>
  );
}

function ListSkeleton({ grid }: { grid: boolean }) {
  return (
    <div role="status" aria-label="Loading" className="clg-skel">
      <div className="clg-day-head">
        <SkeletonLine width={220} height={14} />
        <SkeletonLine width="100%" height={10} />
      </div>
      {grid ? (
        <div className="clg-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="clg-gcard is-skel" aria-hidden>
              <span className="clg-gcard-media">
                <span className="sk" style={{ display: "block", inlineSize: "100%", blockSize: "100%" }} />
              </span>
              <span className="clg-gcard-body">
                <SkeletonLine width="60%" />
                <SkeletonLine width="80%" />
              </span>
            </div>
          ))}
        </div>
      ) : (
        Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="clg-row is-skel" aria-hidden style={{ opacity: Math.max(0.2, 1 - i * 0.12) }}>
            <span className="clg-thumb clg-thumb-row sk" />
            <SkeletonLine width="70%" />
            <SkeletonLine width="80%" />
            <SkeletonLine width="60%" />
            <SkeletonLine width="50%" />
            <span />
          </div>
        ))
      )}
    </div>
  );
}

const dateTriggerStyle = {
  height: FIELD_H,
  minWidth: 150,
  padding: "0 12px",
  fontSize: 13,
  borderRadius: 10,
} as const;
