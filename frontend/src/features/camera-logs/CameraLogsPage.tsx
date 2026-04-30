// Admin Camera Logs page (P11).
// Paginated table of detection_events with filters and live thumbnails
// (each <img> hits the auth-gated /crop endpoint, which decrypts on the
// fly and writes a detection_event.crop_viewed audit row per fetch).

import { Fragment, useMemo, useState } from "react";

import { Icon } from "../../shell/Icon";
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

function formatTimeRange(group: EventGroup): string {
  const a = new Date(group.lastAt).toLocaleTimeString();
  if (group.children.length === 1) return new Date(group.lastAt).toLocaleString();
  const b = new Date(group.firstAt).toLocaleTimeString();
  // Time-only range when same calendar day; full date for the
  // anchor (lastAt) so the operator can read the date too.
  return `${new Date(group.lastAt).toLocaleDateString()}, ${b} – ${a}`;
}

export function CameraLogsPage() {
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
  // Grouping: which group ids are currently expanded. Resets on
  // filter change (the group ids are derived from primary event id,
  // so a fresh page reset clears stale entries naturally).
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(
    () => new Set(),
  );
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
          <h1 className="page-title">Camera Logs</h1>
          <p className="page-sub">
            {events.data
              ? `${events.data.total} event${events.data.total === 1 ? "" : "s"} matching filters`
              : "—"}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Detection events</h3>
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
              <option value="">All cameras</option>
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
              <option value="">All</option>
              <option value="identified">Identified</option>
              <option value="unidentified">Unidentified</option>
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
              Former employees only
            </label>
            <input
              type="datetime-local"
              value={filters.start ?? ""}
              onChange={(e) => update({ start: e.target.value || null })}
              style={selectStyle}
              title="From"
            />
            <input
              type="datetime-local"
              value={filters.end ?? ""}
              onChange={(e) => update({ end: e.target.value || null })}
              style={selectStyle}
              title="To"
            />
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 88 }}>Crop</th>
              <th>Captured</th>
              <th>Camera</th>
              <th>Employee</th>
              <th style={{ width: 80 }}>Confidence</th>
              <th>Track</th>
            </tr>
          </thead>
          <tbody>
            {events.isLoading && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  Loading…
                </td>
              </tr>
            )}
            {events.isError && (
              <tr>
                <td
                  colSpan={6}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  Could not load events.
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
                        ? `${groupSize} captures in this window — click to expand`
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
                          title="Crop unavailable"
                          aria-label="Crop unavailable"
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
                          Crop
                          <br />
                          unavailable
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
                        <span>{formatTimeRange(group)}</span>
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
                              archived
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
                              ? `Former: ${ev.former_match_employee_name}`
                              : "Former employee"
                          }
                        >
                          <span className="pill pill-danger">
                            Former employee
                          </span>{" "}
                          <span className="mono text-xs text-dim">
                            {ev.former_match_employee_code ?? "—"}
                          </span>
                        </span>
                      ) : (
                        <span className="pill pill-warning">Unidentified</span>
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
                          {new Date(child.captured_at).toLocaleString()}
                        </td>
                        <td className="text-sm text-dim">
                          {child.camera_name}
                        </td>
                        <td className="text-sm text-dim">
                          {child.employee_id
                            ? child.employee_name ?? `EMP ${child.employee_id}`
                            : child.former_employee_match
                              ? "Former employee"
                              : "Unidentified"}
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
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  No events match. Try widening filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>

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
            Page {filters.page} of {totalPages}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn btn-sm"
              disabled={filters.page <= 1}
              onClick={() =>
                setFilters((prev) => ({ ...prev, page: prev.page - 1 }))
              }
            >
              <Icon name="chevronLeft" size={11} />
              Prev
            </button>
            <button
              className="btn btn-sm"
              disabled={filters.page >= totalPages}
              onClick={() =>
                setFilters((prev) => ({ ...prev, page: prev.page + 1 }))
              }
            >
              Next
              <Icon name="chevronRight" size={11} />
            </button>
          </div>
        </div>
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
