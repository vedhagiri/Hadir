// Similarity-group detail drawer: first/last seen, per-camera activity,
// in-cluster filters (similarity / quality / clarity), a paged face
// grid and the face viewer. Primary action: "Map group to employee".

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { FaceViewer } from "./FaceViewer";
import { useClusterEvents } from "./hooks";
import type { AnyMapResult } from "./MapToEmployee";
import { MapToEmployeeModal } from "./MapToEmployee";
import type { FaceClusterOut } from "./types";
import type { Tone } from "./ufUi";
import { Fact, FaceImg, TonePill, poseTone, qualityTone, similarityTone, useFaceLabels } from "./ufUi";

type QualityFilter = "all" | "high" | "medium" | "low";
type ClarityFilter = "all" | "clear" | "blur" | "side" | "partial";

/** Mutually-exclusive clarity bucket. Priority: partial > side > blur > clear. */
function clarityOf(quality: string, faceType: string): Exclude<ClarityFilter, "all"> {
  if (faceType === "partial") return "partial";
  if (faceType === "side") return "side";
  if (quality === "low") return "blur";
  return "clear";
}

const SIMILAR_FACES_PER_PAGE = 24;

// ── Filter dropdown shell ──────────────────────────────────────────────

function FilterDropdown({
  label,
  isOpen,
  onToggle,
  onClose,
  children,
}: {
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target) && triggerRef.current && !triggerRef.current.contains(target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [isOpen, onClose]);

  return (
    <div className="unid-dd">
      <button ref={triggerRef} type="button" className="unid-addbtn" aria-haspopup="menu" aria-expanded={isOpen} onClick={onToggle}>
        <Icon name="plus" size={10} />
        <span>{label}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {isOpen && (
        <div ref={menuRef} role="menu" className="unid-menu" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── In-cluster filter bar ──────────────────────────────────────────────

function ClusterFilterBar({
  simPct,
  simMode,
  qualityFilter,
  clarityFilter,
  setSimPct,
  setSimMode,
  setQualityFilter,
  setClarityFilter,
  simRangeMin,
  simRangeMax,
  presets,
  shown,
  total,
}: {
  simPct: number;
  simMode: "gte" | "eq";
  qualityFilter: QualityFilter;
  clarityFilter: ClarityFilter;
  setSimPct: (n: number) => void;
  setSimMode: (m: "gte" | "eq") => void;
  setQualityFilter: (q: QualityFilter) => void;
  setClarityFilter: (c: ClarityFilter) => void;
  simRangeMin: number;
  simRangeMax: number;
  presets: number[];
  shown: number;
  total: number;
}) {
  const { t } = useTranslation();
  const [openKey, setOpenKey] = useState<"sim" | "quality" | "clarity" | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState<string>(simPct > 0 ? String(simPct) : "");
  const [customMode, setCustomMode] = useState<"gte" | "eq">(simMode);
  const hasAny = simPct > 0 || qualityFilter !== "all" || clarityFilter !== "all";

  const closeAll = useCallback(() => {
    setOpenKey(null);
    setCustomOpen(false);
  }, []);
  const toggleKey = (k: "sim" | "quality" | "clarity") => () => {
    setOpenKey((cur) => (cur === k ? null : k));
    if (k !== "sim") setCustomOpen(false);
  };
  const applySim = (pct: number, mode: "gte" | "eq") => {
    setSimPct(pct);
    setSimMode(mode);
    closeAll();
  };

  const QUALITY_OPTIONS: readonly [QualityFilter, string, Tone][] = [
    ["high", t("unidentifiedFaces.qHighChip", "High") as string, "success"],
    ["medium", t("unidentifiedFaces.qMediumChip", "Medium") as string, "warning"],
    ["low", t("unidentifiedFaces.qLowChip", "Low") as string, "neutral"],
  ];
  const CLARITY_OPTIONS: readonly [ClarityFilter, string, Tone][] = [
    ["clear", t("unidentifiedFaces.cClearChip", "Clear face") as string, "success"],
    ["blur", t("unidentifiedFaces.cBlurChip", "Blur face") as string, "neutral"],
    ["side", t("unidentifiedFaces.cSideChip", "Side face") as string, "accent"],
    ["partial", t("unidentifiedFaces.cPartialChip", "Partial face") as string, "warning"],
  ];
  const qualityLabel = QUALITY_OPTIONS.find(([k]) => k === qualityFilter)?.[1] ?? "";
  const clarityLabel = CLARITY_OPTIONS.find(([k]) => k === clarityFilter)?.[1] ?? "";
  const customN = parseInt(customValue, 10);
  const customValid = !Number.isNaN(customN) && customN >= 1 && customN <= 100;

  return (
    <div className="unid-tagbar-wrap">
      <div className="unid-tagbar">
        <span className="unid-tagbar-label">
          <Icon name="filter" size={12} />
          {t("unidentifiedFaces.filterFaces", { defaultValue: "Filter faces" })}
        </span>
        {simPct > 0 && (
          <span className="unid-tag">
            <span>
              {t("unidentifiedFaces.filterSim", "Similarity") as string} {simMode === "gte" ? "≥" : "="}
              {simPct}%
            </span>
            <button type="button" className="unid-tag-x" onClick={() => setSimPct(0)} aria-label={t("unidentifiedFaces.clearSimFilter", "Clear similarity filter") as string}>
              <Icon name="x" size={10} />
            </button>
          </span>
        )}
        {qualityFilter !== "all" && (
          <span className="unid-tag">
            <span>
              {t("unidentifiedFaces.filterQuality", "Quality") as string} {qualityLabel}
            </span>
            <button type="button" className="unid-tag-x" onClick={() => setQualityFilter("all")} aria-label={t("unidentifiedFaces.clearQualityFilter", "Clear quality filter") as string}>
              <Icon name="x" size={10} />
            </button>
          </span>
        )}
        {clarityFilter !== "all" && (
          <span className="unid-tag">
            <span>
              {t("unidentifiedFaces.filterClarity", "Clarity") as string} {clarityLabel}
            </span>
            <button type="button" className="unid-tag-x" onClick={() => setClarityFilter("all")} aria-label={t("unidentifiedFaces.clearClarityFilter", "Clear clarity filter") as string}>
              <Icon name="x" size={10} />
            </button>
          </span>
        )}

        <FilterDropdown label={t("unidentifiedFaces.filterSim", "Similarity") as string} isOpen={openKey === "sim"} onToggle={toggleKey("sim")} onClose={closeAll}>
          {presets.length > 0 ? (
            presets.map((p) => (
              <button key={p} role="menuitem" type="button" className="unid-menu-item" aria-pressed={simPct === p && simMode === "gte"} onClick={() => applySim(p, "gte")}>
                ≥{p}%
              </button>
            ))
          ) : (
            <div className="unid-menu-empty">{t("unidentifiedFaces.noSimRange", "No similarity range data") as string}</div>
          )}
          <button role="menuitem" type="button" className="unid-menu-item" aria-expanded={customOpen} onClick={() => setCustomOpen((v) => !v)}>
            {t("unidentifiedFaces.customSim", "Custom…") as string}
          </button>
          {customOpen && (
            <div className="unid-menu-custom">
              <div role="group" className="unid-modetoggle" aria-label={t("unidentifiedFaces.simModeAria", "Similarity match mode") as string}>
                <button type="button" aria-pressed={customMode === "gte"} onClick={() => setCustomMode("gte")} title={t("unidentifiedFaces.simModeGteHint", "Greater than or equal to") as string}>
                  ≥
                </button>
                <button type="button" aria-pressed={customMode === "eq"} onClick={() => setCustomMode("eq")} title={t("unidentifiedFaces.simModeEqHint", "Equal to") as string}>
                  =
                </button>
              </div>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                placeholder={t("unidentifiedFaces.simAnyPlaceholder", "any") as string}
                aria-label={t("unidentifiedFaces.filterSimAria", "Similarity percentage") as string}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customValid) applySim(customN, customMode);
                }}
              />
              <span className="text-dim text-xs">%</span>
              <button type="button" className="unid-apply-btn" disabled={!customValid} onClick={() => customValid && applySim(customN, customMode)}>
                {t("unidentifiedFaces.apply", "Apply") as string}
              </button>
            </div>
          )}
          {simRangeMin < simRangeMax && (
            <div className="unid-menu-range">
              {t("unidentifiedFaces.simRangeHint", "in cluster: {{min}}–{{max}}%", { min: simRangeMin, max: simRangeMax }) as string}
            </div>
          )}
        </FilterDropdown>

        <FilterDropdown label={t("unidentifiedFaces.filterQuality", "Quality") as string} isOpen={openKey === "quality"} onToggle={toggleKey("quality")} onClose={closeAll}>
          {QUALITY_OPTIONS.map(([key, label, tone]) => (
            <button key={key} role="menuitem" type="button" className="unid-menu-item" aria-pressed={qualityFilter === key} onClick={() => { setQualityFilter(key); closeAll(); }}>
              <span className={`unid-tone-dot tone-${tone}`} aria-hidden />
              {label}
            </button>
          ))}
        </FilterDropdown>

        <FilterDropdown label={t("unidentifiedFaces.filterClarity", "Clarity") as string} isOpen={openKey === "clarity"} onToggle={toggleKey("clarity")} onClose={closeAll}>
          {CLARITY_OPTIONS.map(([key, label, tone]) => (
            <button key={key} role="menuitem" type="button" className="unid-menu-item" aria-pressed={clarityFilter === key} onClick={() => { setClarityFilter(key); closeAll(); }}>
              <span className={`unid-tone-dot tone-${tone}`} aria-hidden />
              {label}
            </button>
          ))}
        </FilterDropdown>
      </div>

      {hasAny && (
        <div className="unid-tagbar-footer">
          <span>{t("unidentifiedFaces.filterStat", "Showing {{shown}} of {{total}}", { shown, total }) as string}</span>
          <button
            type="button"
            className="unid-reset-btn"
            onClick={() => {
              setSimPct(0);
              setQualityFilter("all");
              setClarityFilter("all");
            }}
          >
            {t("unidentifiedFaces.clearFilters", "Reset filters") as string}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Drawer ─────────────────────────────────────────────────────────────

export function ClusterDrawer({
  cluster,
  onClose,
  onMapped,
}: {
  cluster: FaceClusterOut;
  onClose: () => void;
  onMapped: (result: AnyMapResult) => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const labels = useFaceLabels();
  const [showMapModal, setShowMapModal] = useState(false);
  const [galleryIdx, setGalleryIdx] = useState<number | null>(null);

  const [simPct, setSimPct] = useState<number>(0);
  const [simMode, setSimMode] = useState<"gte" | "eq">("gte");
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const [clarityFilter, setClarityFilter] = useState<ClarityFilter>("all");
  const [similarFacesPage, setSimilarFacesPage] = useState<number>(1);

  const events = useClusterEvents(cluster.event_ids.slice(0, 100), true);

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

  // Per-event lookups from the events fetch (captured time + camera).
  const eventLookup = (() => {
    const m = new Map<number, { captured_at: string; camera_name: string }>();
    for (const ev of events.data?.items ?? []) m.set(ev.id, { captured_at: ev.captured_at, camera_name: ev.camera_name });
    return m;
  })();

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

  const totalPages = Math.max(1, Math.ceil(filteredCropIds.length / SIMILAR_FACES_PER_PAGE));
  useEffect(() => {
    if (similarFacesPage > totalPages) setSimilarFacesPage(totalPages);
    else if (similarFacesPage < 1) setSimilarFacesPage(1);
  }, [similarFacesPage, totalPages]);
  const safePage = Math.min(Math.max(1, similarFacesPage), totalPages);
  const pageStart = (safePage - 1) * SIMILAR_FACES_PER_PAGE;
  const pageCropIds = filteredCropIds.slice(pageStart, pageStart + SIMILAR_FACES_PER_PAGE);

  const cropSims = cluster.crop_event_ids.map((id) => metaByEvent.get(id)?.similarity).filter((s): s is number => typeof s === "number");
  const simRangeMin = cropSims.length > 0 ? Math.floor(Math.min(...cropSims) * 100) : 0;
  const simRangeMax = cropSims.length > 0 ? Math.ceil(Math.max(...cropSims) * 100) : 100;
  const presets = (() => {
    if (cropSims.length < 2 || simRangeMin >= simRangeMax) return [];
    const span = simRangeMax - simRangeMin;
    const raw = [simRangeMin + Math.round(span * 0.25), simRangeMin + Math.round(span * 0.5), simRangeMin + Math.round(span * 0.75)];
    return [...new Set(raw)];
  })();

  // Esc closes the drawer — unless the viewer or map modal is on top
  // (they own Esc while open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (galleryIdx !== null || showMapModal) return;
      // An open in-drawer filter menu owns the first Esc.
      if (document.querySelector(".unid-drawer .unid-menu")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, galleryIdx, showMapModal]);

  const clusterAvgSimPct = Math.round(cluster.avg_similarity * 100);
  const cameraDisplay =
    cluster.camera_names.length <= 2
      ? cluster.camera_names.join(", ")
      : (t("unidentifiedFaces.nCameras", { defaultValue: "{{n}} cameras", n: cluster.camera_names.length }) as string);

  const cameraActivity = (() => {
    const counts = new Map<number, { name: string; count: number }>();
    for (let i = 0; i < cluster.camera_ids.length; i += 1) {
      const id = cluster.camera_ids[i];
      if (id === undefined) continue;
      counts.set(id, { name: cluster.camera_names[i] ?? `cam_${id}`, count: 0 });
    }
    for (const ev of events.data?.items ?? []) {
      const c = counts.get(ev.camera_id);
      if (c) c.count += 1;
      else counts.set(ev.camera_id, { name: ev.camera_name, count: 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  })();
  const maxCamCount = cameraActivity[0]?.count ?? 0;

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

  const resetFilters = () => {
    setSimPct(0);
    setQualityFilter("all");
    setClarityFilter("all");
  };

  return (
    <>
      {createPortal(
        <>
          {/* Visual-only backdrop: outside-click does NOT close the drawer
              (explicit × or Esc only — unchanged behaviour). */}
          <div aria-hidden className="unid-scrim" style={{ zIndex: 399 }} />
          <aside role="dialog" aria-modal="true" aria-label={t("unidentifiedFaces.drawerTitle", "Cluster detail") as string} className="unid-drawer" style={{ zIndex: 400 }}>
            <header className="unid-drawer-head">
              <div className="unid-drawer-mosaic" aria-hidden>
                <FaceImg id={cluster.representative_event_id} hasCrop={cluster.crop_event_ids.length > 0} />
              </div>
              <div className="unid-drawer-titles">
                <h2 className="unid-drawer-title">
                  {t("unidentifiedFaces.groupOfN", { defaultValue: "Group of {{count}} faces", defaultValue_one: "Group of {{count}} face", count: cluster.count })}
                </h2>
                <div className="unid-drawer-sub">
                  <TonePill tone={similarityTone(clusterAvgSimPct)}>
                    {t("unidentifiedFaces.avgSimShort", { defaultValue: "{{n}}% similar", n: clusterAvgSimPct })}
                  </TonePill>
                  <span className="unid-dot-sep" aria-hidden>·</span>
                  <span className="unid-drawer-cams">
                    <Icon name="camera" size={12} />
                    {cameraDisplay || "—"}
                  </span>
                </div>
              </div>
              <div className="unid-drawer-actions">
                <button type="button" onClick={() => setShowMapModal(true)} className="btn btn-primary btn-sm">
                  <Icon name="user" size={13} />
                  {t("unidentifiedFaces.mapGroup", { defaultValue: "Map group to employee" })}
                </button>
                <button type="button" onClick={onClose} className="btn btn-sm btn-ghost unid-icon-btn" aria-label={t("common.close", "Close") as string}>
                  <Icon name="x" size={16} />
                </button>
              </div>
            </header>

            <div className="unid-drawer-body">
              <div className="unid-time-hero">
                <div className="unid-time-col">
                  <span className="unid-time-label">{t("unidentifiedFaces.firstSeen", "First seen")}</span>
                  <span className="unid-time-value">{dt.formatTime(cluster.first_seen) || cluster.first_seen}</span>
                  <span className="unid-time-rel">{dt.formatDate(cluster.first_seen) || cluster.first_seen}</span>
                </div>
                <div className="unid-time-arrow" aria-hidden>
                  <span className="unid-time-arrow-icon">→</span>
                  <span>{fmtSpan(cluster.first_seen, cluster.last_seen)}</span>
                </div>
                <div className="unid-time-col unid-time-col-end">
                  <span className="unid-time-label">{t("unidentifiedFaces.lastSeen", "Last seen")}</span>
                  <span className="unid-time-value">{dt.formatTime(cluster.last_seen) || cluster.last_seen}</span>
                  <span className="unid-time-rel">{dt.formatDate(cluster.last_seen) || cluster.last_seen}</span>
                </div>
              </div>

              {cameraActivity.length > 0 && maxCamCount > 0 && (
                <div className="unid-cam-activity">
                  <div className="unid-section-label">{t("unidentifiedFaces.cameraActivity", "Camera activity")}</div>
                  {cameraActivity.map((cam) => (
                    <div key={cam.name} className="unid-cam-bar-row">
                      <span className="unid-cam-bar-name" title={cam.name}>
                        <Icon name="camera" size={11} />
                        {cam.name}
                      </span>
                      <div className="unid-cam-bar-track">
                        <div className="unid-cam-bar-fill" style={{ width: `${Math.max(4, (cam.count / maxCamCount) * 100)}%` }} />
                      </div>
                      <span className="unid-cam-bar-count">{cam.count}</span>
                    </div>
                  ))}
                </div>
              )}

              <ClusterFilterBar
                simPct={simPct}
                simMode={simMode}
                qualityFilter={qualityFilter}
                clarityFilter={clarityFilter}
                setSimPct={setSimPct}
                setSimMode={setSimMode}
                setQualityFilter={setQualityFilter}
                setClarityFilter={setClarityFilter}
                simRangeMin={simRangeMin}
                simRangeMax={simRangeMax}
                presets={presets}
                shown={filteredCropIds.length}
                total={cluster.crop_event_ids.length}
              />

              <div className="unid-section-head">
                <h3 className="unid-section-title">{t("unidentifiedFaces.similarFaces", "Similar Faces")}</h3>
                <span className="text-dim text-xs">
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

              {filteredCropIds.length === 0 && cluster.crop_event_ids.length > 0 ? (
                <div className="unid-inline-empty">
                  <Icon name="filter" size={22} />
                  <span>{t("unidentifiedFaces.allFiltered", "All faces hidden by current filters.")}</span>
                  <button type="button" onClick={resetFilters} className="btn btn-sm">
                    {t("unidentifiedFaces.clearFilters", "Clear filters")}
                  </button>
                </div>
              ) : filteredCropIds.length === 0 ? (
                <div className="unid-inline-empty">
                  <Icon name="user" size={22} />
                  <span>{t("unidentifiedFaces.noCrops", "No face crops in this cluster.")}</span>
                </div>
              ) : (
                <>
                  <div className="unid-drawer-grid">
                    {pageCropIds.map((id, i) => {
                      const isRef = id === cluster.representative_event_id;
                      const meta = metaByEvent.get(id);
                      const pct = meta ? Math.round(meta.similarity * 100) : 0;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`unid-face unid-face-btn${isRef ? " is-ref" : ""}`}
                          onClick={() => setGalleryIdx(pageStart + i)}
                          aria-label={t("unidentifiedFaces.openPreview", "Open preview for face #{{id}}", { id }) as string}
                        >
                          <span className="unid-face-img">
                            <FaceImg id={id} />
                          </span>
                          <span className={`unid-face-badge${isRef ? " is-ref" : ""}`}>
                            {isRef ? t("unidentifiedFaces.refShort", "REF") : `${pct}%`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {filteredCropIds.length > SIMILAR_FACES_PER_PAGE && (
                    <div className="unid-flow-pager">
                      <span className="text-dim">
                        {t("common.pageOf", "Page {{page}} of {{total}}", { page: safePage, total: totalPages })} ·{" "}
                        {filteredCropIds.length.toLocaleString()}{" "}
                        {filteredCropIds.length === 1 ? t("unidentifiedFaces.face", "face") : t("unidentifiedFaces.faces", "faces")}
                      </span>
                      <div className="unid-flow-pager-btns">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={safePage <= 1}
                          onClick={() => setSimilarFacesPage(Math.max(1, safePage - 1))}
                          aria-label={t("unidentifiedFaces.prevSimilarFacesPage", "Previous page of similar faces") as string}
                        >
                          <Icon name="chevronLeft" size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={safePage >= totalPages}
                          onClick={() => setSimilarFacesPage(Math.min(totalPages, safePage + 1))}
                          aria-label={t("unidentifiedFaces.nextSimilarFacesPage", "Next page of similar faces") as string}
                        >
                          <Icon name="chevronRight" size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>
        </>,
        document.body,
      )}

      {galleryIdx !== null && filteredCropIds.length > 0 && (
        <FaceViewer
          items={filteredCropIds}
          index={galleryIdx}
          onIndex={setGalleryIdx}
          onClose={() => setGalleryIdx(null)}
          getId={(id) => id}
          label={t("unidentifiedFaces.galleryTitle", "Cluster face gallery") as string}
          layer={700}
          renderHeader={(id) => (
            <>
              <div className="unid-viewer-eyebrow">
                <span className={`pill ${id === cluster.representative_event_id ? "pill-info" : "pill-neutral"} unid-mini-pill`}>
                  {id === cluster.representative_event_id
                    ? t("unidentifiedFaces.referenceImage", "Reference")
                    : t("unidentifiedFaces.detectionDetail", "Detection")}
                </span>
                <span className="mono text-dim text-xs">#{id}</span>
              </div>
              <div className="unid-viewer-title">{t("unidentifiedFaces.unknownPerson", "Unknown Person")}</div>
              <div className="unid-viewer-sub">
                {t("unidentifiedFaces.clusterMemberOf", "Cluster member · {{n}} crops", { n: filteredCropIds.length })}
              </div>
            </>
          )}
          renderPanel={(id) => {
            const meta = metaByEvent.get(id);
            const sim = meta ? Math.round(meta.similarity * 100) : 0;
            const ev = eventLookup.get(id);
            return (
              <>
                <div className="unid-simbar">
                  <div className="unid-simbar-top">
                    <span>{t("unidentifiedFaces.faceSimilarity", { defaultValue: "Similarity to group" })}</span>
                    <strong>{sim}%</strong>
                  </div>
                  <div className={`unid-simbar-track tone-${similarityTone(sim)}`}>
                    <span style={{ width: `${Math.max(2, sim)}%` }} />
                  </div>
                </div>
                <dl className="unid-facts">
                  <Fact label={t("unidentifiedFaces.detectionTimeLabel", "Detection time")}>
                    {ev ? dt.formatTimeWithSeconds(ev.captured_at) || "—" : "—"}
                  </Fact>
                  <Fact label={t("unidentifiedFaces.detectionDateLabel", "Detection date")}>{ev ? dt.formatDate(ev.captured_at) || "—" : "—"}</Fact>
                  <Fact label={t("unidentifiedFaces.camera", "Camera")}>{ev?.camera_name ?? (cluster.camera_names.length === 1 ? cluster.camera_names[0] : "—")}</Fact>
                  <Fact label={t("unidentifiedFaces.qualityLabel", "Quality")}>
                    <TonePill tone={qualityTone(meta?.quality ?? "unknown")}>{labels.quality(meta?.quality ?? "unknown")}</TonePill>
                  </Fact>
                  <Fact label={t("unidentifiedFaces.poseLabel", "Face type")}>
                    <TonePill tone={poseTone(meta?.faceType ?? "unknown")}>{labels.pose(meta?.faceType ?? "unknown")}</TonePill>
                  </Fact>
                  <Fact label={t("unidentifiedFaces.eventId", "Event ID")}>
                    <span className="mono">#{id}</span>
                  </Fact>
                </dl>
                <div className="unid-viewer-cta">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      setGalleryIdx(null);
                      setShowMapModal(true);
                    }}
                  >
                    <Icon name="user" size={13} />
                    {t("unidentifiedFaces.mapGroup", { defaultValue: "Map group to employee" })}
                  </button>
                  <p className="text-dim text-xs">
                    {t("unidentifiedFaces.mapGroupHint", {
                      defaultValue: "Mapping applies to the whole group — you can review the faces before confirming.",
                    })}
                  </p>
                </div>
              </>
            );
          }}
        />
      )}

      {showMapModal && (
        <MapToEmployeeModal
          cluster={cluster}
          onClose={() => setShowMapModal(false)}
          onSuccess={(r) => {
            setShowMapModal(false);
            onMapped(r);
            onClose();
          }}
        />
      )}
    </>
  );
}
