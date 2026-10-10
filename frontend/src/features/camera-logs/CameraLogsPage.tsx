// Admin Camera Logs page (P11).
// Paginated detection_events feed with filters, a summary strip, list
// and grid views, and a read-only detail drawer. Every crop <img> hits
// the auth-gated /crop endpoint, which decrypts on the fly and writes a
// detection_event.crop_viewed audit row per fetch.

import { Fragment, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { extractApiError } from "../../api/client";
import { DatePicker } from "../../components/DatePicker";
import {
  EmptyPanel,
  FilterSelect,
  ResetButton,
  StatCard,
  StatGrid,
  Toolbar,
  ViewToggle,
  pct,
  useViewMode,
} from "../../components/ListPageUi";
import { Pagination } from "../../components/Pagination";
import { relativeText } from "../../components/RelativeTime";
import { SkeletonCards, SkeletonGrid, SkeletonLine } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime, type TenantDateTime } from "../../util/datetime";
import { ATT_ICON, StrokeIcon, fieldDateStyle } from "../attendance/attendanceUi";
import {
  addDaysIso,
  ConfidenceBar,
  CropThumb,
  EventStatusPill,
  InfoHint,
  PersonCell,
  TrackChip,
  cropUrl,
  presetDays,
  tenantBound,
  tenantDayKey,
  useDayGrouping,
  type RangePreset,
} from "./clUi";
import { EventDetailDrawer } from "./EventDetailDrawer";
import { useCameraOptions, useDetectionEventCounts, useDetectionEvents, type CountFilter } from "./hooks";
import type { DetectionEvent, DetectionEventFilters } from "./types";

const PAGE_SIZE = 100;

// Operator ask: when the same person is captured several times at the
// same camera within a short window, collapse the rows into one
// expandable group rather than spamming the table. Threshold is the
// max gap between *consecutive* events in time (events arrive
// captured_at-DESC), not the total span — a person who walks past,
// loiters, and walks past again 35s later groups together; one who
// walks past 60s apart gets two groups.
const GROUP_GAP_MS = 40_000;

interface EventGroup {
  primary: DetectionEvent;
  children: DetectionEvent[]; // includes primary; chronologically newest → oldest
  firstAt: string; // earliest captured_at across the group (oldest)
  lastAt: string; // latest captured_at (newest)
}

function groupEvents(events: DetectionEvent[]): EventGroup[] {
  // Events arrive sorted by captured_at DESC. Walk through and merge
  // each new event into the current group when:
  //   * same camera_id
  //   * same identity signal (same employee_id, or same
  //     former_match_employee_id, or same track_id for unknowns)
  //   * gap between this event and the *previous accepted event* is
  //     within the threshold
  // Any failure starts a new group.
  const groups: EventGroup[] = [];
  let current: EventGroup | null = null;
  let prevTimeMs = 0;
  for (const ev of events) {
    const t = new Date(ev.captured_at).getTime();
    const sameCamera = current && current.primary.camera_id === ev.camera_id;
    const cur = current?.primary;
    const sameIdentity =
      cur != null &&
      ((ev.employee_id != null && cur.employee_id === ev.employee_id) ||
        (ev.former_match_employee_id != null &&
          cur.former_match_employee_id === ev.former_match_employee_id) ||
        (ev.employee_id == null &&
          cur.employee_id == null &&
          !ev.former_match_employee_id &&
          !cur.former_match_employee_id &&
          ev.track_id === cur.track_id));
    const withinGap = current && Math.abs(prevTimeMs - t) <= GROUP_GAP_MS;
    if (current && sameCamera && sameIdentity && withinGap) {
      current.children.push(ev);
      // ``firstAt`` is the OLDEST event in the group; we walk DESC
      // so each successive event is older.
      current.firstAt = ev.captured_at;
    } else {
      current = {
        primary: ev,
        children: [ev],
        firstAt: ev.captured_at,
        lastAt: ev.captured_at,
      };
      groups.push(current);
    }
    prevTimeMs = t;
  }
  return groups;
}

function formatRangeTooltip(group: EventGroup, dt: TenantDateTime): string {
  if (group.children.length === 1) return `${dt.formatDate(group.lastAt)} ${dt.formatTimeWithSeconds(group.lastAt)}`;
  return `${dt.formatTimeWithSeconds(group.firstAt)} → ${dt.formatTimeWithSeconds(group.lastAt)}`;
}

type StatusValue = "" | "identified" | "unidentified" | "former";

const STAT_ICON = {
  total: ATT_ICON.camera,
  identified: ATT_ICON.present,
  unknown: ATT_ICON.unknown,
  former: ATT_ICON.shield,
};

export function CameraLogsPage() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<DetectionEventFilters>({
    camera_id: null,
    employee_id: null,
    identified: null,
    start: null,
    end: null,
    page: 1,
    page_size: PAGE_SIZE,
  });
  // P28.7: former-employee matches, wired through to the
  // ``former_only=true`` query param (now the "Former employees"
  // option of the Status filter).
  const [formerOnly, setFormerOnly] = useState(false);
  // Migration 0068 — tenant tz + format for times + day boundaries.
  const dt = useTenantDateTime();
  const tz = dt.timezone;
  const [view, setView] = useViewMode("maugood.cameraLogs.view");

  // Date range: a preset or a custom day span, sent to the API as
  // tenant-local start/end-of-day datetimes.
  const [preset, setPreset] = useState<RangePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // Grouping: which group ids are currently expanded.
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(() => new Set());
  // Shared 30 s ticker drives every row's relative-time label so they
  // advance in lockstep without one timer per row.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const toggleGroup = (id: number) =>
    setExpandedGroups((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [selected, setSelected] = useState<DetectionEvent | null>(null);

  const cameras = useCameraOptions();
  const events = useDetectionEvents(filters, { formerOnly });
  const items = useMemo(() => events.data?.items ?? [], [events.data]);
  const groupedEvents = useMemo(() => groupEvents(items), [items]);
  const groupOf = useMemo(() => {
    const m = new Map<number, EventGroup>();
    for (const g of groupedEvents) for (const c of g.children) m.set(c.id, g);
    return m;
  }, [groupedEvents]);
  const groupByDay = useDayGrouping();
  const days = useMemo(() => groupByDay(groupedEvents, (g) => g.lastAt), [groupByDay, groupedEvents]);

  const totalPages = useMemo(() => {
    if (!events.data) return 1;
    return Math.max(1, Math.ceil(events.data.total / events.data.page_size));
  }, [events.data]);

  const update = (patch: Partial<DetectionEventFilters>) => setFilters((prev) => ({ ...prev, page: 1, ...patch }));

  // ── Summary counts (count-only GETs, status filter excluded so the
  //    cards keep showing the whole picture for the camera + range). ──
  const base = { camera_id: filters.camera_id, start: filters.start, end: filters.end };
  const statQueries = useDetectionEventCounts([
    { ...base, identified: null, formerOnly: false },
    { ...base, identified: true, formerOnly: false },
    { ...base, identified: false, formerOnly: false },
    { ...base, identified: null, formerOnly: true },
  ]);
  const [qTotal, qIdent, qUnident, qFormer] = statQueries;
  const statsLoading = statQueries.some((q) => q.isLoading);
  const nTotal = qTotal?.data ?? 0;
  const nIdent = qIdent?.data ?? 0;
  const nUnident = qUnident?.data ?? 0;
  const nFormer = qFormer?.data ?? 0;

  // ── Per-day totals for the day headers (count-only, current filters). ──
  const dayFilters: CountFilter[] = days
    .filter((d) => d.key !== "unknown")
    .map((d) => ({
      camera_id: filters.camera_id,
      identified: filters.identified,
      formerOnly,
      start: tenantBound(d.key, "00:00:00", tz),
      end: tenantBound(d.key, "23:59:59", tz),
    }));
  const dayCountQueries = useDetectionEventCounts(dayFilters);
  const dayCount = new Map<string, number>();
  dayFilters.forEach((f, i) => {
    const n = dayCountQueries[i]?.data;
    if (n !== undefined && f.start) dayCount.set(f.start.slice(0, 10), n);
  });

  const statusValue: StatusValue = formerOnly
    ? "former"
    : filters.identified === null
      ? ""
      : filters.identified
        ? "identified"
        : "unidentified";
  const setStatus = (v: StatusValue) => {
    setFormerOnly(v === "former");
    update({ identified: v === "identified" ? true : v === "unidentified" ? false : null });
  };

  const todayKey = tenantDayKey(tz, new Date(nowTick));
  const applyRange = (p: RangePreset, from?: string, to?: string) => {
    setPreset(p);
    if (p === "all") {
      update({ start: null, end: null });
      return;
    }
    let span: { from: string; to: string };
    if (p === "custom") {
      const f = from || customFrom || presetDays("7d", todayKey).from;
      const tt = to || customTo || todayKey;
      span = { from: f, to: tt < f ? f : tt };
      setCustomFrom(span.from);
      setCustomTo(span.to);
    } else {
      span = presetDays(p, todayKey);
    }
    update({ start: tenantBound(span.from, "00:00:00", tz), end: tenantBound(span.to, "23:59:59", tz) });
  };

  const filtersActive = filters.camera_id !== null || filters.identified !== null || !!filters.start || !!filters.end || formerOnly;
  const resetFilters = () => {
    setFormerOnly(false);
    setPreset("all");
    update({ camera_id: null, identified: null, start: null, end: null });
  };
  const showEmpty = !!events.data && events.data.items.length === 0 && !events.isLoading;
  const noRecordsAtAll = showEmpty && !filtersActive;
  const noResults = showEmpty && filtersActive;

  // Detail drawer navigation walks the page in feed order.
  const selIndex = selected ? items.findIndex((e) => e.id === selected.id) : -1;
  const prevEv = selIndex > 0 ? items[selIndex - 1] : undefined;
  const nextEv = selIndex >= 0 && selIndex < items.length - 1 ? items[selIndex + 1] : undefined;
  const selGroup = selected ? groupOf.get(selected.id) : undefined;

  const openOnKey = (ev: DetectionEvent) => (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelected(ev);
    }
  };

  const dayHeader = (d: { key: string; label: string; items: EventGroup[] }) => {
    const n = dayCount.get(d.key);
    const onPage = d.items.reduce((s, g) => s + g.children.length, 0);
    return (
      <>
        <span className="cl-log-day-label">{d.label}</span>
        {(d.key === todayKey || d.key === addDaysIso(todayKey, -1)) && (
          <span className="cl-log-day-date">{dt.formatLocalDate(d.key)}</span>
        )}
        <span className="cl-log-day-count">
          {n !== undefined
            ? t("cameraLogs.day.events", { count: n, formatted: n.toLocaleString(), defaultValue: `${n.toLocaleString()} events` })
            : t("cameraLogs.day.events", { count: onPage, formatted: onPage.toLocaleString(), defaultValue: `${onPage.toLocaleString()} events` })}
        </span>
      </>
    );
  };

  const statusOptions: Array<[string, string]> = [
    ["", t("cameraLogs.statusFilter.all")],
    ["identified", t("cameraLogs.statusFilter.identified")],
    ["unidentified", t("cameraLogs.statusFilter.unidentified")],
    ["former", t("cameraLogs.statusFilter.former", { defaultValue: "Former employees" })],
  ];
  const presets: Array<[RangePreset, string]> = [
    ["all", t("cameraLogs.range.all", { defaultValue: "All time" })],
    ["today", t("cameraLogs.range.today", { defaultValue: "Today" })],
    ["yesterday", t("cameraLogs.range.yesterday", { defaultValue: "Yesterday" })],
    ["7d", t("cameraLogs.range.last7", { defaultValue: "Last 7 days" })],
    ["custom", t("cameraLogs.range.custom", { defaultValue: "Custom" })],
  ];
  const cameraCount = cameras.data?.items.length ?? 0;
  const rangeLabel = presets.find(([p]) => p === preset)?.[1] ?? "";

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("cameraLogs.title")}</h1>
          <p className="page-sub">
            {t("cameraLogs.subtitle", {
              defaultValue: "Every face the cameras detected, newest first. Repeat sightings are grouped.",
            })}
          </p>
        </div>
      </div>

      {events.isError ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
            title={t("cameraLogs.emptyState.errorTitle", { defaultValue: "Couldn't load detection events" })}
            body={extractApiError(events.error, t("cameraLogs.loadFailed"))}
            actions={
              <button type="button" className="btn" onClick={() => void events.refetch()}>
                <Icon name="refresh" size={12} />
                {t("cameraLogs.emptyState.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : noRecordsAtAll ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<StrokeIcon>{ATT_ICON.camera}</StrokeIcon>}
            title={t("cameraLogs.emptyState.noneTitle", { defaultValue: "No detections yet" })}
            body={t("cameraLogs.emptyState.noneBody", {
              defaultValue: "Detections appear here as cameras see faces. Make sure at least one camera is enabled and reachable.",
            })}
            actions={
              <Link to="/cameras" className="btn">
                <Icon name="camera" size={13} />
                {t("cameraLogs.emptyState.manageCameras", { defaultValue: "Manage cameras" })}
              </Link>
            }
          />
        </div>
      ) : (
        <>
          {statsLoading && !qTotal?.data ? (
            <div className="cl-log-stats-sk">
              <SkeletonCards count={4} minWidth={210} />
            </div>
          ) : (
            <StatGrid>
              <StatCard
                tone="info"
                icon={STAT_ICON.total}
                label={t("cameraLogs.stats.total", { defaultValue: "Total events" })}
                value={nTotal}
                sub={t("cameraLogs.stats.totalSub", {
                  range: rangeLabel,
                  count: cameraCount,
                  defaultValue: `${rangeLabel} · ${cameraCount} cameras`,
                })}
                active={statusValue === ""}
                onClick={() => setStatus("")}
              />
              <StatCard
                tone="success"
                icon={STAT_ICON.identified}
                label={t("cameraLogs.stats.identified", { defaultValue: "Identified" })}
                value={nIdent}
                sub={t("cameraLogs.stats.identifiedSub", {
                  pct: pct(nIdent, nTotal),
                  defaultValue: `${pct(nIdent, nTotal)}% identification rate`,
                })}
                active={statusValue === "identified"}
                onClick={() => setStatus(statusValue === "identified" ? "" : "identified")}
              />
              <StatCard
                tone="warning"
                icon={STAT_ICON.unknown}
                label={t("cameraLogs.stats.unidentified", { defaultValue: "Unidentified" })}
                value={nUnident}
                sub={t("cameraLogs.stats.unidentifiedSub", {
                  pct: pct(nUnident, nTotal),
                  defaultValue: `${pct(nUnident, nTotal)}% of events · no match`,
                })}
                active={statusValue === "unidentified"}
                onClick={() => setStatus(statusValue === "unidentified" ? "" : "unidentified")}
              />
              <StatCard
                tone="danger"
                icon={STAT_ICON.former}
                label={t("cameraLogs.stats.former", { defaultValue: "Former employees" })}
                value={nFormer}
                sub={t("cameraLogs.stats.formerSub", { defaultValue: "Matched an inactive employee" })}
                active={statusValue === "former"}
                onClick={() => setStatus(statusValue === "former" ? "" : "former")}
              />
            </StatGrid>
          )}

          <Toolbar>
            <FilterSelect
              label={t("cameraLogs.filter.camera", { defaultValue: "Camera" })}
              value={filters.camera_id === null ? "" : String(filters.camera_id)}
              onChange={(v) => update({ camera_id: v === "" ? null : Number(v) })}
              options={[
                ["", t("cameraLogs.allCameras")],
                ...(cameras.data?.items ?? []).map((c) => [String(c.id), c.name] as [string, string]),
              ]}
            />
            <FilterSelect
              label={t("cameraLogs.filter.status", { defaultValue: "Status" })}
              value={statusValue}
              onChange={(v) => setStatus(v as StatusValue)}
              options={statusOptions}
            />
            <div className="seg cl-log-seg" role="group" aria-label={t("cameraLogs.range.label", { defaultValue: "Date range" })}>
              {presets.map(([p, label]) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={preset === p}
                  className={`seg-btn${preset === p ? " active" : ""}`}
                  onClick={() => applyRange(p)}
                >
                  {label}
                </button>
              ))}
            </div>
            {preset === "custom" && (
              <div className="cl-log-custom">
                <DatePicker
                  value={customFrom}
                  max={customTo || todayKey}
                  onChange={(v) => applyRange("custom", v, customTo)}
                  ariaLabel={t("cameraLogs.from")}
                  triggerStyle={fieldDateStyle}
                />
                <span className="cl-log-dim" aria-hidden>
                  →
                </span>
                <DatePicker
                  value={customTo}
                  min={customFrom}
                  max={todayKey}
                  onChange={(v) => applyRange("custom", customFrom, v)}
                  ariaLabel={t("cameraLogs.to")}
                  triggerStyle={fieldDateStyle}
                />
              </div>
            )}
            <ResetButton active={filtersActive} label={t("cameraLogs.filter.reset", { defaultValue: "Reset" })} onClick={resetFilters} />
          </Toolbar>

          <div className="card cl-log-card">
            <div className="cl-log-card-head">
              <div className="cl-log-card-title">
                <h3 className="card-title">{t("cameraLogs.detectionEvents")}</h3>
                <InfoHint label={t("cameraLogs.hintLabel", { defaultValue: "About missed detections" })}>
                  {t("cameraLogs.anomalyNote")}
                </InfoHint>
              </div>
              <span className="cl-log-count">
                {events.data
                  ? t("cameraLogs.matchingCountFmt", {
                      count: events.data.total,
                      formatted: events.data.total.toLocaleString(),
                      defaultValue: `${events.data.total.toLocaleString()} events matching filters`,
                    })
                  : ""}
                {events.isFetching && events.data && <span className="cl-log-live" aria-hidden />}
              </span>
              <ViewToggle
                value={view}
                onChange={setView}
                listLabel={t("cameraLogs.view.list", { defaultValue: "List view" })}
                gridLabel={t("cameraLogs.view.grid", { defaultValue: "Grid view" })}
              />
            </div>

            {noResults ? (
              <EmptyPanel
                tone="neutral"
                icon={<Icon name="filter" size={28} />}
                title={t("cameraLogs.emptyState.filtersTitle", { defaultValue: "No detections match these filters" })}
                body={t("cameraLogs.emptyState.filtersBody", {
                  defaultValue: "Try another camera, status or time range, or clear the filters.",
                })}
                actions={
                  <button type="button" className="btn" onClick={resetFilters}>
                    <Icon name="refresh" size={12} />
                    {t("cameraLogs.emptyState.clearFilters", { defaultValue: "Clear filters" })}
                  </button>
                }
              />
            ) : view === "grid" ? (
              <div className="cl-log-grid-wrap">
                {events.isLoading ? (
                  <SkeletonGrid count={14} minWidth={176} />
                ) : (
                  days.map((d) => (
                    <section key={d.key} className="cl-log-grid-day">
                      <h4 className="cl-log-day">{dayHeader(d)}</h4>
                      <div className="cl-log-grid">
                        {d.items.map((g) => {
                          const ev = g.primary;
                          const size = g.children.length;
                          return (
                            <button
                              key={ev.id}
                              type="button"
                              className="cl-log-tile"
                              onClick={() => setSelected(ev)}
                              title={formatRangeTooltip(g, dt)}
                            >
                              <span className="cl-log-tile-media">
                                {ev.has_crop ? (
                                  <img src={cropUrl(ev.id)} alt="" loading="lazy" />
                                ) : (
                                  <span className="cl-log-tile-empty">
                                    <Icon name="eyeOff" size={18} />
                                    {t("cameraLogs.cropUnavailable")}
                                  </span>
                                )}
                                {size > 1 && <span className="cl-log-tile-badge">×{size}</span>}
                                <span className="cl-log-tile-status">
                                  <EventStatusPill ev={ev} />
                                </span>
                              </span>
                              <span className="cl-log-tile-body">
                                <span className="cl-log-tile-top">
                                  <span className="cl-log-tile-time">{dt.formatTimeWithSeconds(ev.captured_at)}</span>
                                  <span className="cl-log-tile-rel">{relativeText(ev.captured_at, nowTick)}</span>
                                </span>
                                <span className="cl-log-tile-cam">
                                  <Icon name="camera" size={11} />
                                  {ev.camera_name}
                                </span>
                                <PersonCell ev={ev} compact linked={false} />
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            ) : (
              <div className="cl-log-table-wrap">
                <table className="table cl-log-table">
                  <thead>
                    <tr>
                      <th className="cl-log-col-crop">{t("cameraLogs.col.crop")}</th>
                      <th className="cl-log-col-time">{t("cameraLogs.col.captured")}</th>
                      <th>{t("cameraLogs.col.camera")}</th>
                      <th className="cl-log-col-status">{t("cameraLogs.col.status")}</th>
                      <th>{t("cameraLogs.col.person")}</th>
                      <th className="cl-log-col-conf">{t("cameraLogs.col.confidence")}</th>
                      <th className="cl-log-col-track">{t("cameraLogs.col.track")}</th>
                      <th className="cl-log-col-more">
                        <span className="cl-log-sr">{t("cameraLogs.col.sightings", { defaultValue: "Sightings" })}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.isLoading && <ListSkeletonRows />}
                    {days.map((d) => (
                      <Fragment key={d.key}>
                        <tr className="cl-log-dayrow">
                          <td colSpan={8}>
                            <div className="cl-log-day">{dayHeader(d)}</div>
                          </td>
                        </tr>
                        {d.items.map((group) => {
                          const ev = group.primary;
                          const groupSize = group.children.length;
                          const isGrouped = groupSize > 1;
                          const isExpanded = isGrouped && expandedGroups.has(ev.id);
                          return (
                            <Fragment key={`group-${ev.id}`}>
                              <tr
                                className={`cl-log-row${isExpanded ? " is-expanded" : ""}`}
                                onClick={() => setSelected(ev)}
                                onKeyDown={openOnKey(ev)}
                                tabIndex={0}
                                aria-label={t("cameraLogs.openEvent", {
                                  time: dt.formatTimeWithSeconds(ev.captured_at),
                                  camera: ev.camera_name,
                                  defaultValue: `Open event at ${dt.formatTimeWithSeconds(ev.captured_at)}, ${ev.camera_name}`,
                                })}
                              >
                                <td>
                                  <CropThumb ev={ev} />
                                </td>
                                <td className="cl-log-nowrap">
                                  <div className="cl-log-time" title={formatRangeTooltip(group, dt)}>
                                    {dt.formatTimeWithSeconds(ev.captured_at)}
                                  </div>
                                  <div className="cl-log-sub">
                                    {relativeText(group.lastAt, nowTick)}
                                    {isGrouped && (
                                      <>
                                        {" · "}
                                        {t("cameraLogs.since", {
                                          time: dt.formatTimeWithSeconds(group.firstAt),
                                          defaultValue: `since ${dt.formatTimeWithSeconds(group.firstAt)}`,
                                        })}
                                      </>
                                    )}
                                  </div>
                                </td>
                                <td className="cl-log-nowrap">
                                  <span className="cl-log-cam">
                                    <Icon name="camera" size={12} />
                                    {ev.camera_name}
                                  </span>
                                </td>
                                <td>
                                  <EventStatusPill ev={ev} />
                                </td>
                                <td>
                                  <PersonCell ev={ev} />
                                </td>
                                <td>
                                  <ConfidenceBar value={ev.confidence} />
                                </td>
                                <td>
                                  <TrackChip id={ev.track_id} />
                                </td>
                                <td className="cl-log-col-more">
                                  {isGrouped ? (
                                    <button
                                      type="button"
                                      className={`cl-log-expand${isExpanded ? " is-open" : ""}`}
                                      aria-expanded={isExpanded}
                                      aria-label={t("cameraLogs.groupTooltip", { count: groupSize })}
                                      title={t("cameraLogs.groupTooltip", { count: groupSize })}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleGroup(ev.id);
                                      }}
                                    >
                                      ×{groupSize}
                                      <Icon name="chevronDown" size={12} />
                                    </button>
                                  ) : (
                                    <span className="cl-log-open-hint" aria-hidden>
                                      <Icon name="chevronRight" size={14} />
                                    </span>
                                  )}
                                </td>
                              </tr>
                              {isExpanded &&
                                group.children.slice(1).map((child) => (
                                  <tr
                                    key={child.id}
                                    className="cl-log-row cl-log-child"
                                    onClick={() => setSelected(child)}
                                    onKeyDown={openOnKey(child)}
                                    tabIndex={0}
                                    aria-label={t("cameraLogs.openEvent", {
                                      time: dt.formatTimeWithSeconds(child.captured_at),
                                      camera: child.camera_name,
                                      defaultValue: `Open event at ${dt.formatTimeWithSeconds(child.captured_at)}, ${child.camera_name}`,
                                    })}
                                  >
                                    <td>
                                      <span className="cl-log-child-thumb">
                                        <CropThumb ev={child} size="sm" />
                                      </span>
                                    </td>
                                    <td className="cl-log-nowrap">
                                      <div className="cl-log-time is-child">{dt.formatTimeWithSeconds(child.captured_at)}</div>
                                      <div className="cl-log-sub">{relativeText(child.captured_at, nowTick)}</div>
                                    </td>
                                    <td className="cl-log-nowrap cl-log-dim">{child.camera_name}</td>
                                    <td>
                                      <EventStatusPill ev={child} />
                                    </td>
                                    <td>
                                      <PersonCell ev={child} compact />
                                    </td>
                                    <td>
                                      <ConfidenceBar value={child.confidence} />
                                    </td>
                                    <td>
                                      <TrackChip id={child.track_id} />
                                    </td>
                                    <td />
                                  </tr>
                                ))}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!noResults && (
              <div className="cl-log-foot">
                <Pagination
                  page={filters.page}
                  totalPages={totalPages}
                  onPageChange={(p) => setFilters((prev) => ({ ...prev, page: p }))}
                  summary={t("cameraLogs.pageOf", {
                    page: filters.page,
                    total: totalPages,
                  })}
                />
              </div>
            )}
          </div>
        </>
      )}

      {selected && (
        <EventDetailDrawer
          ev={selected}
          group={selGroup ? { size: selGroup.children.length, firstAt: selGroup.firstAt, lastAt: selGroup.lastAt } : null}
          onClose={() => setSelected(null)}
          onPrev={prevEv ? () => setSelected(prevEv) : null}
          onNext={nextEv ? () => setSelected(nextEv) : null}
        />
      )}
    </>
  );
}

/** Loading rows shaped like the real ones: thumb, time + relative,
 *  camera, pill, avatar + name, bar, chip. */
function ListSkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <tr key={i} aria-hidden style={{ opacity: Math.max(0.3, 1 - i * 0.09) }}>
          <td>
            <SkeletonLine width={48} height={48} radius={10} />
          </td>
          <td>
            <SkeletonLine width={70} height={12} />
            <SkeletonLine width={52} height={9} style={{ marginTop: 6 }} />
          </td>
          <td>
            <SkeletonLine width={110} height={11} />
          </td>
          <td>
            <SkeletonLine width={88} height={20} radius={999} />
          </td>
          <td>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <SkeletonLine width={30} height={30} radius="50%" />
              <SkeletonLine width={120} height={11} />
            </span>
          </td>
          <td>
            <SkeletonLine width={80} height={8} radius={999} />
          </td>
          <td>
            <SkeletonLine width={76} height={18} radius={6} />
          </td>
          <td />
        </tr>
      ))}
    </>
  );
}
