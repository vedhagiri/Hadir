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
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { useCameras } from "../cameras/hooks";
import { ClipCleanupModal } from "./ClipCleanupModal";
import {
  useClipRetentionSetting,
  useUpdateClipRetentionSetting,
} from "./hooks";
import type { ClipCleanupFilter, ClipCleanupMode } from "./types";

const HOUR_PRESETS: number[] = [1, 6, 12, 24];
const DAY_PRESETS: number[] = [7, 30, 60, 90];
const RETENTION_PRESETS: (number | null)[] = [null, 7, 30, 60, 90];

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
  const { t } = useTranslation();
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
          <div className="card-title">{t("clipCleanup.title") as string}</div>
          <div className="card-sub">
            {t("clipCleanup.subtitle") as string}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {retention.isLoading ? (
            <span className="pill pill-neutral">…</span>
          ) : currentRetention !== null ? (
            <span
              className="pill pill-success"
              title={t("clipCleanup.autoTooltip", { days: currentRetention }) as string}
            >
              <span className="pill-dot" />
              {t("clipCleanup.autoBadge", { days: currentRetention }) as string}
            </span>
          ) : (
            <span
              className="pill pill-neutral"
              title={t("clipCleanup.autoOffTooltip") as string}
            >
              {t("clipCleanup.autoOff") as string}
            </span>
          )}
        </div>
      </div>

      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Mode segment */}
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <div className="filter-group">
            <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>
              {t("clipCleanup.mode") as string}
            </span>
            <div className="seg" role="group" aria-label={t("clipCleanup.mode") as string}>
              <button
                type="button"
                className={`seg-btn${mode === "hours" ? " active" : ""}`}
                onClick={() => setMode("hours")}
                aria-pressed={mode === "hours"}
              >
                {t("clipCleanup.modeHours") as string}
              </button>
              <button
                type="button"
                className={`seg-btn${mode === "days" ? " active" : ""}`}
                onClick={() => setMode("days")}
                aria-pressed={mode === "days"}
              >
                {t("clipCleanup.modeDays") as string}
              </button>
              <button
                type="button"
                className={`seg-btn${mode === "range" ? " active" : ""}`}
                onClick={() => setMode("range")}
                aria-pressed={mode === "range"}
              >
                {t("clipCleanup.modeRange") as string}
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
              aria-label={t("clipCleanup.cameraScope") as string}
            >
              <option value="">{t("clipCleanup.allCameras") as string}</option>
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
            <div className="seg" role="group" aria-label={t("clipCleanup.hourPresetsAria") as string} style={{ display: "inline-flex" }}>
              {HOUR_PRESETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`seg-btn${hours === value ? " active" : ""}`}
                  onClick={() => setHours(value)}
                  aria-pressed={hours === value}
                >
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
                <button
                  key={value}
                  type="button"
                  className={`seg-btn${days === value ? " active" : ""}`}
                  onClick={() => setDays(value)}
                  aria-pressed={days === value}
                >
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
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500 }}>
                {t("clipCleanup.from") as string}
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
                {t("clipCleanup.to") as string}
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
                {t("clipCleanup.rangeInvalid") as string}
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
              {t("clipCleanup.autoTitle") as string}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
              {t("clipCleanup.autoDesc") as string}
            </div>
            {updateRetention.isError && (
              <div
                role="alert"
                style={{ fontSize: 11.5, color: "var(--danger-text)", marginTop: 4 }}
              >
                {extractApiError(updateRetention.error, t("clipCleanup.couldNotSave") as string)}
              </div>
            )}
          </div>
          <div className="seg" role="group" aria-label={t("clipCleanup.autoWindowAria") as string} style={{ flexShrink: 0 }}>
            {RETENTION_PRESETS.map((value) => (
              <button
                key={String(value)}
                type="button"
                className={`seg-btn${currentRetention === value ? " active" : ""}`}
                onClick={() => setRetention(value)}
                aria-pressed={currentRetention === value}
                disabled={updateRetention.isPending}
              >
                {value === null ? (t("clipCleanup.retentionOff") as string) : `${value}d`}
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
            aria-label={t("clipCleanup.previewAria") as string}
          >
            <Icon name="trash" size={13} />
            {t("clipCleanup.preview") as string}
          </button>
        </div>
      </div>

      {pendingFilter !== null && (
        <ClipCleanupModal filter={pendingFilter} onClose={handleClose} />
      )}
    </div>
  );
}
