// Camera events tab of the employee profile (/employees/:id?tab=events)
// and the read-only EmployeeViewDrawer.
//
// Answers "when and where did the cameras see this person?":
//   * a range segmented control (All · Today · Yesterday · 7 days ·
//     30 days · Custom) + a camera filter when more than one camera
//     has seen them — URL-synced on the profile page
//   * a summary strip for the selected range (sightings, days seen,
//     last / first seen, average match confidence)
//   * a day-grouped list (or crop gallery) of sightings; clicking a
//     crop opens the viewer with prev / next
//
// Data: GET /api/detection-events only (no backend changes).
//   * list — the page being shown (server-paginated, PAGE_SIZE)
//   * sample — newest SAMPLE_SIZE rows (the API max) for the stats;
//     stats are labelled "in the latest 200" when the range holds more
//   * oldest — one row (page=total, page_size=1) for "First seen" when
//     the sample doesn't reach back to the start of the range
// Crops come from the audited /api/detection-events/{id}/crop endpoint
// with loading="lazy", so only crops scrolled into view are fetched.
// Styling: ./employee-events.css (prefix ``pe-ev-``).

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { api } from "../../api/client";
import { DatePicker } from "../../components/DatePicker";
import { EmptyPanel, FilterSelect, ViewToggle, useViewMode } from "../../components/ListPageUi";
import { Pagination } from "../../components/Pagination";
import { SkeletonCards, SkeletonLine } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { addDaysIso, tenantBound, tenantDayKey, useDayGrouping } from "../camera-logs/clUi";
import { useDetectionEvents } from "../camera-logs/hooks";
import type { DetectionEvent, DetectionEventListResponse } from "../camera-logs/types";

import "./employee-events.css";

const PAGE_SIZE = 25;
/** The list endpoint's page_size ceiling (le=200). */
const SAMPLE_SIZE = 200;

type Range = "all" | "today" | "yesterday" | "7d" | "30d" | "custom";
const RANGES: Range[] = ["all", "today", "yesterday", "7d", "30d", "custom"];
const DEFAULT_RANGE: Range = "all";

// ---------------------------------------------------------------------------
// State: URL-synced on the profile page, local in the drawer
// ---------------------------------------------------------------------------

type StateKey = "range" | "from" | "to" | "cam" | "page";

function useTabState(syncUrl: boolean): {
  get: (k: StateKey) => string;
  patch: (next: Partial<Record<StateKey, string | null>>, keepPage?: boolean) => void;
} {
  const [params, setParams] = useSearchParams();
  const [local, setLocal] = useState<Partial<Record<StateKey, string>>>({});
  const get = (k: StateKey) => (syncUrl ? (params.get(k) ?? "") : (local[k] ?? ""));
  const patch = (next: Partial<Record<StateKey, string | null>>, keepPage = false) => {
    const entries = Object.entries(next) as [StateKey, string | null][];
    if (syncUrl) {
      setParams(
        (cur) => {
          const p = new URLSearchParams(cur);
          for (const [k, v] of entries) {
            if (v === null || v === "") p.delete(k);
            else p.set(k, v);
          }
          if (!keepPage) p.delete("page");
          return p;
        },
        { replace: true },
      );
    } else {
      setLocal((cur) => {
        const p = { ...cur };
        for (const [k, v] of entries) {
          if (v === null || v === "") delete p[k];
          else p[k] = v;
        }
        if (!keepPage) delete p.page;
        return p;
      });
    }
  };
  return { get, patch };
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function eventsPath(
  employeeId: number,
  start: string | null,
  end: string | null,
  cameraId: number | null,
  page: number,
  pageSize: number,
): string {
  const p = new URLSearchParams();
  p.set("employee_id", String(employeeId));
  if (cameraId !== null) p.set("camera_id", String(cameraId));
  if (start) p.set("start", start);
  if (end) p.set("end", end);
  p.set("page", String(page));
  p.set("page_size", String(pageSize));
  return `/api/detection-events?${p.toString()}`;
}

function useEventSample(employeeId: number, start: string | null, end: string | null, cameraId: number | null) {
  return useQuery({
    queryKey: ["detection-events", "employee-sample", employeeId, start, end, cameraId],
    queryFn: () => api<DetectionEventListResponse>(eventsPath(employeeId, start, end, cameraId, 1, SAMPLE_SIZE)),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}

/** Match label from the threshold the matcher used for this event
 *  (stamped into detection_metadata). Without it we show no label. */
function confidenceLevel(ev: DetectionEvent): "strong" | "good" | "weak" | null {
  const c = ev.confidence;
  const thr = ev.detection_metadata?.match_threshold;
  if (c === null || thr === undefined || thr === null) return null;
  if (c >= Math.max(0.6, thr + 0.1)) return "strong";
  if (c < thr + 0.05) return "weak";
  return "good";
}

function useRelative(): (iso: string) => string {
  const { i18n } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const fmt = useMemo(() => {
    try {
      return new Intl.RelativeTimeFormat(i18n.language || "en", { numeric: "auto" });
    } catch {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    }
  }, [i18n.language]);
  return (iso: string) => {
    const ts = new Date(iso).getTime();
    if (!Number.isFinite(ts)) return "";
    const sec = Math.round((ts - now) / 1000);
    const abs = Math.abs(sec);
    if (abs < 45) return fmt.format(0, "second");
    if (abs < 3600) return fmt.format(Math.round(sec / 60), "minute");
    if (abs < 86400) return fmt.format(Math.round(sec / 3600), "hour");
    if (abs < 86400 * 30) return fmt.format(Math.round(sec / 86400), "day");
    if (abs < 86400 * 365) return fmt.format(Math.round(sec / (86400 * 30)), "month");
    return fmt.format(Math.round(sec / (86400 * 365)), "year");
  };
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function EmployeeEventsTab({ employeeId, syncUrl = false }: { employeeId: number; syncUrl?: boolean }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const tz = dt.timezone;
  const rel = useRelative();
  const groupByDay = useDayGrouping();
  const { get, patch } = useTabState(syncUrl);
  const [view, setView] = useViewMode("maugood.employeeEvents.view");
  const [viewerId, setViewerId] = useState<number | null>(null);

  // ── Filters ──────────────────────────────────────────────────────
  const rangeRaw = get("range") as Range;
  const range: Range = RANGES.includes(rangeRaw) ? rangeRaw : DEFAULT_RANGE;
  const camRaw = Number.parseInt(get("cam"), 10);
  const cameraId = Number.isFinite(camRaw) && camRaw > 0 ? camRaw : null;
  const page = Math.max(1, Number.parseInt(get("page"), 10) || 1);
  const todayKey = tenantDayKey(tz, new Date());
  const span = useMemo((): { from: string; to: string } | null => {
    switch (range) {
      case "today":
        return { from: todayKey, to: todayKey };
      case "yesterday": {
        const y = addDaysIso(todayKey, -1);
        return { from: y, to: y };
      }
      case "7d":
        return { from: addDaysIso(todayKey, -6), to: todayKey };
      case "30d":
        return { from: addDaysIso(todayKey, -29), to: todayKey };
      case "custom": {
        const f = get("from") || todayKey;
        const tt = get("to") || f;
        return { from: f, to: tt < f ? f : tt };
      }
      default:
        return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, get("from"), get("to"), todayKey]);
  const start = span ? tenantBound(span.from, "00:00:00", tz) : null;
  const end = span ? tenantBound(span.to, "23:59:59", tz) : null;

  // ── Queries ──────────────────────────────────────────────────────
  const list = useDetectionEvents({
    camera_id: cameraId,
    employee_id: employeeId,
    identified: null,
    start,
    end,
    page,
    page_size: PAGE_SIZE,
  });
  // All cameras in range (drives the camera filter options) …
  const sampleAll = useEventSample(employeeId, start, end, null);
  // … and the camera-filtered sample when a camera is picked (same
  // query as above when no camera is selected — React Query dedupes).
  const sampleCam = useEventSample(employeeId, start, end, cameraId);
  const sample = cameraId === null ? sampleAll : sampleCam;
  const sTotal = sample.data?.total ?? 0;
  const sItems = sample.data?.items ?? [];
  const sampleComplete = sItems.length >= sTotal;
  const oldest = useQuery({
    queryKey: ["detection-events", "employee-oldest", employeeId, start, end, cameraId, sTotal],
    queryFn: () => api<DetectionEventListResponse>(eventsPath(employeeId, start, end, cameraId, sTotal, 1)),
    enabled: !!sample.data && !sampleComplete && sTotal > 0,
    staleTime: 60_000,
  });

  // ── Derived stats ────────────────────────────────────────────────
  const stats = useMemo(() => {
    const dayCounts = new Map<string, number>();
    let confSum = 0;
    let confN = 0;
    let confMin = 1;
    let confMax = 0;
    for (const ev of sItems) {
      const k = tenantDayKey(tz, new Date(ev.captured_at));
      dayCounts.set(k, (dayCounts.get(k) ?? 0) + 1);
      if (ev.confidence !== null) {
        confSum += ev.confidence;
        confN += 1;
        confMin = Math.min(confMin, ev.confidence);
        confMax = Math.max(confMax, ev.confidence);
      }
    }
    const last = sItems[0] ?? null;
    const first = sampleComplete ? (sItems[sItems.length - 1] ?? null) : (oldest.data?.items[0] ?? null);
    const oldestSampleDay = sItems.length ? tenantDayKey(tz, new Date(sItems[sItems.length - 1]!.captured_at)) : null;
    return {
      dayCounts,
      oldestSampleDay,
      last,
      first,
      avg: confN ? confSum / confN : null,
      confMin,
      confMax,
    };
  }, [sItems, sampleComplete, oldest.data, tz]);

  const cameraOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const ev of sampleAll.data?.items ?? []) if (!m.has(ev.camera_id)) m.set(ev.camera_id, ev.camera_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [sampleAll.data]);
  const showCameraFilter = cameraOptions.length > 1 || cameraId !== null;

  // ── Page / grouping ──────────────────────────────────────────────
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const days = useMemo(() => groupByDay(items, (e) => e.captured_at), [groupByDay, items]);
  const total = list.data?.total ?? 0;
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(total, page * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const dayCount = (key: string, onPage: number): number =>
    sampleComplete || (stats.oldestSampleDay !== null && key > stats.oldestSampleDay)
      ? (stats.dayCounts.get(key) ?? onPage)
      : onPage;
  const viewerEvents = items.filter((e) => e.has_crop);
  const viewerIndex = viewerId === null ? -1 : viewerEvents.findIndex((e) => e.id === viewerId);

  // Clamp a stale ?page= past the end (e.g. after narrowing the range).
  useEffect(() => {
    if (list.data && page > totalPages) patch({ page: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, page, totalPages]);

  // ── Labels ───────────────────────────────────────────────────────
  const rangeLabel = (r: Range): string =>
    ({
      all: t("employees.events.range.all", { defaultValue: "All" }),
      today: t("employees.events.range.today", { defaultValue: "Today" }),
      yesterday: t("employees.events.range.yesterday", { defaultValue: "Yesterday" }),
      "7d": t("employees.events.range.last7", { defaultValue: "7 days" }),
      "30d": t("employees.events.range.last30", { defaultValue: "30 days" }),
      custom: t("employees.events.range.custom", { defaultValue: "Custom" }),
    })[r];
  const periodText =
    range === "all"
      ? t("employees.events.period.all", { defaultValue: "All time" })
      : range === "custom" && span
        ? span.from === span.to
          ? dt.formatLocalDate(span.from)
          : `${dt.formatLocalDate(span.from)} – ${dt.formatLocalDate(span.to)}`
        : rangeLabel(range);
  const partialNote = t("employees.events.stats.latestN", { n: SAMPLE_SIZE, defaultValue: "In the latest {{n}} sightings" });
  const dayWord = (key: string, iso: string): string =>
    key === todayKey
      ? t("cameraLogs.day.today", { defaultValue: "Today" })
      : key === addDaysIso(todayKey, -1)
        ? t("cameraLogs.day.yesterday", { defaultValue: "Yesterday" })
        : dt.formatDate(iso);

  const isFirstLoad = (list.isLoading && !list.data) || (sample.isLoading && !sample.data);
  const isError = list.isError || sample.isError;
  const retry = () => {
    void list.refetch();
    void sample.refetch();
    void sampleAll.refetch();
  };
  const filtered = range !== "all" || cameraId !== null;

  return (
    <div className="pe-ev">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <div className="pe-ev-toolbar">
        <div className="seg pe-ev-seg" role="group" aria-label={t("employees.events.range.label", { defaultValue: "Date range" })}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              className={`seg-btn${range === r ? " active" : ""}`}
              onClick={() =>
                r === "custom"
                  ? patch({ range: "custom", from: span?.from ?? todayKey, to: span?.to ?? todayKey })
                  : patch({ range: r === DEFAULT_RANGE ? null : r, from: null, to: null })
              }
            >
              {rangeLabel(r)}
            </button>
          ))}
        </div>
        {range === "custom" && span && (
          <div className="pe-ev-custom">
            <DatePicker
              value={span.from}
              max={todayKey}
              onChange={(v) => patch({ from: v, to: !v || span.to < v ? v : span.to })}
              ariaLabel={t("employees.events.fromLabel", { defaultValue: "From date" })}
              triggerStyle={{ height: "var(--control-h)" }}
            />
            <span className="pe-ev-dim" aria-hidden>
              →
            </span>
            <DatePicker
              value={span.to}
              min={span.from}
              max={todayKey}
              onChange={(v) => patch({ to: v })}
              ariaLabel={t("employees.events.toLabel", { defaultValue: "To date" })}
              triggerStyle={{ height: "var(--control-h)" }}
            />
          </div>
        )}
        {showCameraFilter && (
          <FilterSelect
            label={t("employees.events.camera", { defaultValue: "Camera" })}
            value={cameraId === null ? "" : String(cameraId)}
            onChange={(v) => patch({ cam: v || null })}
            options={[
              ["", t("employees.events.allCameras", { defaultValue: "All cameras" })],
              ...cameraOptions.map(([id, name]) => [String(id), name] as [string, string]),
            ]}
          />
        )}
        <span className="pe-ev-toolbar-end">
          {list.isFetching && !isFirstLoad && <span className="pe-ev-spin" aria-hidden />}
          <ViewToggle
            value={view}
            onChange={setView}
            listLabel={t("employees.events.viewList", { defaultValue: "List view" })}
            gridLabel={t("employees.events.viewGrid", { defaultValue: "Gallery view" })}
          />
        </span>
      </div>

      {isError ? (
        <EmptyPanel
          tone="danger"
          icon={<Icon name="info" size={28} />}
          title={t("employees.events.loadFailedTitle", { defaultValue: "Couldn't load camera sightings" })}
          body={t("employees.events.loadFailedBody", { defaultValue: "The request failed. Check your connection and try again." })}
          actions={
            <button type="button" className="btn" onClick={retry}>
              <Icon name="refresh" size={12} />
              {t("common.retry", { defaultValue: "Retry" })}
            </button>
          }
        />
      ) : (
        <>
          {/* ── Summary strip ─────────────────────────────────────── */}
          {isFirstLoad ? (
            <div className="pe-ev-stats-sk">
              <SkeletonCards count={5} minWidth={170} />
            </div>
          ) : (
            <div className="pe-ev-stats">
              <Stat
                tone="info"
                icon={
                  <>
                    <path d="M3 8V6a2 2 0 0 1 2-2h2M17 4h2a2 2 0 0 1 2 2v2M21 16v2a2 2 0 0 1-2 2h-2M7 20H5a2 2 0 0 1-2-2v-2" />
                    <circle cx="12" cy="11" r="3" />
                    <path d="M7.5 17a5 5 0 0 1 9 0" />
                  </>
                }
                label={t("employees.events.stats.sightings", { defaultValue: "Sightings" })}
                value={sTotal.toLocaleString()}
                sub={periodText}
              />
              <Stat
                tone="success"
                icon={
                  <>
                    <rect x="3" y="5" width="18" height="16" rx="2" />
                    <path d="M3 10h18M8 3v4M16 3v4" />
                  </>
                }
                label={t("employees.events.stats.daysSeen", { defaultValue: "Days seen" })}
                value={stats.dayCounts.size.toLocaleString()}
                sub={
                  !sampleComplete
                    ? partialNote
                    : span && span.from !== span.to
                      ? t("employees.events.stats.ofDays", { count: daysBetween(span.from, span.to), defaultValue: "of {{count}} days in range", defaultValue_one: "of {{count}} day in range" })
                      : !span && stats.first
                        ? t("employees.events.stats.since", { date: dt.formatDate(stats.first.captured_at), defaultValue: "Since {{date}}" })
                        : periodText
                }
              />
              <Stat
                tone="neutral"
                icon={
                  <>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </>
                }
                label={t("employees.events.stats.lastSeen", { defaultValue: "Last seen" })}
                value={stats.last ? dt.formatTime(stats.last.captured_at) : "—"}
                small
                sub={
                  stats.last
                    ? `${dayWord(tenantDayKey(tz, new Date(stats.last.captured_at)), stats.last.captured_at)} · ${stats.last.camera_name}`
                    : t("employees.events.stats.none", { defaultValue: "No sightings in this period" })
                }
                title={stats.last ? dt.formatDateTime(stats.last.captured_at) : undefined}
              />
              <Stat
                tone="neutral"
                icon={
                  <>
                    <path d="M4 20V5" />
                    <path d="M4 5h11l-2 3.5L15 12H4" />
                  </>
                }
                label={t("employees.events.stats.firstSeen", { defaultValue: "First seen" })}
                value={stats.first ? dt.formatTime(stats.first.captured_at) : !sampleComplete && oldest.isLoading ? "…" : "—"}
                small
                sub={
                  stats.first
                    ? `${dayWord(tenantDayKey(tz, new Date(stats.first.captured_at)), stats.first.captured_at)} · ${stats.first.camera_name}`
                    : t("employees.events.stats.none", { defaultValue: "No sightings in this period" })
                }
                title={stats.first ? dt.formatDateTime(stats.first.captured_at) : undefined}
              />
              <Stat
                tone="warning"
                icon={<path d="M3 17l5-5 4 4 8-8M15 8h5v5" />}
                label={t("employees.events.stats.avgConfidence", { defaultValue: "Avg confidence" })}
                value={stats.avg === null ? "—" : `${Math.round(stats.avg * 100)}%`}
                sub={
                  stats.avg === null
                    ? t("employees.events.stats.none", { defaultValue: "No sightings in this period" })
                    : !sampleComplete
                      ? partialNote
                      : t("employees.events.stats.confRange", {
                          min: Math.round(stats.confMin * 100),
                          max: Math.round(stats.confMax * 100),
                          defaultValue: "Lowest {{min}}% · highest {{max}}%",
                        })
                }
              />
            </div>
          )}

          <MissHint />

          {/* ── List / gallery ────────────────────────────────────── */}
          <div className="card pe-ev-card">
            <div className="pe-ev-card-head">
              <h3 className="pe-ev-card-title">{t("employees.events.listTitle", { defaultValue: "Sightings" })}</h3>
              <span className="pe-ev-count" aria-live="polite">
                {list.data && total > 0
                  ? t("employees.events.showing", {
                      from: firstShown.toLocaleString(),
                      to: lastShown.toLocaleString(),
                      total: total.toLocaleString(),
                      defaultValue: "Showing {{from}}–{{to}} of {{total}}",
                    })
                  : ""}
              </span>
            </div>

            {isFirstLoad ? (
              <div className="pe-ev-sk" role="status" aria-label={t("employees.events.loading", { defaultValue: "Loading sightings" })}>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="pe-ev-sk-row" style={{ opacity: Math.max(0.25, 1 - i * 0.14) }}>
                    <SkeletonLine width={56} height={56} radius={12} />
                    <SkeletonLine width={110} />
                    <SkeletonLine width={130} height={22} radius={999} />
                    <SkeletonLine width={150} />
                  </div>
                ))}
              </div>
            ) : total === 0 ? (
              filtered ? (
                <EmptyPanel
                  tone="neutral"
                  icon={<Icon name="calendar" size={28} />}
                  title={t("employees.events.emptyRangeTitle", { defaultValue: "No sightings in this period" })}
                  body={t("employees.events.emptyRangeBody", { defaultValue: "The cameras didn't match this person in the selected range. Try a wider range." })}
                  actions={
                    <button type="button" className="btn" onClick={() => patch({ range: null, from: null, to: null, cam: null })}>
                      {t("employees.events.showAll", { defaultValue: "Show all dates" })}
                    </button>
                  }
                />
              ) : (
                <EmptyPanel
                  tone="accent"
                  icon={<Icon name="camera" size={28} />}
                  title={t("employees.events.emptyAllTitle", { defaultValue: "Not seen by any camera yet" })}
                  body={t("employees.events.emptyBody", { defaultValue: "Camera detections matched to this person will appear here." })}
                />
              )
            ) : (
              <div className="pe-ev-list">
                {days.map((d) => {
                  const n = dayCount(d.key, d.items.length);
                  return (
                    <section key={d.key} className="pe-ev-day" aria-label={d.label}>
                      <h4 className="pe-ev-day-head">
                        <span className="pe-ev-day-label">{d.label}</span>
                        {(d.key === todayKey || d.key === addDaysIso(todayKey, -1)) && (
                          <span className="pe-ev-day-date">{dt.formatLocalDate(d.key)}</span>
                        )}
                        <span className="pe-ev-day-n">
                          {t("employees.events.daySightings", { count: n, defaultValue: "{{count}} sightings", defaultValue_one: "{{count}} sighting" })}
                        </span>
                      </h4>
                      {view === "grid" ? (
                        <ul className="pe-ev-gallery">
                          {d.items.map((ev) => (
                            <li key={ev.id}>
                              <GalleryTile ev={ev} time={dt.formatTime(ev.captured_at)} onOpen={() => setViewerId(ev.id)} />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <ul className="pe-ev-rows">
                          {d.items.map((ev) => (
                            <li key={ev.id}>
                              <SightingRow
                                ev={ev}
                                time={dt.formatTime(ev.captured_at)}
                                exact={dt.formatDateTime(ev.captured_at)}
                                relative={rel(ev.captured_at)}
                                onOpen={() => setViewerId(ev.id)}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            )}

            {!!list.data && totalPages > 1 && (
              <Pagination
                page={page}
                totalPages={totalPages}
                pageSize={PAGE_SIZE}
                onPageChange={(p) => patch({ page: p === 1 ? null : String(p) }, true)}
                summary={t("employees.events.pageOf", { page, totalPages, defaultValue: "Page {{page}} of {{totalPages}}" })}
              />
            )}
          </div>
        </>
      )}

      {viewerIndex !== -1 && (
        <DetectionEventLightbox events={viewerEvents} initialIndex={viewerIndex} onClose={() => setViewerId(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Stat({
  tone,
  icon,
  label,
  value,
  sub,
  small = false,
  title,
}: {
  tone: "info" | "success" | "warning" | "neutral";
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  small?: boolean;
  title?: string | undefined;
}) {
  return (
    <div className={`mg-stat pe-ev-stat tone-${tone}`} title={title}>
      <span className="mg-stat-top">
        <span className="mg-stat-label">{label}</span>
        <span className="mg-stat-icon pe-ev-stat-icon" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </span>
      </span>
      <span className={`mg-stat-value${small ? " pe-ev-stat-value-sm" : ""}`}><bdi>{value}</bdi></span>
      <span className="mg-stat-sub pe-ev-stat-sub">{sub}</span>
    </div>
  );
}

function MissHint() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="pe-ev-hint">
      <Icon name="info" size={13} />
      <div className="pe-ev-hint-body">
        <span>
          {t("employees.events.hint.short", {
            defaultValue: "Not every visit is captured — lighting or camera angle can cause misses.",
          })}{" "}
          <button type="button" className="pe-ev-hint-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open
              ? t("employees.events.hint.less", { defaultValue: "Show less" })
              : t("employees.events.hint.more", { defaultValue: "Learn more" })}
          </button>
        </span>
        {open && (
          <p className="pe-ev-hint-long">
            {t("employees.events.hint.long", {
              defaultValue:
                "If the camera misses certain events due to camera positioning, capture limitations, lighting, or brightness conditions, those cases should be treated as possible anomalies.",
            })}
          </p>
        )}
      </div>
    </div>
  );
}

function Crop({ ev, className }: { ev: DetectionEvent; className: string }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (!ev.has_crop || failed) {
    return (
      <span className={`${className} is-empty`} role="img" aria-label={t("employees.events.noCrop", { defaultValue: "No face crop" })}>
        <Icon name="eyeOff" size={16} />
      </span>
    );
  }
  return (
    <span className={className}>
      <img
        src={`/api/detection-events/${ev.id}/crop`}
        alt={t("employees.events.cropAlt", { id: ev.id, defaultValue: "Face crop, sighting {{id}}" })}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function ConfidenceMeter({ ev }: { ev: DetectionEvent }) {
  const { t } = useTranslation();
  if (ev.confidence === null) return <span className="pe-ev-dim">—</span>;
  const pct = Math.round(Math.max(0, Math.min(1, ev.confidence)) * 100);
  const level = confidenceLevel(ev);
  const levelText =
    level === "strong"
      ? t("employees.events.conf.strong", { defaultValue: "Strong" })
      : level === "good"
        ? t("employees.events.conf.good", { defaultValue: "Good" })
        : level === "weak"
          ? t("employees.events.conf.weak", { defaultValue: "Weak" })
          : null;
  return (
    <span
      className={`pe-ev-conf${level ? ` is-${level}` : ""}`}
      title={t("employees.events.conf.title", { pct: (ev.confidence * 100).toFixed(1), defaultValue: "Match confidence {{pct}}%" })}
    >
      <span className="pe-ev-conf-track" aria-hidden>
        <span className="pe-ev-conf-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="pe-ev-conf-val">{pct}%</span>
      {levelText && <span className="pe-ev-conf-label">{levelText}</span>}
    </span>
  );
}

function CameraChip({ name }: { name: string }) {
  return (
    <span className="pe-ev-cam" title={name}>
      <Icon name="camera" size={12} />
      <span className="pe-ev-cam-name">{name}</span>
    </span>
  );
}

function SightingRow({
  ev,
  time,
  exact,
  relative,
  onOpen,
}: {
  ev: DetectionEvent;
  time: string;
  exact: string;
  relative: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const body = (
    <>
      <Crop ev={ev} className="pe-ev-thumb" />
      <span className="pe-ev-time" title={exact}>
        <span className="pe-ev-time-main"><bdi>{time}</bdi></span>
        <span className="pe-ev-time-sub">{relative}</span>
      </span>
      <span className="pe-ev-cell-cam">
        <CameraChip name={ev.camera_name} />
      </span>
      <span className="pe-ev-cell-conf">
        <ConfidenceMeter ev={ev} />
      </span>
    </>
  );
  if (!ev.has_crop) return <div className="pe-ev-row">{body}</div>;
  return (
    <button
      type="button"
      className="pe-ev-row is-clickable"
      onClick={onOpen}
      aria-label={t("employees.events.openSighting", { time: exact, camera: ev.camera_name, defaultValue: "View sighting at {{time}}, {{camera}}" })}
    >
      {body}
      <span className="pe-ev-row-go" aria-hidden>
        <Icon name="maximize" size={13} />
      </span>
    </button>
  );
}

function GalleryTile({ ev, time, onOpen }: { ev: DetectionEvent; time: string; onOpen: () => void }) {
  const { t } = useTranslation();
  const pct = ev.confidence === null ? null : Math.round(ev.confidence * 100);
  const inner = (
    <>
      <Crop ev={ev} className="pe-ev-tile-img" />
      <span className="pe-ev-tile-meta">
        <span className="pe-ev-tile-time"><bdi>{time}</bdi></span>
        {pct !== null && <span className="pe-ev-tile-pct">{pct}%</span>}
      </span>
      <span className="pe-ev-tile-cam" title={ev.camera_name}>
        {ev.camera_name}
      </span>
    </>
  );
  if (!ev.has_crop) return <div className="pe-ev-tile">{inner}</div>;
  return (
    <button
      type="button"
      className="pe-ev-tile is-clickable"
      onClick={onOpen}
      aria-label={t("employees.events.openSighting", { time, camera: ev.camera_name, defaultValue: "View sighting at {{time}}, {{camera}}" })}
    >
      {inner}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Viewer — split panel (crop left, metadata right) with prev / next.
// ---------------------------------------------------------------------------

export function DetectionEventLightbox({
  events,
  initialIndex,
  onClose,
}: {
  events: DetectionEvent[];
  initialIndex: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [index, setIndex] = useState(initialIndex);
  const total = events.length;
  const ev = events[Math.min(index, total - 1)];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const rtl = document.documentElement.dir === "rtl";
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIndex((i) => (rtl ? (i + 1) % total : (i - 1 + total) % total));
      if (e.key === "ArrowRight") setIndex((i) => (rtl ? (i - 1 + total) % total : (i + 1) % total));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, total]);

  if (!ev) return null;
  const portalTarget = typeof document !== "undefined" ? (document.getElementById("drawer-root") ?? document.body) : null;
  const prev = () => setIndex((i) => (i - 1 + total) % total);
  const next = () => setIndex((i) => (i + 1) % total);

  const modal = (
    <div
      className="pe-ev-viewer-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t("employees.events.viewer.title", { defaultValue: "Sighting" })}
      onClick={onClose}
    >
      <div className="pe-ev-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="pe-ev-viewer-stage">
          <img key={ev.id} src={`/api/detection-events/${ev.id}/crop`} alt={ev.employee_name ?? `#${ev.id}`} />
          {total > 1 && (
            <>
              <button type="button" className="pe-ev-viewer-nav is-prev" onClick={prev} aria-label={t("common.previous", { defaultValue: "Previous" })}>
                <Icon name="chevronLeft" size={16} />
              </button>
              <button type="button" className="pe-ev-viewer-nav is-next" onClick={next} aria-label={t("common.next", { defaultValue: "Next" })}>
                <Icon name="chevronRight" size={16} />
              </button>
            </>
          )}
          <span className="pe-ev-viewer-pos mono">
            {index + 1} / {total}
          </span>
        </div>
        <div className="pe-ev-viewer-side">
          <div className="pe-ev-viewer-head">
            <CameraChip name={ev.camera_name} />
            <button type="button" className="pe-ev-viewer-close" onClick={onClose} aria-label={t("common.close", { defaultValue: "Close" })}>
              <Icon name="x" size={12} />
            </button>
          </div>
          <div className="pe-ev-viewer-id">
            <div className="pe-ev-viewer-name">{ev.employee_name ?? ev.former_match_employee_name ?? "—"}</div>
            <div className="pe-ev-viewer-when"><bdi>{dt.formatDateTime(ev.captured_at)}</bdi></div>
            {ev.confidence != null && (
              <div className="pe-ev-viewer-conf">
                <span className="pe-ev-viewer-conf-label">{t("employees.events.viewer.confidence", { defaultValue: "Match confidence" })}</span>
                <ConfidenceMeter ev={ev} />
              </div>
            )}
          </div>
          <dl className="pe-ev-viewer-meta">
            <MetaCard label={t("employees.events.viewer.time", { defaultValue: "Time" })} value={dt.formatTimeWithSeconds(ev.captured_at)} />
            <MetaCard label={t("employees.events.viewer.date", { defaultValue: "Date" })} value={dt.formatDate(ev.captured_at)} />
            <MetaCard label={t("employees.events.viewer.camera", { defaultValue: "Camera" })} value={ev.camera_name} />
            <MetaCard label={t("employees.events.viewer.eventId", { defaultValue: "Event ID" })} value={`#${ev.id}`} />
            {ev.detection_metadata?.detector_mode && (
              <MetaCard label={t("employees.events.viewer.detector", { defaultValue: "Detector" })} value={ev.detection_metadata.detector_mode} />
            )}
          </dl>
          <div className="pe-ev-viewer-foot">
            {t("employees.events.viewer.keys", { defaultValue: "← → to browse · Esc to close" })}
          </div>
        </div>
      </div>
    </div>
  );
  return portalTarget ? createPortal(modal, portalTarget) : modal;
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="pe-ev-viewer-card">
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}
