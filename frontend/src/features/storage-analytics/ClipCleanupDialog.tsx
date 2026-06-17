// Clip Video Cleanup — manual one-shot reclaim popup (Admin-only).
//
// Reclaim raw clip videos by Hours / Days / Range + camera scope, handing a
// frozen filter to ``ClipCleanupModal`` for the preview + confirm + run loop.
// The auto-delete-after-processing toggle lives on the Storage Analytics page
// itself (outside this popup); scheduled retention sweep was removed.
//
// Styling: design-system classes only (.card, .seg, .btn, .filter-bar). No
// new CSS.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useCameras } from "../cameras/hooks";
import { ClipCleanupModal } from "./ClipCleanupModal";
import { DateRangePicker } from "./DateRangePicker";
import type { ClipCleanupFilter, ClipCleanupMode } from "./types";

const HOUR_PRESETS: number[] = [1, 6, 12, 24];
const DAY_PRESETS: number[] = [7, 30, 60, 90];

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

interface Props {
  onClose: () => void;
}

export function ClipCleanupDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const cameras = useCameras();

  const [mode, setMode] = useState<ClipCleanupMode>("days");
  const [hours, setHours] = useState<number>(6);
  const [days, setDays] = useState<number>(30);
  const [startDate, setStartDate] = useState<string>(aWeekAgoIso());
  const [endDate, setEndDate] = useState<string>(todayIso());
  const [cameraId, setCameraId] = useState<number | null>(null);

  // Manual cleanup → preview/run modal handoff.
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

  // Esc to close (only when the run modal isn't on top of us).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && pendingFilter === null) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pendingFilter]);

  // During preview/run, show ONLY the run modal — not stacked on the dialog
  // (which would double the "Clip Video Cleanup" header). Closing it returns here.
  if (pendingFilter !== null) {
    return (
      <ClipCleanupModal filter={pendingFilter} onClose={() => setPendingFilter(null)} />
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("clipCleanup.title") as string}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pendingFilter === null) onClose();
      }}
    >
      <div
        className="card"
        style={{ width: "min(540px, 100%)", maxHeight: "90vh", overflowY: "auto", margin: 0 }}
      >
        {/* Header */}
        <div className="card-head" style={{ alignItems: "center" }}>
          <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="trash" size={16} />
            {t("clipCleanup.title") as string}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label={t("common.close") as string}
            style={{ padding: "4px 8px" }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {t("clipCleanup.manualIntro") as string}
          </div>

          {/* Mode + camera scope */}
          <div className="filter-bar" style={{ marginBottom: 0 }}>
            <div className="filter-group">
              <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>
                {t("clipCleanup.mode") as string}
              </span>
              <div className="seg" role="group" aria-label={t("clipCleanup.mode") as string}>
                <button type="button" className={`seg-btn${mode === "hours" ? " active" : ""}`} onClick={() => setMode("hours")} aria-pressed={mode === "hours"}>
                  {t("clipCleanup.modeHours") as string}
                </button>
                <button type="button" className={`seg-btn${mode === "days" ? " active" : ""}`} onClick={() => setMode("days")} aria-pressed={mode === "days"}>
                  {t("clipCleanup.modeDays") as string}
                </button>
                <button type="button" className={`seg-btn${mode === "range" ? " active" : ""}`} onClick={() => setMode("range")} aria-pressed={mode === "range"}>
                  {t("clipCleanup.modeRange") as string}
                </button>
              </div>
            </div>

            <div className="filter-group">
              <Icon name="camera" size={13} style={{ color: "var(--text-tertiary)" }} />
              <select
                value={cameraId ?? ""}
                onChange={(e) => setCameraId(e.target.value === "" ? null : Number(e.target.value))}
                style={{
                  fontSize: 12.5,
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg-elev)",
                  color: "var(--text)",
                }}
                aria-label={t("clipCleanup.cameraScope") as string}
              >
                <option value="">{t("clipCleanup.allCameras") as string}</option>
                {cameras.data?.items.map((cam) => (
                  <option key={cam.id} value={cam.id}>{cam.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Per-mode body */}
          {mode === "hours" && (
            <div>
              <div className="seg" role="group" aria-label={t("clipCleanup.hourPresetsAria") as string} style={{ display: "inline-flex" }}>
                {HOUR_PRESETS.map((value) => (
                  <button key={value} type="button" className={`seg-btn${hours === value ? " active" : ""}`} onClick={() => setHours(value)} aria-pressed={hours === value}>
                    {t("clipCleanup.hoursPreset", { count: value }) as string}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 6 }}>
                {t("clipCleanup.deleteOlderHours", { count: hours }) as string}
              </div>
            </div>
          )}

          {mode === "days" && (
            <div>
              <div className="seg" role="group" aria-label={t("clipCleanup.dayPresetsAria") as string} style={{ display: "inline-flex" }}>
                {DAY_PRESETS.map((value) => (
                  <button key={value} type="button" className={`seg-btn${days === value ? " active" : ""}`} onClick={() => setDays(value)} aria-pressed={days === value}>
                    {t("clipCleanup.daysPreset", { count: value }) as string}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 6 }}>
                {t("clipCleanup.deleteOlderDays", { count: days }) as string}
              </div>
            </div>
          )}

          {mode === "range" && (
            <div>
              <DateRangePicker
                start={startDate}
                end={endDate}
                maxDate={todayIso()}
                onChange={(s, e) => {
                  setStartDate(s);
                  setEndDate(e);
                }}
              />
            </div>
          )}

          {/* Footer */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              {t("common.cancel") as string}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setPendingFilter(filter)}
              disabled={rangeInvalid}
              aria-label={t("clipCleanup.previewAria") as string}
            >
              <Icon name="trash" size={13} />
              {t("clipCleanup.preview") as string}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
