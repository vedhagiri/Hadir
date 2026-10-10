/**
 * Unidentified Faces — review faces the cameras saw but could not match,
 * and map them to the right employee.
 *
 * Layout: header → summary StatGrid → ONE flat tab bar (Unknown faces ·
 * Similarity groups · Mapped faces · Mapped by employee, synced to
 * ``?tab=``) → toolbar (date presets, camera, sort, density, select) →
 * tab content.
 *
 * Performance notes (unchanged):
 *  - ``loading="lazy"`` on every crop; ``placeholderData`` keeps the
 *    previous page visible while the next loads.
 *  - Threshold / min-appearances inputs are debounced (400 ms) so the
 *    server only re-clusters after the operator stops adjusting.
 *  - Skeletons match the real tile / card shapes so nothing jumps.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import { extractApiError } from "../../api/client";
import { DatePicker } from "../../components/DatePicker";
import { EmptyPanel, FilterSelect, StatCard, StatGrid, Toolbar } from "../../components/ListPageUi";
import { SkeletonCards } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { ATT_ICON, StrokeIcon, fieldDateStyle } from "../attendance/attendanceUi";
import { ClusterDrawer } from "./ClusterDrawer";
import { FaceViewer } from "./FaceViewer";
import {
  useCameraList,
  useMappedClusters,
  useMappedFaces,
  useRawUnidentifiedFaces,
  useUnidentifiedFaceClusters,
} from "./hooks";
import type { AnyMapResult } from "./MapToEmployee";
import { MapFlow, MapResultSummary, MapToEmployeeModal } from "./MapToEmployee";
import { MappedEmployeeCard, MappedFacePanel, MappedFaceTile, UnmapConfirmModal } from "./MappedViews";
import type {
  FaceClusterOut,
  MappedEmployeeGroupOut,
  MappedFaceEventOut,
  RawFaceEventOut,
  RawUnidentifiedFilters,
  UnidentifiedFacesFilters,
} from "./types";
import type { Density, RangePreset } from "./ufUi";
import {
  Fact,
  FaceImg,
  TonePill,
  matchPreset,
  presetRange,
  similarityTone,
  todayIso,
  useDayGrouper,
  useDensity,
  useFmtDate,
} from "./ufUi";
import "./unidentified-faces.css";

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.65;
const DEFAULT_MIN_COUNT = 1;
const PAGE_SIZE = 24;
const RAW_PAGE_SIZE = 48;
const MAPPED_PAGE_SIZE = 48;
const MAPPED_CLUSTERS_PAGE_SIZE = 24;
const DEBOUNCE_MS = 400;
const MAX_EVENTS_PER_REQUEST = 200;

type Tab = "unknown" | "groups" | "mapped" | "mapped-employees";
const TABS: Tab[] = ["unknown", "groups", "mapped", "mapped-employees"];
type SortOrder = "newest" | "oldest";

function parseTab(v: string | null): Tab {
  // Legacy-friendly aliases for old links.
  if (v === "raw") return "unknown";
  if (v === "clusters") return "groups";
  return TABS.includes(v as Tab) ? (v as Tab) : "unknown";
}

/**
 * Server lists are newest-first. "Oldest first" walks the server pages
 * backwards and reverses each one, which yields a true global
 * oldest-first order (page 1 may be shorter than the rest).
 */
function serverPageFor(page: number, total: number | undefined, pageSize: number, sort: SortOrder): number {
  if (sort === "newest" || total === undefined) return page;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return Math.max(1, totalPages - page + 1);
}

// ── Small presentational pieces ────────────────────────────────────────

function FaceGridSkeleton({ count, density, grouped = true }: { count: number; density: Density; grouped?: boolean }) {
  return (
    <div role="status" aria-label="Loading" className="unid-sk-wrap">
      {grouped && <div className="unid-skeleton unid-sk-dayhead" />}
      <div className={`unid-face-grid is-${density}`}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="unid-face is-skeleton" style={{ opacity: Math.max(0.25, 1 - i * 0.035) }}>
            <span className="unid-face-img unid-skeleton" />
            <span className="unid-face-caption">
              <span className="unid-skeleton" style={{ width: "40%", height: 9 }} />
              <span className="unid-skeleton" style={{ width: "55%", height: 9 }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupCardSkeleton({ count, strip = false }: { count: number; strip?: boolean }) {
  return (
    <div role="status" aria-label="Loading" className={`unid-group-grid${strip ? " is-wide" : ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="unid-group-card is-skeleton" style={{ opacity: Math.max(0.25, 1 - i * 0.07) }}>
          <span className={`unid-skeleton ${strip ? "unid-sk-strip" : "unid-sk-mosaic"}`} />
          <div className="unid-group-body">
            <span className="unid-skeleton" style={{ width: "50%", height: 12 }} />
            <span className="unid-skeleton" style={{ width: "75%", height: 9 }} />
            <span className="unid-skeleton" style={{ width: "40%", height: 9 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DayHeader({
  label,
  count,
  selectable,
  allSelected,
  onSelectAll,
}: {
  label: string;
  count: number;
  selectable: boolean;
  allSelected: boolean;
  onSelectAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="unid-dayhead">
      <span className="unid-dayhead-label">{label}</span>
      <span className="unid-dayhead-count">
        {t("unidentifiedFaces.nFaces", { defaultValue: "{{count}} faces", defaultValue_one: "{{count}} face", count })}
      </span>
      <span className="unid-dayhead-line" aria-hidden />
      {selectable && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onSelectAll} aria-pressed={allSelected}>
          <Icon name={allSelected ? "x" : "check"} size={12} />
          {allSelected
            ? t("unidentifiedFaces.deselectDay", { defaultValue: "Deselect day" })
            : t("unidentifiedFaces.selectDay", { defaultValue: "Select day" })}
        </button>
      )}
    </div>
  );
}

function UnknownFaceTile({
  event,
  selected,
  selectMode,
  onToggleSelect,
  onView,
  onMap,
}: {
  event: RawFaceEventOut;
  selected: boolean;
  selectMode: boolean;
  onToggleSelect: (id: number) => void;
  onView: (event: RawFaceEventOut) => void;
  onMap: (event: RawFaceEventOut) => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const fmtDate = useFmtDate();
  const when = fmtDate(event.captured_at);
  return (
    <div className={`unid-face${selected ? " is-selected" : ""}${selectMode ? " is-selecting" : ""}`}>
      <button
        type="button"
        className="unid-face-img"
        onClick={() => (selectMode ? onToggleSelect(event.id) : onView(event))}
        aria-label={
          (selectMode
            ? t("unidentifiedFaces.toggleSelect", "{{action}} face detected at {{time}}", {
                action: selected ? t("unidentifiedFaces.deselect", { defaultValue: "Deselect" }) : t("unidentifiedFaces.select", { defaultValue: "Select" }),
                time: when,
              })
            : t("unidentifiedFaces.viewFace", "View face detected at {{time}}", { time: when })) as string
        }
      >
        <FaceImg id={event.id} hasCrop={event.has_crop} />
        {!event.has_embedding && (
          <span className="unid-face-flag" title={t("unidentifiedFaces.noFaceDataHint", { defaultValue: "No face data — this face can't be grouped" }) as string}>
            {t("unidentifiedFaces.noFaceDataShort", { defaultValue: "No face data" })}
          </span>
        )}
      </button>
      <span
        role="checkbox"
        aria-checked={selected}
        aria-label={t("unidentifiedFaces.selectFace", "Select this face") as string}
        tabIndex={0}
        className="unid-face-check"
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(event.id);
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onToggleSelect(event.id);
          }
        }}
      >
        {selected && <Icon name="check" size={12} />}
      </span>
      {!selectMode && (
        <button
          type="button"
          className="unid-face-action"
          onClick={(e) => {
            e.stopPropagation();
            onMap(event);
          }}
          aria-label={t("unidentifiedFaces.mapToEmployee", "Map to Employee") as string}
          title={t("unidentifiedFaces.mapToEmployee", "Map to Employee") as string}
        >
          <Icon name="user" size={12} />
          <span>{t("unidentifiedFaces.mapShort", { defaultValue: "Map" })}</span>
        </button>
      )}
      <div className="unid-face-caption">
        <span className="mono">{dt.formatTime(event.captured_at) || when}</span>
        <span className="unid-face-cam" title={event.camera_name}>
          {event.camera_name}
        </span>
      </div>
    </div>
  );
}

function ClusterCard({
  cluster,
  onOpen,
  onMap,
}: {
  cluster: FaceClusterOut;
  onOpen: (c: FaceClusterOut) => void;
  onMap: (c: FaceClusterOut) => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const simPct = Math.round(cluster.avg_similarity * 100);
  // Representative first, then the other crops.
  const ids = [
    ...(cluster.crop_event_ids.includes(cluster.representative_event_id) ? [cluster.representative_event_id] : []),
    ...cluster.crop_event_ids.filter((id) => id !== cluster.representative_event_id),
  ];
  const shown = ids.slice(0, 4);
  const extra = cluster.count - shown.length;
  const q = cluster.event_qualities.reduce(
    (acc, v) => {
      if (v === "high" || v === "medium" || v === "low") acc[v] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );
  const qTotal = q.high + q.medium + q.low;
  const sameDay = dt.formatDate(cluster.first_seen) === dt.formatDate(cluster.last_seen);

  return (
    <article className="unid-group-card">
      <button
        type="button"
        className={`unid-mosaic n-${Math.max(1, shown.length)}`}
        onClick={() => onOpen(cluster)}
        aria-label={t("unidentifiedFaces.clusterOf", "Cluster of {{count}} faces", { count: cluster.count }) as string}
      >
        {shown.length === 0 ? (
          <span className="unid-img-fallback" aria-hidden>
            <Icon name="user" size={30} />
          </span>
        ) : (
          shown.map((id, i) => (
            <span key={id} className="unid-mosaic-cell">
              <FaceImg id={id} />
              {i === shown.length - 1 && extra > 0 && <span className="unid-mosaic-more">+{extra}</span>}
            </span>
          ))
        )}
      </button>
      <div className="unid-group-body">
        <div className="unid-group-top">
          <span className="unid-group-title">
            {t("unidentifiedFaces.nFaces", { defaultValue: "{{count}} faces", defaultValue_one: "{{count}} face", count: cluster.count })}
          </span>
          <TonePill tone={similarityTone(simPct)} title={t("unidentifiedFaces.avgSim", "avg similarity") as string}>
            {simPct}%
          </TonePill>
        </div>
        <div className="unid-group-facts">
          <span>
            <Icon name="clock" size={12} />
            {sameDay
              ? `${dt.formatDate(cluster.first_seen)} · ${dt.formatTime(cluster.first_seen)} – ${dt.formatTime(cluster.last_seen)}`
              : `${dt.formatDate(cluster.first_seen)} → ${dt.formatDate(cluster.last_seen)}`}
          </span>
          <span title={cluster.camera_names.join(", ")}>
            <Icon name="camera" size={12} />
            {cluster.camera_names[0] ?? "—"}
            {cluster.camera_names.length > 1 && <span className="text-dim"> +{cluster.camera_names.length - 1}</span>}
          </span>
        </div>
        {qTotal > 0 && (
          <div
            className="unid-qbar"
            aria-label={t("unidentifiedFaces.qualityDistribution", "Image quality distribution") as string}
            title={t("unidentifiedFaces.qualityTooltip", "{{h}} high · {{m}} medium · {{l}} low", { h: q.high, m: q.medium, l: q.low }) as string}
          >
            {q.high > 0 && <span className="tone-success" style={{ flexGrow: q.high }} />}
            {q.medium > 0 && <span className="tone-warning" style={{ flexGrow: q.medium }} />}
            {q.low > 0 && <span className="tone-neutral" style={{ flexGrow: q.low }} />}
          </div>
        )}
      </div>
      <div className="unid-group-foot">
        <button type="button" className="btn btn-sm unid-grow" onClick={() => onMap(cluster)}>
          <Icon name="user" size={13} />
          {t("unidentifiedFaces.mapGroup", { defaultValue: "Map group to employee" })}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost unid-icon-btn"
          onClick={() => onOpen(cluster)}
          aria-label={t("unidentifiedFaces.viewAllFaces", { defaultValue: "View all faces" }) as string}
          title={t("unidentifiedFaces.viewAllFaces", { defaultValue: "View all faces" }) as string}
        >
          <Icon name="eye" size={14} />
        </button>
      </div>
    </article>
  );
}

/** Compact "Adjust grouping" popover — threshold slider + min appearances. */
function GroupingPopover({
  threshold,
  minCount,
  onThreshold,
  onMinCount,
  onReset,
}: {
  threshold: number;
  minCount: number;
  onThreshold: (v: number) => void;
  onMinCount: (v: number) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const isDefault = threshold === DEFAULT_THRESHOLD && minCount === DEFAULT_MIN_COUNT;

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const fillPct = ((threshold - 0.4) / (0.99 - 0.4)) * 100;
  return (
    <div ref={wrapRef} className="unid-pop-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`mg-control${isDefault ? "" : " is-active"}${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="settings" size={14} />
        <span className="mg-control-label">{t("unidentifiedFaces.adjustGrouping", { defaultValue: "Grouping" })}:</span>
        <span className="mg-control-value">
          {Math.round(threshold * 100)}% · {t("unidentifiedFaces.minShort", { defaultValue: "min {{n}}", n: minCount })}
        </span>
        <span aria-hidden className="mg-control-chev">
          <Icon name="chevronDown" size={13} />
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label={t("unidentifiedFaces.adjustGroupingTitle", { defaultValue: "Adjust grouping" }) as string} className="unid-pop">
          <div className="unid-pop-head">
            <span className="unid-pop-title">{t("unidentifiedFaces.adjustGroupingTitle", { defaultValue: "Adjust grouping" })}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onReset} disabled={isDefault} title={t("unidentifiedFaces.resetDefaultsHint", "Reset threshold and min appearances to defaults") as string}>
              {t("unidentifiedFaces.resetDefaults", "Reset defaults")}
            </button>
          </div>
          <div className="unid-thresh-header">
            <span className="unid-thresh-label">{t("unidentifiedFaces.threshold", "Similarity Threshold")}</span>
            <span className="unid-thresh-badge" aria-live="polite">
              {(threshold * 100).toFixed(0)}%
            </span>
          </div>
          <input
            type="range"
            min={0.4}
            max={0.99}
            step={0.01}
            value={threshold}
            aria-label={t("unidentifiedFaces.threshold", "Similarity Threshold") as string}
            className="unid-thresh-slider"
            style={{ "--fill-pct": `${fillPct}%` } as React.CSSProperties}
            onChange={(e) => onThreshold(parseFloat(e.target.value))}
          />
          <div className="unid-thresh-zones">
            <div className="unid-thresh-zone">
              <span>40%</span>
              <span>{t("unidentifiedFaces.looser", "Broad")}</span>
            </div>
            <div className="unid-thresh-zone is-mid">
              <span>~65%</span>
              <span>{t("unidentifiedFaces.balanced", "Balanced")}</span>
            </div>
            <div className="unid-thresh-zone is-end">
              <span>99%</span>
              <span>{t("unidentifiedFaces.tighter", "Strict")}</span>
            </div>
          </div>
          <p className="unid-thresh-hint">
            {t("unidentifiedFaces.thresholdHint", "Higher values create tighter, more distinct clusters. Lower values group faces more broadly.")}
          </p>
          <label className="unid-pop-row">
            <span>
              <span className="unid-thresh-label">{t("unidentifiedFaces.minCount", "Min appearances")}</span>
              <span className="unid-thresh-hint">
                {t("unidentifiedFaces.minCountHint", { defaultValue: "Hide groups seen fewer times than this." })}
              </span>
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={minCount}
              className="input sm unid-pop-num"
              onChange={(e) => onMinCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function DensityToggle({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  const { t } = useTranslation();
  const btn = (d: Density, label: string, icon: ReactNode) => (
    <button type="button" aria-pressed={value === d} aria-label={label} title={label} className={`seg-btn${value === d ? " active" : ""}`} onClick={() => onChange(d)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {icon}
      </svg>
    </button>
  );
  return (
    <div role="group" aria-label={t("unidentifiedFaces.density", { defaultValue: "Grid density" }) as string} className="seg unid-seg">
      {btn(
        "comfortable",
        t("unidentifiedFaces.densityComfortable", { defaultValue: "Comfortable" }) as string,
        <>
          <rect x="3" y="3" width="8" height="8" rx="1.5" />
          <rect x="13" y="3" width="8" height="8" rx="1.5" />
          <rect x="3" y="13" width="8" height="8" rx="1.5" />
          <rect x="13" y="13" width="8" height="8" rx="1.5" />
        </>,
      )}
      {btn(
        "compact",
        t("unidentifiedFaces.densityCompact", { defaultValue: "Compact" }) as string,
        <>
          <rect x="3" y="3" width="5" height="5" rx="1" />
          <rect x="10" y="3" width="5" height="5" rx="1" />
          <rect x="17" y="3" width="4" height="5" rx="1" />
          <rect x="3" y="10" width="5" height="5" rx="1" />
          <rect x="10" y="10" width="5" height="5" rx="1" />
          <rect x="17" y="10" width="4" height="5" rx="1" />
          <rect x="3" y="17" width="5" height="4" rx="1" />
          <rect x="10" y="17" width="5" height="4" rx="1" />
          <rect x="17" y="17" width="4" height="4" rx="1" />
        </>,
      )}
    </div>
  );
}

// ── Unknown-face viewer (with the inline map flow) ─────────────────────

function UnknownFaceViewer({
  items,
  startId,
  onClose,
}: {
  items: RawFaceEventOut[];
  startId: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  // Snapshot the list at open time so prev/next stays stable while
  // mapped faces drop out of the live grid behind the viewer.
  const [list] = useState(items);
  const [idx, setIdx] = useState(() => Math.max(0, items.findIndex((e) => e.id === startId)));
  const [mapped, setMapped] = useState<Map<number, AnyMapResult>>(() => new Map());

  const nextUnmapped = (from: number): number | null => {
    for (let i = from + 1; i < list.length; i += 1) {
      const e = list[i];
      if (e && !mapped.has(e.id)) return i;
    }
    return null;
  };

  return (
    <FaceViewer
      items={list}
      index={idx}
      onIndex={setIdx}
      onClose={onClose}
      getId={(e) => e.id}
      hasCrop={(e) => e.has_crop}
      label={t("unidentifiedFaces.viewerTitle", "Face detection") as string}
      thumbBadge={(e) =>
        mapped.has(e.id) ? (
          <span className="unid-thumb-tick" aria-hidden>
            <Icon name="check" size={10} />
          </span>
        ) : null
      }
      renderHeader={(e) => (
        <>
          <div className="unid-viewer-eyebrow">
            <span className={`pill ${mapped.has(e.id) ? "pill-success" : "pill-warning"} unid-mini-pill`}>
              {mapped.has(e.id)
                ? t("unidentifiedFaces.mappedChip", "MAPPED")
                : t("unidentifiedFaces.unknownChip", { defaultValue: "Unknown" })}
            </span>
            <span className="mono text-dim text-xs">#{e.id}</span>
          </div>
          <div className="unid-viewer-title">{t("unidentifiedFaces.unknownFace", "Unknown Face")}</div>
          <div className="unid-viewer-sub">{dt.formatDateTime(e.captured_at)}</div>
        </>
      )}
      renderPanel={(e) => {
        const done = mapped.get(e.id);
        const next = nextUnmapped(idx);
        return (
          <>
            <dl className="unid-facts">
              <Fact label={t("unidentifiedFaces.detectionTimeLabel", "Detection time")}>{dt.formatTimeWithSeconds(e.captured_at) || "—"}</Fact>
              <Fact label={t("unidentifiedFaces.camera", "Camera")}>{e.camera_name}</Fact>
              <Fact label={t("unidentifiedFaces.faceData", { defaultValue: "Face data" })}>
                {e.has_embedding ? (
                  <TonePill tone="success">{t("unidentifiedFaces.faceDataYes", { defaultValue: "Available" })}</TonePill>
                ) : (
                  <TonePill tone="warning">{t("unidentifiedFaces.noFaceDataShort", { defaultValue: "No face data" })}</TonePill>
                )}
              </Fact>
            </dl>
            {done ? (
              <MapResultSummary
                result={done}
                extra={
                  next !== null ? (
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => setIdx(next)}>
                      {t("unidentifiedFaces.nextFace", { defaultValue: "Next face" })}
                      <Icon name="chevronRight" size={13} />
                    </button>
                  ) : null
                }
                onDone={onClose}
                doneLabel={t("common.close", "Close") as string}
              />
            ) : (
              <MapFlow
                key={e.id}
                variant="panel"
                cluster={{
                  cluster_id: `raw_${e.id}`,
                  representative_event_id: e.id,
                  event_ids: [e.id],
                  crop_event_ids: e.has_crop ? [e.id] : [],
                  count: 1,
                  first_seen: e.captured_at,
                  last_seen: e.captured_at,
                  camera_ids: [e.camera_id],
                  camera_names: [e.camera_name],
                  avg_similarity: 0,
                  event_similarities: [],
                  event_qualities: [],
                  event_face_types: [],
                }}
                onClose={onClose}
                onSuccess={(r) =>
                  setMapped((prev) => {
                    const m = new Map(prev);
                    m.set(e.id, r);
                    return m;
                  })
                }
              />
            )}
          </>
        );
      }}
    />
  );
}

// ── Main page ──────────────────────────────────────────────────────────

export function UnidentifiedFacesPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));
  const setTab = useCallback(
    (next: Tab) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === "unknown") p.delete("tab");
          else p.set("tab", next);
          return p;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // ── Shared filter state (date range + camera + clustering knobs) ──
  const [filters, setFilters] = useState<UnidentifiedFacesFilters>({
    start: todayIso(),
    end: todayIso(),
    camera_id: null,
    min_count: DEFAULT_MIN_COUNT,
    threshold: DEFAULT_THRESHOLD,
    page: 1,
    page_size: PAGE_SIZE,
  });
  const [uiThreshold, setUiThreshold] = useState(DEFAULT_THRESHOLD);
  const [uiMinCount, setUiMinCount] = useState(DEFAULT_MIN_COUNT);
  const [customRange, setCustomRange] = useState(false);
  const preset: RangePreset = customRange ? "custom" : matchPreset(filters.start, filters.end);

  const [density, setDensity] = useDensity();
  const [sort, setSort] = useState<SortOrder>("newest");

  // ── Unknown faces state ──
  const [rawPage, setRawPage] = useState(1);
  const [rawHasEmbedding, setRawHasEmbedding] = useState<boolean | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectOn, setSelectOn] = useState(false);
  const selectMode = selectOn || selectedIds.size > 0;

  // ── Mapped state ──
  const [mappedPage, setMappedPage] = useState(1);
  const [mappedClustersPage, setMappedClustersPage] = useState(1);
  const [mappedEmployee, setMappedEmployee] = useState<{ id: number; name: string } | null>(null);

  // ── Overlays ──
  const [openCluster, setOpenCluster] = useState<FaceClusterOut | null>(null);
  const [mapCluster, setMapCluster] = useState<FaceClusterOut | null>(null);
  const [mapRawEvent, setMapRawEvent] = useState<RawFaceEventOut | null>(null);
  const [bulkMapOpen, setBulkMapOpen] = useState(false);
  const [viewer, setViewer] = useState<{ items: RawFaceEventOut[]; id: number } | null>(null);
  const [mappedViewer, setMappedViewer] = useState<{ items: MappedFaceEventOut[]; idx: number } | null>(null);
  const [unmapTarget, setUnmapTarget] = useState<MappedFaceEventOut | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const announceMapped = useCallback(
    (r: AnyMapResult) =>
      setToast(
        t("unidentifiedFaces.toastMapped", {
          defaultValue: "Mapped {{n}} face(s) to {{name}}.",
          n: r.data.mapped_events,
          name: r.employee.full_name,
        }) as string,
      ),
    [t],
  );

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectOn(false);
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameras = useCameraList();

  // ── Queries (all four stay live so the stats + tab counts are real) ──
  const clusterResult = useUnidentifiedFaceClusters(filters);
  const clusterData = clusterResult.data;
  const clusters = clusterData?.clusters ?? [];
  const totalClusterPages = Math.max(1, Math.ceil((clusterData?.total_clusters ?? 0) / PAGE_SIZE));

  const [rawTotalHint, setRawTotalHint] = useState<number | undefined>(undefined);
  const rawQueryFilters: RawUnidentifiedFilters = {
    start: filters.start,
    end: filters.end,
    camera_id: filters.camera_id,
    has_embedding: rawHasEmbedding,
    page: serverPageFor(rawPage, rawTotalHint, RAW_PAGE_SIZE, sort),
    page_size: RAW_PAGE_SIZE,
  };
  const rawResult = useRawUnidentifiedFaces(rawQueryFilters);
  const rawData = rawResult.data;
  const totalRawPages = Math.max(1, Math.ceil((rawData?.total ?? 0) / RAW_PAGE_SIZE));
  useEffect(() => {
    if (rawData && !rawResult.isPlaceholderData) setRawTotalHint(rawData.total);
  }, [rawData, rawResult.isPlaceholderData]);

  const [mappedTotalHint, setMappedTotalHint] = useState<number | undefined>(undefined);
  const mappedResult = useMappedFaces({
    start: filters.start,
    end: filters.end,
    camera_id: filters.camera_id,
    employee_id: mappedEmployee?.id ?? null,
    page: serverPageFor(mappedPage, mappedTotalHint, MAPPED_PAGE_SIZE, sort),
    page_size: MAPPED_PAGE_SIZE,
  });
  const mappedData = mappedResult.data;
  const totalMappedPages = Math.max(1, Math.ceil((mappedData?.total ?? 0) / MAPPED_PAGE_SIZE));
  useEffect(() => {
    if (mappedData && !mappedResult.isPlaceholderData) setMappedTotalHint(mappedData.total);
  }, [mappedData, mappedResult.isPlaceholderData]);

  const mappedClustersResult = useMappedClusters({
    start: filters.start,
    end: filters.end,
    camera_id: filters.camera_id,
    page: mappedClustersPage,
    page_size: MAPPED_CLUSTERS_PAGE_SIZE,
  });
  const mappedClustersData = mappedClustersResult.data;
  const totalMappedClustersPages = Math.max(1, Math.ceil((mappedClustersData?.total ?? 0) / MAPPED_CLUSTERS_PAGE_SIZE));

  // Display order (server is newest-first; oldest reverses each page).
  const rawItems = rawData ? (sort === "oldest" ? [...rawData.items].reverse() : rawData.items) : [];
  const mappedItems = mappedData ? (sort === "oldest" ? [...mappedData.items].reverse() : mappedData.items) : [];

  const groupByDay = useDayGrouper();

  // ── Filter commits ──
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
    setMappedPage(1);
    setMappedClustersPage(1);
    setSelectedIds(new Set());
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const applyPreset = (p: RangePreset) => {
    if (p === "custom") {
      setCustomRange(true);
      return;
    }
    setCustomRange(false);
    commitNow(presetRange(p));
  };

  const changeSort = (s: SortOrder) => {
    setSort(s);
    setRawPage(1);
    setMappedPage(1);
  };

  const resetGrouping = () => {
    setUiThreshold(DEFAULT_THRESHOLD);
    setUiMinCount(DEFAULT_MIN_COUNT);
    commitNow({ threshold: DEFAULT_THRESHOLD, min_count: DEFAULT_MIN_COUNT });
  };

  const resetAllFilters = () => {
    setUiThreshold(DEFAULT_THRESHOLD);
    setUiMinCount(DEFAULT_MIN_COUNT);
    setCustomRange(false);
    setRawHasEmbedding(null);
    setMappedEmployee(null);
    commitNow({ start: todayIso(), end: todayIso(), camera_id: null, threshold: DEFAULT_THRESHOLD, min_count: DEFAULT_MIN_COUNT });
  };

  // ── Bulk selection → synthetic cluster for the existing map modal ──
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

  // Single-face Map (hover action) → synthetic one-event cluster.
  const singleCluster: FaceClusterOut | null = mapRawEvent
    ? {
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
      }
    : null;

  // ── Shared renderers ──
  const renderPagination = (page: number, total: number, onPage: (p: number) => void) => {
    if (total <= 1) return null;
    return (
      <nav className="unid-pager" aria-label={t("unidentifiedFaces.pagination", { defaultValue: "Pagination" }) as string}>
        <button type="button" onClick={() => onPage(1)} disabled={page <= 1} className="btn btn-sm btn-ghost" aria-label={t("common.first", "First page") as string}>
          «
        </button>
        <button type="button" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1} className="btn btn-sm btn-ghost" aria-label={t("common.previous", "Previous page") as string}>
          <Icon name="chevronLeft" size={14} />
        </button>
        {Array.from({ length: Math.min(5, total) }, (_, i) => {
          const startP = Math.max(1, Math.min(page - 2, total - 4));
          const p = startP + i;
          if (p > total) return null;
          return (
            <button
              type="button"
              key={p}
              onClick={() => onPage(p)}
              className={p === page ? "btn btn-sm unid-page-active" : "btn btn-sm btn-ghost"}
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </button>
          );
        })}
        <button type="button" onClick={() => onPage(Math.min(total, page + 1))} disabled={page >= total} className="btn btn-sm btn-ghost" aria-label={t("common.next", "Next page") as string}>
          <Icon name="chevronRight" size={14} />
        </button>
        <button type="button" onClick={() => onPage(total)} disabled={page >= total} className="btn btn-sm btn-ghost" aria-label={t("common.last", "Last page") as string}>
          »
        </button>
        <span className="text-xs text-dim unid-pager-label">{t("unidentifiedFaces.page", "Page {{page}} of {{total}}", { page, total })}</span>
      </nav>
    );
  };

  const renderError = (error: unknown, retry: () => void) => (
    <div className="card">
      <EmptyPanel
        tone="danger"
        icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
        title={t("unidentifiedFaces.loadFailedTitle", "Couldn't load unidentified faces") as string}
        body={extractApiError(error, t("unidentifiedFaces.loadFailed", "Could not load unidentified faces.") as string)}
        actions={
          <button type="button" className="btn" onClick={retry}>
            <Icon name="refresh" size={12} />
            {t("unidentifiedFaces.retry", "Retry")}
          </button>
        }
      />
    </div>
  );

  const widenAction =
    preset !== "30d" ? (
      <button type="button" className="btn btn-primary" onClick={() => applyPreset("30d")}>
        <Icon name="calendar" size={13} />
        {t("unidentifiedFaces.widenRange", { defaultValue: "Show last 30 days" })}
      </button>
    ) : null;

  const reviewUnknownAction =
    (rawData?.total ?? 0) > 0 ? (
      <button type="button" className="btn btn-primary" onClick={() => setTab("unknown")}>
        <Icon name="user" size={13} />
        {t("unidentifiedFaces.reviewUnknown", { defaultValue: "Review unknown faces" })}
      </button>
    ) : null;

  const renderEmpty = (title: string, body: string, extra?: ReactNode) => {
    // Camera / face-data / employee filters narrow the view → offer reset.
    const narrowed = filters.camera_id !== null || (tab === "unknown" && rawHasEmbedding !== null) || (tab === "mapped" && mappedEmployee !== null);
    return (
      <div className="card">
        {narrowed ? (
          <EmptyPanel
            tone="neutral"
            icon={<Icon name="filter" size={28} />}
            title={t("unidentifiedFaces.noResultsTitle", "No results for these filters") as string}
            body={
              t("unidentifiedFaces.noResultsBody", {
                defaultValue: "Nothing in this date range matches the current camera / face-data / employee filter. Clear the filters to see everything.",
              }) as string
            }
            actions={
              <button type="button" className="btn" onClick={resetAllFilters}>
                <Icon name="refresh" size={12} />
                {t("unidentifiedFaces.clearFilters", "Clear filters")}
              </button>
            }
          />
        ) : (
          <EmptyPanel
            tone="accent"
            icon={<StrokeIcon>{ATT_ICON.face}</StrokeIcon>}
            title={title}
            body={body}
            actions={
              <>
                {widenAction}
                {extra}
                <Link to="/camera-logs" className="btn">
                  <Icon name="camera" size={13} />
                  {t("unidentifiedFaces.viewCameraLogs", "View camera logs")}
                </Link>
              </>
            }
          />
        )}
      </div>
    );
  };

  // ── Stats ──
  const unknownTotal = rawHasEmbedding === null ? rawData?.total : clusterData?.total_unidentified_events;
  const mappedTotal = mappedClustersData?.total_events;
  const statsReady = unknownTotal !== undefined && mappedTotal !== undefined;
  const noRecordsAtAll = statsReady && unknownTotal === 0 && mappedTotal === 0 && rawHasEmbedding === null;
  const noFaceData = rawData?.events_without_embedding ?? 0;

  const tabCount = (tb: Tab): number | undefined =>
    tb === "unknown"
      ? rawData?.total
      : tb === "groups"
        ? clusterData?.total_clusters
        : tb === "mapped"
          ? mappedData?.total
          : mappedClustersData?.total_employees;
  const tabLabel = (tb: Tab): string =>
    tb === "unknown"
      ? (t("unidentifiedFaces.tabUnknown", { defaultValue: "Unknown faces" }) as string)
      : tb === "groups"
        ? (t("unidentifiedFaces.tabSimilarityGroups", { defaultValue: "Similarity groups" }) as string)
        : tb === "mapped"
          ? (t("unidentifiedFaces.tabMappedFaces", { defaultValue: "Mapped faces" }) as string)
          : (t("unidentifiedFaces.tabMappedEmployees", { defaultValue: "Mapped by employee" }) as string);

  const isGridTab = tab === "unknown" || tab === "mapped";

  // ── Unknown faces grid body ──
  const unknownBody = (() => {
    if (rawResult.isError && !rawData) return renderError(rawResult.error, () => void rawResult.refetch());
    if (rawResult.isLoading && !rawData) return <FaceGridSkeleton count={24} density={density} />;
    if (!rawData) return null;
    if (rawData.items.length === 0) {
      return renderEmpty(
        t("unidentifiedFaces.emptyUnknownTitle", { defaultValue: "No unknown faces in this range" }) as string,
        t(
          "unidentifiedFaces.emptyNoneBody",
          "Every face the cameras saw in this range was matched to an employee. Widen the date range above, or come back as new detections arrive.",
        ) as string,
      );
    }
    const groups = groupByDay(rawItems, (e) => e.captured_at);
    return (
      <div className={rawResult.isPlaceholderData ? "at-faded" : undefined}>
        {rawResult.isError && renderError(rawResult.error, () => void rawResult.refetch())}
        {groups.map((g) => {
          const allSel = g.items.every((e) => selectedIds.has(e.id));
          return (
            <section key={g.key} className="unid-day" aria-label={g.label}>
              <DayHeader
                label={g.label}
                count={g.items.length}
                selectable={selectMode}
                allSelected={allSel}
                onSelectAll={() =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    for (const e of g.items) {
                      if (allSel) next.delete(e.id);
                      else next.add(e.id);
                    }
                    return next;
                  })
                }
              />
              <div className={`unid-face-grid is-${density}`}>
                {g.items.map((ev) => (
                  <UnknownFaceTile
                    key={ev.id}
                    event={ev}
                    selected={selectedIds.has(ev.id)}
                    selectMode={selectMode}
                    onToggleSelect={toggleSelect}
                    onView={(e) => setViewer({ items: rawItems, id: e.id })}
                    onMap={setMapRawEvent}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {totalRawPages > 1 && (
          <p className="unid-day-note text-dim text-xs">
            {t("unidentifiedFaces.dayCountNote", { defaultValue: "Day counts are for this page ({{n}} of {{total}} faces).", n: rawData.items.length, total: rawData.total })}
          </p>
        )}
        {renderPagination(rawPage, totalRawPages, setRawPage)}
      </div>
    );
  })();

  // ── Similarity groups body ──
  const groupsBody = (() => {
    if (clusterResult.isError && !clusterData) return renderError(clusterResult.error, () => void clusterResult.refetch());
    if (clusterResult.isLoading && !clusterData) return <GroupCardSkeleton count={8} />;
    if (!clusterData) return null;
    const groupingTweaked = filters.threshold !== DEFAULT_THRESHOLD || filters.min_count !== DEFAULT_MIN_COUNT;
    return (
      <>
        {clusterData.capped && (
          <div className="unid-notice tone-warning" role="status">
            <Icon name="info" size={14} />
            {t("unidentifiedFaces.capped", "Capped at 5,000 most recent — narrow date range to see older events")}
          </div>
        )}
        {clusterData.events_without_embedding > 0 && clusterData.clusters.length > 0 && (
          <div className="unid-notice" role="note">
            <Icon name="info" size={14} />
            <span>
              {t("unidentifiedFaces.noFaceDataNote", {
                defaultValue: "{{n}} face(s) in this range have no face data and can't be grouped — find them under Unknown faces.",
                n: clusterData.events_without_embedding,
              })}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setRawHasEmbedding(false);
                setRawPage(1);
                setTab("unknown");
              }}
            >
              {t("unidentifiedFaces.showThem", { defaultValue: "Show them" })}
            </button>
          </div>
        )}
        {clusterData.clusters.length === 0 ? (
          renderEmpty(
            t("unidentifiedFaces.emptyGroupsTitle", { defaultValue: "No groups yet" }) as string,
            (groupingTweaked
              ? t("unidentifiedFaces.emptyHint", "Try expanding the date range or lowering the similarity threshold.")
              : t("unidentifiedFaces.emptyGroupsBody", {
                  defaultValue: "Unknown faces with face data in this range are grouped by similarity. Widen the range to find repeat visitors.",
                })) as string,
            groupingTweaked ? (
              <button type="button" className="btn" onClick={resetGrouping}>
                <Icon name="refresh" size={12} />
                {t("unidentifiedFaces.resetDefaults", "Reset defaults")}
              </button>
            ) : null,
          )
        ) : (
          <div className={clusterResult.isPlaceholderData ? "at-faded" : undefined}>
            <div className="unid-group-grid">
              {clusters.map((cluster) => (
                <ClusterCard key={cluster.cluster_id} cluster={cluster} onOpen={setOpenCluster} onMap={setMapCluster} />
              ))}
            </div>
            {renderPagination(filters.page, totalClusterPages, (p) => setFilters((f) => ({ ...f, page: p })))}
          </div>
        )}
      </>
    );
  })();

  // ── Mapped faces body ──
  const mappedBody = (() => {
    if (mappedResult.isError && !mappedData) return renderError(mappedResult.error, () => void mappedResult.refetch());
    if (mappedResult.isLoading && !mappedData) return <FaceGridSkeleton count={24} density={density} />;
    if (!mappedData) return null;
    if (mappedData.items.length === 0) {
      return renderEmpty(
        t("unidentifiedFaces.emptyMappedTitle", { defaultValue: "Nothing mapped yet" }) as string,
        t(
          "unidentifiedFaces.emptyMapped",
          "No manually-mapped detections yet. Use Map to Employee on an Unknown face to populate this tab — auto live-matches appear in Camera Logs.",
        ) as string,
        reviewUnknownAction,
      );
    }
    const groups = groupByDay(mappedItems, (e) => e.captured_at);
    return (
      <div className={mappedResult.isPlaceholderData ? "at-faded" : undefined}>
        {groups.map((g) => (
          <section key={g.key} className="unid-day" aria-label={g.label}>
            <DayHeader label={g.label} count={g.items.length} selectable={false} allSelected={false} onSelectAll={() => undefined} />
            <div className={`unid-face-grid is-${density}`}>
              {g.items.map((ev) => (
                <MappedFaceTile
                  key={ev.id}
                  event={ev}
                  onOpen={() => setMappedViewer({ items: mappedItems, idx: Math.max(0, mappedItems.findIndex((m) => m.id === ev.id)) })}
                  onUnmap={() => setUnmapTarget(ev)}
                />
              ))}
            </div>
          </section>
        ))}
        {renderPagination(mappedPage, totalMappedPages, setMappedPage)}
      </div>
    );
  })();

  // ── Mapped by employee body ──
  const mappedEmployeesBody = (() => {
    if (mappedClustersResult.isError && !mappedClustersData) return renderError(mappedClustersResult.error, () => void mappedClustersResult.refetch());
    if (mappedClustersResult.isLoading && !mappedClustersData) return <GroupCardSkeleton count={6} strip />;
    if (!mappedClustersData) return null;
    if (mappedClustersData.items.length === 0) {
      return renderEmpty(
        t("unidentifiedFaces.emptyMappedTitle", { defaultValue: "Nothing mapped yet" }) as string,
        t(
          "unidentifiedFaces.emptyMappedClusters",
          "No employees have manually-mapped detections in this date range. This tab only shows operator-reviewed maps from Reference / Attendance Mapping — auto live-matches appear in Camera Logs.",
        ) as string,
        reviewUnknownAction,
      );
    }
    return (
      <div className={mappedClustersResult.isPlaceholderData ? "at-faded" : undefined}>
        <div className="unid-group-grid is-wide">
          {mappedClustersData.items.map((emp) => (
            <MappedEmployeeCard
              key={emp.employee_id}
              group={emp}
              unmapFilter={{ start: filters.start, end: filters.end, camera_id: filters.camera_id }}
              onViewFaces={(g: MappedEmployeeGroupOut) => {
                setMappedEmployee({
                  id: g.employee_id,
                  name: g.employee_name ?? (t("unidentifiedFaces.employeeN", { defaultValue: "Employee #{{id}}", id: g.employee_id }) as string),
                });
                setMappedPage(1);
                setTab("mapped");
              }}
            />
          ))}
        </div>
        {renderPagination(mappedClustersPage, totalMappedClustersPages, setMappedClustersPage)}
      </div>
    );
  })();

  const rangeOptions: [RangePreset, string][] = [
    ["today", t("unidentifiedFaces.today", "Today") as string],
    ["yesterday", t("unidentifiedFaces.dayYesterday", { defaultValue: "Yesterday" }) as string],
    ["7d", t("unidentifiedFaces.last7", { defaultValue: "Last 7 days" }) as string],
    ["30d", t("unidentifiedFaces.last30", { defaultValue: "Last 30 days" }) as string],
    ["custom", t("unidentifiedFaces.custom", { defaultValue: "Custom" }) as string],
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("unidentifiedFaces.title", "Unidentified Faces")}</h1>
          <p className="page-sub">
            {t(
              "unidentifiedFaces.pageSub",
              "Faces the cameras saw but could not match to an employee. Review them and map each face to the right person.",
            )}
          </p>
        </div>
      </div>

      {/* ── Summary ── */}
      {!statsReady ? (
        <div className="unid-stats-sk">
          <SkeletonCards count={4} minWidth={210} />
        </div>
      ) : noRecordsAtAll ? null : (
        <StatGrid>
          <StatCard
            tone="warning"
            icon={<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0" />}
            label={t("unidentifiedFaces.statUnknown", { defaultValue: "Unknown faces" }) as string}
            value={unknownTotal ?? 0}
            sub={t("unidentifiedFaces.statInRange", { defaultValue: "In the selected range" }) as string}
            active={tab === "unknown" && rawHasEmbedding === null}
            onClick={() => {
              setRawHasEmbedding(null);
              setRawPage(1);
              setTab("unknown");
            }}
          />
          <StatCard
            tone="info"
            icon={
              <>
                <circle cx="8" cy="9" r="3" />
                <circle cx="16" cy="9" r="3" />
                <path d="M2 20a6 6 0 0 1 12 0M10 20a6 6 0 0 1 12 0" />
              </>
            }
            label={t("unidentifiedFaces.statGroups", { defaultValue: "Similarity groups" }) as string}
            value={clusterData?.total_clusters ?? 0}
            sub={
              (clusterData
                ? t("unidentifiedFaces.statGroupsSub", { defaultValue: "From {{n}} faces with face data", n: clusterData.events_with_embedding })
                : t("unidentifiedFaces.statGrouping", { defaultValue: "Grouping faces…" })) as string
            }
            active={tab === "groups"}
            onClick={() => setTab("groups")}
          />
          <StatCard
            tone="success"
            icon={<path d="M20 6 9 17l-5-5" />}
            label={t("unidentifiedFaces.statMapped", { defaultValue: "Mapped in range" }) as string}
            value={mappedTotal ?? 0}
            sub={
              t("unidentifiedFaces.statMappedSub", {
                defaultValue: "{{n}} employee(s)",
                n: mappedClustersData?.total_employees ?? 0,
              }) as string
            }
            active={tab === "mapped" || tab === "mapped-employees"}
            onClick={() => setTab("mapped")}
          />
          <StatCard
            tone="neutral"
            icon={
              <>
                <circle cx="12" cy="12" r="9" />
                <path d="M5.6 5.6 18.4 18.4" />
              </>
            }
            label={t("unidentifiedFaces.statNoFaceData", { defaultValue: "No face data" }) as string}
            value={noFaceData}
            sub={t("unidentifiedFaces.statNoFaceDataSub", { defaultValue: "Can't be grouped — review one by one" }) as string}
            active={tab === "unknown" && rawHasEmbedding === false}
            onClick={() => {
              setRawHasEmbedding((v) => (v === false && tab === "unknown" ? null : false));
              setRawPage(1);
              setTab("unknown");
            }}
          />
        </StatGrid>
      )}

      {/* ── Tabs (one flat level) ── */}
      <div role="tablist" aria-label={t("unidentifiedFaces.title", "Unidentified Faces") as string} className="tabs unid-tabs">
        {TABS.map((tb) => {
          const n = tabCount(tb);
          return (
            <button key={tb} type="button" role="tab" aria-selected={tab === tb} onClick={() => setTab(tb)} className={tab === tb ? "tab active" : "tab"}>
              {tabLabel(tb)}
              {n !== undefined && <span className="unid-tab-count">{n.toLocaleString()}</span>}
            </button>
          );
        })}
      </div>

      {/* ── Toolbar ── */}
      <Toolbar>
        <div role="group" aria-label={t("unidentifiedFaces.dateRange", { defaultValue: "Date range" }) as string} className="seg unid-seg">
          {rangeOptions.map(([p, label]) => (
            <button key={p} type="button" aria-pressed={preset === p} className={`seg-btn${preset === p ? " active" : ""}`} onClick={() => applyPreset(p)}>
              {label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="unid-range-custom">
            <DatePicker
              value={filters.start ?? ""}
              onChange={(v) => commitNow({ start: v || null })}
              max={filters.end || todayIso()}
              ariaLabel={t("unidentifiedFaces.from", "From") as string}
              triggerStyle={{ ...fieldDateStyle, width: 150 }}
            />
            <span className="text-dim" aria-hidden>
              →
            </span>
            <DatePicker
              value={filters.end ?? ""}
              onChange={(v) => commitNow({ end: v || null })}
              {...(filters.start ? { min: filters.start } : {})}
              max={todayIso()}
              ariaLabel={t("unidentifiedFaces.to", "To") as string}
              triggerStyle={{ ...fieldDateStyle, width: 150 }}
            />
          </div>
        )}
        {cameras.data && cameras.data.items.length > 0 && (
          <FilterSelect
            label={t("unidentifiedFaces.camera", "Camera") as string}
            value={filters.camera_id === null ? "" : String(filters.camera_id)}
            onChange={(v) => commitNow({ camera_id: v ? parseInt(v, 10) : null })}
            options={[
              ["", t("unidentifiedFaces.allCameras", "All cameras") as string],
              ...cameras.data.items.map((cam) => [String(cam.id), cam.name] as [string, string]),
            ]}
          />
        )}
        {tab === "unknown" && rawHasEmbedding === false && (
          <span className="unid-tag unid-tag-lg">
            {t("unidentifiedFaces.noFaceDataOnly", { defaultValue: "Only faces without face data" })}
            <button
              type="button"
              className="unid-tag-x"
              onClick={() => {
                setRawHasEmbedding(null);
                setRawPage(1);
              }}
              aria-label={t("unidentifiedFaces.clearFilters", "Clear filters") as string}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        )}
        {tab === "mapped" && mappedEmployee && (
          <span className="unid-tag unid-tag-lg">
            {t("unidentifiedFaces.employeeFilter", { defaultValue: "Employee: {{name}}", name: mappedEmployee.name })}
            <button
              type="button"
              className="unid-tag-x"
              onClick={() => {
                setMappedEmployee(null);
                setMappedPage(1);
              }}
              aria-label={t("unidentifiedFaces.clearFilters", "Clear filters") as string}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        )}

        <span className="unid-toolbar-spacer" />

        {tab === "groups" && (
          <GroupingPopover
            threshold={uiThreshold}
            minCount={uiMinCount}
            onThreshold={(v) => {
              setUiThreshold(v);
              scheduleCommit({ threshold: v });
            }}
            onMinCount={(v) => {
              setUiMinCount(v);
              scheduleCommit({ min_count: v });
            }}
            onReset={resetGrouping}
          />
        )}
        {isGridTab && (
          <div role="group" aria-label={t("unidentifiedFaces.sort", { defaultValue: "Sort" }) as string} className="seg unid-seg">
            {(["newest", "oldest"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={sort === s} className={`seg-btn${sort === s ? " active" : ""}`} onClick={() => changeSort(s)}>
                {s === "newest"
                  ? t("unidentifiedFaces.sortNewest", { defaultValue: "Newest" })
                  : t("unidentifiedFaces.sortOldest", { defaultValue: "Oldest" })}
              </button>
            ))}
          </div>
        )}
        {isGridTab && <DensityToggle value={density} onChange={setDensity} />}
        {tab === "unknown" && (
          <button
            type="button"
            className={`mg-control${selectMode ? " is-active" : ""}`}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? clearSelection() : setSelectOn(true))}
          >
            <Icon name={selectMode ? "x" : "check"} size={14} />
            {selectMode ? t("unidentifiedFaces.doneSelecting", { defaultValue: "Done" }) : t("unidentifiedFaces.selectMode", { defaultValue: "Select" })}
          </button>
        )}
      </Toolbar>

      {/* ── Tab content ── */}
      <div className="unid-content" role="tabpanel" aria-label={tabLabel(tab)}>
        {tab === "unknown" && unknownBody}
        {tab === "groups" && groupsBody}
        {tab === "mapped" && mappedBody}
        {tab === "mapped-employees" && mappedEmployeesBody}
      </div>

      {/* ── Bulk action bar (Unknown faces · select mode) ── */}
      {selectMode && tab === "unknown" && (
        <div role="toolbar" aria-label={t("unidentifiedFaces.bulkToolbar", "Bulk selection toolbar") as string} className="unid-bulkbar">
          <span className="unid-bulkbar-count">
            <span className="unid-bulkbar-check" aria-hidden>
              <Icon name="check" size={12} />
            </span>
            {selectedIds.size > 0
              ? t("unidentifiedFaces.selectedCount", "{{count}} selected", { count: selectedIds.size })
              : t("unidentifiedFaces.selectHint", { defaultValue: "Click faces to select them" })}
          </span>
          {rawData && rawData.items.some((ev) => !selectedIds.has(ev.id)) && (
            <button
              type="button"
              onClick={() =>
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  for (const ev of rawData.items) next.add(ev.id);
                  return next;
                })
              }
              className="btn btn-sm btn-ghost"
            >
              {t("unidentifiedFaces.selectAll", "Select all {{n}}", { n: rawData.items.length })}
            </button>
          )}
          {selectedIds.size > MAX_EVENTS_PER_REQUEST && (
            <span className="unid-bulkbar-warn">
              {t("unidentifiedFaces.bulkCapNote", { defaultValue: "Max {{max}} per mapping", max: MAX_EVENTS_PER_REQUEST })}
            </span>
          )}
          <span className="unid-bulkbar-sep" aria-hidden />
          <button type="button" onClick={clearSelection} className="btn btn-sm btn-ghost" aria-label={t("unidentifiedFaces.clearSelection", "Clear selection") as string}>
            {t("unidentifiedFaces.clear", { defaultValue: "Clear" })}
          </button>
          <button type="button" onClick={() => bulkCluster && setBulkMapOpen(true)} className="btn btn-sm btn-primary" disabled={selectedIds.size === 0}>
            <Icon name="user" size={13} />
            {t("unidentifiedFaces.mapToEmployee", "Map to Employee")}
          </button>
        </div>
      )}

      {toast && (
        <div className="unid-toast" role="status">
          <Icon name="check" size={14} />
          <span>{toast}</span>
          <button type="button" className="unid-tag-x" onClick={() => setToast(null)} aria-label={t("common.close", "Close") as string}>
            <Icon name="x" size={10} />
          </button>
        </div>
      )}

      {/* ── Overlays ── */}
      {openCluster && <ClusterDrawer cluster={openCluster} onClose={() => setOpenCluster(null)} onMapped={announceMapped} />}

      {viewer && <UnknownFaceViewer items={viewer.items} startId={viewer.id} onClose={() => setViewer(null)} />}

      {mappedViewer && (
        <FaceViewer
          items={mappedViewer.items}
          index={mappedViewer.idx}
          onIndex={(i) => setMappedViewer((v) => (v ? { ...v, idx: i } : v))}
          onClose={() => setMappedViewer(null)}
          getId={(e) => e.id}
          hasCrop={(e) => e.has_crop}
          label={t("unidentifiedFaces.mappedTileAria", "Mapped detection") as string}
          renderHeader={(e) => (
            <>
              <div className="unid-viewer-eyebrow">
                <span className="pill pill-success unid-mini-pill">{t("unidentifiedFaces.mappedChip", "MAPPED")}</span>
                <span className="mono text-dim text-xs">#{e.id}</span>
              </div>
              <div className="unid-viewer-title">{e.employee_name ?? `#${e.employee_id}`}</div>
              <div className="unid-viewer-sub">{e.camera_name}</div>
            </>
          )}
          renderPanel={(e) => (
            <MappedFacePanel
              event={e}
              onUnmap={() => {
                setMappedViewer(null);
                setUnmapTarget(e);
              }}
            />
          )}
        />
      )}

      {unmapTarget && (
        <UnmapConfirmModal
          eventIds={[unmapTarget.id]}
          subject={unmapTarget.employee_name ?? (t("unidentifiedFaces.employeeN", { defaultValue: "Employee #{{id}}", id: unmapTarget.employee_id }) as string)}
          onClose={() => setUnmapTarget(null)}
          onDone={(res) => {
            setUnmapTarget(null);
            setToast(
              t("unidentifiedFaces.unmapModal.cardSuccess", {
                defaultValue: "Reverted {{n}} mapping(s). {{dates}} day(s) recomputed.",
                n: res.unmapped_events,
                dates: res.attendance_dates_recomputed.length,
              }) as string,
            );
          }}
        />
      )}

      {singleCluster && (
        <MapToEmployeeModal
          cluster={singleCluster}
          onClose={() => setMapRawEvent(null)}
          onSuccess={(r) => {
            setMapRawEvent(null);
            announceMapped(r);
          }}
        />
      )}

      {mapCluster && (
        <MapToEmployeeModal
          cluster={mapCluster}
          onClose={() => setMapCluster(null)}
          onSuccess={(r) => {
            setMapCluster(null);
            announceMapped(r);
          }}
        />
      )}

      {bulkCluster && bulkMapOpen && !singleCluster && (
        <MapToEmployeeModal
          cluster={bulkCluster}
          onClose={() => setBulkMapOpen(false)}
          onSuccess={(r) => {
            setBulkMapOpen(false);
            clearSelection();
            announceMapped(r);
          }}
        />
      )}
    </>
  );
}
