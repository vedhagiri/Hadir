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

import { Icon } from "../../shell/Icon";
import type { EmployeeListFilters } from "../employees/hooks";
import { useEmployeeList } from "../employees/hooks";
import type { Employee } from "../employees/types";
import { useCameraList, useClusterEvents, useMapToEmployee, useUnidentifiedFaceClusters } from "./hooks";
import type { FaceClusterOut, MapToEmployeeResponse, PhotoAssignment, UnidentifiedFacesFilters } from "./types";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.6;
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
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
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
}
.unid-card:hover {
  border-color: var(--accent-border);
  box-shadow: 0 2px 12px rgba(0,0,0,0.08);
}
.unid-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
        {/* count badge */}
        <div style={{
          position: "absolute",
          top: 6,
          insetInlineEnd: 6,
          background: "rgba(0,0,0,0.62)",
          color: "#fff",
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 700,
          padding: "2px 7px",
          letterSpacing: "0.02em",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}>
          {cluster.count}
        </div>
        {/* crops available indicator */}
        {cluster.crop_event_ids.length > 0 && (
          <div style={{
            position: "absolute",
            bottom: 6,
            insetInlineStart: 6,
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            borderRadius: 4,
            fontSize: 10,
            padding: "1px 5px",
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

      {/* metadata */}
      <div style={{ padding: "8px 10px 10px", flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
          <Icon name="clock" size={11} style={{ flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fmtDate(cluster.last_seen)}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
          <Icon name="camera" size={11} style={{ flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cluster.camera_names[0] ?? "—"}
            {cluster.camera_names.length > 1 && (
              <span style={{ color: "var(--text-tertiary)" }}> +{cluster.camera_names.length - 1}</span>
            )}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
          <span style={{
            fontSize: 10.5,
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "1px 6px",
            color: "var(--text-tertiary)",
          }}>
            {(cluster.avg_similarity * 100).toFixed(0)}%{" "}
            {t("unidentifiedFaces.sim", "sim")}
          </span>
        </div>
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


// ── Cluster detail drawer ──────────────────────────────────────────────────

interface ClusterDrawerProps {
  cluster: FaceClusterOut;
  onClose: () => void;
}

function ClusterDrawer({ cluster, onClose }: ClusterDrawerProps) {
  const { t } = useTranslation();
  const [activeIdx, setActiveIdx] = useState(0);
  const [showMapModal, setShowMapModal] = useState(false);
  const cropIds = cluster.crop_event_ids;
  const events = useClusterEvents(cluster.event_ids.slice(0, 100), true);

  const goTo = useCallback(
    (idx: number) => setActiveIdx(Math.max(0, Math.min(cropIds.length - 1, idx))),
    [cropIds.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); goTo(activeIdx - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); goTo(activeIdx + 1); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [activeIdx, goTo, onClose]);

  const activeCropId = cropIds[activeIdx];

  return (
    <>
      {/* backdrop */}
      <div
        role="presentation"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 399,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
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
          width: "min(440px, 100vw)",
          background: "var(--bg-elev)",
          borderInlineStart: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          zIndex: 400,
          boxShadow: "-6px 0 32px rgba(0,0,0,0.14)",
          animation: "unid-fadein 0.15s ease both",
        }}
      >
        {/* header */}
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
              <strong>{(cluster.avg_similarity * 100).toFixed(0)}%</strong>
              {" · "}
              {cluster.camera_names.join(", ")}
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

        {/* main preview */}
        <div style={{ position: "relative", flexShrink: 0, background: "var(--bg-sunken)" }}>
          {activeCropId !== undefined ? (
            <img
              key={activeCropId}
              src={`/api/detection-events/${activeCropId}/crop`}
              alt={t("unidentifiedFaces.faceAlt", "Unknown face")}
              style={{
                width: "100%",
                aspectRatio: "1",
                objectFit: "cover",
                display: "block",
                animation: "unid-fadein 0.12s ease both",
              }}
            />
          ) : (
            <div style={{
              aspectRatio: "1",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <Icon name="user" size={52} style={{ opacity: 0.18 }} />
            </div>
          )}

          {/* nav arrows */}
          {cropIds.length > 1 && (
            <>
              <button
                onClick={() => goTo(activeIdx - 1)}
                disabled={activeIdx === 0}
                aria-label={t("common.previous", "Previous")}
                style={{
                  position: "absolute",
                  insetInlineStart: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "rgba(0,0,0,0.55)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "50%",
                  width: 32,
                  height: 32,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: activeIdx === 0 ? 0.25 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                <Icon name="chevronLeft" size={16} />
              </button>
              <button
                onClick={() => goTo(activeIdx + 1)}
                disabled={activeIdx === cropIds.length - 1}
                aria-label={t("common.next", "Next")}
                style={{
                  position: "absolute",
                  insetInlineEnd: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "rgba(0,0,0,0.55)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "50%",
                  width: 32,
                  height: 32,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: activeIdx === cropIds.length - 1 ? 0.25 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                <Icon name="chevronRight" size={16} />
              </button>
              {/* counter */}
              <div style={{
                position: "absolute",
                bottom: 8,
                insetInlineEnd: 8,
                background: "rgba(0,0,0,0.6)",
                color: "#fff",
                borderRadius: 4,
                fontSize: 11,
                padding: "2px 7px",
              }}>
                {activeIdx + 1} / {cropIds.length}
              </div>
            </>
          )}
        </div>

        {/* thumbnail strip (lazy-loaded) */}
        {cropIds.length > 1 && (
          <div style={{
            flexShrink: 0,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}>
            <div style={{
              display: "flex",
              gap: 6,
              overflowX: "auto",
              scrollbarWidth: "none",
              paddingBottom: 2,
            }}>
              {cropIds.map((id, idx) => (
                <button
                  key={id}
                  onClick={() => goTo(idx)}
                  aria-label={`${t("unidentifiedFaces.faceAlt", "Unknown face")} ${idx + 1}`}
                  aria-pressed={idx === activeIdx}
                  style={{
                    flexShrink: 0,
                    width: 52,
                    height: 52,
                    padding: 0,
                    border: idx === activeIdx
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                    borderRadius: "var(--radius-sm)",
                    overflow: "hidden",
                    cursor: "pointer",
                    background: "var(--bg-sunken)",
                    transition: "border-color 0.1s",
                    opacity: idx === activeIdx ? 1 : 0.7,
                  }}
                >
                  <img
                    src={`/api/detection-events/${id}/crop`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* metadata + timeline */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* key facts grid */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "6px 14px",
            fontSize: 12.5,
          }}>
            <span style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
              {t("unidentifiedFaces.firstSeen", "First seen")}
            </span>
            <span>{fmtDate(cluster.first_seen)}</span>
            <span style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
              {t("unidentifiedFaces.lastSeen", "Last seen")}
            </span>
            <span>{fmtDate(cluster.last_seen)}</span>
            <span style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
              {t("unidentifiedFaces.cameras", "Cameras")}
            </span>
            <span>{cluster.camera_names.join(", ")}</span>
            <span style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
              {t("unidentifiedFaces.totalEvents", "Total events")}
            </span>
            <span>{cluster.event_ids.length}</span>
          </div>

          {/* detection timeline */}
          {events.isLoading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[...Array(4)].map((_, i) => (
                <div key={i} className="unid-skeleton" style={{ height: 14, width: i % 2 === 0 ? "80%" : "65%" }} />
              ))}
            </div>
          )}
          {events.data && events.data.items.length > 0 && (
            <div>
              <div style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                color: "var(--text-tertiary)",
                marginBottom: 8,
              }}>
                {t("unidentifiedFaces.detectionTimes", "Detection times")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {events.data.items.slice(0, 30).map((ev) => (
                  <div key={ev.id} style={{ fontSize: 12, display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>
                      {fmtDate(ev.captured_at)}
                    </span>
                    <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ev.camera_name}
                    </span>
                  </div>
                ))}
                {events.data.items.length > 30 && (
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                    + {events.data.items.length - 30} {t("unidentifiedFaces.more", "more")}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>

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

// ── Main page ──────────────────────────────────────────────────────────────

export function UnidentifiedFacesPage() {
  const { t } = useTranslation();

  // committed query state — what the API actually receives
  const [filters, setFilters] = useState<UnidentifiedFacesFilters>({
    start: defaultStart(),
    end: todayIso(),
    camera_id: null,
    min_count: DEFAULT_MIN_COUNT,
    threshold: DEFAULT_THRESHOLD,
    page: 1,
    page_size: PAGE_SIZE,
  });

  // UI-only state for debounced inputs (threshold, minCount)
  const [uiThreshold, setUiThreshold] = useState(DEFAULT_THRESHOLD);
  const [uiMinCount, setUiMinCount] = useState(DEFAULT_MIN_COUNT);

  const [openCluster, setOpenCluster] = useState<FaceClusterOut | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cameras = useCameraList();
  const result = useUnidentifiedFaceClusters(filters);
  const data = result.data;
  const isPlaceholder = result.isPlaceholderData;

  const totalPages = Math.max(1, Math.ceil((data?.total_clusters ?? 0) / PAGE_SIZE));

  // Debounce helper — commits pending UI values to query state after DEBOUNCE_MS
  const scheduleCommit = useCallback((patch: Partial<UnidentifiedFacesFilters>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, page: 1, ...patch }));
    }, DEBOUNCE_MS);
  }, []);

  const commitNow = useCallback((patch: Partial<UnidentifiedFacesFilters>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setFilters((prev) => ({ ...prev, page: 1, ...patch }));
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

  return (
    <>
      {/* inject keyframes once */}
      <style>{INJECTED_STYLE}</style>

      <div
        style={{
          padding: "24px 28px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          maxWidth: 1400,
        }}
      >
        {/* ── Page header ── */}
        <div>
          <h1 className="page-title" style={{ marginBottom: 8 }}>
            {t("unidentifiedFaces.title", "Unidentified Faces")}
          </h1>
          {/* stats pills */}
          {data && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <StatPill
                label={t("unidentifiedFaces.clusters", "clusters")}
                value={data.total_clusters.toLocaleString()}
              />
              <StatPill
                label={t("unidentifiedFaces.totalEvents", "total events")}
                value={data.total_unidentified_events.toLocaleString()}
              />
              <StatPill
                label={t("unidentifiedFaces.withEmbedding", "with embedding")}
                value={data.events_with_embedding.toLocaleString()}
              />
              {data.capped && (
                <StatPill
                  warn
                  label="⚠"
                  value={t("unidentifiedFaces.capped", "Capped at 1,500 most recent")}
                />
              )}
            </div>
          )}
          {result.isLoading && !data && (
            <div style={{ display: "flex", gap: 8 }}>
              {[80, 110, 90].map((w) => (
                <div key={w} className="unid-skeleton" style={{ height: 30, width: w, borderRadius: 999 }} />
              ))}
            </div>
          )}
        </div>

        {/* ── Filter bar ── */}
        <div style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}>
          {/* primary filters row */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            <div>
              <label style={labelStyle}>{t("unidentifiedFaces.from", "From")}</label>
              <input
                type="date"
                value={filters.start ?? ""}
                onChange={(e) => commitNow({ start: e.target.value || null })}
                style={{ ...inputStyle, width: 145 }}
              />
            </div>
            <div>
              <label style={labelStyle}>{t("unidentifiedFaces.to", "To")}</label>
              <input
                type="date"
                value={filters.end ?? ""}
                onChange={(e) => commitNow({ end: e.target.value || null })}
                style={{ ...inputStyle, width: 145 }}
              />
            </div>
            {cameras.data && cameras.data.items.length > 0 && (
              <div>
                <label style={labelStyle}>{t("unidentifiedFaces.camera", "Camera")}</label>
                <select
                  value={filters.camera_id ?? ""}
                  onChange={(e) =>
                    commitNow({ camera_id: e.target.value ? parseInt(e.target.value, 10) : null })
                  }
                  style={{ ...inputStyle, width: 180 }}
                >
                  <option value="">{t("unidentifiedFaces.allCameras", "All cameras")}</option>
                  {cameras.data.items.map((cam) => (
                    <option key={cam.id} value={cam.id}>
                      {cam.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label style={labelStyle}>{t("unidentifiedFaces.minCount", "Min appearances")}</label>
              <input
                type="number"
                min={1}
                max={100}
                value={uiMinCount}
                onChange={(e) => {
                  const v = Math.max(1, parseInt(e.target.value, 10) || 1);
                  setUiMinCount(v);
                  scheduleCommit({ min_count: v });
                }}
                style={{ ...inputStyle, width: 90 }}
              />
            </div>
            <div style={{ marginInlineStart: "auto" }}>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                className="btn btn-sm"
                aria-expanded={showAdvanced}
                style={{ gap: 4, display: "flex", alignItems: "center" }}
              >
                {t("unidentifiedFaces.advanced", "Advanced")}
                <Icon name={showAdvanced ? "chevronUp" : "chevronDown"} size={12} />
              </button>
            </div>
          </div>

          {/* advanced row (threshold) */}
          {showAdvanced && (
            <div style={{
              paddingTop: 12,
              borderTop: "1px solid var(--border)",
              display: "flex",
              flexWrap: "wrap",
              gap: 14,
              alignItems: "flex-end",
            }}>
              <div style={{ flex: "1 1 260px", maxWidth: 380 }}>
                <label style={labelStyle}>
                  {t("unidentifiedFaces.threshold", "Similarity threshold")} —{" "}
                  <strong>{(uiThreshold * 100).toFixed(0)}%</strong>
                  <span style={{ fontWeight: 400, fontSize: 11, marginInlineStart: 6, color: "var(--text-quaternary)" }}>
                    {t("unidentifiedFaces.thresholdHint", "(higher = tighter clusters)")}
                  </span>
                </label>
                <input
                  type="range"
                  min={0.40}
                  max={0.99}
                  step={0.01}
                  value={uiThreshold}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setUiThreshold(v);
                    scheduleCommit({ threshold: v });
                  }}
                  style={{ width: "100%", accentColor: "var(--accent)" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--text-quaternary)", marginTop: 3 }}>
                  <span>40% — {t("unidentifiedFaces.looser", "looser")}</span>
                  <span>99% — {t("unidentifiedFaces.tighter", "tighter")}</span>
                </div>
              </div>
              <button
                onClick={() => {
                  setUiThreshold(DEFAULT_THRESHOLD);
                  setUiMinCount(DEFAULT_MIN_COUNT);
                  commitNow({ threshold: DEFAULT_THRESHOLD, min_count: DEFAULT_MIN_COUNT });
                }}
                className="btn btn-sm"
                style={{ alignSelf: "flex-start", marginTop: 18 }}
              >
                {t("unidentifiedFaces.resetDefaults", "Reset defaults")}
              </button>
            </div>
          )}
        </div>

        {/* ── Error state ── */}
        {result.isError && (
          <div style={{
            padding: "32px 0",
            textAlign: "center",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}>
            <Icon name="x" size={28} style={{ opacity: 0.3, marginBottom: 10 }} />
            <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
              {t("unidentifiedFaces.loadFailed", "Could not load unidentified faces.")}
            </div>
          </div>
        )}

        {/* ── Skeleton grid (initial load only) ── */}
        {result.isLoading && !data && (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))",
            gap: 12,
          }}>
            {[...Array(PAGE_SIZE)].map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        )}

        {/* ── Empty state ── */}
        {!result.isLoading && !result.isError && data && data.clusters.length === 0 && (
          <div style={{
            padding: "56px 24px",
            textAlign: "center",
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "var(--bg-sunken)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <Icon name="user" size={26} style={{ opacity: 0.3 }} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              {t("unidentifiedFaces.empty", "No unidentified face clusters")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 340, margin: "0 auto" }}>
              {t(
                "unidentifiedFaces.emptyHint",
                "Try expanding the date range or lowering the similarity threshold.",
              )}
            </div>
          </div>
        )}

        {/* ── Cluster grid ── */}
        {data && data.clusters.length > 0 && (
          <div style={{ opacity: isPlaceholder ? 0.6 : 1, transition: "opacity 0.2s" }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))",
              gap: 12,
            }}>
              {data.clusters.map((cluster) => (
                <ClusterCard key={cluster.cluster_id} cluster={cluster} onOpen={setOpenCluster} />
              ))}
            </div>
          </div>
        )}

        {/* ── Pagination ── */}
        {data && totalPages > 1 && (
          <div style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 6,
            paddingTop: 4,
          }}>
            <button
              onClick={() => setFilters((f) => ({ ...f, page: 1 }))}
              disabled={filters.page <= 1}
              className="btn btn-sm"
              aria-label={t("common.first", "First page")}
              style={{ padding: "4px 8px" }}
            >
              «
            </button>
            <button
              onClick={() => setFilters((f) => ({ ...f, page: Math.max(1, f.page - 1) }))}
              disabled={filters.page <= 1}
              className="btn btn-sm"
              aria-label={t("common.previous", "Previous page")}
              style={{ padding: "4px 8px" }}
            >
              <Icon name="chevronLeft" size={14} />
            </button>

            {/* page number pills */}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const start = Math.max(1, Math.min(filters.page - 2, totalPages - 4));
              const p = start + i;
              if (p > totalPages) return null;
              return (
                <button
                  key={p}
                  onClick={() => setFilters((f) => ({ ...f, page: p }))}
                  className="btn btn-sm"
                  aria-current={p === filters.page ? "page" : undefined}
                  style={{
                    padding: "4px 10px",
                    background: p === filters.page ? "var(--accent)" : undefined,
                    color: p === filters.page ? "#fff" : undefined,
                    borderColor: p === filters.page ? "var(--accent)" : undefined,
                    minWidth: 32,
                  }}
                >
                  {p}
                </button>
              );
            })}

            <button
              onClick={() => setFilters((f) => ({ ...f, page: Math.min(totalPages, f.page + 1) }))}
              disabled={filters.page >= totalPages}
              className="btn btn-sm"
              aria-label={t("common.next", "Next page")}
              style={{ padding: "4px 8px" }}
            >
              <Icon name="chevronRight" size={14} />
            </button>
            <button
              onClick={() => setFilters((f) => ({ ...f, page: totalPages }))}
              disabled={filters.page >= totalPages}
              className="btn btn-sm"
              aria-label={t("common.last", "Last page")}
              style={{ padding: "4px 8px" }}
            >
              »
            </button>

            <span style={{ fontSize: 12, color: "var(--text-tertiary)", marginInlineStart: 4 }}>
              {t("unidentifiedFaces.page", "Page {{page}} of {{total}}", {
                page: filters.page,
                total: totalPages,
              })}
            </span>
          </div>
        )}
      </div>

      {/* ── Cluster detail drawer ── */}
      {openCluster && (
        <ClusterDrawer cluster={openCluster} onClose={() => setOpenCluster(null)} />
      )}
    </>
  );
}
