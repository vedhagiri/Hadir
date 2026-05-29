// Clip Video Cleanup card — Admin-only.
//
// Three modes (Hours / Days / Range) with quick presets, an optional
// per-camera scope, plus an auto-cleanup toggle backed by
// ``tenant_settings.clip_retention_days``. The "Preview cleanup" action
// hands a frozen filter snapshot to ``ClipCleanupModal``; the modal
// does the impact preview + confirm + progress loop.
//
// Styling: design system classes only (.card, .seg, .btn, .pill,
// .filter-bar). No new CSS.

import { useMemo, useState } from "react";

import { extractApiError } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { useCameras } from "../cameras/hooks";
import { ClipCleanupModal } from "./ClipCleanupModal";
import {
  useClipRetentionSetting,
  useUpdateClipRetentionSetting,
} from "./hooks";
import type { ClipCleanupFilter, ClipCleanupMode } from "./types";

const HOUR_PRESETS: { value: number; label: string }[] = [
  { value: 1, label: "1 hour" },
  { value: 6, label: "6 hours" },
  { value: 12, label: "12 hours" },
  { value: 24, label: "24 hours" },
];

const DAY_PRESETS: { value: number; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
];

const RETENTION_PRESETS: { value: number | null; label: string }[] = [
  { value: null, label: "Off" },
  { value: 7, label: "7d" },
  { value: 30, label: "30d" },
  { value: 60, label: "60d" },
  { value: 90, label: "90d" },
];

function todayIso(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function aWeekAgoIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

export function ClipCleanupCard() {
  const cameras = useCameras();
  const retention = useClipRetentionSetting();
  const updateRetention = useUpdateClipRetentionSetting();

  const [mode, setMode] = useState<ClipCleanupMode>("days");
  const [hours, setHours] = useState<number>(6);
  const [days, setDays] = useState<number>(30);
  const [startDate, setStartDate] = useState<string>(aWeekAgoIso());
  const [endDate, setEndDate] = useState<string>(todayIso());
  const [cameraId, setCameraId] = useState<number | null>(null);

  const [pendingFilter, setPendingFilter] = useState<ClipCleanupFilter | null>(
    null,
  );

  const filter = useMemo<ClipCleanupFilter>(() => {
    const base: ClipCleanupFilter = {};
    if (cameraId !== null) base.camera_id = cameraId;
    if (mode === "hours") base.older_than_hours = hours;
    if (mode === "days") base.older_than_days = days;
    if (mode === "range") {
      base.start_date = startDate;
      base.end_date = endDate;
    }
    return base;
  }, [mode, hours, days, startDate, endDate, cameraId]);

  const rangeInvalid =
    mode === "range" && (!startDate || !endDate || startDate > endDate);

  const handlePreview = () => {
    setPendingFilter(filter);
  };

  const handleClose = () => setPendingFilter(null);

  const setRetention = (val: number | null) => {
    updateRetention.mutate({ clip_retention_days: val });
  };

  const currentRetention = retention.data?.clip_retention_days ?? null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Clip Video Cleanup</div>
          <div className="card-sub">
            Reclaim raw video files. Face crops, attendance evidence and
            reference photos are unaffected.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {retention.isLoading ? (
            <span className="pill pill-neutral">…</span>
          ) : currentRetention !== null ? (
            <span
              className="pill pill-success"
              title={`Sweep auto-deletes clips older than ${currentRetention} days every 03:00.`}
            >
              <span className="pill-dot" />
              Auto · {currentRetention}d
            </span>
          ) : (
            <span
              className="pill pill-neutral"
              title="Automatic cleanup is off. Use the form below for a one-shot reclaim."
            >
              Auto · off
            </span>
          )}
        </div>
      </div>

      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Mode segment */}
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <div className="filter-group">
            <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>
              Cleanup mode
            </span>
            <div className="seg" role="group" aria-label="Cleanup mode">
              <button
                type="button"
                className={`seg-btn${mode === "hours" ? " active" : ""}`}
                onClick={() => setMode("hours")}
                aria-pressed={mode === "hours"}
              >
                Hours
              </button>
              <button
                type="button"
                className={`seg-btn${mode === "days" ? " active" : ""}`}
                onClick={() => setMode("days")}
                aria-pressed={mode === "days"}
              >
                Days
              </button>
              <button
                type="button"
                className={`seg-btn${mode === "range" ? " active" : ""}`}
                onClick={() => setMode("range")}
                aria-pressed={mode === "range"}
              >
                Date range
              </button>
            </div>
          </div>

          <div className="filter-group">
            <Icon name="camera" size={13} style={{ color: "var(--text-tertiary)" }} />
            <select
              value={cameraId ?? ""}
              onChange={(e) =>
                setCameraId(e.target.value === "" ? null : Number(e.target.value))
              }
              style={{
                fontSize: 12.5,
                padding: "3px 8px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-elev)",
                color: "var(--text)",
              }}
              aria-label="Camera scope"
            >
              <option value="">All cameras</option>
              {cameras.data?.items.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Per-mode body */}
        {mode === "hours" && (
          <div>
            <div className="seg" role="group" aria-label="Hour presets" style={{ display: "inline-flex" }}>
              {HOUR_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className={`seg-btn${hours === p.value ? " active" : ""}`}
                  onClick={() => setHours(p.value)}
                  aria-pressed={hours === p.value}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 6 }}>
              Delete clips older than {hours} hour{hours === 1 ? "" : "s"}.
            </div>
          </div>
        )}

        {mode === "days" && (
          <div>
            <div className="seg" role="group" aria-label="Day presets" style={{ display: "inline-flex" }}>
              {DAY_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className={`seg-btn${days === p.value ? " active" : ""}`}
                  onClick={() => setDays(p.value)}
                  aria-pressed={days === p.value}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 6 }}>
              Delete clips older than {days} day{days === 1 ? "" : "s"}.
            </div>
          </div>
        )}

        {mode === "range" && (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500 }}>
                From
              </span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                max={endDate || undefined}
                style={{
                  fontSize: 12.5,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: `1px solid ${rangeInvalid ? "var(--danger)" : "var(--border)"}`,
                  background: "var(--bg-elev)",
                  color: "var(--text)",
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500 }}>
                To
              </span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate || undefined}
                style={{
                  fontSize: 12.5,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: `1px solid ${rangeInvalid ? "var(--danger)" : "var(--border)"}`,
                  background: "var(--bg-elev)",
                  color: "var(--text)",
                }}
              />
            </label>
            {rangeInvalid && (
              <span
                role="alert"
                style={{ fontSize: 11.5, color: "var(--danger-text)" }}
              >
                Start date must be on or before the end date.
              </span>
            )}
          </div>
        )}

        {/* Auto-retention toggle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
          }}
        >
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>
              Automatic clip retention
            </div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
              When enabled, the 03:00 sweep reclaims clip videos older than
              the chosen window.
            </div>
            {updateRetention.isError && (
              <div
                role="alert"
                style={{ fontSize: 11.5, color: "var(--danger-text)", marginTop: 4 }}
              >
                {extractApiError(updateRetention.error, "Could not save")}
              </div>
            )}
          </div>
          <div className="seg" role="group" aria-label="Auto retention window" style={{ flexShrink: 0 }}>
            {RETENTION_PRESETS.map((p) => (
              <button
                key={String(p.value)}
                type="button"
                className={`seg-btn${currentRetention === p.value ? " active" : ""}`}
                onClick={() => setRetention(p.value)}
                aria-pressed={currentRetention === p.value}
                disabled={updateRetention.isPending}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Preview action */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handlePreview}
            disabled={rangeInvalid}
            aria-label="Preview clip cleanup impact"
          >
            <Icon name="trash" size={13} />
            Preview cleanup
          </button>
        </div>
      </div>

      {pendingFilter !== null && (
        <ClipCleanupModal filter={pendingFilter} onClose={handleClose} />
      )}
    </div>
  );
}
