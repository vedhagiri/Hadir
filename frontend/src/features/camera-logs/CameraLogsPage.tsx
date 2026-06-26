// Admin Camera Logs page (P11).
// Paginated table of detection_events with filters and live thumbnails
// (each <img> hits the auth-gated /crop endpoint, which decrypts on the
// fly and writes a detection_event.crop_viewed audit row per fetch).

import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnomalyInfoBanner } from "../../components/AnomalyNote";
import { RelativeTime, relativeText } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { Pagination } from "../../components/Pagination";
import { useTenantDateTime, type TenantDateTime } from "../../util/datetime";
import { useCameraOptions, useDetectionEvents } from "./hooks";
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

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("cameraLogs.title")}</h1>
          <p className="page-sub">
            {events.data
              ? t("cameraLogs.matchingCount", { count: events.data.total })
              : "—"}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">{t("cameraLogs.detectionEvents")}</h3>
          <div className="flex gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={filters.camera_id ?? ""}
              onChange={(e) =>
                update({
                  camera_id: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              style={selectStyle}
            >
              <option value="">{t("cameraLogs.allCameras")}</option>
              {cameras.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <select
              value={
                filters.identified === null
                  ? ""
                  : filters.identified
                    ? "identified"
                    : "unidentified"
              }
              onChange={(e) => {
                const v = e.target.value;
                update({
                  identified:
                    v === "" ? null : v === "identified" ? true : false,
                });
              }}
              style={selectStyle}
            >
              <option value="">{t("cameraLogs.statusFilter.all")}</option>
              <option value="identified">{t("cameraLogs.statusFilter.identified")}</option>
              <option value="unidentified">{t("cameraLogs.statusFilter.unidentified")}</option>
            </select>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: formerOnly
                  ? "var(--danger-text)"
                  : "var(--text-secondary)",
                background: formerOnly ? "var(--danger-soft)" : "transparent",
                padding: "4px 8px",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${
                  formerOnly ? "var(--danger-text)" : "var(--border)"
                }`,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={formerOnly}
                onChange={(e) => setFormerOnly(e.target.checked)}
              />
              {t("cameraLogs.formerOnly")}
            </label>
            <input
              type="datetime-local"
              value={filters.start ?? ""}
              onChange={(e) => update({ start: e.target.value || null })}
              style={selectStyle}
              title={t("cameraLogs.from")}
            />
            <input
              type="datetime-local"
              value={filters.end ?? ""}
              onChange={(e) => update({ end: e.target.value || null })}
              style={selectStyle}
              title={t("cameraLogs.to")}
            />
          </div>
        </div>

        <AnomalyInfoBanner message={t("cameraLogs.anomalyNote")} />

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
            {events.isLoading && (
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("cameraLogs.loading")}
                </td>
              </tr>
            )}
            {events.isError && (
              <tr>
                <td
                  colSpan={7}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  {t("cameraLogs.loadFailed")}
                </td>
              </tr>
            )}
            {groupedEvents.map((group) => {
              const ev = group.primary;
              const groupSize = group.children.length;
              const isGrouped = groupSize > 1;
              const isExpanded = isGrouped && expandedGroups.has(ev.id);
              return (
                <Fragment key={`group-${ev.id}`}>
                  <tr
                    onClick={isGrouped ? () => toggleGroup(ev.id) : undefined}
                    style={{
                      cursor: isGrouped ? "pointer" : "default",
                      background: isExpanded
                        ? "var(--bg-sunken)"
                        : undefined,
                    }}
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
                          style={{
                            display: "block",
                            width: 56,
                            height: 56,
                            objectFit: "cover",
                            borderRadius: "var(--radius-sm)",
                            border: "1px solid var(--border)",
                          }}
                        />
                      ) : (
                        <div
                          title={t("cameraLogs.cropUnavailable")}
                          aria-label={t("cameraLogs.cropUnavailable")}
                          style={{
                            display: "grid",
                            placeItems: "center",
                            width: 56,
                            height: 56,
                            borderRadius: "var(--radius-sm)",
                            border: "1px dashed var(--border)",
                            background: "var(--bg-sunken)",
                            color: "var(--text-tertiary)",
                            fontSize: 9,
                            textAlign: "center",
                            lineHeight: 1.1,
                            padding: 4,
                          }}
                        >
                          {t("cameraLogs.cropUnavailable")}
                        </div>
                      )}
                    </td>
                    <td className="mono text-sm">
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
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
                          <span
                            className="pill pill-accent"
                            style={{ fontSize: 10 }}
                          >
                            ×{groupSize}
                          </span>
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
                          style={{ marginTop: 2 }}
                        >
                          {ev.detection_metadata.detector_mode}
                          {ev.detection_metadata.insightface_version
                            ? ` · ${ev.detection_metadata.detector_pack} · v${ev.detection_metadata.insightface_version}`
                            : ` · ${ev.detection_metadata.detector_pack}`}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-sm">{ev.camera_name}</td>
                    <td>
                      {ev.employee_id ? (
                        <span className="pill pill-success">{t("cameraLogs.pill.identified")}</span>
                      ) : ev.former_employee_match ? (
                        <span className="pill pill-danger">{t("cameraLogs.pill.former")}</span>
                      ) : (
                        <span className="pill pill-warning">{t("cameraLogs.pill.unidentified")}</span>
                      )}
                    </td>
                    <td className="text-sm">
                      {ev.employee_id ? (
                        <span>
                          <span
                            style={{
                              fontWeight: 500,
                              color:
                                ev.employee_status === "inactive"
                                  ? "var(--text-secondary)"
                                  : undefined,
                              textDecoration:
                                ev.employee_status === "inactive"
                                  ? "line-through"
                                  : undefined,
                            }}
                          >
                            {ev.employee_name}
                          </span>{" "}
                          {ev.employee_status === "inactive" && (
                            <span
                              className="pill pill-neutral"
                              style={{ fontSize: 10, marginInlineEnd: 4 }}
                            >
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
                          <span style={{ fontWeight: 500, color: "var(--text-secondary)" }}>
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
                    <td className="mono text-xs text-dim">
                      {ev.track_id.slice(0, 12)}
                    </td>
                  </tr>
                  {isExpanded &&
                    group.children.slice(1).map((child) => (
                      <tr
                        key={child.id}
                        style={{ background: "var(--bg-sunken)" }}
                      >
                        <td>
                          {child.has_crop ? (
                            <img
                              src={`/api/detection-events/${child.id}/crop`}
                              alt={`crop ${child.id}`}
                              loading="lazy"
                              style={{
                                display: "block",
                                width: 40,
                                height: 40,
                                objectFit: "cover",
                                borderRadius: "var(--radius-sm)",
                                border: "1px solid var(--border)",
                                marginInlineStart: 14,
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: 40,
                                height: 40,
                                marginInlineStart: 14,
                                borderRadius: "var(--radius-sm)",
                                border: "1px dashed var(--border)",
                                background: "var(--bg-sunken)",
                              }}
                            />
                          )}
                        </td>
                        <td
                          className="mono text-sm text-dim"
                          style={{ paddingInlineStart: 14 }}
                        >
                          <RelativeTime iso={child.captured_at} />
                        </td>
                        <td className="text-sm text-dim">
                          {child.camera_name}
                        </td>
                        <td>
                          {child.employee_id ? (
                            <span className="pill pill-success">{t("cameraLogs.pill.identified")}</span>
                          ) : child.former_employee_match ? (
                            <span className="pill pill-danger">{t("cameraLogs.pill.former")}</span>
                          ) : (
                            <span className="pill pill-warning">{t("cameraLogs.pill.unidentified")}</span>
                          )}
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
            {events.data && events.data.items.length === 0 && !events.isLoading && (
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("cameraLogs.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>

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
