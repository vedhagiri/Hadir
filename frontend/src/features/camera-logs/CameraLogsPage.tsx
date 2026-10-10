// Admin Camera Logs page (P11).
// Paginated table of detection_events with filters and live thumbnails
// (each <img> hits the auth-gated /crop endpoint, which decrypts on the
// fly and writes a detection_event.crop_viewed audit row per fetch).

import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { extractApiError } from "../../api/client";
import { AnomalyInfoBanner } from "../../components/AnomalyNote";
import { RelativeTime, relativeText } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { Pagination } from "../../components/Pagination";
import { useTenantDateTime, type TenantDateTime } from "../../util/datetime";
import { useCameraOptions, useDetectionEvents } from "./hooks";
import type { DetectionEvent, DetectionEventFilters } from "./types";
import { SkeletonRows } from "../../components/Skeleton";
import { EmptyPanel, FilterSelect, ResetButton, Toolbar } from "../../components/ListPageUi";
import { ATT_ICON, DotPill, FieldGroup, StrokeIcon } from "../attendance/attendanceUi";

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

function formatTimeRange(group: EventGroup, now: number): string {
  // Always relative for the table cell. Tooltip carries the exact
  // tenant-local times (see formatRangeTooltip).
  return relativeText(group.lastAt, now);
}

function formatRangeTooltip(group: EventGroup, dt: TenantDateTime): string {
  if (group.children.length === 1) return dt.formatTimeWithSeconds(group.lastAt);
  return `${dt.formatTimeWithSeconds(group.firstAt)} → ${dt.formatTimeWithSeconds(
    group.lastAt,
  )}`;
}

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
  // P28.7: client-side toggle wired through to the new
  // ``former_only=true`` query param.
  const [formerOnly, setFormerOnly] = useState(false);
  // Migration 0068 — tenant tz + format for the row tooltip.
  const dt = useTenantDateTime();
  // Grouping: which group ids are currently expanded. Resets on
  // filter change (the group ids are derived from primary event id,
  // so a fresh page reset clears stale entries naturally).
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(
    () => new Set(),
  );
  // Shared 30 s ticker drives every group-row's relative-time
  // label so they advance in lockstep without one timer per row.
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

  const cameras = useCameraOptions();
  const events = useDetectionEvents(filters, { formerOnly });
  const groupedEvents = useMemo(
    () => groupEvents(events.data?.items ?? []),
    [events.data],
  );

  const totalPages = useMemo(() => {
    if (!events.data) return 1;
    return Math.max(1, Math.ceil(events.data.total / events.data.page_size));
  }, [events.data]);

  const update = (patch: Partial<DetectionEventFilters>) =>
    setFilters((prev) => ({ ...prev, page: 1, ...patch }));

  const statusValue =
    filters.identified === null
      ? ""
      : filters.identified
        ? "identified"
        : "unidentified";
  const filtersActive =
    filters.camera_id !== null ||
    filters.identified !== null ||
    !!filters.start ||
    !!filters.end ||
    formerOnly;
  const resetFilters = () => {
    setFormerOnly(false);
    update({ camera_id: null, identified: null, start: null, end: null });
  };
  const showEmpty =
    !!events.data && events.data.items.length === 0 && !events.isLoading;

  const noRecordsAtAll = showEmpty && !filtersActive;
  const noResults = showEmpty && filtersActive;

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
            body={t("cameraLogs.emptyState.noneBody", { defaultValue: "Detections appear here as cameras see faces. Make sure at least one camera is enabled and reachable." })}
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
          <Toolbar>
            <FilterSelect
              label={t("cameraLogs.filter.camera", { defaultValue: "Camera" })}
              value={filters.camera_id === null ? "" : String(filters.camera_id)}
              onChange={(v) => update({ camera_id: v === "" ? null : Number(v) })}
              options={[
                ["", t("cameraLogs.allCameras")],
                ...(cameras.data?.items ?? []).map(
                  (c) => [String(c.id), c.name] as [string, string],
                ),
              ]}
            />
            <FilterSelect
              label={t("cameraLogs.filter.status", { defaultValue: "Status" })}
              value={statusValue}
              onChange={(v) =>
                update({ identified: v === "" ? null : v === "identified" })
              }
              options={[
                ["", t("cameraLogs.statusFilter.all")],
                ["identified", t("cameraLogs.statusFilter.identified")],
                ["unidentified", t("cameraLogs.statusFilter.unidentified")],
              ]}
            />
            <button
              type="button"
              aria-pressed={formerOnly}
              className="at-toggle tone-danger"
              onClick={() => {
                setFormerOnly((v) => !v);
                update({});
              }}
            >
              <span aria-hidden className="at-toggle-box">
                {formerOnly && <Icon name="check" size={10} />}
              </span>
              {t("cameraLogs.formerOnly")}
            </button>
            <FieldGroup label={t("cameraLogs.from")}>
              <input
                type="datetime-local"
                className="at-control"
                value={filters.start ?? ""}
                onChange={(e) => update({ start: e.target.value || null })}
                title={t("cameraLogs.from")}
                aria-label={t("cameraLogs.from")}
              />
            </FieldGroup>
            <FieldGroup label={t("cameraLogs.to")}>
              <input
                type="datetime-local"
                className="at-control"
                value={filters.end ?? ""}
                onChange={(e) => update({ end: e.target.value || null })}
                title={t("cameraLogs.to")}
                aria-label={t("cameraLogs.to")}
              />
            </FieldGroup>
            <ResetButton
              active={filtersActive}
              label={t("cameraLogs.filter.reset", { defaultValue: "Reset" })}
              onClick={resetFilters}
            />
          </Toolbar>

          <div className="card">
            <div className="at-card-head">
              <h3 className="card-title">{t("cameraLogs.detectionEvents")}</h3>
              <span className="text-xs text-dim at-nowrap">
                {events.data
                  ? t("cameraLogs.matchingCount", { count: events.data.total })
                  : "—"}
              </span>
            </div>
            <div className="at-card-body" style={{ paddingBottom: 0 }}>
              <AnomalyInfoBanner message={t("cameraLogs.anomalyNote")} />
            </div>

            {noResults ? (
              <EmptyPanel
                tone="neutral"
                icon={<Icon name="filter" size={28} />}
                title={t("cameraLogs.emptyState.filtersTitle", { defaultValue: "No detections match these filters" })}
                body={t("cameraLogs.emptyState.filtersBody", { defaultValue: "Try another camera, status or time range, or clear the filters." })}
                actions={
                  <button type="button" className="btn" onClick={resetFilters}>
                    <Icon name="refresh" size={12} />
                    {t("cameraLogs.emptyState.clearFilters", { defaultValue: "Clear filters" })}
                  </button>
                }
              />
            ) : (
              <div className="at-scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 88 }}>{t("cameraLogs.col.crop")}</th>
                      <th>{t("cameraLogs.col.captured")}</th>
                      <th>{t("cameraLogs.col.camera")}</th>
                      <th style={{ width: 120 }}>{t("cameraLogs.col.status")}</th>
                      <th>{t("cameraLogs.col.person")}</th>
                      <th style={{ width: 80 }}>{t("cameraLogs.col.confidence")}</th>
                      <th>{t("cameraLogs.col.track")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.isLoading && <SkeletonRows cols={7} />}
                    {groupedEvents.map((group) => {
                      const ev = group.primary;
                      const groupSize = group.children.length;
                      const isGrouped = groupSize > 1;
                      const isExpanded = isGrouped && expandedGroups.has(ev.id);
                      const rowClass = [isGrouped ? "at-row-clickable" : "", isExpanded ? "at-row-expanded" : ""].filter(Boolean).join(" ") || undefined;
                      return (
                        <Fragment key={`group-${ev.id}`}>
                          <tr
                            onClick={isGrouped ? () => toggleGroup(ev.id) : undefined}
                            className={rowClass}
                            title={
                              isGrouped
                                ? t("cameraLogs.groupTooltip", { count: groupSize })
                                : undefined
                            }
                          >
                            <td>
                              {ev.has_crop ? (
                                <img
                                  src={`/api/detection-events/${ev.id}/crop`}
                                  alt={`crop ${ev.id}`}
                                  loading="lazy"
                                  className="at-thumb"
                                />
                              ) : (
                                <div
                                  title={t("cameraLogs.cropUnavailable")}
                                  aria-label={t("cameraLogs.cropUnavailable")}
                                  className="at-thumb-empty"
                                >
                                  {t("cameraLogs.cropUnavailable")}
                                </div>
                              )}
                            </td>
                            <td className="mono text-sm at-nowrap">
                              <div className="at-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                                {isGrouped && (
                                  <Icon
                                    name={isExpanded ? "chevronDown" : "chevronRight"}
                                    size={11}
                                  />
                                )}
                                <span title={formatRangeTooltip(group, dt)}>
                                  {formatTimeRange(group, nowTick)}
                                </span>
                                {isGrouped && (
                                  <span className="pill pill-accent">×{groupSize}</span>
                                )}
                              </div>
                              {ev.detection_metadata ? (
                                <div
                                  className="mono text-xs text-dim"
                                  title={JSON.stringify(
                                    ev.detection_metadata,
                                    null,
                                    2,
                                  )}
                                >
                                  {ev.detection_metadata.detector_mode}
                                  {ev.detection_metadata.insightface_version
                                    ? ` · ${ev.detection_metadata.detector_pack} · v${ev.detection_metadata.insightface_version}`
                                    : ` · ${ev.detection_metadata.detector_pack}`}
                                </div>
                              ) : null}
                            </td>
                            <td className="text-sm at-nowrap">{ev.camera_name}</td>
                            <td>
                              <EventStatusPill ev={ev} />
                            </td>
                            <td className="text-sm">
                              {ev.employee_id ? (
                                <span>
                                  <span
                                    className={ev.employee_status === "inactive" ? "at-muted" : undefined}
                                    style={{
                                      fontWeight: 500,
                                      textDecoration:
                                        ev.employee_status === "inactive"
                                          ? "line-through"
                                          : undefined,
                                    }}
                                  >
                                    {ev.employee_name}
                                  </span>{" "}
                                  {ev.employee_status === "inactive" && (
                                    <span className="pill pill-neutral" style={{ marginInlineEnd: 4 }}>
                                      {t("cameraLogs.archived")}
                                    </span>
                                  )}
                                  <span className="mono text-xs text-dim">
                                    {ev.employee_code}
                                  </span>
                                </span>
                              ) : ev.former_employee_match ? (
                                <span
                                  title={
                                    ev.former_match_employee_name
                                      ? t("cameraLogs.formerNamed", { name: ev.former_match_employee_name })
                                      : t("cameraLogs.pill.former")
                                  }
                                >
                                  <span className="at-muted" style={{ fontWeight: 500 }}>
                                    {ev.former_match_employee_name ?? t("cameraLogs.unknown")}
                                  </span>{" "}
                                  <span className="mono text-xs text-dim">
                                    {ev.former_match_employee_code ?? "—"}
                                  </span>
                                </span>
                              ) : (
                                <span className="text-dim">—</span>
                              )}
                            </td>
                            <td className="mono text-sm">
                              {ev.confidence !== null
                                ? `${(ev.confidence * 100).toFixed(0)}%`
                                : "—"}
                            </td>
                            <td className="mono text-xs text-dim at-nowrap">
                              {ev.track_id.slice(0, 12)}
                            </td>
                          </tr>
                          {isExpanded &&
                            group.children.slice(1).map((child) => (
                              <tr key={child.id} className="at-row-child">
                                <td>
                                  {child.has_crop ? (
                                    <img
                                      src={`/api/detection-events/${child.id}/crop`}
                                      alt={`crop ${child.id}`}
                                      loading="lazy"
                                      className="at-thumb sm"
                                      style={{ marginInlineStart: 14 }}
                                    />
                                  ) : (
                                    <div className="at-thumb-empty sm" style={{ marginInlineStart: 14 }} />
                                  )}
                                </td>
                                <td className="mono text-sm text-dim at-indent">
                                  <RelativeTime iso={child.captured_at} />
                                </td>
                                <td className="text-sm text-dim">
                                  {child.camera_name}
                                </td>
                                <td>
                                  <EventStatusPill ev={child} />
                                </td>
                                <td className="text-sm text-dim">
                                  {child.employee_id
                                    ? (child.employee_name ?? t("cameraLogs.empFallback", { id: child.employee_id }))
                                    : child.former_employee_match
                                      ? (child.former_match_employee_name ?? t("cameraLogs.pill.former"))
                                      : "—"}
                                </td>
                                <td className="mono text-sm text-dim">
                                  {child.confidence !== null
                                    ? `${(child.confidence * 100).toFixed(0)}%`
                                    : "—"}
                                </td>
                                <td className="mono text-xs text-dim">
                                  {child.track_id.slice(0, 12)}
                                </td>
                              </tr>
                            ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!noResults && (
              <div className="at-table-foot">
                <Pagination
                  page={filters.page}
                  totalPages={totalPages}
                  onPageChange={(p) =>
                    setFilters((prev) => ({ ...prev, page: p }))
                  }
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
    </>
  );
}

function EventStatusPill({ ev }: { ev: DetectionEvent }) {
  const { t } = useTranslation();
  if (ev.employee_id) return <DotPill tone="success">{t("cameraLogs.pill.identified")}</DotPill>;
  if (ev.former_employee_match) return <DotPill tone="danger">{t("cameraLogs.pill.former")}</DotPill>;
  return <DotPill tone="warning">{t("cameraLogs.pill.unidentified")}</DotPill>;
}
