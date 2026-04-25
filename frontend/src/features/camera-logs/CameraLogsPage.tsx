// Admin Camera Logs page (P11).
// Paginated table of detection_events with filters and live thumbnails
// (each <img> hits the auth-gated /crop endpoint, which decrypts on the
// fly and writes a detection_event.crop_viewed audit row per fetch).

import { useMemo, useState } from "react";

import { Icon } from "../../shell/Icon";
import { useCameraOptions, useDetectionEvents } from "./hooks";
import type { DetectionEventFilters } from "./types";

const PAGE_SIZE = 100;

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

  const cameras = useCameraOptions();
  const events = useDetectionEvents(filters);

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
            {events.data?.items.map((ev) => (
              <tr key={ev.id}>
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
                    <span className="text-xs text-dim">—</span>
                  )}
                </td>
                <td className="mono text-sm">
                  {new Date(ev.captured_at).toLocaleString()}
                </td>
                <td className="text-sm">{ev.camera_name}</td>
                <td className="text-sm">
                  {ev.employee_id ? (
                    <span>
                      <span style={{ fontWeight: 500 }}>{ev.employee_name}</span>{" "}
                      <span className="mono text-xs text-dim">{ev.employee_code}</span>
                    </span>
                  ) : (
                    <span className="pill pill-warning">Unidentified</span>
                  )}
                </td>
                <td className="mono text-sm">
                  {ev.confidence !== null ? `${(ev.confidence * 100).toFixed(0)}%` : "—"}
                </td>
                <td className="mono text-xs text-dim">{ev.track_id.slice(0, 12)}</td>
              </tr>
            ))}
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
