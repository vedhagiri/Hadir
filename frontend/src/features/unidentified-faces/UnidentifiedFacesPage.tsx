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

import { EmptyPanel, FilterSelect, Toolbar } from "../../components/ListPageUi";
import { ATT_ICON, FieldCaption, StrokeIcon, fieldDateStyle } from "../attendance/attendanceUi";

import "./unidentified-faces.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { extractApiError } from "../../api/client";

import { DatePicker } from "../../components/DatePicker";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import {
  MAX_REFERENCE_PHOTOS,
  PHOTO_MESSAGES,
  referencePhotosRemaining,
} from "../../util/photoValidation";
import type { EmployeeListFilters } from "../employees/hooks";
import { useEmployeeList } from "../employees/hooks";
import type { Employee } from "../employees/types";
import {
  useCameraList,
  useClusterEvents,
  useMapAsAttendance,
  useMapAsReference,
  useMappedClusters,
  useMappedFaces,
  useRawUnidentifiedFaces,
  useUnidentifiedFaceClusters,
  useUnmapByEmployee,
  useUnmapEvents,
} from "./hooks";
import type {
  FaceClusterOut,
  MapAsAttendanceResponse,
  MappedEmployeeGroupOut,
  MappedFaceEventOut,
  MapToEmployeeResponse,
  MapWorkflow,
  PhotoAssignment,
  RawFaceEventOut,
  RawUnidentifiedFilters,
  UnidentifiedFacesFilters,
  UnmapEventsResponse,
} from "./types";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.65;
const DEFAULT_MIN_COUNT = 1;
const PAGE_SIZE = 24;
const DEBOUNCE_MS = 400;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Migration 0068: every fmtDate caller is a React function component,
 * so the formatter is exposed as a hook factory. Each component calls
 * ``const fmtDate = useFmtDate();`` once and the rest of the JSX stays
 * untouched. Renders through ``useTenantDateTime`` so the tenant's
 * configured timezone + date/time format apply automatically.
 */
function useFmtDate(): (iso: string) => string {
  const dt = useTenantDateTime();
  return (iso: string) => dt.formatDateTime(iso);
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


// ── Skeleton card ──────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="unid-card unid-card-skeleton" aria-hidden>
      <div className="unid-skeleton unid-skeleton-tile" />
      <div className="unid-skeleton-lines">
        <div className="unid-skeleton" style={{ width: "60%" }} />
        <div className="unid-skeleton" style={{ width: "80%" }} />
        <div className="unid-skeleton" style={{ width: "40%" }} />
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
  const fmtDate = useFmtDate();
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
  onSuccess: (result: MapToEmployeeResponse | MapAsAttendanceResponse) => void;
}

interface PhotoSelectionState {
  event_id: number;
  selected: boolean;
  angle: MapAngle;
}

// Result envelope normalised across the two workflows so the success
// screen can read the same shape regardless of which mutation fired.
type AnyMapResult =
  | { kind: "reference"; data: MapToEmployeeResponse }
  | { kind: "attendance"; data: MapAsAttendanceResponse };

function MapToEmployeeModal({ cluster, onClose, onSuccess }: MapToEmployeeModalProps) {
  const { t } = useTranslation();

  // Step machine. ``workflow`` is the new entry step: operator picks
  // which side-effect bag to fire (training-set update vs attendance
  // recompute) before anything else happens. The rest of the flow
  // (search → confirm → done) is parameterised on that choice.
  const [step, setStep] = useState<"workflow" | "search" | "confirm" | "done">(
    "workflow",
  );
  const [workflow, setWorkflow] = useState<MapWorkflow>("reference");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  // Employee picker pagination. The list is server-paged so a tenant
  // with hundreds of employees doesn't stuff the whole roster into one
  // response; the operator pages through (or narrows via the search
  // box). Page resets to 1 on every new query so a search never lands
  // on a stale out-of-range page.
  const EMP_PAGE_SIZE = 15;
  const [empPage, setEmpPage] = useState<number>(1);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [result, setResult] = useState<AnyMapResult | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Per-photo selection state: initialised when entering confirm step.
  // Only relevant for the Reference workflow; the Attendance workflow
  // ignores photoSelections entirely.
  const [photoSelections, setPhotoSelections] = useState<PhotoSelectionState[]>([]);
  // Confirm-step photo grid pagination. A 100+ crop cluster renders a
  // very tall tile grid inside the modal; 24 tiles/page (4 × 6 at the
  // modal's natural width) keeps the confirm step compact. Selection +
  // angle state lives on ``photoSelections`` keyed by event_id, so
  // paging never loses a checkbox or an angle choice — the slice only
  // affects what's *rendered*, and the "{{n}} of {{total}} selected"
  // hint still counts across every page.
  const CONFIRM_PHOTOS_PER_PAGE = 24;
  const [confirmPhotoPage, setConfirmPhotoPage] = useState<number>(1);

  // Per-event opt-in for the Attendance workflow. The cluster /
  // bulk selection arrives with N event IDs; in the confirm step
  // the operator can deselect any that don't actually belong to
  // this employee before triggering the attribution + attendance
  // recompute. Defaults to all selected; backed by a Set for O(1)
  // lookup during render.
  const [attendanceSelection, setAttendanceSelection] = useState<Set<number>>(
    () => new Set(),
  );
  const MAX_EVENTS_PER_REQUEST = 200;

  const refMutation = useMapAsReference();
  const attMutation = useMapAsAttendance();
  const mapMutation = workflow === "reference" ? refMutation : attMutation;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Reset to page 1 whenever the (debounced) query changes — a new
  // search shouldn't inherit the previous query's page number.
  useEffect(() => {
    setEmpPage(1);
  }, [debouncedQ]);

  // Auto-focus search input when modal opens
  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 60);
  }, []);

  const empFilters: EmployeeListFilters = {
    q: debouncedQ,
    department_id: null,
    include_inactive: false,
    page: empPage,
    page_size: EMP_PAGE_SIZE,
  };
  const empSearch = useEmployeeList(empFilters);
  const empTotal = empSearch.data?.total ?? 0;
  const empTotalPages = Math.max(1, Math.ceil(empTotal / EMP_PAGE_SIZE));

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
    // Initialise attendance per-event selection: every event in the
    // incoming cluster is opted-in by default. The operator can
    // deselect outliers (events that don't actually belong to this
    // employee) before confirming.
    setAttendanceSelection(new Set(cluster.event_ids));
    // Always open the confirm photo grid on page 1.
    setConfirmPhotoPage(1);
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

  // Reference-image count cap (shared rule). The employee already has
  // ``photo_count`` reference photos; this batch can only fill the
  // remaining slots up to MAX_REFERENCE_PHOTOS. Backend re-enforces.
  const refRemaining = selected
    ? referencePhotosRemaining(selected.photo_count ?? 0)
    : MAX_REFERENCE_PHOTOS;
  const refOverLimit =
    workflow === "reference" && selectedPhotos.length > refRemaining;

  const handleConfirm = async () => {
    if (!selected) return;
    if (refOverLimit) return; // guarded; the button is disabled too
    try {
      if (workflow === "reference") {
        const photoAssignments: PhotoAssignment[] = selectedPhotos.map((p) => ({
          event_id: p.event_id,
          angle: p.angle,
        }));
        const res = await refMutation.mutateAsync({
          employee_id: selected.id,
          event_ids: cluster.event_ids,
          photo_assignments: photoAssignments,
        });
        setResult({ kind: "reference", data: res });
        setStep("done");
        onSuccess(res);
      } else {
        // Attendance workflow — submit only the events the operator
        // left checked in the per-event selection grid.
        const selectedEventIds = cluster.event_ids.filter((id) =>
          attendanceSelection.has(id),
        );
        const res = await attMutation.mutateAsync({
          employee_id: selected.id,
          event_ids: selectedEventIds,
        });
        setResult({ kind: "attendance", data: res });
        setStep("done");
        onSuccess(res);
      }
    } catch {
      // Error surfaced via the active mutation's isError state.
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
      <div role="presentation" onClick={onClose} className="unid-scrim" style={{ zIndex: 499 }} />

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
          className="unid-modal"
          style={{ width: "min(480px, 92vw)", maxHeight: "80vh" }}
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
                  : step === "search"
                  ? t("unidentifiedFaces.mapModal.searchTitle", "Choose Employee")
                  : t("unidentifiedFaces.mapModal.workflowTitle", "Map to Employee")}
              </div>
              {step !== "done" && (
                <div style={{
                  fontSize: 11.5,
                  color: "var(--text-secondary)",
                  marginTop: 2,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}>
                  <span>
                    {t("unidentifiedFaces.clusterOf", "Cluster of {{count}} faces", { count: cluster.count })}
                  </span>
                  {step !== "workflow" && (
                    <>
                      <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                      <span
                        style={{
                          padding: "1px 7px",
                          borderRadius: 999,
                          background:
                            workflow === "reference"
                              ? "rgba(59,130,246,0.15)"
                              : "rgba(34,197,94,0.15)",
                          color:
                            workflow === "reference" ? "#2563eb" : "#16a34a",
                          fontSize: 10.5,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                        }}
                      >
                        {workflow === "reference"
                          ? t("unidentifiedFaces.mapModal.wfRefChip", "Reference")
                          : t("unidentifiedFaces.mapModal.wfAttChip", "Attendance")}
                      </span>
                    </>
                  )}
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

          {/* ── Step 0: Workflow picker ──
              Two distinct workflows with explicit side-effect copy
              under each so the operator can't pick the wrong one by
              accident. Picking either advances to the search step. */}
          {step === "workflow" && (
            <div style={{
              padding: "16px 18px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              flex: 1,
            }}>
              <div style={{
                fontSize: 12.5,
                color: "var(--text-secondary)",
                marginBottom: 2,
              }}>
                {t(
                  "unidentifiedFaces.mapModal.workflowIntro",
                  "Both workflows attribute the selected faces to the chosen employee. Pick the workflow that matches what you're doing:",
                )}
              </div>

              <button
                type="button"
                onClick={() => { setWorkflow("reference"); setStep("search"); }}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "12px 14px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  background: "var(--bg)",
                  textAlign: "start",
                  cursor: "pointer",
                  transition: "border-color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "#3b82f6";
                  e.currentTarget.style.background = "rgba(59,130,246,0.04)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.background = "var(--bg)";
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "rgba(59,130,246,0.15)",
                    color: "#2563eb",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon name="camera" size={16} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 3 }}>
                    {t(
                      "unidentifiedFaces.mapModal.wfReferenceTitle",
                      "Add as reference photos",
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                    {t(
                      "unidentifiedFaces.mapModal.wfReferenceBody",
                      "Adds the selected face crops to the employee's training set. Improves automatic recognition for future captures of this person.",
                    )}
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => { setWorkflow("attendance"); setStep("search"); }}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "12px 14px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  background: "var(--bg)",
                  textAlign: "start",
                  cursor: "pointer",
                  transition: "border-color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "#16a34a";
                  e.currentTarget.style.background = "rgba(34,197,94,0.04)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.background = "var(--bg)";
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "rgba(34,197,94,0.15)",
                    color: "#16a34a",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon name="clock" size={16} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 3 }}>
                    {t(
                      "unidentifiedFaces.mapModal.wfAttendanceTitle",
                      "Correct attendance event",
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                    {t(
                      "unidentifiedFaces.mapModal.wfAttendanceBody",
                      "Marks the chosen events as the employee's attendance. Updates Camera Logs + Matched Clips and recomputes the attendance record for the affected dates.",
                    )}
                  </div>
                </div>
              </button>
            </div>
          )}

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
              {/* Employee picker pager — only when the result set spans
                  more than one page. The scrollable list above shows
                  one page (EMP_PAGE_SIZE rows); these controls walk the
                  full roster without forcing the operator to refine the
                  search. */}
              {!empSearch.isLoading && empTotal > EMP_PAGE_SIZE && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderTop: "1px solid var(--border)",
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                >
                  <span className="text-dim">
                    {t("common.pageOf", "Page {{page}} of {{total}}", {
                      page: empPage,
                      total: empTotalPages,
                    })}
                    {" · "}
                    {empTotal.toLocaleString()}{" "}
                    {empTotal === 1
                      ? t("unidentifiedFaces.mapModal.employee", "employee")
                      : t("unidentifiedFaces.mapModal.employees", "employees")}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={empPage <= 1 || empSearch.isFetching}
                      onClick={() => setEmpPage((p) => Math.max(1, p - 1))}
                      aria-label={t(
                        "unidentifiedFaces.mapModal.prevEmployeePage",
                        "Previous page of employees",
                      )}
                      style={{ padding: "7px 12px", fontSize: 12.5 }}
                    >
                      <Icon name="chevronLeft" size={13} />
                      {t("common.previous", "Previous")}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={empPage >= empTotalPages || empSearch.isFetching}
                      onClick={() =>
                        setEmpPage((p) => Math.min(empTotalPages, p + 1))
                      }
                      aria-label={t(
                        "unidentifiedFaces.mapModal.nextEmployeePage",
                        "Next page of employees",
                      )}
                      style={{ padding: "7px 12px", fontSize: 12.5 }}
                    >
                      {t("common.next", "Next")}
                      <Icon name="chevronRight" size={13} />
                    </button>
                  </div>
                </div>
              )}
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

                {/* Photo selection section — Reference workflow only.
                    The Attendance workflow doesn't copy photos, so we
                    swap the block out for an attendance-correction
                    summary below. */}
                {workflow === "reference" && (
                  photoSelections.length === 0 ? (
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
                      <span style={{ fontWeight: 400, marginInlineStart: 6, fontSize: 11, color: "var(--text-tertiary)" }}>
                        ({refRemaining} of {MAX_REFERENCE_PHOTOS} slots free)
                      </span>
                    </div>
                    {refOverLimit && (
                      <div
                        role="alert"
                        style={{
                          background: "var(--danger-soft)",
                          color: "var(--danger-text)",
                          border: "1px solid var(--border)",
                          padding: "8px 10px",
                          borderRadius: "var(--radius-sm)",
                          fontSize: 12,
                          marginBottom: 10,
                        }}
                      >
                        {PHOTO_MESSAGES.maxImages}
                      </div>
                    )}
                    {(() => {
                      const photoTotalPages = Math.max(
                        1,
                        Math.ceil(
                          photoSelections.length / CONFIRM_PHOTOS_PER_PAGE,
                        ),
                      );
                      const safePage = Math.min(
                        Math.max(1, confirmPhotoPage),
                        photoTotalPages,
                      );
                      const start = (safePage - 1) * CONFIRM_PHOTOS_PER_PAGE;
                      const pagePhotos = photoSelections.slice(
                        start,
                        start + CONFIRM_PHOTOS_PER_PAGE,
                      );
                      return (
                        <>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
                            gap: 8,
                            marginBottom: 16,
                          }}>
                            {pagePhotos.map((ps) => (
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
                          {photoSelections.length > CONFIRM_PHOTOS_PER_PAGE && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: 16,
                                paddingTop: 10,
                                borderTop: "1px solid var(--border)",
                                fontSize: 12,
                              }}
                            >
                              <span className="text-dim">
                                {t("common.pageOf", "Page {{page}} of {{total}}", {
                                  page: safePage,
                                  total: photoTotalPages,
                                })}
                                {" · "}
                                {photoSelections.length.toLocaleString()}{" "}
                                {photoSelections.length === 1
                                  ? t("unidentifiedFaces.mapModal.photo", "photo")
                                  : t("unidentifiedFaces.mapModal.photos", "photos")}
                              </span>
                              <div style={{ display: "flex", gap: 8 }}>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={safePage <= 1}
                                  onClick={() =>
                                    setConfirmPhotoPage(Math.max(1, safePage - 1))
                                  }
                                  aria-label={t(
                                    "unidentifiedFaces.mapModal.prevPhotoPage",
                                    "Previous page of photos",
                                  )}
                                  style={{ padding: "7px 12px", fontSize: 12.5 }}
                                >
                                  <Icon name="chevronLeft" size={13} />
                                  {t("common.previous", "Previous")}
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={safePage >= photoTotalPages}
                                  onClick={() =>
                                    setConfirmPhotoPage(
                                      Math.min(photoTotalPages, safePage + 1),
                                    )
                                  }
                                  aria-label={t(
                                    "unidentifiedFaces.mapModal.nextPhotoPage",
                                    "Next page of photos",
                                  )}
                                  style={{ padding: "7px 12px", fontSize: 12.5 }}
                                >
                                  {t("common.next", "Next")}
                                  <Icon name="chevronRight" size={13} />
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </>
                )
                )}

                {/* Attendance workflow — per-event picker grid.
                    Every event in the cluster shows up as a tile with
                    a checkbox; defaults to selected. The operator can
                    deselect outliers (events that don't actually
                    belong to this employee) before triggering the
                    attribution + attendance recompute.

                    Backend caps each request at 200 events; the count
                    badge below surfaces that limit. */}
                {workflow === "attendance" && (() => {
                  // Build event tiles only for events with a crop on
                  // disk — those are the ones we have visible
                  // evidence for. Events without crops still get
                  // attributed (the operator already chose to include
                  // them via the upstream selection); they just don't
                  // appear in the picker grid because there's nothing
                  // to render.
                  const cropIds = cluster.crop_event_ids;
                  const otherIds = cluster.event_ids.filter(
                    (id) => !cropIds.includes(id),
                  );
                  const selectedCount = cluster.event_ids.filter((id) =>
                    attendanceSelection.has(id),
                  ).length;
                  const overCap = selectedCount > MAX_EVENTS_PER_REQUEST;
                  const toggle = (id: number) => {
                    setAttendanceSelection((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  };
                  const setAll = (on: boolean) => {
                    setAttendanceSelection(
                      on ? new Set(cluster.event_ids) : new Set(),
                    );
                  };
                  return (
                    <div style={{ marginBottom: 14 }}>
                      {/* Header row: title + Select all + count chip */}
                      <div style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        marginBottom: 10,
                        flexWrap: "wrap",
                      }}>
                        <div style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: "var(--text)",
                        }}>
                          {t(
                            "unidentifiedFaces.mapModal.attendanceSelectTitle",
                            "Pick events for this attendance correction",
                          )}
                        </div>
                        <div style={{ flex: 1 }} />
                        <button
                          type="button"
                          onClick={() =>
                            setAll(
                              selectedCount !== cluster.event_ids.length,
                            )
                          }
                          className="btn btn-sm"
                          style={{ padding: "3px 9px", fontSize: 11 }}
                          disabled={mapMutation.isPending}
                        >
                          {selectedCount === cluster.event_ids.length
                            ? t(
                                "unidentifiedFaces.mapModal.deselectAll",
                                "Deselect all",
                              )
                            : t(
                                "unidentifiedFaces.mapModal.selectAll",
                                "Select all",
                              )}
                        </button>
                        <span
                          style={{
                            fontSize: 11,
                            padding: "2.5px 10px",
                            borderRadius: 999,
                            background: overCap
                              ? "rgba(220,38,38,0.12)"
                              : "rgba(34,197,94,0.12)",
                            color: overCap ? "#dc2626" : "#16a34a",
                            border: overCap
                              ? "1px solid rgba(220,38,38,0.25)"
                              : "1px solid rgba(34,197,94,0.25)",
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: 600,
                          }}
                        >
                          {selectedCount} / {cluster.event_ids.length}
                          {overCap
                            ? ` · max ${MAX_EVENTS_PER_REQUEST}`
                            : ""}
                        </span>
                      </div>

                      {overCap && (
                        <div
                          style={{
                            padding: "8px 12px",
                            marginBottom: 8,
                            background: "rgba(220,38,38,0.06)",
                            border: "1px solid rgba(220,38,38,0.25)",
                            borderRadius: "var(--radius-sm)",
                            fontSize: 11.5,
                            color: "#dc2626",
                          }}
                        >
                          {t(
                            "unidentifiedFaces.mapModal.tooManyEvents",
                            "Too many events selected. Deselect at least {{n}} — the server caps each request at {{max}}.",
                            {
                              n: selectedCount - MAX_EVENTS_PER_REQUEST,
                              max: MAX_EVENTS_PER_REQUEST,
                            },
                          )}
                        </div>
                      )}

                      {cropIds.length === 0 ? (
                        <div style={{
                          fontSize: 12.5,
                          color: "var(--text-tertiary)",
                          fontStyle: "italic",
                          padding: "10px 12px",
                          background: "var(--bg-sunken)",
                          borderRadius: "var(--radius-sm)",
                        }}>
                          {t(
                            "unidentifiedFaces.mapModal.attendanceNoCrops",
                            "No face crops available to preview. {{count}} event(s) will still be attributed if you continue.",
                            { count: cluster.event_ids.length },
                          )}
                        </div>
                      ) : (
                        <div style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))",
                          gap: 6,
                          maxHeight: 240,
                          overflowY: "auto",
                          padding: 2,
                        }}>
                          {cropIds.map((id) => {
                            const isOn = attendanceSelection.has(id);
                            return (
                              <button
                                key={id}
                                type="button"
                                onClick={() => toggle(id)}
                                aria-pressed={isOn}
                                aria-label={t(
                                  "unidentifiedFaces.mapModal.attendanceTileAria",
                                  "Toggle event #{{id}}",
                                  { id },
                                ) as string}
                                style={{
                                  position: "relative",
                                  padding: 0,
                                  border: isOn
                                    ? "2px solid #16a34a"
                                    : "1px solid var(--border)",
                                  borderRadius: "var(--radius-sm)",
                                  overflow: "hidden",
                                  background: "var(--bg-sunken)",
                                  cursor: "pointer",
                                  aspectRatio: "1",
                                  opacity: isOn ? 1 : 0.45,
                                  transition: "opacity 0.12s, border-color 0.12s",
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
                                <span
                                  aria-hidden
                                  style={{
                                    position: "absolute",
                                    top: 4,
                                    insetInlineEnd: 4,
                                    width: 18,
                                    height: 18,
                                    borderRadius: 4,
                                    background: isOn
                                      ? "#16a34a"
                                      : "rgba(0,0,0,0.55)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    color: "#fff",
                                    fontSize: 11,
                                  }}
                                >
                                  {isOn ? <Icon name="check" size={10} /> : ""}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {otherIds.length > 0 && (
                        <div style={{
                          fontSize: 11,
                          color: "var(--text-tertiary)",
                          marginTop: 6,
                          fontStyle: "italic",
                        }}>
                          {t(
                            "unidentifiedFaces.mapModal.attendanceNoPreviewNote",
                            "+{{n}} event(s) without a saved crop. They follow the same selection as the preview tiles (toggle Select all to opt out).",
                            { n: otherIds.length },
                          )}
                        </div>
                      )}

                      <div style={{
                        marginTop: 10,
                        fontSize: 11,
                        color: "var(--text-tertiary)",
                        fontStyle: "italic",
                      }}>
                        {t(
                          "unidentifiedFaces.mapModal.attendanceNoteRefs",
                          "No reference photos will be added — use the Reference workflow to also train the matcher with these crops.",
                        )}
                      </div>
                    </div>
                  );
                })()}

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
                  onClick={() => {
                    // Back goes to search so the operator can pick a
                    // different employee without losing the workflow
                    // choice. A separate "Change workflow" affordance
                    // lives in the header chip if needed.
                    setStep("search");
                    refMutation.reset();
                    attMutation.reset();
                  }}
                  className="btn btn-sm"
                  disabled={mapMutation.isPending}
                >
                  {t("unidentifiedFaces.mapModal.back", "Back")}
                </button>
                <button
                  onClick={() => { void handleConfirm(); }}
                  className="btn btn-sm btn-primary"
                  disabled={
                    mapMutation.isPending
                    // Attendance workflow needs at least one event
                    // selected and must respect the 200-per-request
                    // server cap. The reference workflow doesn't gate
                    // on the per-event picker because it always
                    // attributes the entire cluster.
                    || (workflow === "attendance" && (
                      attendanceSelection.size === 0
                      || cluster.event_ids.filter((id) => attendanceSelection.has(id)).length
                          > MAX_EVENTS_PER_REQUEST
                    ))
                    // Reference workflow can't push the employee past
                    // the per-employee reference-image cap.
                    || refOverLimit
                  }
                >
                  {mapMutation.isPending
                    ? t("unidentifiedFaces.mapModal.mapping", "Mapping…")
                    : workflow === "attendance"
                      ? (t(
                          "unidentifiedFaces.mapModal.confirmBtnAtt",
                          "Confirm ({{n}} event{{plural}})",
                          {
                            n: cluster.event_ids.filter((id) => attendanceSelection.has(id)).length,
                            plural: cluster.event_ids.filter((id) => attendanceSelection.has(id)).length === 1 ? "" : "s",
                          },
                        ) as string)
                      : (t("unidentifiedFaces.mapModal.confirmBtn", "Confirm Mapping") as string)}
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
                <div style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 360 }}>
                  {result.kind === "reference"
                    ? (t("unidentifiedFaces.mapModal.successDetail",
                        "Marked {{events}} event(s) as identified and added {{photos}} reference photo(s) for {{name}}.",
                        {
                          events: result.data.mapped_events,
                          photos: result.data.photos_created,
                          name: selected.full_name,
                        },
                      ) as string)
                    : (t("unidentifiedFaces.mapModal.successDetailAttendance",
                        "Marked {{events}} event(s) as {{name}}'s attendance and recomputed {{dates}} day(s).",
                        {
                          events: result.data.mapped_events,
                          name: selected.full_name,
                          dates: result.data.attendance_dates_recomputed.length,
                        },
                      ) as string)}
                </div>
                {result.kind === "attendance" &&
                  result.data.attendance_dates_recomputed.length > 0 && (
                    <div style={{
                      marginTop: 10,
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      justifyContent: "center",
                    }}>
                      {result.data.attendance_dates_recomputed.map((d) => (
                        <span
                          key={d}
                          style={{
                            fontSize: 11,
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: "rgba(34,197,94,0.12)",
                            color: "#16a34a",
                            fontVariantNumeric: "tabular-nums",
                            border: "1px solid rgba(34,197,94,0.25)",
                          }}
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  )}
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
  const dt = useTenantDateTime();

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
        background: "var(--unid-scrim)",
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
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-lg)",
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
              value={captured ? dt.formatTimeWithSeconds(captured) || "—" : "—"}
            />
            <GalleryMetaCell
              label={t("unidentifiedFaces.detectionDateLabel", "Detection date")}
              value={captured ? dt.formatDate(captured) || "—" : "—"}
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

// ----------------------------------------------------------------------
// ClusterFilterBar — in-cluster filter UI.
//
// Replaces the previous 3-row stacked chip layout. Active filters appear
// as removable tags; "+ Add filter" opens a grouped menu (Similarity /
// Quality / Clarity). The menu uses ``createPortal`` for the popover
// position so ancestor ``overflow: hidden`` doesn't clip it; the
// outside-click / Escape handlers restore focus to the trigger.
// ----------------------------------------------------------------------

interface ClusterFilterBarProps {
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
}

// Small dropdown shell used by ClusterFilterBar — three instances, one
// per filter category. Owns its trigger ref + outside-click / Escape
// handling so the parent only juggles which key is open.
interface FilterDropdownProps {
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}

function FilterDropdown({ label, isOpen, onToggle, onClose, children }: FilterDropdownProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        className="unid-addbtn"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <Icon name="plus" size={10} aria-hidden />
        <span>{label}</span>
        <Icon name="chevronDown" size={10} aria-hidden />
      </button>
      {isOpen && (
        <div ref={menuRef} role="menu" className="unid-menu" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

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
}: ClusterFilterBarProps) {
  const { t } = useTranslation();
  // Only one dropdown open at a time — clicking a second button closes
  // the first. ``null`` = all closed.
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

  const qualityLabel = (k: QualityFilter): string => ({
    all: "",
    high: t("unidentifiedFaces.qHighChip", "High") as string,
    medium: t("unidentifiedFaces.qMediumChip", "Medium") as string,
    low: t("unidentifiedFaces.qLowChip", "Low") as string,
  })[k];

  const clarityLabel = (k: ClarityFilter): string => ({
    all: "",
    clear: t("unidentifiedFaces.cClearChip", "Clear face") as string,
    blur: t("unidentifiedFaces.cBlurChip", "Blur face") as string,
    side: t("unidentifiedFaces.cSideChip", "Side face") as string,
    partial: t("unidentifiedFaces.cPartialChip", "Partial face") as string,
  })[k];

  const QUALITY_OPTIONS: readonly [QualityFilter, string, string][] = [
    ["high", t("unidentifiedFaces.qHighChip", "High") as string, "#22c55e"],
    ["medium", t("unidentifiedFaces.qMediumChip", "Medium") as string, "#f59e0b"],
    ["low", t("unidentifiedFaces.qLowChip", "Low") as string, "#94a3b8"],
  ];
  const CLARITY_OPTIONS: readonly [ClarityFilter, string, string][] = [
    ["clear", t("unidentifiedFaces.cClearChip", "Clear face") as string, "#22c55e"],
    ["blur", t("unidentifiedFaces.cBlurChip", "Blur face") as string, "#94a3b8"],
    ["side", t("unidentifiedFaces.cSideChip", "Side face") as string, "#a855f7"],
    ["partial", t("unidentifiedFaces.cPartialChip", "Partial face") as string, "#f97316"],
  ];

  return (
    <div className="unid-tagbar-wrap">
      <div className="unid-tagbar">
        {/* Active filter tags */}
        {simPct > 0 && (
          <span className="unid-tag">
            <span>
              {t("unidentifiedFaces.filterSim", "Similarity") as string}{" "}
              {simMode === "gte" ? "≥" : "="}{simPct}%
            </span>
            <button
              type="button"
              className="unid-tag-x"
              onClick={() => setSimPct(0)}
              aria-label={t("unidentifiedFaces.clearSimFilter", "Clear similarity filter") as string}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        )}
        {qualityFilter !== "all" && (
          <span className="unid-tag">
            <span>
              {t("unidentifiedFaces.filterQuality", "Quality") as string}{" "}
              {qualityLabel(qualityFilter)}
            </span>
            <button
              type="button"
              className="unid-tag-x"
              onClick={() => setQualityFilter("all")}
              aria-label={t("unidentifiedFaces.clearQualityFilter", "Clear quality filter") as string}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        )}
        {clarityFilter !== "all" && (
          <span className="unid-tag">
            <span>
              {t("unidentifiedFaces.filterClarity", "Clarity") as string}{" "}
              {clarityLabel(clarityFilter)}
            </span>
            <button
              type="button"
              className="unid-tag-x"
              onClick={() => setClarityFilter("all")}
              aria-label={t("unidentifiedFaces.clearClarityFilter", "Clear clarity filter") as string}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        )}

        {/* Three independent category dropdowns. Each owns its trigger
            + popover; ``openKey`` ensures only one is visible at a time. */}
        <FilterDropdown
          label={t("unidentifiedFaces.filterSim", "Similarity") as string}
          isOpen={openKey === "sim"}
          onToggle={toggleKey("sim")}
          onClose={closeAll}
        >
          {presets.length > 0 ? (
            presets.map((p) => (
              <button
                key={p}
                role="menuitem"
                type="button"
                className="unid-menu-item"
                aria-pressed={simPct === p && simMode === "gte"}
                onClick={() => applySim(p, "gte")}
              >
                ≥{p}%
              </button>
            ))
          ) : (
            <div className="unid-menu-empty">
              {t("unidentifiedFaces.noSimRange", "No similarity range data") as string}
            </div>
          )}
          <button
            role="menuitem"
            type="button"
            className="unid-menu-item"
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
          >
            {t("unidentifiedFaces.customSim", "Custom…") as string}
          </button>
          {customOpen && (
            <div className="unid-menu-custom">
              <div
                role="group"
                className="unid-modetoggle"
                aria-label={t("unidentifiedFaces.simModeAria", "Similarity match mode") as string}
              >
                <button
                  type="button"
                  aria-pressed={customMode === "gte"}
                  onClick={() => setCustomMode("gte")}
                  title={t("unidentifiedFaces.simModeGteHint", "Greater than or equal to") as string}
                >≥</button>
                <button
                  type="button"
                  aria-pressed={customMode === "eq"}
                  onClick={() => setCustomMode("eq")}
                  title={t("unidentifiedFaces.simModeEqHint", "Equal to") as string}
                >=</button>
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
                  if (e.key === "Enter") {
                    const n = parseInt(customValue, 10);
                    if (!Number.isNaN(n) && n >= 1 && n <= 100) {
                      applySim(n, customMode);
                    }
                  }
                }}
              />
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>%</span>
              <button
                type="button"
                className="unid-apply-btn"
                disabled={(() => {
                  const n = parseInt(customValue, 10);
                  return Number.isNaN(n) || n < 1 || n > 100;
                })()}
                onClick={() => {
                  const n = parseInt(customValue, 10);
                  if (!Number.isNaN(n) && n >= 1 && n <= 100) {
                    applySim(n, customMode);
                  }
                }}
              >
                {t("unidentifiedFaces.apply", "Apply") as string}
              </button>
            </div>
          )}
          {simRangeMin < simRangeMax && (
            <div className="unid-menu-range">
              {t("unidentifiedFaces.simRangeHint", "in cluster: {{min}}–{{max}}%", {
                min: simRangeMin,
                max: simRangeMax,
              }) as string}
            </div>
          )}
        </FilterDropdown>

        <FilterDropdown
          label={t("unidentifiedFaces.filterQuality", "Quality") as string}
          isOpen={openKey === "quality"}
          onToggle={toggleKey("quality")}
          onClose={closeAll}
        >
          {QUALITY_OPTIONS.map(([key, label, dot]) => (
            <button
              key={key}
              role="menuitem"
              type="button"
              className="unid-menu-item"
              aria-pressed={qualityFilter === key}
              onClick={() => {
                setQualityFilter(key);
                closeAll();
              }}
            >
              <span className="unid-chip-dot" style={{ background: dot }} />
              {label}
            </button>
          ))}
        </FilterDropdown>

        <FilterDropdown
          label={t("unidentifiedFaces.filterClarity", "Clarity") as string}
          isOpen={openKey === "clarity"}
          onToggle={toggleKey("clarity")}
          onClose={closeAll}
        >
          {CLARITY_OPTIONS.map(([key, label, dot]) => (
            <button
              key={key}
              role="menuitem"
              type="button"
              className="unid-menu-item"
              aria-pressed={clarityFilter === key}
              onClick={() => {
                setClarityFilter(key);
                closeAll();
              }}
            >
              <span className="unid-chip-dot" style={{ background: dot }} />
              {label}
            </button>
          ))}
        </FilterDropdown>
      </div>

      {hasAny && (
        <div className="unid-tagbar-footer">
          <span>
            {t("unidentifiedFaces.filterStat", "Showing {{shown}} of {{total}}", {
              shown,
              total,
            }) as string}
          </span>
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

function ClusterDrawer({ cluster, onClose }: ClusterDrawerProps) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
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
  // Similar Faces grid pagination — 24 tiles/page matches the
  // ``repeat(4, ...)`` × 6 rows layout the drawer already uses, so a
  // page is exactly one screenful at the drawer's natural width.
  // Long clusters (a single person walking past the camera for an
  // hour) routinely hit hundreds of crops; rendering them all at
  // once forces the operator into a long inline scroll.
  const SIMILAR_FACES_PER_PAGE = 24;
  const [similarFacesPage, setSimilarFacesPage] = useState<number>(1);

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

  // Similar Faces pagination. Pages flip independently of the
  // filter row above, but any filter change shrinks the set — so
  // clamp the page back in range whenever ``filteredCropIds.length``
  // moves. Without this the operator can be left staring at an empty
  // page-5 after tightening a filter.
  const similarFacesTotalPages = Math.max(
    1,
    Math.ceil(filteredCropIds.length / SIMILAR_FACES_PER_PAGE),
  );
  useEffect(() => {
    if (similarFacesPage > similarFacesTotalPages) {
      setSimilarFacesPage(similarFacesTotalPages);
    } else if (similarFacesPage < 1) {
      setSimilarFacesPage(1);
    }
  }, [similarFacesPage, similarFacesTotalPages]);
  const similarFacesSafePage = Math.min(
    Math.max(1, similarFacesPage),
    similarFacesTotalPages,
  );
  const similarFacesStart =
    (similarFacesSafePage - 1) * SIMILAR_FACES_PER_PAGE;
  const similarFacesEnd = similarFacesStart + SIMILAR_FACES_PER_PAGE;
  const pageCropIds = filteredCropIds.slice(
    similarFacesStart,
    similarFacesEnd,
  );

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
  // Migration 0068 — tenant tz + format.
  const fmtTime = (iso: string) => dt.formatTime(iso) || iso;
  const fmtDay = (iso: string) => dt.formatDate(iso) || iso;

  return (
    <>
      {/* Backdrop — visual only. Outside-click does NOT close; the
          drawer requires an explicit × button or Esc keypress. */}
      <div aria-hidden className="unid-scrim" style={{ zIndex: 399, pointerEvents: "none" }} />

      <aside
        role="dialog"
        aria-label={t("unidentifiedFaces.drawerTitle", "Cluster detail")}
        aria-modal="true"
        className="unid-drawer"
        style={{ width: "min(720px, 96vw)", zIndex: 400 }}
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

          {/* ── In-cluster filters — active-tag bar + "+ Add filter" menu */}
          <div style={{ padding: "16px 18px 0" }}>
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
              presets={(() => {
                if (cropSims.length < 2 || simRangeMin >= simRangeMax) return [];
                const span = simRangeMax - simRangeMin;
                const raw = [
                  simRangeMin + Math.round(span * 0.25),
                  simRangeMin + Math.round(span * 0.5),
                  simRangeMin + Math.round(span * 0.75),
                ];
                const seen = new Set<number>();
                return raw.filter((p) => {
                  if (seen.has(p)) return false;
                  seen.add(p);
                  return true;
                });
              })()}
              shown={filteredCropIds.length}
              total={cluster.crop_event_ids.length}
            />
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
              <>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                  gap: 10,
                }}>
                  {pageCropIds.map((id) => {
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
                {filteredCropIds.length > SIMILAR_FACES_PER_PAGE && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginTop: 12,
                      paddingTop: 10,
                      borderTop: "1px solid var(--border)",
                      fontSize: 12,
                    }}
                  >
                    <span className="text-dim">
                      {t("common.pageOf", "Page {{page}} of {{total}}", {
                        page: similarFacesSafePage,
                        total: similarFacesTotalPages,
                      })}
                      {" · "}
                      {filteredCropIds.length.toLocaleString()}{" "}
                      {filteredCropIds.length === 1
                        ? t("unidentifiedFaces.face", "face")
                        : t("unidentifiedFaces.faces", "faces")}
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        className="btn"
                        disabled={similarFacesSafePage <= 1}
                        onClick={() =>
                          setSimilarFacesPage(
                            Math.max(1, similarFacesSafePage - 1),
                          )
                        }
                        aria-label={t(
                          "unidentifiedFaces.prevSimilarFacesPage",
                          "Previous page of similar faces",
                        )}
                        style={{ padding: "8px 14px", fontSize: 13 }}
                      >
                        <Icon name="chevronLeft" size={14} />
                        {t("common.previous", "Previous")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={similarFacesSafePage >= similarFacesTotalPages}
                        onClick={() =>
                          setSimilarFacesPage(
                            Math.min(
                              similarFacesTotalPages,
                              similarFacesSafePage + 1,
                            ),
                          )
                        }
                        aria-label={t(
                          "unidentifiedFaces.nextSimilarFacesPage",
                          "Next page of similar faces",
                        )}
                        style={{ padding: "8px 14px", fontSize: 13 }}
                      >
                        {t("common.next", "Next")}
                        <Icon name="chevronRight" size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </>
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
  const fmtDate = useFmtDate();
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
      <div role="presentation" className="unid-scrim" style={{ zIndex: 499 }} />
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
        <div className="unid-modal" style={{ width: "min(420px, 94vw)", overflow: "hidden" }}>
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
  const fmtDate = useFmtDate();
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
    <span className={warn ? "unid-statpill pill pill-warning" : "unid-statpill pill"}>
      <span className="unid-statpill-label">{label}</span>
      <span className="unid-statpill-value">{value}</span>
    </span>
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
  renderError: (error?: unknown, retry?: () => void) => React.ReactNode;
  onRetry?: () => void;
  renderSkeleton: (n: number) => React.ReactNode;
  renderPagination: (
    page: number,
    total: number,
    onPage: (p: number) => void,
  ) => React.ReactNode;
  pageSize: number;
}

// ── Unmap confirm modal ───────────────────────────────────────────────
//
// Shared confirmation modal for reverting Map-to-Employee operations.
// One UI for the single-event "Unmap" path and the per-employee
// "Unmap all" path — they only differ in count + description.
//
// Spells out exactly what will happen (events return to Unknown pool,
// attendance is recomputed for the affected dates, reference photos
// stay) so the operator can't tap-through unintentionally.

interface UnmapConfirmModalProps {
  eventIds: number[];
  /** Plain-English subject — "this detection", "Hari's mappings", … */
  subject: string;
  onClose: () => void;
  onDone: (result: UnmapEventsResponse) => void;
}

function UnmapConfirmModal({
  eventIds,
  subject,
  onClose,
  onDone,
}: UnmapConfirmModalProps) {
  const { t } = useTranslation();
  const unmap = useUnmapEvents();
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const handleConfirm = () => {
    setResultMsg(null);
    unmap.mutate(
      { event_ids: eventIds },
      {
        onSuccess: (res) => {
          onDone(res);
        },
        onError: (err) => {
          setResultMsg(
            (t("unidentifiedFaces.unmapModal.failed", {
              defaultValue: "Unmap failed — please try again.",
            }) as string) +
              ` (${(err as Error).message})`,
          );
        },
      },
    );
  };

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !unmap.isPending) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, unmap.isPending]);

  // Portal up to document.body so ``position: fixed`` is interpreted
  // relative to the viewport, not the containing tile. ``.unid-card``
  // has ``overflow: hidden`` + a fade-in animation that creates a
  // containing block, which clips the modal to the tile box if we
  // render in-place. Portal escapes both.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unmap-confirm-title"
      className="unid-scrim"
      style={{ display: "grid", placeItems: "center", zIndex: 9000, padding: 24 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="unid-modal"
        style={{ width: "min(460px, 92vw)", padding: 18, gap: 12 }}
      >
        <div
          id="unmap-confirm-title"
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: "var(--warning-soft)",
              color: "var(--warning-text)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="refresh" size={13} />
          </span>
          {t("unidentifiedFaces.unmapModal.title", {
            defaultValue: "Revert this employee mapping?",
          }) as string}
        </div>

        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {t("unidentifiedFaces.unmapModal.body", {
            defaultValue:
              "{{count}} detection event(s) for {{subject}} will be returned to the Unknown Faces pool. Attendance for the affected dates will be recomputed and the live matcher cache will be refreshed.",
            count: eventIds.length,
            subject,
          }) as string}
        </div>

        <ul
          style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            paddingInlineStart: 18,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          <li>
            {t("unidentifiedFaces.unmapModal.note1", {
              defaultValue: "Events reappear in Unknown Faces + Similarity Groups",
            }) as string}
          </li>
          <li>
            {t("unidentifiedFaces.unmapModal.note2", {
              defaultValue: "Camera Logs + Matched Clips drop the employee tag",
            }) as string}
          </li>
          <li>
            {t("unidentifiedFaces.unmapModal.note3", {
              defaultValue: "Attendance for the affected dates is recomputed",
            }) as string}
          </li>
          <li>
            {t("unidentifiedFaces.unmapModal.note4", {
              defaultValue:
                "Reference photos copied earlier are NOT removed — manage them via Employee → Reference Photos.",
            }) as string}
          </li>
        </ul>

        {resultMsg && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              fontSize: 12,
              background: "var(--danger-soft, #fee2e2)",
              border: "1px solid var(--danger, #fca5a5)",
              color: "var(--danger-text, #991b1b)",
            }}
          >
            {resultMsg}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={unmap.isPending}
          >
            {t("common.cancel", { defaultValue: "Cancel" }) as string}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            style={{
              background: "var(--danger, #dc2626)",
              borderColor: "var(--danger, #dc2626)",
              color: "white",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
            onClick={handleConfirm}
            disabled={unmap.isPending}
          >
            <Icon name="refresh" size={11} />
            {unmap.isPending
              ? (t("unidentifiedFaces.unmapModal.unmapping", {
                  defaultValue: "Reverting…",
                }) as string)
              : (t("unidentifiedFaces.unmapModal.confirm", {
                  defaultValue: "Revert {{n}} event(s)",
                  n: eventIds.length,
                }) as string)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
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
  onRetry,
  renderSkeleton,
  renderPagination,
  pageSize,
}: MappedFacesGridProps) {
  const { t } = useTranslation();
  return (
    <>
      {isError && renderError(undefined, onRetry)}
      {isLoading && !data && renderSkeleton(pageSize)}
      {!isLoading &&
        !isError &&
        data &&
        data.items.length === 0 &&
        renderEmpty(
          t(
            "unidentifiedFaces.emptyMapped",
            "No manually-mapped detections yet. Use Map to Employee on an Unknown face to populate this tab — auto live-matches appear in Camera Logs.",
          ),
        )}
      {data && data.items.length > 0 && (
        <div className={isPlaceholder ? "at-faded" : undefined}>
          <div className="unid-grid">
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

// ── Mapping-source chip ────────────────────────────────────────────────────
//
// Renders a small badge labelling how a detection got its employee_id.
// Surfaced on Mapped Employees rows so the operator can tell at a glance
// whether a row came from the Reference Mapping or Attendance Mapping
// workflow. The ``/mapped`` + ``/mapped-clusters`` endpoints already
// filter out ``auto`` rows, so this component only ever shows the two
// manual variants — but it also handles ``"auto"`` defensively (legacy
// rows + future surfaces).

function MappingSourceChip({
  source,
}: {
  source: import("./types").MappingSource | null | undefined;
}) {
  const { t } = useTranslation();
  if (!source) return null;
  const PALETTE: Record<
    import("./types").MappingSource,
    { bg: string; fg: string; key: string; fallback: string }
  > = {
    manual_reference: {
      bg: "rgba(59,130,246,0.16)",
      fg: "#2563eb",
      key: "unidentifiedFaces.sourceReference",
      fallback: "Reference",
    },
    manual_attendance: {
      bg: "rgba(34,197,94,0.18)",
      fg: "#16a34a",
      key: "unidentifiedFaces.sourceAttendance",
      fallback: "Attendance",
    },
    auto: {
      bg: "rgba(148,163,184,0.18)",
      fg: "var(--text-secondary)",
      key: "unidentifiedFaces.sourceAuto",
      fallback: "Auto",
    },
  };
  const p = PALETTE[source];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: 999,
        background: p.bg,
        color: p.fg,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {t(p.key, p.fallback) as string}
    </span>
  );
}

function MappedFaceTile({ event }: { event: MappedFaceEventOut }) {
  const { t } = useTranslation();
  const fmtDate = useFmtDate();
  const [imgFailed, setImgFailed] = useState(false);
  const [unmapOpen, setUnmapOpen] = useState(false);
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
        {/* Unmap button — top-right overlay. Opens a confirm modal
            that calls the revert endpoint. Same modal is shared by
            the per-employee "Unmap all" path on the cluster cards. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setUnmapOpen(true); }}
          aria-label={t("unidentifiedFaces.unmapTileAria", {
            defaultValue: "Revert this employee mapping",
          }) as string}
          title={t("unidentifiedFaces.unmapTileTitle", {
            defaultValue: "Revert mapping",
          }) as string}
          style={{
            position: "absolute",
            top: 6,
            insetInlineEnd: 6,
            width: 24,
            height: 24,
            borderRadius: 999,
            background: "rgba(0,0,0,0.65)",
            border: "1px solid rgba(255,255,255,0.18)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            padding: 0,
          }}
        >
          <Icon name="refresh" size={11} />
        </button>
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
        {event.mapping_source && (
          <div style={{ marginTop: 2 }}>
            <MappingSourceChip source={event.mapping_source} />
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

      {unmapOpen && (
        <UnmapConfirmModal
          eventIds={[event.id]}
          subject={
            event.employee_name ?? `Employee #${event.employee_id}`
          }
          onClose={() => setUnmapOpen(false)}
          onDone={() => setUnmapOpen(false)}
        />
      )}
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
  // Page-level filter pass-through so the per-employee unmap matches
  // the exact event set the rollup card is summarising. Without these,
  // an "Unmap all" click could revert events outside the visible
  // filter window — surprising behaviour for the operator.
  unmapFilter: {
    start: string | null;
    end: string | null;
    camera_id: number | null;
  };
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
  onRetry,
  renderSkeleton,
  renderPagination,
  pageSize,
  unmapFilter,
}: MappedClustersGridProps) {
  const { t } = useTranslation();
  return (
    <>
      {isError && renderError(undefined, onRetry)}
      {isLoading && !data && renderSkeleton(pageSize)}
      {!isLoading &&
        !isError &&
        data &&
        data.items.length === 0 &&
        renderEmpty(
          t(
            "unidentifiedFaces.emptyMappedClusters",
            "No employees have manually-mapped detections in this date range. This tab only shows operator-reviewed maps from Reference / Attendance Mapping — auto live-matches appear in Camera Logs.",
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
          <div className={isPlaceholder ? "at-faded" : undefined}>
            <div className="unid-grid unid-grid-wide">
              {data.items.map((emp) => (
                <MappedEmployeeCard
                  key={emp.employee_id}
                  group={emp}
                  unmapFilter={unmapFilter}
                />
              ))}
            </div>
          </div>
        </>
      )}
      {data && renderPagination(page, totalPages, onPage)}
    </>
  );
}

function MappedEmployeeCard({
  group,
  unmapFilter,
}: {
  group: MappedEmployeeGroupOut;
  unmapFilter: {
    start: string | null;
    end: string | null;
    camera_id: number | null;
  };
}) {
  const { t } = useTranslation();
  const fmtDate = useFmtDate();
  const [unmapOpen, setUnmapOpen] = useState(false);
  const [unmapResult, setUnmapResult] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
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
        position: "relative",
      }}
      role="article"
      aria-label={t("unidentifiedFaces.mappedEmployeeCardAria", "Mapped employee")}
    >
      {/* Unmap-all action — top-right overlay on the card. Acts on
          ``sample_event_ids`` (up to 8 most-recent crop events for
          this employee). For larger backfills the operator can
          repeat the action — the bounded sample makes the revert
          predictable. */}
      <button
        type="button"
        onClick={() => setUnmapOpen(true)}
        aria-label={t("unidentifiedFaces.unmapCardAria", {
          defaultValue: "Revert all sample mappings for this employee",
        }) as string}
        title={t("unidentifiedFaces.unmapCardTitle", {
          defaultValue: "Revert sample mappings",
        }) as string}
        style={{
          position: "absolute",
          top: 8,
          insetInlineEnd: 8,
          zIndex: 2,
          padding: "3px 8px",
          background: "rgba(0,0,0,0.65)",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 999,
          color: "#fff",
          fontSize: 10.5,
          fontWeight: 600,
          cursor: "pointer",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <Icon name="refresh" size={9} />
        {t("unidentifiedFaces.unmapCardBtn", {
          defaultValue: "Unmap",
        }) as string}
      </button>

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
        {/* Mapping-source chip(s). Single value → that workflow's
            label. Multiple → "Mixed". Empty list (pre-0067 row or
            mid-migration) renders nothing. */}
        {group.mapping_sources && group.mapping_sources.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {group.mapping_sources.length === 1 ? (
              <MappingSourceChip source={group.mapping_sources[0]} />
            ) : (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "1px 7px",
                  borderRadius: 999,
                  background: "rgba(148,163,184,0.22)",
                  color: "var(--text-secondary)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
                title={group.mapping_sources.join(", ")}
              >
                {t("unidentifiedFaces.sourceMixed", "Mixed") as string}
              </span>
            )}
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

      {/* Inline result banner — sits inside the card so the operator
          sees confirmation in context after the unmap completes. */}
      {unmapResult && (
        <div
          style={{
            padding: "6px 10px",
            margin: "0 12px 10px",
            fontSize: 11,
            borderRadius: 6,
            background:
              unmapResult.tone === "ok"
                ? "rgba(22,163,74,0.10)"
                : "rgba(220,38,38,0.10)",
            border:
              unmapResult.tone === "ok"
                ? "1px solid rgba(22,163,74,0.30)"
                : "1px solid rgba(220,38,38,0.30)",
            color: unmapResult.tone === "ok" ? "#15803d" : "#b91c1c",
          }}
        >
          {unmapResult.text}
        </div>
      )}

      {unmapOpen && (
        <UnmapByEmployeeModal
          employeeId={group.employee_id}
          subject={
            group.employee_name ?? `Employee #${group.employee_id}`
          }
          count={group.count}
          filter={unmapFilter}
          onClose={() => setUnmapOpen(false)}
          onDone={(res) => {
            setUnmapOpen(false);
            setUnmapResult({
              tone: "ok",
              text: t("unidentifiedFaces.unmapModal.cardSuccess", {
                defaultValue:
                  "Reverted {{n}} mapping(s). {{dates}} day(s) recomputed.",
                n: res.unmapped_events,
                dates: res.attendance_dates_recomputed.length,
              }) as string,
            });
          }}
        />
      )}
    </div>
  );
}

// ── UnmapByEmployeeModal — per-employee revert ─────────────────────
// Mirrors UnmapConfirmModal in copy but submits to the
// /unmap-by-employee endpoint with the page-level filter so the
// server selects the exact event set the card was summarising.

function UnmapByEmployeeModal({
  employeeId,
  subject,
  count,
  filter,
  onClose,
  onDone,
}: {
  employeeId: number;
  subject: string;
  count: number;
  filter: {
    start: string | null;
    end: string | null;
    camera_id: number | null;
  };
  onClose: () => void;
  onDone: (res: UnmapEventsResponse) => void;
}) {
  const { t } = useTranslation();
  const unmap = useUnmapByEmployee();
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Same date-encoding the listing queries use: start is start-of-day
  // UTC, end is end-of-day UTC. Matches the existing `/mapped` filter
  // so the server selects identical rows.
  const handleConfirm = () => {
    setErrMsg(null);
    unmap.mutate(
      {
        employee_id: employeeId,
        start: filter.start ? filter.start + "T00:00:00Z" : null,
        end: filter.end ? filter.end + "T23:59:59Z" : null,
        camera_id: filter.camera_id,
      },
      {
        onSuccess: (res) => {
          onDone(res);
        },
        onError: (err) => {
          setErrMsg(
            (t("unidentifiedFaces.unmapModal.failed", {
              defaultValue: "Unmap failed — please try again.",
            }) as string) +
              ` (${(err as Error).message})`,
          );
        },
      },
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !unmap.isPending) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, unmap.isPending]);

  // Portal to document.body — same rationale as UnmapConfirmModal: the
  // MappedEmployeeCard ancestor uses overflow/animation that would
  // otherwise contain the fixed-position modal to the card box.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="unid-scrim"
      style={{ display: "grid", placeItems: "center", zIndex: 9000, padding: 24 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="unid-modal"
        style={{ width: "min(460px, 92vw)", padding: 18, gap: 12 }}
      >
        <div style={{
          fontSize: 15,
          fontWeight: 700,
          color: "var(--text)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span aria-hidden style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "var(--warning-soft)",
            color: "var(--warning-text)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <Icon name="refresh" size={13} />
          </span>
          {t("unidentifiedFaces.unmapModal.titleAll", {
            defaultValue: "Revert all mappings for {{name}}?",
            name: subject,
          }) as string}
        </div>

        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {t("unidentifiedFaces.unmapModal.bodyAll", {
            defaultValue:
              "All {{count}} mapped detection(s) attributed to {{name}} within the current filter (date range + camera) will be returned to the Unknown Faces pool. Attendance for the affected dates will be recomputed.",
            count,
            name: subject,
          }) as string}
        </div>

        <ul style={{
          fontSize: 12,
          color: "var(--text-tertiary)",
          paddingInlineStart: 18,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}>
          <li>
            {t("unidentifiedFaces.unmapModal.note1", {
              defaultValue: "Events reappear in Unknown Faces + Similarity Groups",
            }) as string}
          </li>
          <li>
            {t("unidentifiedFaces.unmapModal.note2", {
              defaultValue: "Camera Logs + Matched Clips drop the employee tag",
            }) as string}
          </li>
          <li>
            {t("unidentifiedFaces.unmapModal.note3", {
              defaultValue: "Attendance for the affected dates is recomputed",
            }) as string}
          </li>
          <li>
            {t("unidentifiedFaces.unmapModal.note4", {
              defaultValue:
                "Reference photos copied earlier are NOT removed — manage them via Employee → Reference Photos.",
            }) as string}
          </li>
        </ul>

        {errMsg && (
          <div style={{
            padding: "8px 10px",
            borderRadius: 6,
            fontSize: 12,
            background: "var(--danger-soft, #fee2e2)",
            border: "1px solid var(--danger, #fca5a5)",
            color: "var(--danger-text, #991b1b)",
          }}>
            {errMsg}
          </div>
        )}

        <div style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 4,
        }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={unmap.isPending}
          >
            {t("common.cancel", { defaultValue: "Cancel" }) as string}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            style={{
              background: "var(--danger, #dc2626)",
              borderColor: "var(--danger, #dc2626)",
              color: "white",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
            onClick={handleConfirm}
            disabled={unmap.isPending}
          >
            <Icon name="refresh" size={11} />
            {unmap.isPending
              ? (t("unidentifiedFaces.unmapModal.unmapping", {
                  defaultValue: "Reverting…",
                }) as string)
              : (t("unidentifiedFaces.unmapModal.confirmAll", {
                  defaultValue: "Revert {{n}} mapping(s)",
                  n: count,
                }) as string)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
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

  // Similarity is filtered ONLY inside the cluster detail drawer
  // (via ``ClusterFilterBar``). The Groups grid shows every cluster the
  // backend returns, paginated by the cluster threshold + min_count.
  const clusters = clusterData?.clusters ?? [];

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
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

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
      <div className="unid-pager">
        <button onClick={() => onPage(1)} disabled={page <= 1} className="btn btn-sm btn-ghost" aria-label={t("common.first", "First page")}>«</button>
        <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1} className="btn btn-sm btn-ghost" aria-label={t("common.previous", "Previous page")}>
          <Icon name="chevronLeft" size={14} />
        </button>
        {Array.from({ length: Math.min(5, total) }, (_, i) => {
          const startP = Math.max(1, Math.min(page - 2, total - 4));
          const p = startP + i;
          if (p > total) return null;
          return (
            <button key={p} onClick={() => onPage(p)} className={p === page ? "btn btn-sm unid-page-active" : "btn btn-sm btn-ghost"} aria-current={p === page ? "page" : undefined}>{p}</button>
          );
        })}
        <button onClick={() => onPage(Math.min(total, page + 1))} disabled={page >= total} className="btn btn-sm btn-ghost" aria-label={t("common.next", "Next page")}>
          <Icon name="chevronRight" size={14} />
        </button>
        <button onClick={() => onPage(total)} disabled={page >= total} className="btn btn-sm btn-ghost" aria-label={t("common.last", "Last page")}>»</button>
        <span className="text-xs text-dim" style={{ marginInlineStart: 4 }}>
          {t("unidentifiedFaces.page", "Page {{page}} of {{total}}", { page, total })}
        </span>
      </div>
    );
  };

  // ── Shared empty / error / skeleton helpers ──
  const renderError = (error?: unknown, retry?: () => void) => (
    <div className="card">
      <EmptyPanel
        tone="danger"
        icon={<StrokeIcon>{ATT_ICON.alert}</StrokeIcon>}
        title={t("unidentifiedFaces.loadFailedTitle", "Couldn't load unidentified faces")}
        body={extractApiError(error, t("unidentifiedFaces.loadFailed", "Could not load unidentified faces."))}
        actions={retry ? (
          <button type="button" className="btn" onClick={retry}>
            <Icon name="refresh" size={12} />
            {t("unidentifiedFaces.retry", "Retry")}
          </button>
        ) : undefined}
      />
    </div>
  );

  const renderSkeleton = (count: number) => (
    <div className="unid-grid" role="status" aria-label="Loading">
      {[...Array(count)].map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );

  // Filters active = anything differs from the default range / camera /
  // clustering knobs. Drives the "no results" vs "no records" split.
  const filtersActive =
    filters.start !== defaultStart() ||
    filters.end !== todayIso() ||
    filters.camera_id !== null ||
    filters.min_count !== DEFAULT_MIN_COUNT ||
    filters.threshold !== DEFAULT_THRESHOLD;
  const resetAllFilters = () => {
    setUiThreshold(DEFAULT_THRESHOLD);
    setUiMinCount(DEFAULT_MIN_COUNT);
    commitNow({ start: defaultStart(), end: todayIso(), camera_id: null, threshold: DEFAULT_THRESHOLD, min_count: DEFAULT_MIN_COUNT });
  };

  // No records at all: default filters, nothing came back on the
  // active primary view. Hides the stats + toolbar per the brief.
  const activeRaw = activeTab === "raw" && rawSubTab === "primary";
  const activeGroups = activeTab === "groups" && groupsSubTab === "primary";
  const activeMappedRaw = activeTab === "raw" && rawSubTab === "mapped";
  const activeMappedGroups = activeTab === "groups" && groupsSubTab === "mapped";
  const noRecordsAtAll =
    !filtersActive &&
    ((activeRaw && !!rawData && rawData.items.length === 0 && !rawResult.isLoading) ||
      (activeGroups && !!clusterData && clusterData.clusters.length === 0 && !clusterResult.isLoading) ||
      (activeMappedRaw && !!mappedData && mappedData.items.length === 0 && !mappedResult.isLoading) ||
      (activeMappedGroups && !!mappedClustersData && mappedClustersData.items.length === 0 && !mappedClustersResult.isLoading));

  const renderEmpty = (hint: string) =>
    filtersActive ? (
      <div className="card">
        <EmptyPanel
          tone="neutral"
          icon={<Icon name="filter" size={28} />}
          title={t("unidentifiedFaces.noResultsTitle", "No results for these filters")}
          body={hint}
          actions={
            <button type="button" className="btn" onClick={resetAllFilters}>
              <Icon name="refresh" size={12} />
              {t("unidentifiedFaces.clearFilters", "Clear filters")}
            </button>
          }
        />
      </div>
    ) : (
      <div className="card">
        <EmptyPanel
          tone="accent"
          icon={<StrokeIcon>{ATT_ICON.face}</StrokeIcon>}
          title={t("unidentifiedFaces.empty", "No unidentified faces found")}
          body={hint}
          actions={
            <Link to="/camera-logs" className="btn">
              <Icon name="camera" size={13} />
              {t("unidentifiedFaces.viewCameraLogs", "View camera logs")}
            </Link>
          }
        />
      </div>
    );

  return (
    <>
      {/* Page title — scrolls away once the sticky nav reaches the top. */}
      <div className="page-header" style={{ marginBottom: 6 }}>
        <div>
          <h1 className="page-title">{t("unidentifiedFaces.title", "Unidentified Faces")}</h1>
          <p className="page-sub">
            {t("unidentifiedFaces.pageSub", "Faces the cameras saw but could not match to an employee. Review them and map each face to the right person.")}
          </p>
        </div>
      </div>

      {/* Hierarchical sticky nav: primary underline tabs + secondary pill row.
          Sticks to the top of ``.content`` (the scrolling ancestor) so the
          operator never loses their place in the hierarchy when scrolling
          a long cluster grid. Pure CSS sticky — no JS measurement needed. */}
      <div className="unid-nav-sticky">
        <div className="unid-nav-inner">
          <div role="tablist" aria-label={t("unidentifiedFaces.title", "Unidentified Faces") as string} className="tabs unid-nav-primary">
            {(["raw", "groups"] as const).map((tab) => {
              const isActive = activeTab === tab;
              const label = tab === "raw"
                ? (t("unidentifiedFaces.tabAllFaces", "All Unknown Faces") as string)
                : (t("unidentifiedFaces.tabGroups", "Similarity Groups") as string);
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab)}
                  className={isActive ? "tab active" : "tab"}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div role="tablist" aria-label={t("unidentifiedFaces.subTabsAria", "Section views") as string} className="seg unid-nav-sub">
            {(["primary", "mapped"] as const).map((sub) => {
              const isActive =
                activeTab === "raw" ? rawSubTab === sub : groupsSubTab === sub;
              const label = (() => {
                if (activeTab === "raw") {
                  return sub === "primary"
                    ? (t("unidentifiedFaces.subUnknownFaces", "Unknown Faces") as string)
                    : (t("unidentifiedFaces.subMappedEmployees", "Mapped Employees") as string);
                }
                return sub === "primary"
                  ? (t("unidentifiedFaces.subSimilarityClusters", "Similarity Clusters") as string)
                  : (t("unidentifiedFaces.subMappedEmployees", "Mapped Employees") as string);
              })();
              return (
                <button
                  key={sub}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => {
                    if (activeTab === "raw") setRawSubTab(sub);
                    else setGroupsSubTab(sub);
                  }}
                  aria-pressed={isActive}
                  className={isActive ? "seg-btn active" : "seg-btn"}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ padding: "16px 0 24px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* ── Stats pills (tab-specific) ── */}
        {noRecordsAtAll ? null : activeTab === "raw" ? (
          rawData ? (
            <div className="at-row">
              <StatPill label={t("unidentifiedFaces.totalEvents", "total events")} value={rawData.total.toLocaleString()} />
            </div>
          ) : rawResult.isLoading ? (
            <div className="at-row" role="status" aria-label="Loading">{[80, 110].map((w) => <div key={w} className="unid-skeleton" style={{ height: 22, width: w, borderRadius: 999 }} />)}</div>
          ) : null
        ) : (
          clusterData ? (
            <div className="at-row">
              <StatPill label={t("unidentifiedFaces.clusters", "clusters")} value={clusterData.total_clusters.toLocaleString()} />
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
            <div className="at-row" role="status" aria-label="Loading">{[80, 110, 90].map((w) => <div key={w} className="unid-skeleton" style={{ height: 22, width: w, borderRadius: 999 }} />)}</div>
          ) : null
        )}

        {/* ── Filter bar — stays visible even when nothing came back, because
            the default range is "today" and widening it is the way out. ── */}
        <div className="unid-filters">
          {/* Shared: date range + camera */}
          <Toolbar>
            <label className="at-field">
              <FieldCaption>{t("unidentifiedFaces.from", "From")}</FieldCaption>
              <DatePicker
                value={filters.start ?? ""}
                onChange={(v) => commitNow({ start: v || null })}
                max={filters.end || todayIso()}
                ariaLabel={t("unidentifiedFaces.from", "From")}
                triggerStyle={{ ...fieldDateStyle, width: 160 }}
              />
            </label>
            <label className="at-field">
              <FieldCaption>{t("unidentifiedFaces.to", "To")}</FieldCaption>
              <DatePicker
                value={filters.end ?? ""}
                onChange={(v) => commitNow({ end: v || null })}
                {...(filters.start ? { min: filters.start } : {})}
                max={todayIso()}
                ariaLabel={t("unidentifiedFaces.to", "To")}
                triggerStyle={{ ...fieldDateStyle, width: 160 }}
              />
            </label>
            {(filters.start !== defaultStart() || filters.end !== todayIso()) && (
              <button
                type="button"
                onClick={() => commitNow({ start: defaultStart(), end: todayIso() })}
                className="btn"
                title={t("unidentifiedFaces.resetToTodayHint", "Reset to default range (today)")}
              >
                {t("unidentifiedFaces.today", "Today")}
              </button>
            )}
            {cameras.data && cameras.data.items.length > 0 && (
              <FilterSelect
                label={t("unidentifiedFaces.camera", "Camera")}
                value={filters.camera_id === null ? "" : String(filters.camera_id)}
                onChange={(v) => commitNow({ camera_id: v ? parseInt(v, 10) : null })}
                options={[
                  ["", t("unidentifiedFaces.allCameras", "All cameras")],
                  ...cameras.data.items.map((cam) => [String(cam.id), cam.name] as [string, string]),
                ]}
              />
            )}
            {/* Min appearances + Reset defaults — Similarity-Clusters-only
                knobs. Hidden on the Mapped Employees sub-tab, which is
                already mapped/reviewed data and isn't re-clustered. */}
            {activeTab === "groups" && groupsSubTab === "primary" && (
              <>
                <label className="at-field">
                  <FieldCaption>{t("unidentifiedFaces.minCount", "Min appearances")}</FieldCaption>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={uiMinCount}
                    onChange={(e) => { const v = Math.max(1, parseInt(e.target.value, 10) || 1); setUiMinCount(v); scheduleCommit({ min_count: v }); }}
                    className="at-control"
                    style={{ width: 90 }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => { setUiThreshold(DEFAULT_THRESHOLD); setUiMinCount(DEFAULT_MIN_COUNT); commitNow({ threshold: DEFAULT_THRESHOLD, min_count: DEFAULT_MIN_COUNT }); }}
                  className="btn btn-ghost"
                  style={{ marginInlineStart: "auto" }}
                  title={t("unidentifiedFaces.resetDefaultsHint", "Reset threshold and min appearances to defaults") as string}
                >
                  {t("unidentifiedFaces.resetDefaults", "Reset defaults")}
                </button>
              </>
            )}
          </Toolbar>

          {/* Threshold slider — only on the Similarity Clusters sub-tab.
              The Mapped Employees view is already-reviewed data, not
              re-clustered, so the clustering knobs would be misleading. */}
          {activeTab === "groups" && groupsSubTab === "primary" && (
            <>
              <div className="card unid-thresh-wrap">
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

              </div>

            </>
          )}
        </div>

        {/* ── Tab 1.a: All Unknown Faces → Unknown Faces ── */}
        {activeTab === "raw" && rawSubTab === "primary" && (
          <>
            {rawResult.isError && renderError(rawResult.error, () => void rawResult.refetch())}
            {rawResult.isLoading && !rawData && renderSkeleton(RAW_PAGE_SIZE)}
            {!rawResult.isLoading && !rawResult.isError && rawData && rawData.items.length === 0 && renderEmpty(
              filtersActive
                ? t("unidentifiedFaces.emptyRaw", "No unidentified face detections in this date range. Try expanding the range or removing the face-data filter.")
                : t("unidentifiedFaces.emptyNoneBody", "Every face the cameras saw in this range was matched to an employee. Widen the date range above, or come back as new detections arrive.")
            )}
            {rawData && rawData.items.length > 0 && (
              <div className={rawResult.isPlaceholderData ? "at-faded" : undefined}>
                <div className="unid-grid">
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
            onRetry={() => void mappedResult.refetch()}
            renderSkeleton={renderSkeleton}
            renderPagination={renderPagination}
            pageSize={MAPPED_PAGE_SIZE}
          />
        )}

        {/* ── Tab 2.a: Similarity Groups → Similarity Clusters ── */}
        {activeTab === "groups" && groupsSubTab === "primary" && (
          <>
            {clusterResult.isError && renderError(clusterResult.error, () => void clusterResult.refetch())}
            {clusterResult.isLoading && !clusterData && renderSkeleton(PAGE_SIZE)}
            {!clusterResult.isLoading && !clusterResult.isError && clusterData && clusterData.clusters.length === 0 && renderEmpty(
              filtersActive
                ? t("unidentifiedFaces.emptyHint", "Try expanding the date range or lowering the similarity threshold.")
                : t("unidentifiedFaces.emptyNoneBody", "Every face the cameras saw in this range was matched to an employee. Widen the date range above, or come back as new detections arrive.")
            )}
            {clusterData && clusters.length > 0 && (
              <div className={isClusterPlaceholder ? "at-faded" : undefined}>
                <div className="unid-grid">
                  {clusters.map((cluster) => (
                    <ClusterCard key={cluster.cluster_id} cluster={cluster} onOpen={setOpenCluster} />
                  ))}
                </div>
              </div>
            )}
            {clusterData && renderPagination(filters.page, totalClusterPages, (p) => setFilters((f) => ({ ...f, page: p })))}
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
            onRetry={() => void mappedClustersResult.refetch()}
            renderSkeleton={renderSkeleton}
            renderPagination={renderPagination}
            pageSize={MAPPED_CLUSTERS_PAGE_SIZE}
            unmapFilter={{
              start: filters.start,
              end: filters.end,
              camera_id: filters.camera_id,
            }}
          />
        )}

      </div>

      {/* ── Bulk selection toolbar — only relevant on Unknown Faces ── */}
      {selectMode && activeTab === "raw" && rawSubTab === "primary" && (
        <div
          role="toolbar"
          aria-label={t("unidentifiedFaces.bulkToolbar", "Bulk selection toolbar")}
          className="unid-bulkbar"
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
            <div className="unid-bulkbar-check">
              <Icon name="check" size={12} />
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
