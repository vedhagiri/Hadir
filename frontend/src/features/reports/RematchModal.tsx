// Admin-only modal that drives ``POST /api/identification/rematch``.
// Replays past detection_events through the current matcher cache so
// newly-uploaded reference photos retroactively assign employee_id on
// historical events. Idempotent — operator can re-run the same date
// any number of times after each new photo upload.

import { useState } from "react";

import { api, ApiError } from "../../api/client";
import { DatePicker, todayIso } from "../../components/DatePicker";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";

interface Props {
  onClose: () => void;
}

interface RematchResult {
  events_scanned: number;
  matches_added: number;
  matches_changed: number;
  attendance_recomputed: number;
}

export function RematchModal({ onClose }: Props) {
  const [from, setFrom] = useState<string>(todayIso());
  const [to, setTo] = useState<string>(todayIso());
  const [onlyUnidentified, setOnlyUnidentified] = useState(true);
  const [recompute, setRecompute] = useState(true);
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<RematchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function runOnce() {
    setRunning(true);
    setErr(null);
    try {
      const result = await api<RematchResult>("/api/identification/rematch", {
        method: "POST",
        body: {
          from,
          to,
          only_unidentified: onlyUnidentified,
          recompute_attendance: recompute,
        },
      });
      setLast(result);
      toast.success(
        `Scanned ${result.events_scanned} · matched ${result.matches_added}` +
          (result.matches_changed > 0 ? ` · changed ${result.matches_changed}` : "") +
          (recompute && result.attendance_recomputed > 0
            ? ` · recomputed ${result.attendance_recomputed} attendance row${result.attendance_recomputed === 1 ? "" : "s"}`
            : ""),
      );
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : "Network error";
      setErr(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Re-match detections"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 80,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md, 10px)",
          boxShadow:
            "0 12px 40px rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.1)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              Re-match detections
            </div>
            <div className="text-xs text-dim" style={{ marginTop: 2 }}>
              Replay past camera events against the current reference
              photos. Re-run as many times as you need.
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label
              className="text-xs text-dim"
              style={{ display: "block", marginBottom: 6, fontWeight: 500 }}
            >
              Date range
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <DatePicker
                value={from}
                onChange={(next) => {
                  setFrom(next);
                  if (to < next) setTo(next);
                }}
                max={todayIso()}
                ariaLabel="From date"
              />
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-tertiary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                →
              </span>
              <DatePicker
                value={to}
                onChange={setTo}
                min={from}
                max={todayIso()}
                ariaLabel="To date"
              />
            </div>
          </div>

          <label
            style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={onlyUnidentified}
              onChange={(e) => setOnlyUnidentified(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ fontSize: 13 }}>
              Only unidentified events
              <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                Skip events that already have an employee assigned. Turn
                off to also re-evaluate identified rows (e.g. after
                replacing a wrong reference photo).
              </div>
            </span>
          </label>

          <label
            style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={recompute}
              onChange={(e) => setRecompute(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ fontSize: 13 }}>
              Recompute attendance for affected days
              <div className="text-xs text-dim" style={{ marginTop: 2 }}>
                After matches change, regenerate the day's attendance
                rows so newly-identified events flow into reports.
              </div>
            </span>
          </label>

          {last && (
            <div
              style={{
                padding: "10px 12px",
                background: "var(--bg-sunken)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "4px 16px",
              }}
            >
              <span className="text-dim">Events scanned</span>
              <span className="mono">{last.events_scanned}</span>
              <span className="text-dim">Matches added</span>
              <span className="mono" style={{ color: "var(--success)" }}>
                {last.matches_added}
              </span>
              <span className="text-dim">Matches changed</span>
              <span className="mono">{last.matches_changed}</span>
              <span className="text-dim">Attendance rows recomputed</span>
              <span className="mono">{last.attendance_recomputed}</span>
            </div>
          )}

          {err && (
            <div
              className="text-sm"
              style={{
                color: "var(--danger-text)",
                padding: "8px 10px",
                background: "var(--danger-soft)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {err}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span className="text-xs text-dim">
            {from === to ? `1 day · ${from}` : `${from} → ${to}`}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runOnce()}
              disabled={running}
            >
              {running ? "Running…" : last ? "Run again" : "Run"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
