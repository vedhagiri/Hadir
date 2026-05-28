/**
 * Unidentified Faces — gallery of clustered unknown face detections.
 *
 * Performance strategy:
 *  - Browser-native `loading="lazy"` on every <img> — zero JS overhead for lazy loading.
 *  - `placeholderData` keeps the previous page visible while the next loads.
 *  - Threshold/minCount inputs are debounced (400 ms) so clustering only reruns after the
 *    user stops adjusting, not on every slider tick.
 *  - Cluster data is cached for 60 s so navigating between pages is instant.
 *  - Skeleton cards match the exact card dimensions so layout doesn't shift on load.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DatePicker } from "../../components/DatePicker";
import { Icon } from "../../shell/Icon";
import type { EmployeeListFilters } from "../employees/hooks";
import { useEmployeeList } from "../employees/hooks";
import type { Employee } from "../employees/types";
import {
  useCameraList,
  useClusterEvents,
  useMapToEmployee,
  useMappedClusters,
  useMappedFaces,
  useRawUnidentifiedFaces,
  useUnidentifiedFaceClusters,
} from "./hooks";
import type {
  FaceClusterOut,
  MappedEmployeeGroupOut,
  MappedFaceEventOut,
  MapToEmployeeResponse,
  PhotoAssignment,
  RawFaceEventOut,
  RawUnidentifiedFilters,
  UnidentifiedFacesFilters,
} from "./types";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.65;
const DEFAULT_MIN_COUNT = 1;
const PAGE_SIZE = 24;
const DEBOUNCE_MS = 400;

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function defaultStart(): string {
  // Default range = today only. Operators expect to triage the day's
  // detections by default; older days are one click away via the picker.
  return todayIso();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Styles injected once ───────────────────────────────────────────────────

const INJECTED_STYLE = `
@keyframes unid-shimmer {
  0%   { background-position: -400px 0; }
  100% { background-position:  400px 0; }
}
@keyframes unid-fadein {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes unid-toolbar-up {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.unid-skeleton {
  background: linear-gradient(90deg, var(--bg-sunken) 25%, var(--bg-hover) 50%, var(--bg-sunken) 75%);
  background-size: 800px 100%;
  animation: unid-shimmer 1.4s infinite linear;
  border-radius: var(--radius-sm);
}
.unid-card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s, box-shadow 0.15s;
  animation: unid-fadein 0.18s ease both;
  position: relative;
}
.unid-card:hover {
  border-color: var(--accent-border);
  box-shadow: 0 2px 12px rgba(0,0,0,0.08);
}
.unid-card.unid-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}
.unid-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.unid-checkbox {
  position: absolute;
  top: 7px;
  inset-inline-start: 7px;
  z-index: 2;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  border: 2px solid rgba(255,255,255,0.85);
  background: rgba(0,0,0,0.38);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, border-color 0.12s, opacity 0.12s;
  opacity: 0;
  cursor: pointer;
  flex-shrink: 0;
  box-shadow: 0 1px 4px rgba(0,0,0,0.28);
}
.unid-card:hover .unid-checkbox,
.unid-card.unid-selected .unid-checkbox,
.unid-select-mode .unid-checkbox {
  opacity: 1;
}
.unid-checkbox.unid-checked {
  background: var(--accent, #000);
  border-color: var(--accent, #000);
  opacity: 1;
}
.unid-emp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.1s;
}
.unid-emp-row:hover, .unid-emp-row:focus-visible {
  background: var(--bg-hover);
  outline: none;
}
.unid-drawer-img {
  position: relative;
  display: block;
}
.unid-drawer-img::after {
  content: "📷 Click to enlarge";
  position: absolute;
  bottom: 8px;
  inset-inline-end: 10px;
  font-size: 10px;
  color: #fff;
  background: rgba(0,0,0,0.55);
  border-radius: 4px;
  padding: 2px 7px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
}
.unid-drawer-img:hover::after {
  opacity: 1;
}
.unid-info-card {
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 13px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.unid-thumb-label {
  font-size: 9.5px;
  text-align: center;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
  max-width: 72px;
}
.unid-thresh-card {
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px 13px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.unid-thresh-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.unid-thresh-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.unid-thresh-badge {
  font-size: 22px;
  font-weight: 700;
  color: var(--accent, #000);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  min-width: 56px;
  text-align: end;
}
.unid-thresh-hint {
  font-size: 11.5px;
  color: var(--text-tertiary);
  line-height: 1.45;
  margin-top: -4px;
}
.unid-thresh-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 3px;
  outline: none;
  cursor: pointer;
  background: linear-gradient(to right, var(--accent, #000) var(--fill-pct, 37%), var(--bg-hover) var(--fill-pct, 37%));
}
.unid-thresh-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent, #000);
  border: 2.5px solid var(--bg-elev);
  box-shadow: 0 1px 5px rgba(0,0,0,0.25);
  cursor: pointer;
  transition: box-shadow 0.12s;
}
.unid-thresh-slider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent, #000);
  border: 2.5px solid var(--bg-elev);
  box-shadow: 0 1px 5px rgba(0,0,0,0.25);
  cursor: pointer;
}
.unid-thresh-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px var(--accent-border);
}
.unid-thresh-zones {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: -4px;
}
.unid-thresh-zone {
  font-size: 10px;
  color: var(--text-quaternary);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.unid-thresh-zone span:first-child {
  font-weight: 600;
  font-size: 10.5px;
  color: var(--text-tertiary);
}
.unid-timeline {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.unid-tl-day-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 6px;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
}
.unid-tl-day-header:first-child {
  margin-top: 0;
}
.unid-tl-day-line {
  flex: 1;
  height: 1px;
  background: var(--border);
}
.unid-tl-events {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-inline-start: 10px;
  border-inline-start: 2px solid var(--border);
  margin-inline-start: 5px;
}
.unid-tl-event {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 0 4px 12px;
  font-size: 12px;
}
.unid-tl-event::before {
  content: "";
  position: absolute;
  inset-inline-start: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent, #000);
  border: 2px solid var(--bg-elev);
  flex-shrink: 0;
}
.unid-tl-time {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  flex-shrink: 0;
  font-size: 11.5px;
}
.unid-tl-cam {
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}

/* ── In-cluster filter chips ───────────────────────────────────────── */
.unid-filterbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-top: 4px;
}
.unid-filterbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.unid-filterbar-label {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  min-width: 70px;
}
.unid-chip {
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.unid-chip:hover {
  border-color: var(--text);
}
.unid-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.unid-chip[aria-pressed="true"] {
  background: var(--text);
  border-color: var(--text);
  color: var(--bg);
  font-weight: 600;
}
.unid-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.unid-filterbar input[type="number"]::-webkit-outer-spin-button,
.unid-filterbar input[type="number"]::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* ── Timeline activity cards (P28.x redesign) ──────────────────────── */
.unid-tl-card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.unid-tl-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.unid-tl-card-date {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.unid-tl-card-date-main {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}
.unid-tl-card-date-sub {
  font-size: 10.5px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;
}
.unid-tl-card-count {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 11px;
  font-variant-numeric: tabular-nums;
}
.unid-tl-card-count-num {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.unid-tl-card-count-label {
  font-size: 10px;
  font-weight: 500;
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.unid-tl-card-events {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
@media (max-width: 540px) {
  .unid-tl-card-events { grid-template-columns: 1fr; }
}
.unid-tl-card-event {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  min-width: 0;
}
.unid-tl-card-event-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #000);
  flex-shrink: 0;
  opacity: 0.7;
}
.unid-tl-card-event-time {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 60px;
}
.unid-tl-card-event-cam {
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Hero time block ───────────────────────────────────────────────── */
.unid-time-hero {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  background: linear-gradient(135deg, var(--bg-sunken) 0%, var(--bg-elev) 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  gap: 12px;
}
.unid-time-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.unid-time-col-end {
  text-align: end;
}
.unid-time-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-tertiary);
}
.unid-time-value {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}
.unid-time-rel {
  font-size: 11px;
  color: var(--text-secondary);
}
.unid-time-arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--text-tertiary);
  gap: 3px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 8px;
  border-inline-start: 1px dashed var(--border);
  border-inline-end: 1px dashed var(--border);
}
.unid-time-arrow-icon {
  font-size: 14px;
  line-height: 1;
}
.unid-cam-activity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}
.unid-cam-bar-row {
  display: grid;
  grid-template-columns: minmax(80px, 28%) 1fr auto;
  gap: 10px;
  align-items: center;
  font-size: 11.5px;
}
.unid-cam-bar-name {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.unid-cam-bar-track {
  height: 6px;
  border-radius: 999px;
  background: var(--bg-sunken);
  overflow: hidden;
}
.unid-cam-bar-fill {
  height: 100%;
  background: var(--accent, #000);
  border-radius: 999px;
  transition: width 0.2s ease-out;
}
.unid-cam-bar-count {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text);
  font-size: 11.5px;
  min-width: 22px;
  text-align: end;
}

/* Cluster face gallery modal renders inline via element styles, mirroring
   FaceCropLightbox in PersonClipsPage. No dedicated CSS classes — kept
   intentionally so the two previews stay structurally identical. */
`;

// ── Skeleton card ──────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="unid-card" style={{ pointerEvents: "none" }}>
      <div className="unid-skeleton" style={{ aspectRatio: "1", width: "100%" }} />
      <div style={{ padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="unid-skeleton" style={{ height: 11, width: "60%" }} />
        <div className="unid-skeleton" style={{ height: 11, width: "80%" }} />
        <div className="unid-skeleton" style={{ height: 11, width: "40%" }} />
      </div>
    </div>
  );
}

// ── Cluster card ───────────────────────────────────────────────────────────

interface ClusterCardProps {
  cluster: FaceClusterOut;
  onOpen: (cluster: FaceClusterOut) => void;
}

function ClusterCard({ cluster, onOpen }: ClusterCardProps) {
  const { t } = useTranslation();
  const repId = cluster.representative_event_id;
  const [imgFailed, setImgFailed] = useState(false);
  const simPct = Math.round(cluster.avg_similarity * 100);

  // Quality breakdown for the small footer strip. Counts default to 0 when
  // backend hasn't sent the metadata (cached cluster from before P28.x).
  const qualityCounts = cluster.event_qualities.reduce(
    (acc, q) => {
      if (q === "high" || q === "medium" || q === "low") acc[q] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0 } as Record<"high" | "medium" | "low", number>,
  );
  const totalKnown = qualityCounts.high + qualityCounts.medium + qualityCounts.low;
  const pct = (n: number) =>
    totalKnown > 0 ? Math.max(2, Math.round((n / totalKnown) * 100)) : 0;

  return (
    <button
      className="unid-card"
      onClick={() => onOpen(cluster)}
      aria-label={t("unidentifiedFaces.clusterOf", "Cluster of {{count}} faces", {
        count: cluster.count,
      })}
    >
      {/* photo */}
      <div style={{ position: "relative", aspectRatio: "1", overflow: "hidden", background: "var(--bg-sunken)" }}>
        {!imgFailed ? (
          <img
            src={`/api/detection-events/${repId}/crop`}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="user" size={32} style={{ opacity: 0.2 }} />
          </div>
        )}

        {/* count — primary signal, top-right */}
        <div
          style={{
            position: "absolute",
            top: 8,
            insetInlineEnd: 8,
            background: "rgba(0,0,0,0.78)",
            color: "#fff",
            borderRadius: "var(--radius-sm)",
            padding: "4px 10px",
            display: "flex",
            alignItems: "baseline",
            gap: 4,
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
          }}
        >
          <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
            {cluster.count}
          </span>
          <span style={{ fontSize: 10, opacity: 0.78, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            {cluster.count === 1
              ? t("unidentifiedFaces.faceShort", "face")
              : t("unidentifiedFaces.facesShort", "faces")}
          </span>
        </div>

        {/* similarity badge — top-left, lower-key now that count is hero */}
        <div
          style={{
            position: "absolute",
            top: 8,
            insetInlineStart: 8,
            background: "rgba(255,255,255,0.92)",
            color: "var(--text)",
            borderRadius: 999,
            fontSize: 10.5,
            fontWeight: 600,
            padding: "2.5px 8px",
            letterSpacing: "0.02em",
            display: "flex",
            alignItems: "center",
            gap: 4,
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background:
                simPct >= 80 ? "#22c55e" : simPct >= 65 ? "#f59e0b" : "#ef4444",
              flexShrink: 0,
            }}
          />
          {simPct}%
        </div>

        {/* crops available indicator — bottom-left */}
        {cluster.crop_event_ids.length > 0 && cluster.crop_event_ids.length < cluster.count && (
          <div style={{
            position: "absolute",
            bottom: 8,
            insetInlineStart: 8,
            background: "rgba(0,0,0,0.6)",
            color: "#fff",
            borderRadius: 4,
            fontSize: 10,
            padding: "2px 6px",
            display: "flex",
            alignItems: "center",
            gap: 3,
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
          }}>
            <Icon name="camera" size={9} />
            {cluster.crop_event_ids.length}
          </div>
        )}
      </div>

      {/* metadata footer */}
      <div style={{
        padding: "9px 11px 10px",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 5,
        background: "var(--bg-elev)",
      }}>
        <div style={{
          fontSize: 11.5,
          color: "var(--text-secondary)",
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}>
          <Icon name="clock" size={11} style={{ flexShrink: 0, opacity: 0.7 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fmtDate(cluster.last_seen)}
          </span>
        </div>
        <div style={{
          fontSize: 11.5,
          color: "var(--text-secondary)",
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}>
          <Icon name="camera" size={11} style={{ flexShrink: 0, opacity: 0.7 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cluster.camera_names[0] ?? "—"}
            {cluster.camera_names.length > 1 && (
              <span style={{ color: "var(--text-tertiary)" }}> +{cluster.camera_names.length - 1}</span>
            )}
          </span>
        </div>

        {/* Quality distribution strip — only when backend sent qualities. */}
        {totalKnown > 0 && (
          <div
            aria-label={t("unidentifiedFaces.qualityDistribution", "Image quality distribution")}
            title={t(
              "unidentifiedFaces.qualityTooltip",
              "{{h}} high · {{m}} medium · {{l}} low",
              {
                h: qualityCounts.high,
                m: qualityCounts.medium,
                l: qualityCounts.low,
              },
            )}
            style={{
              display: "flex",
              height: 4,
              borderRadius: 999,
              overflow: "hidden",
              background: "var(--bg-sunken)",
              marginTop: 2,
            }}
          >
            {qualityCounts.high > 0 && (
              <div style={{ width: `${pct(qualityCounts.high)}%`, background: "#22c55e" }} />
            )}
            {qualityCounts.medium > 0 && (
              <div style={{ width: `${pct(qualityCounts.medium)}%`, background: "#f59e0b" }} />
            )}
            {qualityCounts.low > 0 && (
              <div style={{ width: `${pct(qualityCounts.low)}%`, background: "#94a3b8" }} />
            )}
          </div>
        )}
      </div>
    </button>
  );
}

// ── Map to Employee modal ──────────────────────────────────────────────────

type MapAngle = "front" | "left" | "right" | "other";

interface MapToEmployeeModalProps {
  cluster: FaceClusterOut;
  onClose: () => void;
  onSuccess: (result: MapToEmployeeResponse) => void;
}

interface PhotoSelectionState {
  event_id: number;
  selected: boolean;
  angle: MapAngle;
}

function MapToEmployeeModal({ cluster, onClose, onSuccess }: MapToEmployeeModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"search" | "confirm" | "done">("search");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selected, setSelected] = useState<Employee | null>(null);
  const [result, setResult] = useState<MapToEmployeeResponse | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Per-photo selection state: initialised when entering confirm step
  const [photoSelections, setPhotoSelections] = useState<PhotoSelectionState[]>([]);

  const mapMutation = useMapToEmployee();

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Auto-focus search input when modal opens
  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 60);
  }, []);

  const empFilters: EmployeeListFilters = {
    q: debouncedQ,
    department_id: null,
    include_inactive: false,
    page: 1,
    page_size: 15,
  };
  const empSearch = useEmployeeList(empFilters);

  const enterConfirm = (emp: Employee) => {
    setSelected(emp);
    // Initialise photo selection: all crops selected by default, all "front"
    setPhotoSelections(
      cluster.crop_event_ids.map((id) => ({
        event_id: id,
        selected: true,
        angle: "front" as MapAngle,
      }))
    );
    setStep("confirm");
  };

  const togglePhoto = (event_id: number) => {
    setPhotoSelections((prev) =>
      prev.map((p) => (p.event_id === event_id ? { ...p, selected: !p.selected } : p))
    );
  };

  const setPhotoAngle = (event_id: number, angle: MapAngle) => {
    setPhotoSelections((prev) =>
      prev.map((p) => (p.event_id === event_id ? { ...p, angle } : p))
    );
  };

  const selectedPhotos = photoSelections.filter((p) => p.selected);

  const handleConfirm = async () => {
    if (!selected) return;
    const photoAssignments: PhotoAssignment[] = selectedPhotos.map((p) => ({
      event_id: p.event_id,
      angle: p.angle,
    }));
    try {
      const res = await mapMutation.mutateAsync({
        employee_id: selected.id,
        event_ids: cluster.event_ids,
        photo_assignments: photoAssignments,
      });
      setResult(res);
      setStep("done");
      onSuccess(res);
    } catch {
      // Error shown via mapMutation.isError
    }
  };

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const ANGLES: MapAngle[] = ["front", "left", "right", "other"];
  const ANGLE_LABELS: Record<MapAngle, string> = {
    front: t("unidentifiedFaces.mapModal.angleFront", "Front"),
    left: t("unidentifiedFaces.mapModal.angleLeft", "Left"),
    right: t("unidentifiedFaces.mapModal.angleRight", "Right"),
    other: t("unidentifiedFaces.mapModal.angleOther", "Other"),
  };

  return (
    <>
      {/* backdrop */}
      <div
        role="presentation"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 499,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("unidentifiedFaces.mapModal.title", "Map to Employee")}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 500,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            pointerEvents: "auto",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 40px rgba(0,0,0,0.2)",
            width: "min(480px, 92vw)",
            maxHeight: "80vh",
            display: "flex",
            flexDirection: "column",
            animation: "unid-fadein 0.15s ease both",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* modal header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>
                {step === "done"
                  ? t("unidentifiedFaces.mapModal.successTitle", "Mapping Complete")
                  : step === "confirm"
                  ? t("unidentifiedFaces.mapModal.confirmTitle", "Confirm Mapping")
                  : t("unidentifiedFaces.mapModal.title", "Map to Employee")}
              </div>
              {step !== "done" && (
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
                  {t("unidentifiedFaces.clusterOf", "Cluster of {{count}} faces", { count: cluster.count })}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="btn btn-sm"
              aria-label={t("common.close", "Close")}
              style={{ padding: "4px 8px", flexShrink: 0 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          {/* ── Step 1: Search ── */}
          {step === "search" && (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                <input
                  ref={searchRef}
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={t("unidentifiedFaces.mapModal.searchPlaceholder", "Search by name or employee code…")}
                  style={{
                    width: "100%",
                    padding: "7px 10px",
                    fontSize: 13,
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-sunken)",
                    color: "var(--text)",
                    fontFamily: "var(--font-sans)",
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
                {empSearch.isLoading && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 2px" }}>
                    {[100, 80, 90].map((w) => (
                      <div key={w} className="unid-skeleton" style={{ height: 40, borderRadius: "var(--radius-sm)" }} />
                    ))}
                  </div>
                )}
                {!empSearch.isLoading && empSearch.data?.items.length === 0 && (
                  <div style={{ textAlign: "center", padding: "28px 0", color: "var(--text-tertiary)", fontSize: 13 }}>
                    {debouncedQ
                      ? t("unidentifiedFaces.mapModal.noResults", "No employees found")
                      : t("unidentifiedFaces.mapModal.searchHint", "Type to search employees")}
                  </div>
                )}
                {empSearch.data?.items.map((emp) => (
                  <button
                    key={emp.id}
                    className="unid-emp-row"
                    onClick={() => enterConfirm(emp)}
                    style={{ width: "100%", background: "none", border: "none", textAlign: "start", cursor: "pointer" }}
                  >
                    <div style={{
                      width: 34,
                      height: 34,
                      borderRadius: "50%",
                      background: "var(--bg-sunken)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      <Icon name="user" size={16} style={{ opacity: 0.4 }} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {emp.full_name}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                        {emp.employee_code}
                        {emp.department.name && (
                          <span style={{ marginInlineStart: 6 }}>· {emp.department.name}</span>
                        )}
                      </div>
                    </div>
                    <Icon name="chevronRight" size={14} style={{ marginInlineStart: "auto", flexShrink: 0, opacity: 0.4 }} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 2: Confirm — per-photo selection grid ── */}
          {step === "confirm" && selected && (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
                {/* selected employee chip */}
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  background: "var(--bg-sunken)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  marginBottom: 16,
                }}>
                  <Icon name="user" size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{selected.full_name}</span>
                  <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{selected.employee_code}</span>
                </div>

                {/* Photo selection section */}
                {photoSelections.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginBottom: 14 }}>
                    {t("unidentifiedFaces.mapModal.noCropsToAdd", "No face crops available. Events will be attributed without adding reference photos.")}
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-tertiary)", marginBottom: 10 }}>
                      {t("unidentifiedFaces.mapModal.selectPhotos", "Select reference photos to add")}
                      <span style={{ fontWeight: 400, marginInlineStart: 6, fontSize: 11 }}>
                        {t("unidentifiedFaces.mapModal.selectPhotosHint", "{{selected}} of {{total}} selected", {
                          selected: selectedPhotos.length,
                          total: photoSelections.length,
                        })}
                      </span>
                    </div>
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
                      gap: 8,
                      marginBottom: 16,
                    }}>
                      {photoSelections.map((ps) => (
                        <div
                          key={ps.event_id}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            opacity: ps.selected ? 1 : 0.45,
                            transition: "opacity 0.15s",
                          }}
                        >
                          {/* thumbnail with checkbox overlay */}
                          <div
                            style={{ position: "relative", cursor: "pointer" }}
                            onClick={() => togglePhoto(ps.event_id)}
                          >
                            <img
                              src={`/api/detection-events/${ps.event_id}/crop`}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              style={{
                                width: "100%",
                                aspectRatio: "1",
                                objectFit: "cover",
                                display: "block",
                                borderRadius: "var(--radius-sm)",
                                border: ps.selected
                                  ? "2px solid var(--accent)"
                                  : "2px solid var(--border)",
                              }}
                            />
                            <div style={{
                              position: "absolute",
                              top: 4,
                              insetInlineEnd: 4,
                              width: 16,
                              height: 16,
                              borderRadius: 3,
                              background: ps.selected ? "var(--accent)" : "rgba(0,0,0,0.5)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              transition: "background 0.1s",
                            }}>
                              {ps.selected && (
                                <Icon name="check" size={10} style={{ color: "#fff" }} />
                              )}
                            </div>
                          </div>
                          {/* angle selector — only when selected */}
                          {ps.selected && (
                            <select
                              value={ps.angle}
                              onChange={(e) => setPhotoAngle(ps.event_id, e.target.value as MapAngle)}
                              aria-label={t("unidentifiedFaces.mapModal.angle", "Photo angle")}
                              style={{
                                fontSize: 11,
                                padding: "2px 4px",
                                border: "1px solid var(--border)",
                                borderRadius: 3,
                                background: "var(--bg-elev)",
                                color: "var(--text)",
                                fontFamily: "var(--font-sans)",
                                width: "100%",
                              }}
                            >
                              {ANGLES.map((a) => (
                                <option key={a} value={a}>{ANGLE_LABELS[a]}</option>
                              ))}
                            </select>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* attribution summary */}
                <div style={{
                  background: "var(--bg-sunken)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  padding: "10px 12px",
                  fontSize: 12.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}>
                  <Icon name="check" size={12} style={{ color: "var(--success, #22c55e)", flexShrink: 0 }} />
                  <span>
                    {t("unidentifiedFaces.mapModal.willMapEvents", "Will attribute {{count}} detection event(s) to {{name}}", {
                      count: cluster.event_ids.length,
                      name: selected.full_name,
                    })}
                  </span>
                </div>

                {/* error state */}
                {mapMutation.isError && (
                  <div style={{
                    marginTop: 10,
                    padding: "10px 12px",
                    background: "var(--bg-danger-subtle, #fee2e2)",
                    border: "1px solid var(--border-danger, #fca5a5)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12.5,
                    color: "var(--text-danger, #dc2626)",
                  }}>
                    {t("unidentifiedFaces.mapModal.errorFailed", "Mapping failed. Please try again.")}
                  </div>
                )}
              </div>

              {/* footer */}
              <div style={{
                padding: "12px 18px",
                borderTop: "1px solid var(--border)",
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                flexShrink: 0,
              }}>
                <button
                  onClick={() => { setStep("search"); mapMutation.reset(); }}
                  className="btn btn-sm"
                  disabled={mapMutation.isPending}
                >
                  {t("unidentifiedFaces.mapModal.back", "Back")}
                </button>
                <button
                  onClick={() => { void handleConfirm(); }}
                  className="btn btn-sm btn-primary"
                  disabled={mapMutation.isPending}
                >
                  {mapMutation.isPending
                    ? t("unidentifiedFaces.mapModal.mapping", "Mapping…")
                    : t("unidentifiedFaces.mapModal.confirmBtn", "Confirm Mapping")}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Success ── */}
          {step === "done" && result && selected && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 24px", gap: 14 }}>
              <div style={{
                width: 52,
                height: 52,
                borderRadius: "50%",
                background: "var(--success-subtle, #dcfce7)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}>
                <Icon name="check" size={24} style={{ color: "var(--success, #16a34a)" }} />
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                  {t("unidentifiedFaces.mapModal.successTitle", "Mapping Complete")}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 320 }}>
                  {t("unidentifiedFaces.mapModal.successDetail",
                    "Marked {{events}} event(s) as identified and added {{photos}} reference photo(s) for {{name}}.",
                    {
                      events: result.mapped_events,
                      photos: result.photos_created,
                      name: selected.full_name,
                    }
                  )}
                </div>
              </div>
              <button onClick={onClose} className="btn btn-sm btn-primary" style={{ marginTop: 8 }}>
                {t("unidentifiedFaces.mapModal.done", "Done")}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}


// ── Cluster gallery modal ──────────────────────────────────────────────────
//
// Full-viewport modal opened when an operator clicks any crop in the
// cluster drawer. Mirrors the Clip Analytics image-preview pattern:
//   - stage (big image) + side panel (metadata) + thumb strip (navigate)
//   - arrow buttons + keyboard prev/next + Esc close
//   - metadata pulled from the cluster's parallel arrays so similarity /
//     quality / pose appear without a second request

const QUALITY_COLORS: Record<string, string> = {
  high: "#22c55e",
  medium: "#f59e0b",
  low: "#94a3b8",
  unknown: "var(--border)",
};

const POSE_COLORS: Record<string, string> = {
  front: "#3b82f6",
  side: "#a855f7",
  partial: "#f97316",
  unknown: "var(--border)",
};

function similarityColor(pct: number): string {
  if (pct >= 80) return "#22c55e";
  if (pct >= 65) return "#f59e0b";
  return "#ef4444";
}

interface ClusterGalleryModalProps {
  cluster: FaceClusterOut;
  /** Ordered list of event ids that are eligible to display (post-filter). */
  cropIds: number[];
  /** Lookup of camera_name keyed by camera_id for the metadata panel. */
  cameraNameLookup: Map<number, string>;
  /** Lookup of captured_at keyed by event_id (from useClusterEvents). */
  capturedAtLookup: Map<number, string>;
  /** Initial event id to display. Caller controls open-state via this. */
  initialEventId: number;
  onClose: () => void;
}

function ClusterGalleryModal({
  cluster,
  cropIds,
  cameraNameLookup,
  capturedAtLookup,
  initialEventId,
  onClose,
}: ClusterGalleryModalProps) {
  const { t } = useTranslation();

  // Per-event metadata map built once from the parallel arrays on the
  // cluster. event_ids/event_similarities/event_qualities/event_face_types
  // share index alignment by clustering invariant.
  const metaByEvent = (() => {
    const m = new Map<
      number,
      { similarity: number; quality: string; faceType: string }
    >();
    for (let i = 0; i < cluster.event_ids.length; i += 1) {
      const id = cluster.event_ids[i];
      if (id === undefined) continue;
      m.set(id, {
        similarity: cluster.event_similarities[i] ?? 0,
        quality: cluster.event_qualities[i] ?? "unknown",
        faceType: cluster.event_face_types[i] ?? "unknown",
      });
    }
    return m;
  })();

  // Active index within `cropIds`. Initialised to the index of the
  // caller-supplied event id; falls back to 0 if not found (e.g. filter
  // applied right before open and the event was filtered out — defensive).
  const initialIdx = Math.max(0, cropIds.indexOf(initialEventId));
  const [idx, setIdx] = useState(initialIdx);
  const activeId = cropIds[idx];
  const thumbStripRef = useRef<HTMLDivElement | null>(null);
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);

  const total = cropIds.length;
  const canPrev = idx > 0;
  const canNext = idx < total - 1;

  const goPrev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(
    () => setIdx((i) => Math.min(total - 1, i + 1)),
    [total],
  );

  // Keyboard nav: Esc closes, arrows page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [goPrev, goNext, onClose]);

  // Scroll active thumbnail into view as the user navigates.
  useEffect(() => {
    if (activeThumbRef.current) {
      activeThumbRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }, [idx]);

  if (activeId === undefined) return null;

  const meta = metaByEvent.get(activeId);
  const simPct = meta ? Math.round(meta.similarity * 100) : 0;
  const captured = capturedAtLookup.get(activeId);
  const isReference = activeId === cluster.representative_event_id;

  // Resolve camera for this event via the event meta fetch. If absent
  // (event metadata still loading) fall back to the cluster's first
  // camera name as a passable placeholder.
  const cameraName =
    (() => {
      // We don't have a direct event→camera map; loosely use the
      // cluster's first camera if there's only one.
      if (cluster.camera_names.length === 1) return cluster.camera_names[0];
      // Try to find via lookup; reuse the cameraNameLookup we receive.
      const cams = Array.from(cameraNameLookup.values());
      return cams.length > 0 ? cams[0] : null;
    })() ?? "—";

  const qualityLabel = meta
    ? meta.quality === "high"
      ? t("unidentifiedFaces.qualHigh", "High quality")
      : meta.quality === "medium"
        ? t("unidentifiedFaces.qualMed", "Medium quality")
        : meta.quality === "low"
          ? t("unidentifiedFaces.qualLow", "Low quality")
          : t("unidentifiedFaces.qualUnknown", "Quality unknown")
    : t("unidentifiedFaces.qualUnknown", "Quality unknown");

  const poseLabel = meta
    ? meta.faceType === "front"
      ? t("unidentifiedFaces.poseFront", "Front face")
      : meta.faceType === "side"
        ? t("unidentifiedFaces.poseSide", "Side face")
        : meta.faceType === "partial"
          ? t("unidentifiedFaces.posePartial", "Partial face")
          : t("unidentifiedFaces.poseUnknown", "Pose unknown")
    : t("unidentifiedFaces.poseUnknown", "Pose unknown");

  // Right-side compact drawer — anchored to the right edge of the viewport,
  // vertically centred. Same 3-area internal grid as FaceCropLightbox
  // (stage | panel ; strip strip) but sized for a lightweight review
  // workflow rather than a full-screen modal.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("unidentifiedFaces.galleryTitle", "Cluster face gallery")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 700,
        background: "rgba(2, 6, 23, 0.55)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        padding: 20,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        ref={thumbStripRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg)",
          borderRadius: 12,
          boxShadow: "0 18px 48px rgba(0,0,0,0.4)",
          width: "min(720px, 92vw)",
          maxHeight: "min(640px, 92vh)",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.05fr) minmax(260px, 1fr)",
          gridTemplateRows: "minmax(0, 1fr) auto",
          gridTemplateAreas: '"stage panel" "strip strip"',
          overflow: "hidden",
        }}
      >
        {/* Stage — fixed-size image box with prev/next + counter overlay */}
        <div
          style={{
            gridArea: "stage",
            position: "relative",
            background: "#0b1220",
            display: "grid",
            placeItems: "center",
            minHeight: 280,
            padding: 14,
          }}
        >
          <img
            key={activeId}
            src={`/api/detection-events/${activeId}/crop`}
            alt={t("unidentifiedFaces.faceAlt", "Unknown face")}
            style={{
              maxWidth: "100%",
              maxHeight: 340,
              objectFit: "contain",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              display: "block",
            }}
          />

          {total > 1 && (
            <>
              <button
                type="button"
                onClick={goPrev}
                disabled={!canPrev}
                aria-label={t("common.previous", "Previous")}
                style={{
                  position: "absolute",
                  left: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.10)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "#fff",
                  cursor: canPrev ? "pointer" : "default",
                  display: "grid",
                  placeItems: "center",
                  opacity: canPrev ? 1 : 0.3,
                }}
              >
                <Icon name="chevronLeft" size={16} />
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={!canNext}
                aria-label={t("common.next", "Next")}
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.10)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "#fff",
                  cursor: canNext ? "pointer" : "default",
                  display: "grid",
                  placeItems: "center",
                  opacity: canNext ? 1 : 0.3,
                }}
              >
                <Icon name="chevronRight" size={16} />
              </button>

              <div
                style={{
                  position: "absolute",
                  bottom: 10,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "rgba(0,0,0,0.5)",
                  color: "#fff",
                  fontSize: 10.5,
                  padding: "3px 9px",
                  borderRadius: 999,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {idx + 1} / {total}
              </div>
            </>
          )}
        </div>

        {/* Metadata panel — matches FaceCropLightbox structure */}
        <div
          style={{
            gridArea: "panel",
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            overflowY: "auto",
            background: "var(--bg)",
            borderInlineStart: "1px solid var(--border)",
          }}
        >
          {/* Reference / Detection chip + close */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 10px",
                borderRadius: 999,
                background: isReference
                  ? "rgba(59,130,246,0.15)"
                  : "rgba(34,197,94,0.15)",
                color: isReference ? "#2563eb" : "#16a34a",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {isReference
                ? t("unidentifiedFaces.referenceImage", "Reference")
                : t("unidentifiedFaces.detectionDetail", "Detection")}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              #{activeId}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close", "Close")}
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                fontSize: 22,
                lineHeight: 1,
                cursor: "pointer",
                padding: 4,
              }}
            >
              ×
            </button>
          </div>

          {/* Title + sim status */}
          <div>
            <div
              style={{
                fontSize: 17,
                fontWeight: 700,
                lineHeight: 1.2,
                color: "var(--text)",
              }}
            >
              {t("unidentifiedFaces.unknownPerson", "Unknown Person")}
            </div>
            <div
              style={{
                marginTop: 3,
                fontSize: 11.5,
                color: "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              {t("unidentifiedFaces.clusterMemberOf", "Cluster member · {{n}} crops", {
                n: total,
              })}
            </div>
          </div>

          {/* Similarity bar — match the confidence-bar shape in
              FaceCropLightbox so the two previews feel identical. */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--text-secondary)",
                marginBottom: 4,
              }}
            >
              <span>{t("unidentifiedFaces.similarity", "Similarity")}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                {simPct}%
              </span>
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 4,
                background: "var(--bg-elev)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.max(2, simPct)}%`,
                  background: `linear-gradient(90deg, ${similarityColor(simPct)} 0%, ${similarityColor(simPct)}cc 100%)`,
                }}
              />
            </div>
          </div>

          {/* Metadata grid — 2-column KPI tiles, mirrors FaceCropLightbox */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              fontSize: 12,
            }}
          >
            <GalleryMetaCell
              label={t("unidentifiedFaces.detectionTimeLabel", "Detection time")}
              value={captured ? new Date(captured).toLocaleTimeString(undefined, {
                hour: "2-digit", minute: "2-digit", second: "2-digit",
              }) : "—"}
            />
            <GalleryMetaCell
              label={t("unidentifiedFaces.detectionDateLabel", "Detection date")}
              value={captured ? new Date(captured).toLocaleDateString(undefined, {
                day: "2-digit", month: "short", year: "numeric",
              }) : "—"}
            />
            <GalleryMetaCell
              label={t("unidentifiedFaces.camera", "Camera")}
              value={cameraName}
            />
            <GalleryMetaCell
              label={t("unidentifiedFaces.qualityLabel", "Quality")}
              value={qualityLabel}
              dotColor={QUALITY_COLORS[meta?.quality ?? "unknown"] ?? "var(--border)"}
            />
            <GalleryMetaCell
              label={t("unidentifiedFaces.poseLabel", "Face type")}
              value={poseLabel}
              dotColor={POSE_COLORS[meta?.faceType ?? "unknown"] ?? "var(--border)"}
            />
            <GalleryMetaCell
              label={t("unidentifiedFaces.eventId", "Event ID")}
              value={`#${activeId}`}
            />
          </div>

          {total > 1 && (
            <div
              style={{
                marginTop: "auto",
                fontSize: 11,
                color: "var(--text-tertiary, var(--text-secondary))",
                paddingTop: 8,
                borderTop: "1px solid var(--border)",
              }}
            >
              ← → to navigate · Esc to close · click a thumbnail below
            </div>
          )}
        </div>

        {/* Thumbnail strip — direct jump-to-any-crop, mirrors
            FaceCropLightbox's CropThumbStrip exactly. */}
        {total > 1 && (
          <div
            role="tablist"
            aria-label={t("unidentifiedFaces.thumbStrip", "Face thumbnails")}
            style={{
              gridArea: "strip",
              background: "rgba(2, 6, 23, 0.92)",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              padding: "8px 12px",
              display: "flex",
              gap: 6,
              overflowX: "auto",
              scrollBehavior: "smooth",
            }}
          >
            {cropIds.map((id, i) => {
              const isActive = i === idx;
              return (
                <button
                  key={id}
                  ref={isActive ? activeThumbRef : null}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-current={isActive}
                  aria-label={t("unidentifiedFaces.faceN", "Face {{n}}", { n: i + 1 })}
                  onClick={() => setIdx(i)}
                  style={{
                    flexShrink: 0,
                    width: 48,
                    height: 48,
                    padding: 0,
                    border: isActive ? "2px solid #fff" : "2px solid transparent",
                    borderRadius: 6,
                    overflow: "hidden",
                    background: "rgba(255,255,255,0.06)",
                    cursor: "pointer",
                    opacity: isActive ? 1 : 0.55,
                    transition: "opacity 0.15s, border-color 0.15s, transform 0.15s",
                    transform: isActive ? "scale(1.04)" : "scale(1)",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.opacity = "0.85";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.opacity = "0.55";
                  }}
                >
                  <img
                    src={`/api/detection-events/${id}/crop`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Small KPI tile shared by the gallery metadata grid. Mirrors the
// ``MetaCell`` used in ``FaceCropLightbox`` so the two previews feel
// visually identical.
function GalleryMetaCell({
  label,
  value,
  dotColor,
}: {
  label: string;
  value: string;
  dotColor?: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-secondary)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 3,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
        }}
      >
        {dotColor && (
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: dotColor,
              flexShrink: 0,
            }}
          />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value}
        </span>
      </div>
    </div>
  );
}

// ── Cluster detail drawer ──────────────────────────────────────────────────

interface ClusterDrawerProps {
  cluster: FaceClusterOut;
  onClose: () => void;
}

type QualityFilter = "all" | "high" | "medium" | "low";
type ClarityFilter = "all" | "clear" | "blur" | "side" | "partial";

/** Derive a single mutually-exclusive clarity label from quality + pose.
 *  Priority: partial > side > blur > clear. This way an event with a
 *  side-profile bbox AND low quality lands in "side" (its dominant
 *  characteristic). Unknown geometry defaults to "clear" so the bucket
 *  isn't silently empty when bbox JSONB is missing. */
function clarityOf(quality: string, faceType: string): Exclude<ClarityFilter, "all"> {
  if (faceType === "partial") return "partial";
  if (faceType === "side") return "side";
  if (quality === "low") return "blur";
  return "clear";
}

function ClusterDrawer({ cluster, onClose }: ClusterDrawerProps) {
  const { t } = useTranslation();
  const [showMapModal, setShowMapModal] = useState(false);
  const [galleryEventId, setGalleryEventId] = useState<number | null>(null);

  // In-cluster filters.
  // ``simPct`` is the operator-typed similarity target (0–100). 0 means
  // no filter — show all. ``simMode`` selects how to interpret the value:
  //   * ``gte`` → show events with similarity ≥ simPct (e.g. 60 → ≥ 60%)
  //   * ``eq``  → show events whose rounded similarity equals simPct
  //               (e.g. 60 → exactly 60%)
  const [simPct, setSimPct] = useState<number>(0);
  const [simMode, setSimMode] = useState<"gte" | "eq">("gte");
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const [clarityFilter, setClarityFilter] = useState<ClarityFilter>("all");

  const events = useClusterEvents(cluster.event_ids.slice(0, 100), true);

  // Per-event metadata lookup: event_id → {similarity, quality, faceType}.
  // Built once per render — clustering invariant: parallel arrays aligned.
  const metaByEvent = (() => {
    const m = new Map<number, { similarity: number; quality: string; faceType: string }>();
    for (let i = 0; i < cluster.event_ids.length; i += 1) {
      const id = cluster.event_ids[i];
      if (id === undefined) continue;
      m.set(id, {
        similarity: cluster.event_similarities[i] ?? 0,
        quality: cluster.event_qualities[i] ?? "unknown",
        faceType: cluster.event_face_types[i] ?? "unknown",
      });
    }
    return m;
  })();

  // Camera lookup: event_id → camera_name. Filled when events load.
  const cameraNameLookup = (() => {
    const m = new Map<number, string>();
    if (events.data) {
      for (const ev of events.data.items) {
        m.set(ev.camera_id, ev.camera_name);
      }
    }
    return m;
  })();
  const capturedAtLookup = (() => {
    const m = new Map<number, string>();
    if (events.data) {
      for (const ev of events.data.items) {
        m.set(ev.id, ev.captured_at);
      }
    }
    return m;
  })();

  // Apply filters to the crop event ids. Unknown-quality events pass any
  // quality filter except an explicit category match — they aren't hidden
  // by the H/M/L chips since their bucket is genuinely unknown.
  const filteredCropIds = cluster.crop_event_ids.filter((id) => {
    const meta = metaByEvent.get(id);
    if (!meta) return true;
    if (simPct > 0) {
      const pct = meta.similarity * 100;
      if (simMode === "gte" && pct < simPct) return false;
      if (simMode === "eq" && Math.round(pct) !== simPct) return false;
    }
    if (qualityFilter !== "all" && meta.quality !== qualityFilter) return false;
    if (clarityFilter !== "all" && clarityOf(meta.quality, meta.faceType) !== clarityFilter) return false;
    return true;
  });

  // Actual similarity range across the cluster's crop events — surfaces in
  // the filter UI so the operator knows what number will actually filter.
  // Without this hint, typing 60 % into a cluster whose lowest event is
  // already 85 % feels broken (no rows hidden).
  const cropSims = cluster.crop_event_ids
    .map((id) => metaByEvent.get(id)?.similarity)
    .filter((s): s is number => typeof s === "number");
  const simRangeMin = cropSims.length > 0 ? Math.floor(Math.min(...cropSims) * 100) : 0;
  const simRangeMax = cropSims.length > 0 ? Math.ceil(Math.max(...cropSims) * 100) : 100;

  // Esc closes the drawer. Arrow-key gallery nav now lives inside the
  // ClusterGalleryModal (4-card grid view has no "active" item to step).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (galleryEventId !== null) return; // gallery handles its own keys
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, galleryEventId]);

  const clusterAvgSimPct = Math.round(cluster.avg_similarity * 100);

  const cameraDisplay =
    cluster.camera_names.length <= 2
      ? cluster.camera_names.join(", ")
      : `${cluster.camera_names.length} cameras`;

  // Camera activity counts — one entry per camera, sorted desc by count.
  const cameraActivity = (() => {
    const counts = new Map<number, { name: string; count: number }>();
    for (let i = 0; i < cluster.camera_ids.length; i += 1) {
      const id = cluster.camera_ids[i];
      const name = cluster.camera_names[i] ?? `cam_${id}`;
      if (id === undefined) continue;
      counts.set(id, { name, count: 0 });
    }
    if (events.data) {
      for (const ev of events.data.items) {
        const c = counts.get(ev.camera_id);
        if (c) c.count += 1;
        else counts.set(ev.camera_id, { name: ev.camera_name, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  })();
  const maxCamCount = cameraActivity[0]?.count ?? 0;

  // Span string — "5 hours", "3 days", "1 minute" — between first and last seen.
  const fmtSpan = (firstIso: string, lastIso: string) => {
    const diff = Math.max(0, new Date(lastIso).getTime() - new Date(firstIso).getTime());
    const m = Math.floor(diff / 60_000);
    if (m < 1) return t("unidentifiedFaces.spanSeconds", "Less than a minute");
    if (m < 60) return t("unidentifiedFaces.spanMinutes", "{{n}} min", { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t("unidentifiedFaces.spanHours", "{{n}}h {{r}}m", { n: h, r: m % 60 });
    const d = Math.floor(h / 24);
    return t("unidentifiedFaces.spanDays", "{{n}}d {{r}}h", { n: d, r: h % 24 });
  };
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: true });
  const fmtDay = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return (
    <>
      {/* Backdrop — visual only. Outside-click does NOT close; the
          drawer requires an explicit × button or Esc keypress. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 399,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          pointerEvents: "none",
        }}
      />

      <aside
        role="dialog"
        aria-label={t("unidentifiedFaces.drawerTitle", "Cluster detail")}
        aria-modal="true"
        style={{
          position: "fixed",
          insetInlineEnd: 0,
          top: 0,
          bottom: 0,
          width: "min(720px, 96vw)",
          background: "var(--bg-elev)",
          borderInlineStart: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          zIndex: 400,
          boxShadow: "-6px 0 32px rgba(0,0,0,0.14)",
          animation: "unid-fadein 0.15s ease both",
        }}
      >
        {/* ── Header ── */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 18px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14.5 }}>
              {t("unidentifiedFaces.clusterOf", "Cluster of {{count}} faces", {
                count: cluster.count,
              })}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("unidentifiedFaces.similarity", "Avg similarity")}{" "}
              <strong>{clusterAvgSimPct}%</strong>
              {" · "}
              {cameraDisplay}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              onClick={() => setShowMapModal(true)}
              className="btn btn-sm"
              aria-label={t("unidentifiedFaces.mapToEmployee", "Map to Employee")}
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
              <Icon name="user" size={13} />
              {t("unidentifiedFaces.mapToEmployee", "Map to Employee")}
            </button>
            <button
              onClick={onClose}
              className="btn btn-sm"
              aria-label={t("common.close", "Close")}
              style={{ padding: "4px 8px" }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* ── Scrollable content ── */}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>

          {/* ── First seen / Last seen + Camera activity (top of drawer) ── */}
          <div style={{ padding: "16px 18px 0" }}>
            <div className="unid-time-hero">
              <div className="unid-time-col">
                <span className="unid-time-label">
                  {t("unidentifiedFaces.firstSeen", "First seen")}
                </span>
                <span className="unid-time-value">{fmtTime(cluster.first_seen)}</span>
                <span className="unid-time-rel">{fmtDay(cluster.first_seen)}</span>
              </div>
              <div className="unid-time-arrow" aria-hidden>
                <span className="unid-time-arrow-icon">→</span>
                <span>{fmtSpan(cluster.first_seen, cluster.last_seen)}</span>
              </div>
              <div className="unid-time-col unid-time-col-end">
                <span className="unid-time-label">
                  {t("unidentifiedFaces.lastSeen", "Last seen")}
                </span>
                <span className="unid-time-value">{fmtTime(cluster.last_seen)}</span>
                <span className="unid-time-rel">{fmtDay(cluster.last_seen)}</span>
              </div>
            </div>

            {/* Per-camera activity */}
            {cameraActivity.length > 0 && maxCamCount > 0 && (
              <div className="unid-cam-activity">
                <div style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  color: "var(--text-tertiary)",
                  marginBottom: 2,
                }}>
                  {t("unidentifiedFaces.cameraActivity", "Camera activity")}
                </div>
                {cameraActivity.map((cam) => (
                  <div key={cam.name} className="unid-cam-bar-row">
                    <span className="unid-cam-bar-name" title={cam.name}>
                      <Icon name="camera" size={11} style={{ opacity: 0.65, marginInlineEnd: 4 }} />
                      {cam.name}
                    </span>
                    <div className="unid-cam-bar-track">
                      <div
                        className="unid-cam-bar-fill"
                        style={{ width: `${Math.max(4, (cam.count / maxCamCount) * 100)}%` }}
                      />
                    </div>
                    <span className="unid-cam-bar-count">{cam.count}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{
              fontSize: 11.5,
              color: "var(--text-tertiary)",
              marginTop: 10,
              display: "flex",
              gap: 14,
              flexWrap: "wrap",
            }}>
              <span>
                <strong style={{ color: "var(--text)" }}>{cluster.event_ids.length}</strong>{" "}
                {t("unidentifiedFaces.totalEventsShort", "events")}
              </span>
              <span>
                <strong style={{ color: "var(--text)" }}>{clusterAvgSimPct}%</strong>{" "}
                {t("unidentifiedFaces.avgSim", "avg similarity")}
              </span>
              <span>{cameraDisplay}</span>
            </div>
          </div>

          {/* ── In-cluster filters (data/filters section — first per the
              Clip Analytics investigation flow) ── */}
          <div style={{ padding: "16px 18px 0" }}>
            <div className="unid-filterbar">
              <div className="unid-filterbar-row">
                <span className="unid-filterbar-label">
                  {t("unidentifiedFaces.filterSim", "Similarity")}
                </span>

                {/* Mode toggle — ≥ (greater-or-equal) vs = (equal-to).
                    Two adjacent segmented buttons; the active mode changes
                    how ``simPct`` is interpreted. Sits inline with the
                    input so the row reads as "Similarity ≥ 60 %". */}
                <div
                  role="group"
                  aria-label={t("unidentifiedFaces.simModeAria", "Similarity match mode")}
                  style={{
                    display: "flex",
                    border: "1px solid var(--border)",
                    borderRadius: 999,
                    overflow: "hidden",
                    background: "var(--bg-elev)",
                  }}
                >
                  {([
                    ["gte", "≥", t("unidentifiedFaces.simModeGteHint", "Greater than or equal to")],
                    ["eq", "=", t("unidentifiedFaces.simModeEqHint", "Equal to")],
                  ] as const).map(([key, glyph, hint]) => {
                    const isActive = simMode === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSimMode(key)}
                        aria-pressed={isActive}
                        title={hint}
                        style={{
                          padding: "3px 10px",
                          minWidth: 30,
                          border: "none",
                          background: isActive ? "var(--text)" : "transparent",
                          color: isActive ? "var(--bg)" : "var(--text)",
                          fontWeight: 700,
                          fontSize: 13,
                          cursor: "pointer",
                          lineHeight: 1.2,
                        }}
                      >
                        {glyph}
                      </button>
                    );
                  })}
                </div>

                {/* Number input — operator types the percentage. The unit
                    glyph in front mirrors the active mode (≥ or =) so the
                    row visually reads as a complete inequality. */}
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "var(--bg-elev)",
                  border: "1px solid var(--border)",
                  borderRadius: 999,
                  padding: "3px 10px",
                }}>
                  <span style={{ fontSize: 11.5, color: "var(--text-tertiary)", fontWeight: 600 }}>
                    {simMode === "gte" ? "≥" : "="}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={simPct === 0 ? "" : simPct}
                    placeholder={t("unidentifiedFaces.simAnyPlaceholder", "any")}
                    aria-label={t("unidentifiedFaces.filterSimAria", "Similarity percentage")}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "") { setSimPct(0); return; }
                      const n = parseInt(raw, 10);
                      if (Number.isNaN(n)) return;
                      setSimPct(Math.max(0, Math.min(100, n)));
                    }}
                    style={{
                      width: 52,
                      border: "none",
                      background: "transparent",
                      color: "var(--text)",
                      fontSize: 12.5,
                      fontWeight: 600,
                      fontVariantNumeric: "tabular-nums",
                      outline: "none",
                      padding: 0,
                      textAlign: "end",
                      MozAppearance: "textfield",
                    }}
                  />
                  <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>%</span>
                </div>

                {cropSims.length > 0 && simRangeMin < simRangeMax && (
                  <span style={{
                    fontSize: 11,
                    color: "var(--text-tertiary)",
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {t("unidentifiedFaces.simRangeHint", "in cluster: {{min}}–{{max}}%", {
                      min: simRangeMin,
                      max: simRangeMax,
                    })}
                  </span>
                )}

                {/* Preset chips — quartile picks from the observed range.
                    Chip prefix tracks the active mode so the operator sees
                    "≥60%" / "≥75%" / ... in gte mode and "=60%" / "=75%"
                    in eq mode. */}
                {(() => {
                  if (cropSims.length < 2 || simRangeMin >= simRangeMax) return null;
                  const span = simRangeMax - simRangeMin;
                  const presets = [
                    simRangeMin + Math.round(span * 0.25),
                    simRangeMin + Math.round(span * 0.5),
                    simRangeMin + Math.round(span * 0.75),
                  ];
                  const seen = new Set<number>();
                  const unique = presets.filter((p) => {
                    if (seen.has(p)) return false;
                    seen.add(p);
                    return true;
                  });
                  return unique.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setSimPct(preset)}
                      aria-pressed={simPct === preset}
                      className="unid-chip"
                      style={{ padding: "3px 8px", fontSize: 11 }}
                    >
                      {simMode === "gte" ? `≥${preset}%` : `=${preset}%`}
                    </button>
                  ));
                })()}

                {simPct > 0 && (
                  <button
                    type="button"
                    onClick={() => setSimPct(0)}
                    className="unid-chip"
                    style={{ padding: "3px 8px", fontSize: 11 }}
                    aria-label={t("unidentifiedFaces.clearSimFilter", "Clear similarity filter")}
                  >
                    <Icon name="x" size={10} />
                  </button>
                )}
              </div>
              <div className="unid-filterbar-row">
                <span className="unid-filterbar-label">
                  {t("unidentifiedFaces.filterQuality", "Quality")}
                </span>
                {([
                  ["all", t("unidentifiedFaces.qAllChip", "All"), undefined],
                  ["high", t("unidentifiedFaces.qHighChip", "High"), "#22c55e"],
                  ["medium", t("unidentifiedFaces.qMediumChip", "Medium"), "#f59e0b"],
                  ["low", t("unidentifiedFaces.qLowChip", "Low"), "#94a3b8"],
                ] as const).map(([key, label, dot]) => (
                  <button
                    key={key}
                    onClick={() => setQualityFilter(key)}
                    aria-pressed={qualityFilter === key}
                    className="unid-chip"
                  >
                    {dot && <span className="unid-chip-dot" style={{ background: dot }} />}
                    {label}
                  </button>
                ))}
              </div>
              <div className="unid-filterbar-row">
                <span className="unid-filterbar-label">
                  {t("unidentifiedFaces.filterClarity", "Clarity")}
                </span>
                {([
                  ["all", t("unidentifiedFaces.cAllChip", "All"), undefined],
                  ["clear", t("unidentifiedFaces.cClearChip", "Clear face"), "#22c55e"],
                  ["blur", t("unidentifiedFaces.cBlurChip", "Blur face"), "#94a3b8"],
                  ["side", t("unidentifiedFaces.cSideChip", "Side face"), "#a855f7"],
                  ["partial", t("unidentifiedFaces.cPartialChip", "Partial face"), "#f97316"],
                ] as const).map(([key, label, dot]) => (
                  <button
                    key={key}
                    onClick={() => setClarityFilter(key)}
                    aria-pressed={clarityFilter === key}
                    className="unid-chip"
                  >
                    {dot && <span className="unid-chip-dot" style={{ background: dot }} />}
                    {label}
                  </button>
                ))}
              </div>
              {(simPct > 0 || qualityFilter !== "all" || clarityFilter !== "all") && (
                <div style={{
                  fontSize: 11.5,
                  color: "var(--text-secondary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  paddingTop: 4,
                  borderTop: "1px solid var(--border)",
                }}>
                  <span>
                    {t("unidentifiedFaces.filterStat", "Showing {{shown}} of {{total}}", {
                      shown: filteredCropIds.length,
                      total: cluster.crop_event_ids.length,
                    })}
                  </span>
                  <button
                    onClick={() => { setSimPct(0); setQualityFilter("all"); setClarityFilter("all"); }}
                    className="btn btn-sm"
                    style={{ padding: "3px 10px", fontSize: 11.5 }}
                  >
                    {t("unidentifiedFaces.clearFilters", "Clear filters")}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── Face crop grid (4 per row, no big banner) ── */}
          <div style={{ padding: "16px 18px 0" }}>
            {/* Section header — anchors the grid below the filters and
                tells the operator these crops belong to one cluster. */}
            <div style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 10,
            }}>
              <div style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                minWidth: 0,
              }}>
                <h3 style={{
                  margin: 0,
                  fontSize: 14,
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                  color: "var(--text)",
                }}>
                  {t("unidentifiedFaces.similarFaces", "Similar Faces")}
                </h3>
                <span style={{
                  fontSize: 11.5,
                  color: "var(--text-tertiary)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {filteredCropIds.length === cluster.crop_event_ids.length
                    ? t("unidentifiedFaces.similarFacesCount", "{{n}} face{{plural}}", {
                        n: filteredCropIds.length,
                        plural: filteredCropIds.length === 1 ? "" : "s",
                      })
                    : t("unidentifiedFaces.similarFacesCountFiltered", "{{shown}} of {{total}}", {
                        shown: filteredCropIds.length,
                        total: cluster.crop_event_ids.length,
                      })}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>
                {t("unidentifiedFaces.similarFacesHint", "Grouped detections in this cluster")}
              </div>
            </div>

            {filteredCropIds.length === 0 && cluster.crop_event_ids.length > 0 ? (
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--bg-sunken)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                gap: 8,
                padding: "32px 20px",
                textAlign: "center",
              }}>
                <Icon name="user" size={36} style={{ opacity: 0.18 }} />
                <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                  {t("unidentifiedFaces.allFiltered", "All faces hidden by current filters.")}
                </div>
                <button
                  onClick={() => { setSimPct(0); setQualityFilter("all"); setClarityFilter("all"); }}
                  className="btn btn-sm"
                >
                  {t("unidentifiedFaces.clearFilters", "Clear filters")}
                </button>
              </div>
            ) : filteredCropIds.length === 0 ? (
              <div style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                fontStyle: "italic",
                padding: "16px 0",
              }}>
                {t("unidentifiedFaces.noCrops", "No face crops in this cluster.")}
              </div>
            ) : (
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: 10,
              }}>
                {filteredCropIds.map((id) => {
                  const isRef = id === cluster.representative_event_id;
                  const meta = metaByEvent.get(id);
                  const pct = meta ? Math.round(meta.similarity * 100) : 0;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setGalleryEventId(id)}
                      aria-label={t("unidentifiedFaces.openPreview", "Open preview for face #{{id}}", { id })}
                      style={{
                        position: "relative",
                        padding: 0,
                        border: isRef ? "2px solid var(--accent)" : "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        overflow: "hidden",
                        background: "var(--bg-sunken)",
                        cursor: "pointer",
                        display: "block",
                        aspectRatio: "1",
                        transition: "transform 0.12s, box-shadow 0.12s, border-color 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = "translateY(-1px)";
                        e.currentTarget.style.boxShadow = "0 4px 14px rgba(0,0,0,0.12)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = "";
                        e.currentTarget.style.boxShadow = "";
                      }}
                    >
                      <img
                        src={`/api/detection-events/${id}/crop`}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                          display: "block",
                        }}
                      />
                      {/* similarity / reference overlay */}
                      <span
                        style={{
                          position: "absolute",
                          top: 6,
                          insetInlineStart: 6,
                          background: isRef ? "var(--accent)" : "rgba(0,0,0,0.72)",
                          color: "#fff",
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 7px",
                          borderRadius: 999,
                          letterSpacing: "0.02em",
                          backdropFilter: "blur(4px)",
                          WebkitBackdropFilter: "blur(4px)",
                        }}
                      >
                        {isRef ? t("unidentifiedFaces.refShort", "REF") : `${pct}%`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

        </div>
      </aside>

      {/* Gallery modal — full-viewport prev/next + metadata panel */}
      {galleryEventId !== null && filteredCropIds.length > 0 && (
        <ClusterGalleryModal
          cluster={cluster}
          cropIds={filteredCropIds}
          cameraNameLookup={cameraNameLookup}
          capturedAtLookup={capturedAtLookup}
          initialEventId={galleryEventId}
          onClose={() => setGalleryEventId(null)}
        />
      )}

      {/* Map to Employee modal — rendered above the drawer */}
      {showMapModal && (
        <MapToEmployeeModal
          cluster={cluster}
          onClose={() => setShowMapModal(false)}
          onSuccess={() => {
            setShowMapModal(false);
            onClose();
          }}
        />
      )}
    </>
  );
}

// ── Raw event viewer (lightbox for Tab 1) ─────────────────────────────────

interface RawEventViewerProps {
  event: RawFaceEventOut;
  onClose: () => void;
  onMap: (event: RawFaceEventOut) => void;
}

function RawEventViewer({ event, onClose, onMap }: RawEventViewerProps) {
  const { t } = useTranslation();
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <>
      <div
        role="presentation"
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 499,
          background: "rgba(0,0,0,0.7)",
          backdropFilter: "blur(3px)",
          WebkitBackdropFilter: "blur(3px)",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("unidentifiedFaces.viewerTitle", "Face detection")}
        style={{
          position: "fixed", inset: 0, zIndex: 500,
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            pointerEvents: "auto",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 12px 48px rgba(0,0,0,0.35)",
            width: "min(420px, 94vw)",
            display: "flex",
            flexDirection: "column",
            animation: "unid-fadein 0.15s ease both",
            overflow: "hidden",
          }}
        >
          {/* header */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0,
          }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              {t("unidentifiedFaces.unknownFace", "Unknown Face")}
            </span>
            <button
              onClick={onClose}
              className="btn btn-sm"
              aria-label={t("common.close", "Close")}
              style={{ padding: "4px 8px" }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          {/* image */}
          <div style={{ background: "var(--bg-sunken)", flexShrink: 0 }}>
            {event.has_crop && !imgFailed ? (
              <img
                src={`/api/detection-events/${event.id}/crop`}
                alt={t("unidentifiedFaces.faceAlt", "Unknown face")}
                style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }}
                onError={() => setImgFailed(true)}
              />
            ) : (
              <div style={{
                aspectRatio: "1", display: "flex",
                alignItems: "center", justifyContent: "center",
              }}>
                <Icon name="user" size={64} style={{ opacity: 0.15 }} />
              </div>
            )}
          </div>

          {/* metadata */}
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", fontSize: 13 }}>
              <span style={{ color: "var(--text-tertiary)" }}>{t("unidentifiedFaces.firstSeen", "Time")}</span>
              <span>{fmtDate(event.captured_at)}</span>
              <span style={{ color: "var(--text-tertiary)" }}>{t("unidentifiedFaces.cameras", "Camera")}</span>
              <span>{event.camera_name}</span>
            </div>
          </div>

          {/* footer */}
          <div style={{
            padding: "10px 16px", borderTop: "1px solid var(--border)",
            display: "flex", gap: 8, justifyContent: "flex-end",
          }}>
            <button onClick={onClose} className="btn btn-sm">
              {t("common.close", "Close")}
            </button>
            <button
              onClick={() => { onClose(); onMap(event); }}
              className="btn btn-sm btn-primary"
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
              <Icon name="user" size={12} />
              {t("unidentifiedFaces.mapToEmployee", "Map to Employee")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Raw event card (Tab 1) ─────────────────────────────────────────────────

interface RawEventCardProps {
  event: RawFaceEventOut;
  selected: boolean;
  selectMode: boolean;
  onToggleSelect: (id: number) => void;
  onView: (event: RawFaceEventOut) => void;
  onMap: (event: RawFaceEventOut) => void;
}

function RawEventCard({ event, selected, selectMode, onToggleSelect, onView, onMap }: RawEventCardProps) {
  const { t } = useTranslation();
  const [imgFailed, setImgFailed] = useState(false);

  const handleCardClick = () => {
    if (selectMode) {
      onToggleSelect(event.id);
    } else {
      onView(event);
    }
  };

  return (
    <div
      className={`unid-card${selected ? " unid-selected" : ""}${selectMode ? " unid-select-mode" : ""}`}
    >
      {/* checkbox overlay */}
      <div
        role="checkbox"
        aria-checked={selected}
        aria-label={t("unidentifiedFaces.selectFace", "Select this face")}
        tabIndex={0}
        className={`unid-checkbox${selected ? " unid-checked" : ""}`}
        onClick={(e) => { e.stopPropagation(); onToggleSelect(event.id); }}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onToggleSelect(event.id); } }}
      >
        {selected && <Icon name="check" size={11} style={{ color: "#fff" }} />}
      </div>

      {/* clickable image + metadata */}
      <button
        onClick={handleCardClick}
        aria-label={
          selectMode
            ? t("unidentifiedFaces.toggleSelect", "{{action}} face detected at {{time}}",
                { action: selected ? "Deselect" : "Select", time: fmtDate(event.captured_at) })
            : t("unidentifiedFaces.viewFace", "View face detected at {{time}}", { time: fmtDate(event.captured_at) })
        }
        style={{
          display: "flex", flexDirection: "column", flex: 1,
          background: "none", border: "none", padding: 0,
          cursor: "pointer", textAlign: "start", width: "100%", minWidth: 0,
        }}
      >
        <div style={{ position: "relative", aspectRatio: "1", overflow: "hidden", background: "var(--bg-sunken)", width: "100%" }}>
          {event.has_crop && !imgFailed ? (
            <img
              src={`/api/detection-events/${event.id}/crop`}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setImgFailed(true)}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="user" size={32} style={{ opacity: 0.2 }} />
            </div>
          )}
        </div>

        <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
            <Icon name="clock" size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {fmtDate(event.captured_at)}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
            <Icon name="camera" size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {event.camera_name}
            </span>
          </div>
        </div>
      </button>

      {/* map button — hidden in select mode (use toolbar instead) */}
      {!selectMode && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "6px 8px" }}>
          <button
            onClick={() => onMap(event)}
            className="btn btn-sm"
            style={{ width: "100%", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}
          >
            <Icon name="user" size={11} />
            {t("unidentifiedFaces.mapToEmployee", "Map to Employee")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Stats bar ──────────────────────────────────────────────────────────────

interface StatPillProps {
  label: string;
  value: string | number;
  warn?: boolean;
}

function StatPill({ label, value, warn }: StatPillProps) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "5px 12px",
      background: "var(--bg-elev)",
      border: `1px solid ${warn ? "var(--accent-border)" : "var(--border)"}`,
      borderRadius: 999,
      fontSize: 12.5,
      whiteSpace: "nowrap",
    }}>
      <span style={{ color: "var(--text-tertiary)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: warn ? "var(--accent-text)" : "var(--text)" }}>
        {value}
      </span>
    </div>
  );
}

// ── Mapped Employees views (sub-tab b) ─────────────────────────────────────
//
// Two read-only views over ``detection_events`` rows that have an
// employee_id. They share the surrounding filter bar so the operator
// can pivot between Unknown and Mapped on the same date/camera scope.
//
//   * MappedFacesGrid    — flat event tiles (each tile = one detection)
//   * MappedClustersGrid — per-employee rollup cards (each card = one
//     employee with their mapped count + camera split + sample crops)

interface MappedRenderProps {
  isLoading: boolean;
  isError: boolean;
  isPlaceholder: boolean;
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
  renderEmpty: (hint: string) => React.ReactNode;
  renderError: () => React.ReactNode;
  renderSkeleton: (n: number) => React.ReactNode;
  renderPagination: (
    page: number,
    total: number,
    onPage: (p: number) => void,
  ) => React.ReactNode;
  pageSize: number;
}

interface MappedFacesGridProps extends MappedRenderProps {
  data: { items: MappedFaceEventOut[]; total: number } | undefined;
}

function MappedFacesGrid({
  data,
  isLoading,
  isError,
  isPlaceholder,
  page,
  totalPages,
  onPage,
  renderEmpty,
  renderError,
  renderSkeleton,
  renderPagination,
  pageSize,
}: MappedFacesGridProps) {
  const { t } = useTranslation();
  return (
    <>
      {isError && renderError()}
      {isLoading && !data && renderSkeleton(pageSize)}
      {!isLoading &&
        !isError &&
        data &&
        data.items.length === 0 &&
        renderEmpty(
          t(
            "unidentifiedFaces.emptyMapped",
            "No mapped detections in this date range. Adjust the filter or pivot to Unknown Faces.",
          ),
        )}
      {data && data.items.length > 0 && (
        <div style={{ opacity: isPlaceholder ? 0.6 : 1, transition: "opacity 0.2s" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))",
              gap: 12,
            }}
          >
            {data.items.map((ev) => (
              <MappedFaceTile key={ev.id} event={ev} />
            ))}
          </div>
        </div>
      )}
      {data && renderPagination(page, totalPages, onPage)}
    </>
  );
}

function MappedFaceTile({ event }: { event: MappedFaceEventOut }) {
  const { t } = useTranslation();
  const [imgFailed, setImgFailed] = useState(false);
  const confPct =
    event.confidence !== null ? Math.round(event.confidence * 100) : null;
  return (
    <div
      className="unid-card"
      style={{ cursor: "default" }}
      role="article"
      aria-label={t("unidentifiedFaces.mappedTileAria", "Mapped detection")}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "1",
          overflow: "hidden",
          background: "var(--bg-sunken)",
        }}
      >
        {event.has_crop && !imgFailed ? (
          <img
            src={`/api/detection-events/${event.id}/crop`}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="user" size={32} style={{ opacity: 0.2 }} />
          </div>
        )}
        {/* Match-confidence pill (top-left). Falls back to "mapped"
            chip when the row has no confidence (hand-mapped events). */}
        <div
          style={{
            position: "absolute",
            top: 6,
            insetInlineStart: 6,
            background: "rgba(0,0,0,0.72)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            padding: "2.5px 8px",
            borderRadius: 999,
            letterSpacing: "0.02em",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
          }}
        >
          {confPct !== null
            ? `${confPct}%`
            : t("unidentifiedFaces.mappedChip", "MAPPED")}
        </div>
      </div>
      <div
        style={{
          padding: "8px 10px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={event.employee_name ?? `Employee #${event.employee_id}`}
        >
          {event.employee_name ?? `Employee #${event.employee_id}`}
        </div>
        {event.employee_code && (
          <div
            className="mono"
            style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}
          >
            {event.employee_code}
          </div>
        )}
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-secondary)",
            display: "flex",
            alignItems: "center",
            gap: 5,
            marginTop: 2,
          }}
        >
          <Icon name="clock" size={11} style={{ flexShrink: 0, opacity: 0.7 }} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fmtDate(event.captured_at)}
          </span>
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-secondary)",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <Icon name="camera" size={11} style={{ flexShrink: 0, opacity: 0.7 }} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {event.camera_name}
          </span>
        </div>
      </div>
    </div>
  );
}

interface MappedClustersGridProps extends MappedRenderProps {
  data:
    | {
        items: MappedEmployeeGroupOut[];
        total: number;
        total_events: number;
        total_employees: number;
      }
    | undefined;
}

function MappedClustersGrid({
  data,
  isLoading,
  isError,
  isPlaceholder,
  page,
  totalPages,
  onPage,
  renderEmpty,
  renderError,
  renderSkeleton,
  renderPagination,
  pageSize,
}: MappedClustersGridProps) {
  const { t } = useTranslation();
  return (
    <>
      {isError && renderError()}
      {isLoading && !data && renderSkeleton(pageSize)}
      {!isLoading &&
        !isError &&
        data &&
        data.items.length === 0 &&
        renderEmpty(
          t(
            "unidentifiedFaces.emptyMappedClusters",
            "No employees have mapped detections in this date range.",
          ),
        )}
      {data && data.items.length > 0 && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <StatPill
              label={t("unidentifiedFaces.mappedEmployeesStat", "employees")}
              value={data.total_employees.toLocaleString()}
            />
            <StatPill
              label={t("unidentifiedFaces.mappedEventsStat", "mapped events")}
              value={data.total_events.toLocaleString()}
            />
          </div>
          <div
            style={{ opacity: isPlaceholder ? 0.6 : 1, transition: "opacity 0.2s" }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: 12,
              }}
            >
              {data.items.map((emp) => (
                <MappedEmployeeCard key={emp.employee_id} group={emp} />
              ))}
            </div>
          </div>
        </>
      )}
      {data && renderPagination(page, totalPages, onPage)}
    </>
  );
}

function MappedEmployeeCard({ group }: { group: MappedEmployeeGroupOut }) {
  const { t } = useTranslation();
  const previews = group.sample_event_ids.slice(0, 4);
  const confPct =
    group.avg_confidence !== null ? Math.round(group.avg_confidence * 100) : null;
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        animation: "unid-fadein 0.18s ease both",
      }}
      role="article"
      aria-label={t("unidentifiedFaces.mappedEmployeeCardAria", "Mapped employee")}
    >
      {/* Preview strip — up to 4 sample crops side-by-side. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.max(1, previews.length)}, 1fr)`,
          gap: 0,
          aspectRatio: previews.length > 0 ? "4/1" : "4/2",
          background: "var(--bg-sunken)",
        }}
      >
        {previews.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-tertiary)",
            }}
          >
            <Icon name="user" size={32} style={{ opacity: 0.2 }} />
          </div>
        ) : (
          previews.map((eid) => (
            <img
              key={eid}
              src={`/api/detection-events/${eid}/crop`}
              alt=""
              loading="lazy"
              decoding="async"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
                borderInlineStart:
                  eid === previews[0] ? "none" : "1px solid var(--bg-elev)",
              }}
            />
          ))
        )}
      </div>
      {/* Header */}
      <div
        style={{
          padding: "10px 12px 6px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 700,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={group.employee_name ?? `Employee #${group.employee_id}`}
        >
          {group.employee_name ?? `Employee #${group.employee_id}`}
        </div>
        {group.employee_code && (
          <div
            className="mono"
            style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}
          >
            {group.employee_code}
          </div>
        )}
      </div>
      {/* Stats row */}
      <div
        style={{
          padding: "0 12px 10px",
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 4,
            padding: "2px 9px",
            borderRadius: 999,
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            fontSize: 11,
          }}
        >
          <strong style={{ color: "var(--text)" }}>{group.count}</strong>
          <span style={{ color: "var(--text-tertiary)" }}>
            {group.count === 1
              ? t("unidentifiedFaces.detectionSingular", "detection")
              : t("unidentifiedFaces.detectionPlural", "detections")}
          </span>
        </span>
        {confPct !== null && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 9px",
              borderRadius: 999,
              background: "var(--bg-sunken)",
              border: "1px solid var(--border)",
              fontSize: 11,
              color: "var(--text-secondary)",
            }}
            title={
              t("unidentifiedFaces.avgConfidenceTooltip", "Average match confidence") as string
            }
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background:
                  confPct >= 80 ? "#22c55e" : confPct >= 65 ? "#f59e0b" : "#ef4444",
              }}
            />
            {confPct}%
          </span>
        )}
      </div>
      {/* Footer: time range + camera */}
      <div
        style={{
          padding: "8px 12px 11px",
          borderTop: "1px dashed var(--border)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-secondary)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Icon name="clock" size={11} style={{ opacity: 0.7, flexShrink: 0 }} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fmtDate(group.first_seen)} → {fmtDate(group.last_seen)}
          </span>
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-secondary)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Icon name="camera" size={11} style={{ opacity: 0.7, flexShrink: 0 }} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {group.camera_names[0] ?? "—"}
            {group.camera_names.length > 1 && (
              <span style={{ color: "var(--text-tertiary)" }}>
                {" "}+{group.camera_names.length - 1}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function UnidentifiedFacesPage() {
  const { t } = useTranslation();

  // ── Tab hierarchy ──
  // Top-level: "raw" (All Unknown Faces) vs "groups" (Similarity Groups).
  // Sub-level (per top tab): "primary" (Unknown Faces / Similarity
  // Clusters — the original views) vs "mapped" (Mapped Employees —
  // detections already attributed to a real employee).
  const [activeTab, setActiveTab] = useState<"raw" | "groups">("raw");
  const [rawSubTab, setRawSubTab] = useState<"primary" | "mapped">("primary");
  const [groupsSubTab, setGroupsSubTab] = useState<"primary" | "mapped">("primary");

  // ── Shared + groups filter state ──
  // The groups (Tab 2) owns the full filter object; Tab 1 reads the shared
  // date/camera slice from it so changing the date range updates both tabs.
  const [filters, setFilters] = useState<UnidentifiedFacesFilters>({
    start: defaultStart(),
    end: todayIso(),
    camera_id: null,
    min_count: DEFAULT_MIN_COUNT,
    threshold: DEFAULT_THRESHOLD,
    page: 1,
    page_size: PAGE_SIZE,
  });
  const [uiThreshold, setUiThreshold] = useState(DEFAULT_THRESHOLD);
  const [uiMinCount, setUiMinCount] = useState(DEFAULT_MIN_COUNT);

  // ── Tab 2: similarity range filter ──
  const [simRange, setSimRange] = useState<"all" | "low" | "mid" | "high">("all");

  // ── Raw (Tab 1) specific state ──
  const [rawPage, setRawPage] = useState(1);
  const RAW_PAGE_SIZE = 48;
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const [openCluster, setOpenCluster] = useState<FaceClusterOut | null>(null);
  const [viewRawEvent, setViewRawEvent] = useState<RawFaceEventOut | null>(null);
  const [mapRawEvent, setMapRawEvent] = useState<RawFaceEventOut | null>(null);
  const [bulkMapOpen, setBulkMapOpen] = useState(false);

  const selectMode = selectedIds.size > 0;

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cameras = useCameraList();

  // ── Tab 2: cluster query ──
  const clusterResult = useUnidentifiedFaceClusters(filters);
  const clusterData = clusterResult.data;
  const isClusterPlaceholder = clusterResult.isPlaceholderData;
  const totalClusterPages = Math.max(1, Math.ceil((clusterData?.total_clusters ?? 0) / PAGE_SIZE));

  // Client-side similarity range filter
  const filteredClusters = clusterData
    ? clusterData.clusters.filter((c) => {
        if (simRange === "low") return c.avg_similarity < 0.60;
        if (simRange === "mid") return c.avg_similarity >= 0.60 && c.avg_similarity < 0.80;
        if (simRange === "high") return c.avg_similarity >= 0.80;
        return true;
      })
    : [];

  // ── Tab 1: raw events query ──
  const rawQueryFilters: RawUnidentifiedFilters = {
    start: filters.start,
    end: filters.end,
    camera_id: filters.camera_id,
    has_embedding: null,
    page: rawPage,
    page_size: RAW_PAGE_SIZE,
  };
  const rawResult = useRawUnidentifiedFaces(rawQueryFilters);
  const rawData = rawResult.data;
  const totalRawPages = Math.max(1, Math.ceil((rawData?.total ?? 0) / RAW_PAGE_SIZE));

  // ── Mapped Employees queries ──
  // Lazy: only fire when the sub-tab is actually open. ``enabled``
  // toggles via the surrounding ``activeTab`` + sub-tab state so we
  // never pay for the mapped query while the operator is looking at
  // Unknown Faces / Similarity Clusters.
  const [mappedPage, setMappedPage] = useState(1);
  const [mappedClustersPage, setMappedClustersPage] = useState(1);
  const MAPPED_PAGE_SIZE = 48;
  const MAPPED_CLUSTERS_PAGE_SIZE = 24;

  const mappedResult = useMappedFaces({
    start: filters.start,
    end: filters.end,
    camera_id: filters.camera_id,
    employee_id: null,
    page: mappedPage,
    page_size: MAPPED_PAGE_SIZE,
  });
  const mappedData = mappedResult.data;
  const totalMappedPages = Math.max(
    1,
    Math.ceil((mappedData?.total ?? 0) / MAPPED_PAGE_SIZE),
  );

  const mappedClustersResult = useMappedClusters({
    start: filters.start,
    end: filters.end,
    camera_id: filters.camera_id,
    page: mappedClustersPage,
    page_size: MAPPED_CLUSTERS_PAGE_SIZE,
  });
  const mappedClustersData = mappedClustersResult.data;
  const totalMappedClustersPages = Math.max(
    1,
    Math.ceil(
      (mappedClustersData?.total ?? 0) / MAPPED_CLUSTERS_PAGE_SIZE,
    ),
  );

  const selectAll = useCallback(() => {
    if (!rawData) return;
    setSelectedIds(new Set(rawData.items.map((ev) => ev.id)));
  }, [rawData]);

  // Debounce helper — commits pending UI values to query state after DEBOUNCE_MS.
  // Always resets both tabs' pages so stale pages don't survive filter changes.
  const scheduleCommit = useCallback((patch: Partial<UnidentifiedFacesFilters>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, page: 1, ...patch }));
      setRawPage(1);
    }, DEBOUNCE_MS);
  }, []);

  const commitNow = useCallback((patch: Partial<UnidentifiedFacesFilters>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setFilters((prev) => ({ ...prev, page: 1, ...patch }));
    setRawPage(1);
    setSelectedIds(new Set());
    setSimRange("all");
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const inputStyle: React.CSSProperties = {
    padding: "6px 10px",
    fontSize: 12.5,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--bg-elev)",
    color: "var(--text)",
    fontFamily: "var(--font-sans)",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11.5,
    color: "var(--text-tertiary)",
    fontWeight: 500,
    marginBottom: 4,
    display: "block",
  };

  // Synthetic FaceClusterOut — single event (single Map button) or bulk selection.
  const syntheticCluster: FaceClusterOut | null = (() => {
    if (mapRawEvent) {
      return {
        cluster_id: `raw_${mapRawEvent.id}`,
        representative_event_id: mapRawEvent.id,
        event_ids: [mapRawEvent.id],
        crop_event_ids: mapRawEvent.has_crop ? [mapRawEvent.id] : [],
        count: 1,
        first_seen: mapRawEvent.captured_at,
        last_seen: mapRawEvent.captured_at,
        camera_ids: [mapRawEvent.camera_id],
        camera_names: [mapRawEvent.camera_name],
        avg_similarity: 0,
        event_similarities: [],
        event_qualities: [],
        event_face_types: [],
      };
    }
    return null;
  })();

  // Bulk-selection synthetic cluster for the toolbar Map action.
  // Built from ALL selected ids (cross-page safe); UI metadata
  // (crop previews, camera names, date range) comes from whichever
  // selected events are currently visible in rawData.items.
  const bulkCluster: FaceClusterOut | null = (() => {
    if (selectedIds.size === 0) return null;
    const allIds = [...selectedIds];
    const visible = rawData ? rawData.items.filter((ev) => selectedIds.has(ev.id)) : [];
    const sorted = [...visible].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const cameraMap = new Map<number, string>();
    visible.forEach((ev) => cameraMap.set(ev.camera_id, ev.camera_name));
    const cropIds = visible.filter((ev) => ev.has_crop).map((ev) => ev.id);
    const repId = cropIds[0] ?? visible[0]?.id ?? allIds[0]!;
    return {
      cluster_id: `bulk_${allIds.join("_")}`,
      representative_event_id: repId,
      event_ids: allIds,
      crop_event_ids: cropIds,
      count: allIds.length,
      first_seen: sorted[0]?.captured_at ?? new Date().toISOString(),
      last_seen: sorted[sorted.length - 1]?.captured_at ?? new Date().toISOString(),
      camera_ids: [...cameraMap.keys()],
      camera_names: [...cameraMap.values()],
      avg_similarity: 0,
      event_similarities: [],
      event_qualities: [],
      event_face_types: [],
    };
  })();

  // ── Shared pagination renderer (no hooks — safe to define inline) ──
  const renderPagination = (
    page: number,
    total: number,
    onPage: (p: number) => void,
  ) => {
    if (total <= 1) return null;
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, paddingTop: 4 }}>
        <button onClick={() => onPage(1)} disabled={page <= 1} className="btn btn-sm" aria-label={t("common.first", "First page")} style={{ padding: "4px 8px" }}>«</button>
        <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1} className="btn btn-sm" aria-label={t("common.previous", "Previous page")} style={{ padding: "4px 8px" }}>
          <Icon name="chevronLeft" size={14} />
        </button>
        {Array.from({ length: Math.min(5, total) }, (_, i) => {
          const startP = Math.max(1, Math.min(page - 2, total - 4));
          const p = startP + i;
          if (p > total) return null;
          return (
            <button key={p} onClick={() => onPage(p)} className="btn btn-sm" aria-current={p === page ? "page" : undefined}
              style={{ padding: "4px 10px", minWidth: 32,
                background: p === page ? "var(--accent)" : undefined,
                color: p === page ? "#fff" : undefined,
                borderColor: p === page ? "var(--accent)" : undefined,
              }}
            >{p}</button>
          );
        })}
        <button onClick={() => onPage(Math.min(total, page + 1))} disabled={page >= total} className="btn btn-sm" aria-label={t("common.next", "Next page")} style={{ padding: "4px 8px" }}>
          <Icon name="chevronRight" size={14} />
        </button>
        <button onClick={() => onPage(total)} disabled={page >= total} className="btn btn-sm" aria-label={t("common.last", "Last page")} style={{ padding: "4px 8px" }}>»</button>
        <span style={{ fontSize: 12, color: "var(--text-tertiary)", marginInlineStart: 4 }}>
          {t("unidentifiedFaces.page", "Page {{page}} of {{total}}", { page, total })}
        </span>
      </div>
    );
  };

  // ── Shared empty / error / skeleton helpers ──
  const renderError = () => (
    <div style={{ padding: "32px 0", textAlign: "center", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
      <Icon name="x" size={28} style={{ opacity: 0.3, marginBottom: 10 }} />
      <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
        {t("unidentifiedFaces.loadFailed", "Could not load unidentified faces.")}
      </div>
    </div>
  );

  const renderSkeleton = (count: number) => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))", gap: 12 }}>
      {[...Array(count)].map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );

  const renderEmpty = (hint: string) => (
    <div style={{ padding: "56px 24px", textAlign: "center", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
      <div style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--bg-sunken)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
        <Icon name="user" size={26} style={{ opacity: 0.3 }} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
        {t("unidentifiedFaces.empty", "No unidentified faces found")}
      </div>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 340, margin: "0 auto" }}>{hint}</div>
    </div>
  );

  return (
    <>
      <style>{INJECTED_STYLE}</style>

      <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 1400 }}>

        {/* ── Page header + tab switcher ── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <h1 className="page-title">{t("unidentifiedFaces.title", "Unidentified Faces")}</h1>

          {/* Tab switcher */}
          <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
            {(["raw", "groups"] as const).map((tab, idx) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                aria-pressed={activeTab === tab}
                className="btn"
                style={{
                  borderRadius: 0,
                  borderRight: idx === 0 ? "1px solid var(--border)" : undefined,
                  background: activeTab === tab ? "var(--text)" : "var(--bg-elev)",
                  color: activeTab === tab ? "var(--bg)" : "var(--text)",
                  fontWeight: activeTab === tab ? 600 : 400,
                  padding: "6px 16px",
                  fontSize: 13,
                }}
              >
                {tab === "raw"
                  ? t("unidentifiedFaces.tabAllFaces", "All Unknown Faces")
                  : t("unidentifiedFaces.tabGroups", "Similarity Groups")}
              </button>
            ))}
          </div>
        </div>

        {/* ── Sub-tab switcher ──
            Each top tab gets a pair of sub-tabs:
              "raw"    → Unknown Faces / Mapped Employees
              "groups" → Similarity Clusters / Mapped Employees
            Mapped Employees is the secondary investigation surface —
            same date+camera filter envelope, but anchored to
            detection_events that already carry an employee_id. */}
        <div style={{
          display: "flex",
          gap: 4,
          padding: 4,
          background: "var(--bg-sunken)",
          border: "1px solid var(--border)",
          borderRadius: 999,
          width: "fit-content",
          marginTop: -4,
        }}>
          {(["primary", "mapped"] as const).map((sub) => {
            const isActive =
              activeTab === "raw"
                ? rawSubTab === sub
                : groupsSubTab === sub;
            const label = (() => {
              if (activeTab === "raw") {
                return sub === "primary"
                  ? t("unidentifiedFaces.subUnknownFaces", "Unknown Faces")
                  : t("unidentifiedFaces.subMappedEmployees", "Mapped Employees");
              }
              return sub === "primary"
                ? t("unidentifiedFaces.subSimilarityClusters", "Similarity Clusters")
                : t("unidentifiedFaces.subMappedEmployees", "Mapped Employees");
            })();
            return (
              <button
                key={sub}
                onClick={() => {
                  if (activeTab === "raw") setRawSubTab(sub);
                  else setGroupsSubTab(sub);
                }}
                aria-pressed={isActive}
                className="btn"
                style={{
                  borderRadius: 999,
                  border: "none",
                  background: isActive ? "var(--bg-elev)" : "transparent",
                  color: isActive ? "var(--text)" : "var(--text-secondary)",
                  fontWeight: isActive ? 600 : 500,
                  padding: "5px 14px",
                  fontSize: 12.5,
                  boxShadow: isActive
                    ? "0 1px 3px rgba(0,0,0,0.08)"
                    : "none",
                  transition: "background 0.12s, color 0.12s",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* ── Stats pills (tab-specific) ── */}
        {activeTab === "raw" ? (
          rawData ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <StatPill label={t("unidentifiedFaces.totalEvents", "total events")} value={rawData.total.toLocaleString()} />
            </div>
          ) : rawResult.isLoading ? (
            <div style={{ display: "flex", gap: 8 }}>{[80, 110].map((w) => <div key={w} className="unid-skeleton" style={{ height: 30, width: w, borderRadius: 999 }} />)}</div>
          ) : null
        ) : (
          clusterData ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <StatPill label={t("unidentifiedFaces.clusters", "clusters")} value={clusterData.total_clusters.toLocaleString()} />
              {simRange !== "all" && (
                <StatPill label={t("unidentifiedFaces.filtered", "filtered")} value={filteredClusters.length.toLocaleString()} warn />
              )}
              <StatPill label={t("unidentifiedFaces.totalEvents", "total events")} value={clusterData.total_unidentified_events.toLocaleString()} />
              <StatPill label={t("unidentifiedFaces.withEmbedding", "with embedding")} value={clusterData.events_with_embedding.toLocaleString()} />
              {clusterData.events_without_embedding > 0 && (
                <StatPill warn label={t("unidentifiedFaces.noEmbedding", "no face data")} value={clusterData.events_without_embedding.toLocaleString()} />
              )}
              {clusterData.capped && (
                <StatPill warn label="⚠" value={t("unidentifiedFaces.capped", "Capped at 5,000 most recent — narrow date range to see older events")} />
              )}
            </div>
          ) : clusterResult.isLoading ? (
            <div style={{ display: "flex", gap: 8 }}>{[80, 110, 90].map((w) => <div key={w} className="unid-skeleton" style={{ height: 30, width: w, borderRadius: 999 }} />)}</div>
          ) : null
        )}

        {/* ── Filter bar ── */}
        <div style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Shared: date range + camera */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end" }}>
            <div>
              <label style={labelStyle}>{t("unidentifiedFaces.from", "From")}</label>
              <div style={{ marginTop: 4 }}>
                <DatePicker
                  value={filters.start ?? ""}
                  onChange={(v) => commitNow({ start: v || null })}
                  max={filters.end || todayIso()}
                  ariaLabel={t("unidentifiedFaces.from", "From")}
                  triggerStyle={{ width: 160 }}
                />
              </div>
            </div>
            <div>
              <label style={labelStyle}>{t("unidentifiedFaces.to", "To")}</label>
              <div style={{ marginTop: 4 }}>
                <DatePicker
                  value={filters.end ?? ""}
                  onChange={(v) => commitNow({ end: v || null })}
                  {...(filters.start ? { min: filters.start } : {})}
                  max={todayIso()}
                  ariaLabel={t("unidentifiedFaces.to", "To")}
                  triggerStyle={{ width: 160 }}
                />
              </div>
            </div>
            {(filters.start !== defaultStart() || filters.end !== todayIso()) && (
              <button
                type="button"
                onClick={() => commitNow({ start: defaultStart(), end: todayIso() })}
                className="btn btn-sm"
                style={{ alignSelf: "flex-end" }}
                title={t("unidentifiedFaces.resetToTodayHint", "Reset to default range (today)")}
              >
                {t("unidentifiedFaces.today", "Today")}
              </button>
            )}
            {cameras.data && cameras.data.items.length > 0 && (
              <div>
                <label style={labelStyle}>{t("unidentifiedFaces.camera", "Camera")}</label>
                <select value={filters.camera_id ?? ""} onChange={(e) => commitNow({ camera_id: e.target.value ? parseInt(e.target.value, 10) : null })} style={{ ...inputStyle, width: 180 }}>
                  <option value="">{t("unidentifiedFaces.allCameras", "All cameras")}</option>
                  {cameras.data.items.map((cam) => <option key={cam.id} value={cam.id}>{cam.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Tab 2: threshold + min_count */}
          {activeTab === "groups" && (
            <>
              <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12 }}>
                {/* Similarity threshold card */}
                <div className="unid-thresh-card">
                  <div className="unid-thresh-header">
                    <div>
                      <div className="unid-thresh-label">
                        {t("unidentifiedFaces.threshold", "Similarity Threshold")}
                      </div>
                    </div>
                    <div className="unid-thresh-badge" aria-live="polite">
                      {(uiThreshold * 100).toFixed(0)}%
                    </div>
                  </div>
                  <div className="unid-thresh-hint">
                    {t("unidentifiedFaces.thresholdHint", "Higher values create tighter, more distinct clusters. Lower values group faces more broadly.")}
                  </div>
                  <div>
                    <input
                      type="range" min={0.40} max={0.99} step={0.01} value={uiThreshold}
                      aria-label={t("unidentifiedFaces.threshold", "Similarity Threshold")}
                      className="unid-thresh-slider"
                      style={{ "--fill-pct": `${((uiThreshold - 0.40) / (0.99 - 0.40)) * 100}%` } as React.CSSProperties}
                      onChange={(e) => { const v = parseFloat(e.target.value); setUiThreshold(v); scheduleCommit({ threshold: v }); }}
                    />
                    <div className="unid-thresh-zones">
                      <div className="unid-thresh-zone">
                        <span>40%</span>
                        <span>{t("unidentifiedFaces.looser", "Broad")}</span>
                      </div>
                      <div className="unid-thresh-zone" style={{ textAlign: "center" }}>
                        <span>~65%</span>
                        <span>{t("unidentifiedFaces.balanced", "Balanced")}</span>
                      </div>
                      <div className="unid-thresh-zone" style={{ textAlign: "end" }}>
                        <span>99%</span>
                        <span>{t("unidentifiedFaces.tighter", "Strict")}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Min appearances + reset row */}
                <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
                  <div>
                    <label style={labelStyle}>{t("unidentifiedFaces.minCount", "Min appearances")}</label>
                    <input type="number" min={1} max={100} value={uiMinCount}
                      onChange={(e) => { const v = Math.max(1, parseInt(e.target.value, 10) || 1); setUiMinCount(v); scheduleCommit({ min_count: v }); }}
                      style={{ ...inputStyle, width: 90 }}
                    />
                  </div>
                  <button
                    onClick={() => { setUiThreshold(DEFAULT_THRESHOLD); setUiMinCount(DEFAULT_MIN_COUNT); commitNow({ threshold: DEFAULT_THRESHOLD, min_count: DEFAULT_MIN_COUNT }); }}
                    className="btn btn-sm"
                  >
                    {t("unidentifiedFaces.resetDefaults", "Reset defaults")}
                  </button>
                </div>
              </div>

              {/* Similarity range filter chips */}
              <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11.5, color: "var(--text-tertiary)", fontWeight: 500 }}>
                  {t("unidentifiedFaces.simFilter", "Similarity:")}
                </span>
                {(["all", "low", "mid", "high"] as const).map((range) => {
                  const labels: Record<typeof range, string> = {
                    all: t("unidentifiedFaces.simAll", "All"),
                    low: t("unidentifiedFaces.simLow", "< 60%"),
                    mid: t("unidentifiedFaces.simMid", "60–80%"),
                    high: t("unidentifiedFaces.simHigh", "> 80%"),
                  };
                  const isActive = simRange === range;
                  return (
                    <button
                      key={range}
                      onClick={() => setSimRange(range)}
                      aria-pressed={isActive}
                      className="btn btn-sm"
                      style={{
                        background: isActive ? "var(--text)" : "var(--bg-elev)",
                        color: isActive ? "var(--bg)" : "var(--text)",
                        borderColor: isActive ? "var(--text)" : "var(--border)",
                        fontWeight: isActive ? 600 : 400,
                        fontSize: 12,
                      }}
                    >
                      {labels[range]}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* ── Tab 1.a: All Unknown Faces → Unknown Faces ── */}
        {activeTab === "raw" && rawSubTab === "primary" && (
          <>
            {rawResult.isError && renderError()}
            {rawResult.isLoading && !rawData && renderSkeleton(RAW_PAGE_SIZE)}
            {!rawResult.isLoading && !rawResult.isError && rawData && rawData.items.length === 0 && renderEmpty(
              t("unidentifiedFaces.emptyRaw", "No unidentified face detections in this date range. Try expanding the range or removing the face-data filter.")
            )}
            {rawData && rawData.items.length > 0 && (
              <div style={{ opacity: rawResult.isPlaceholderData ? 0.6 : 1, transition: "opacity 0.2s" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))", gap: 12 }}>
                  {rawData.items.map((ev) => (
                    <RawEventCard
                      key={ev.id}
                      event={ev}
                      selected={selectedIds.has(ev.id)}
                      selectMode={selectMode}
                      onToggleSelect={toggleSelect}
                      onView={setViewRawEvent}
                      onMap={setMapRawEvent}
                    />
                  ))}
                </div>
              </div>
            )}
            {rawData && renderPagination(rawPage, totalRawPages, setRawPage)}
          </>
        )}

        {/* ── Tab 1.b: All Unknown Faces → Mapped Employees ── */}
        {activeTab === "raw" && rawSubTab === "mapped" && (
          <MappedFacesGrid
            data={mappedData}
            isLoading={mappedResult.isLoading}
            isError={mappedResult.isError}
            isPlaceholder={mappedResult.isPlaceholderData}
            page={mappedPage}
            totalPages={totalMappedPages}
            onPage={setMappedPage}
            renderEmpty={renderEmpty}
            renderError={renderError}
            renderSkeleton={renderSkeleton}
            renderPagination={renderPagination}
            pageSize={MAPPED_PAGE_SIZE}
          />
        )}

        {/* ── Tab 2.a: Similarity Groups → Similarity Clusters ── */}
        {activeTab === "groups" && groupsSubTab === "primary" && (
          <>
            {clusterResult.isError && renderError()}
            {clusterResult.isLoading && !clusterData && renderSkeleton(PAGE_SIZE)}
            {!clusterResult.isLoading && !clusterResult.isError && clusterData && clusterData.clusters.length === 0 && renderEmpty(
              t("unidentifiedFaces.emptyHint", "Try expanding the date range or lowering the similarity threshold.")
            )}
            {clusterData && clusterData.clusters.length > 0 && filteredClusters.length === 0 && (
              renderEmpty(t("unidentifiedFaces.emptySimFilter", "No clusters match this similarity range. Try a different filter."))
            )}
            {clusterData && filteredClusters.length > 0 && (
              <div style={{ opacity: isClusterPlaceholder ? 0.6 : 1, transition: "opacity 0.2s" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))", gap: 12 }}>
                  {filteredClusters.map((cluster) => (
                    <ClusterCard key={cluster.cluster_id} cluster={cluster} onOpen={setOpenCluster} />
                  ))}
                </div>
              </div>
            )}
            {clusterData && simRange === "all" && renderPagination(filters.page, totalClusterPages, (p) => setFilters((f) => ({ ...f, page: p })))}
          </>
        )}

        {/* ── Tab 2.b: Similarity Groups → Mapped Employees ── */}
        {activeTab === "groups" && groupsSubTab === "mapped" && (
          <MappedClustersGrid
            data={mappedClustersData}
            isLoading={mappedClustersResult.isLoading}
            isError={mappedClustersResult.isError}
            isPlaceholder={mappedClustersResult.isPlaceholderData}
            page={mappedClustersPage}
            totalPages={totalMappedClustersPages}
            onPage={setMappedClustersPage}
            renderEmpty={renderEmpty}
            renderError={renderError}
            renderSkeleton={renderSkeleton}
            renderPagination={renderPagination}
            pageSize={MAPPED_CLUSTERS_PAGE_SIZE}
          />
        )}

      </div>

      {/* ── Bulk selection toolbar — only relevant on Unknown Faces ── */}
      {selectMode && activeTab === "raw" && rawSubTab === "primary" && (
        <div
          role="toolbar"
          aria-label={t("unidentifiedFaces.bulkToolbar", "Bulk selection toolbar")}
          style={{
            position: "fixed",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 300,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 6px 32px rgba(0,0,0,0.22)",
            display: "flex",
            alignItems: "center",
            gap: 0,
            padding: "8px 10px",
            animation: "unid-toolbar-up 0.18s ease both",
            whiteSpace: "nowrap",
          }}
        >
          {/* selected count */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingInlineEnd: 12,
            borderInlineEnd: "1px solid var(--border)",
            marginInlineEnd: 10,
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: 5,
              background: "var(--accent, #000)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <Icon name="check" size={12} style={{ color: "#fff" }} />
            </div>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>
              {t("unidentifiedFaces.selectedCount", "{{count}} selected", { count: selectedIds.size })}
            </span>
          </div>

          {/* select all on page */}
          {rawData && selectedIds.size < rawData.items.length && (
            <button
              onClick={selectAll}
              className="btn btn-sm"
              style={{ marginInlineEnd: 6 }}
            >
              {t("unidentifiedFaces.selectAll", "Select all {{n}}", { n: rawData.items.length })}
            </button>
          )}

          {/* clear */}
          <button
            onClick={clearSelection}
            className="btn btn-sm"
            aria-label={t("unidentifiedFaces.clearSelection", "Clear selection")}
            style={{ marginInlineEnd: 10, padding: "5px 8px" }}
          >
            <Icon name="x" size={14} />
          </button>

          {/* map to employee */}
          <button
            onClick={() => {
              if (bulkCluster) setBulkMapOpen(true);
            }}
            className="btn btn-sm btn-primary"
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <Icon name="user" size={13} />
            {t("unidentifiedFaces.mapToEmployee", "Map to Employee")}
          </button>
        </div>
      )}

      {/* Cluster detail drawer (Tab 2) */}
      {openCluster && (
        <ClusterDrawer cluster={openCluster} onClose={() => setOpenCluster(null)} />
      )}

      {/* Face viewer lightbox (Tab 1) */}
      {viewRawEvent && (
        <RawEventViewer
          event={viewRawEvent}
          onClose={() => setViewRawEvent(null)}
          onMap={(ev) => { setViewRawEvent(null); setMapRawEvent(ev); }}
        />
      )}

      {/* Map to Employee modal (Tab 1 — single raw event) */}
      {syntheticCluster && (
        <MapToEmployeeModal
          cluster={syntheticCluster}
          onClose={() => setMapRawEvent(null)}
          onSuccess={() => setMapRawEvent(null)}
        />
      )}

      {/* Map to Employee modal (Tab 1 — bulk selection) */}
      {bulkCluster && bulkMapOpen && !syntheticCluster && (
        <MapToEmployeeModal
          cluster={bulkCluster}
          onClose={() => setBulkMapOpen(false)}
          onSuccess={() => { setBulkMapOpen(false); clearSelection(); }}
        />
      )}
    </>
  );
}
