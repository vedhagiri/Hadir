// Right-sliding drawer for one row on the Daily Attendance page.
// Pulls the underlying detection_events for the same employee + date and
// renders them with auth-gated thumbnails (the GET /crop endpoint) plus
// a small flag-explanation block. Layout follows the design's
// RecordDrawer pattern from src/design/pages.jsx.

import { Icon } from "../../shell/Icon";
import { useEmployeeDayEvents } from "./hooks";
import type { AttendanceItem } from "./types";

interface Props {
  item: AttendanceItem;
  onClose: () => void;
}

export function AttendanceDrawer({ item, onClose }: Props) {
  const events = useEmployeeDayEvents(item.employee_id, item.date);

  const totalHours =
    item.total_minutes !== null
      ? `${(item.total_minutes / 60).toFixed(2)}h`
      : "—";
  const overtime =
    item.overtime_minutes > 0
      ? `${(item.overtime_minutes / 60).toFixed(2)}h`
      : "0h";

  const flagNotes = [
    item.absent
      ? {
          tone: "danger",
          label: "Absent",
          text: "No detection events recorded today, and no leave covers this date.",
        }
      : null,
    item.late
      ? {
          tone: "warning",
          label: "Late",
          text:
            "First detection landed after the policy start plus the configured grace window.",
        }
      : null,
    item.early_out
      ? {
          tone: "warning",
          label: "Early out",
          text:
            "Last detection of the day came before the policy end minus the grace window.",
        }
      : null,
    item.short_hours
      ? {
          tone: "info",
          label: "Short hours",
          text: `Total time on site is below the policy's required ${item.policy.name.includes("8") ? "8" : "required"} hours.`,
        }
      : null,
    item.overtime_minutes > 0
      ? {
          tone: "accent",
          label: "Overtime",
          text: `${overtime} of overtime computed against the policy required hours.`,
        }
      : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">Attendance record</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {item.full_name} · {item.date}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="drawer-body">
          {/* Profile header */}
          <div
            className="flex items-center gap-3"
            style={{ marginBottom: 16 }}
          >
            <div
              className="avatar"
              style={{ width: 46, height: 46, fontSize: 16 }}
            >
              {initials(item.full_name)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {item.full_name}
              </div>
              <div className="text-sm text-dim mono">{item.employee_code}</div>
              <div className="flex gap-2" style={{ marginTop: 4 }}>
                <span className="pill pill-neutral">{item.department.name}</span>
                {item.absent && <span className="pill pill-danger">absent</span>}
                {!item.absent && item.late && (
                  <span className="pill pill-warning">late</span>
                )}
                {!item.absent && item.early_out && (
                  <span className="pill pill-warning">early out</span>
                )}
                {!item.absent && item.overtime_minutes > 0 && (
                  <span className="pill pill-accent">overtime</span>
                )}
              </div>
            </div>
          </div>

          {/* Summary tiles */}
          <div
            className="grid grid-4"
            style={{ gap: 10, marginBottom: 16 }}
          >
            <SummaryTile label="In time" value={item.in_time ?? "—"} />
            <SummaryTile label="Out time" value={item.out_time ?? "—"} />
            <SummaryTile label="Total" value={totalHours} />
            <SummaryTile label="Overtime" value={overtime} />
          </div>

          {/* Policy applied */}
          <SectionLabel>Policy applied</SectionLabel>
          <div
            style={{
              padding: 12,
              border: "1px solid var(--border)",
              borderRadius: 8,
              marginBottom: 16,
            }}
          >
            <div className="flex items-center justify-between">
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {item.policy.name}
              </div>
              <span className="text-xs text-dim mono">policy id {item.policy.id}</span>
            </div>
          </div>

          {/* Flag explanations */}
          {flagNotes.length > 0 && (
            <>
              <SectionLabel>Flags</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                {flagNotes.map((f) => (
                  <div
                    key={f.label}
                    style={{
                      padding: "8px 10px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg-sunken)",
                      fontSize: 12.5,
                    }}
                  >
                    <span className={`pill pill-${f.tone}`}>{f.label}</span>{" "}
                    <span className="text-dim">{f.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Underlying events */}
          <SectionLabel>
            Detection events
            {events.data ? ` · ${events.data.total}` : ""}
          </SectionLabel>
          {events.isLoading && (
            <div className="text-sm text-dim">Loading…</div>
          )}
          {events.data && events.data.items.length === 0 && (
            <div className="text-sm text-dim">
              No detection events on this date.
            </div>
          )}
          {events.data && events.data.items.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 8,
              }}
            >
              {events.data.items.map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "var(--bg-sunken)",
                  }}
                >
                  {ev.has_crop ? (
                    <img
                      src={`/api/detection-events/${ev.id}/crop`}
                      alt={`event ${ev.id}`}
                      loading="lazy"
                      style={{
                        display: "block",
                        width: "100%",
                        aspectRatio: "1 / 1",
                        objectFit: "cover",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        aspectRatio: "1 / 1",
                        display: "grid",
                        placeItems: "center",
                        color: "var(--text-tertiary)",
                        fontSize: 11,
                      }}
                    >
                      no crop
                    </div>
                  )}
                  <div style={{ padding: "4px 6px" }}>
                    <div className="mono text-xs">
                      {new Date(ev.captured_at).toLocaleTimeString()}
                    </div>
                    <div className="text-xs text-dim">{ev.camera_name}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg-sunken)",
        borderRadius: 8,
      }}
    >
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div className="mono" style={{ fontSize: 15, fontWeight: 500, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-tertiary)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}
