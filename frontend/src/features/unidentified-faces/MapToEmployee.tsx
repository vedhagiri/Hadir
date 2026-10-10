// Map-to-Employee flow. One step machine (workflow → search → confirm →
// done) rendered either as a centred modal (cluster / bulk selection) or
// inline inside the face viewer's side panel (single face).
//
// Two workflows, two endpoints (unchanged):
//   * Reference  → POST /api/unidentified-faces/map-as-reference
//                  (copies chosen crops to the employee's training set)
//   * Attendance → POST /api/unidentified-faces/map-as-attendance
//                  (attributes events + recomputes attendance)

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { MAX_REFERENCE_PHOTOS, PHOTO_MESSAGES, referencePhotosRemaining } from "../../util/photoValidation";
import type { EmployeeListFilters } from "../employees/hooks";
import { useEmployeeList } from "../employees/hooks";
import type { Employee } from "../employees/types";
import { useMapAsAttendance, useMapAsReference } from "./hooks";
import type {
  FaceClusterOut,
  MapAsAttendanceResponse,
  MapToEmployeeResponse,
  MapWorkflow,
  PhotoAssignment,
} from "./types";
import { cropUrl, initials } from "./ufUi";

type MapAngle = "front" | "left" | "right" | "other";

interface PhotoSelectionState {
  event_id: number;
  selected: boolean;
  angle: MapAngle;
}

/** Result envelope normalised across the two workflows. */
export type AnyMapResult =
  | { kind: "reference"; data: MapToEmployeeResponse; employee: Employee }
  | { kind: "attendance"; data: MapAsAttendanceResponse; employee: Employee };

const EMP_PAGE_SIZE = 15;
const CONFIRM_PHOTOS_PER_PAGE = 24;
const MAX_EVENTS_PER_REQUEST = 200;

export interface MapFlowProps {
  cluster: FaceClusterOut;
  variant: "modal" | "panel";
  onClose: () => void;
  onSuccess: (result: AnyMapResult) => void;
}

export function MapFlow({ cluster, variant, onClose, onSuccess }: MapFlowProps) {
  const { t } = useTranslation();
  const isPanel = variant === "panel";

  const [step, setStep] = useState<"workflow" | "search" | "confirm" | "done">("workflow");
  const [workflow, setWorkflow] = useState<MapWorkflow>("reference");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [empPage, setEmpPage] = useState<number>(1);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [result, setResult] = useState<AnyMapResult | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reference workflow: per-photo selection + angle (paged 24 / page;
  // state is keyed by event_id so paging never loses a choice).
  const [photoSelections, setPhotoSelections] = useState<PhotoSelectionState[]>([]);
  const [confirmPhotoPage, setConfirmPhotoPage] = useState<number>(1);
  // Attendance workflow: per-event opt-in, defaults to all selected.
  const [attendanceSelection, setAttendanceSelection] = useState<Set<number>>(() => new Set());

  const refMutation = useMapAsReference();
  const attMutation = useMapAsAttendance();
  const mapMutation = workflow === "reference" ? refMutation : attMutation;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setEmpPage(1);
  }, [debouncedQ]);

  useEffect(() => {
    if (step === "search") {
      const id = setTimeout(() => searchRef.current?.focus(), 60);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [step]);

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
    setPhotoSelections(
      cluster.crop_event_ids.map((id) => ({ event_id: id, selected: true, angle: "front" as MapAngle })),
    );
    setAttendanceSelection(new Set(cluster.event_ids));
    setConfirmPhotoPage(1);
    setStep("confirm");
  };

  const togglePhoto = (event_id: number) =>
    setPhotoSelections((prev) => prev.map((p) => (p.event_id === event_id ? { ...p, selected: !p.selected } : p)));
  const setPhotoAngle = (event_id: number, angle: MapAngle) =>
    setPhotoSelections((prev) => prev.map((p) => (p.event_id === event_id ? { ...p, angle } : p)));

  const selectedPhotos = photoSelections.filter((p) => p.selected);
  const refRemaining = selected ? referencePhotosRemaining(selected.photo_count ?? 0) : MAX_REFERENCE_PHOTOS;
  const refOverLimit = workflow === "reference" && selectedPhotos.length > refRemaining;
  const attSelectedCount = cluster.event_ids.filter((id) => attendanceSelection.has(id)).length;

  const handleConfirm = async () => {
    if (!selected) return;
    if (refOverLimit) return;
    try {
      if (workflow === "reference") {
        const photoAssignments: PhotoAssignment[] = selectedPhotos.map((p) => ({ event_id: p.event_id, angle: p.angle }));
        const res = await refMutation.mutateAsync({
          employee_id: selected.id,
          event_ids: cluster.event_ids,
          photo_assignments: photoAssignments,
        });
        const r: AnyMapResult = { kind: "reference", data: res, employee: selected };
        setResult(r);
        setStep("done");
        onSuccess(r);
      } else {
        const selectedEventIds = cluster.event_ids.filter((id) => attendanceSelection.has(id));
        const res = await attMutation.mutateAsync({ employee_id: selected.id, event_ids: selectedEventIds });
        const r: AnyMapResult = { kind: "attendance", data: res, employee: selected };
        setResult(r);
        setStep("done");
        onSuccess(r);
      }
    } catch {
      // Surfaced via the active mutation's isError state.
    }
  };

  // Modal variant: Esc closes. (The panel variant lives inside the
  // viewer, which owns Esc.)
  useEffect(() => {
    if (isPanel) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, isPanel]);

  const ANGLES: MapAngle[] = ["front", "left", "right", "other"];
  const ANGLE_LABELS: Record<MapAngle, string> = {
    front: t("unidentifiedFaces.mapModal.angleFront", "Front"),
    left: t("unidentifiedFaces.mapModal.angleLeft", "Left"),
    right: t("unidentifiedFaces.mapModal.angleRight", "Right"),
    other: t("unidentifiedFaces.mapModal.angleOther", "Other"),
  };

  const stepTitle =
    step === "done"
      ? t("unidentifiedFaces.mapModal.successTitle", "Mapping Complete")
      : step === "confirm"
        ? t("unidentifiedFaces.mapModal.confirmTitle", "Confirm Mapping")
        : step === "search"
          ? t("unidentifiedFaces.mapModal.searchTitle", "Choose Employee")
          : t("unidentifiedFaces.mapModal.workflowTitle", "Map to Employee");

  const wfChip = (
    <span className={`pill ${workflow === "reference" ? "pill-info" : "pill-success"} unid-mini-pill`}>
      {workflow === "reference"
        ? t("unidentifiedFaces.mapModal.wfRefChip", "Reference")
        : t("unidentifiedFaces.mapModal.wfAttChip", "Attendance")}
    </span>
  );

  const pager = (page: number, total: number, onPage: (p: number) => void, summary: string, disabled = false, prevLabel: string, nextLabel: string) => (
    <div className="unid-flow-pager">
      <span className="text-dim">
        {t("common.pageOf", "Page {{page}} of {{total}}", { page, total })} · {summary}
      </span>
      <div className="unid-flow-pager-btns">
        <button type="button" className="btn btn-sm" disabled={page <= 1 || disabled} onClick={() => onPage(Math.max(1, page - 1))} aria-label={prevLabel}>
          <Icon name="chevronLeft" size={13} />
        </button>
        <button type="button" className="btn btn-sm" disabled={page >= total || disabled} onClick={() => onPage(Math.min(total, page + 1))} aria-label={nextLabel}>
          <Icon name="chevronRight" size={13} />
        </button>
      </div>
    </div>
  );

  const body = (
    <>
      {/* ── Step 0: workflow picker ── */}
      {step === "workflow" && (
        <div className="unid-flow-body">
          <p className="unid-flow-intro">
            {t(
              "unidentifiedFaces.mapModal.workflowIntro",
              "Both workflows attribute the selected faces to the chosen employee. Pick the workflow that matches what you're doing:",
            )}
          </p>
          <button type="button" className="unid-wf-card tone-info" onClick={() => { setWorkflow("reference"); setStep("search"); }}>
            <span className="unid-wf-icon" aria-hidden>
              <Icon name="camera" size={16} />
            </span>
            <span className="unid-wf-text">
              <span className="unid-wf-title">{t("unidentifiedFaces.mapModal.wfReferenceTitle", "Add as reference photos")}</span>
              <span className="unid-wf-desc">
                {t(
                  "unidentifiedFaces.mapModal.wfReferenceBody",
                  "Adds the selected face crops to the employee's training set. Improves automatic recognition for future captures of this person.",
                )}
              </span>
            </span>
            <Icon name="chevronRight" size={14} className="unid-wf-chev" />
          </button>
          <button type="button" className="unid-wf-card tone-success" onClick={() => { setWorkflow("attendance"); setStep("search"); }}>
            <span className="unid-wf-icon" aria-hidden>
              <Icon name="clock" size={16} />
            </span>
            <span className="unid-wf-text">
              <span className="unid-wf-title">{t("unidentifiedFaces.mapModal.wfAttendanceTitle", "Correct attendance event")}</span>
              <span className="unid-wf-desc">
                {t(
                  "unidentifiedFaces.mapModal.wfAttendanceBody",
                  "Marks the chosen events as the employee's attendance. Updates Camera Logs + Matched Clips and recomputes the attendance record for the affected dates.",
                )}
              </span>
            </span>
            <Icon name="chevronRight" size={14} className="unid-wf-chev" />
          </button>
        </div>
      )}

      {/* ── Step 1: employee search ── */}
      {step === "search" && (
        <div className="unid-flow-col">
          <div className="unid-flow-search">
            <label className="mg-search">
              <span aria-hidden className="mg-search-icon">
                <Icon name="search" size={15} />
              </span>
              <input
                ref={searchRef}
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t("unidentifiedFaces.mapModal.searchPlaceholder", "Search by name or employee code…") as string}
                aria-label={t("unidentifiedFaces.mapModal.searchPlaceholder", "Search by name or employee code…") as string}
              />
            </label>
          </div>
          <div className="unid-flow-list">
            {empSearch.isLoading && (
              <div className="unid-flow-sk" role="status" aria-label="Loading">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="unid-flow-sk-row">
                    <span className="unid-skeleton unid-sk-avatar" />
                    <span className="unid-flow-sk-lines">
                      <span className="unid-skeleton" style={{ width: "55%" }} />
                      <span className="unid-skeleton" style={{ width: "35%" }} />
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!empSearch.isLoading && empSearch.data?.items.length === 0 && (
              <div className="unid-flow-empty">
                {debouncedQ
                  ? t("unidentifiedFaces.mapModal.noResults", "No employees found")
                  : t("unidentifiedFaces.mapModal.searchHint", "Type to search employees")}
              </div>
            )}
            {empSearch.data?.items.map((emp) => (
              <button key={emp.id} type="button" className="unid-emp-row" onClick={() => enterConfirm(emp)}>
                <span className="unid-avatar" aria-hidden>
                  {initials(emp.full_name)}
                </span>
                <span className="unid-emp-row-text">
                  <span className="unid-emp-row-name">{emp.full_name}</span>
                  <span className="unid-emp-row-meta">
                    <span className="mono">{emp.employee_code}</span>
                    {emp.department.name && <> · {emp.department.name}</>}
                  </span>
                </span>
                <Icon name="chevronRight" size={14} className="unid-emp-row-chev" />
              </button>
            ))}
          </div>
          {!empSearch.isLoading && empTotal > EMP_PAGE_SIZE &&
            pager(
              empPage,
              empTotalPages,
              setEmpPage,
              `${empTotal.toLocaleString()} ${empTotal === 1 ? t("unidentifiedFaces.mapModal.employee", "employee") : t("unidentifiedFaces.mapModal.employees", "employees")}`,
              empSearch.isFetching,
              t("unidentifiedFaces.mapModal.prevEmployeePage", "Previous page of employees") as string,
              t("unidentifiedFaces.mapModal.nextEmployeePage", "Next page of employees") as string,
            )}
          <div className="unid-flow-foot">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStep("workflow")}>
              <Icon name="chevronLeft" size={13} />
              {t("unidentifiedFaces.mapModal.back", "Back")}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: confirm ── */}
      {step === "confirm" && selected && (
        <div className="unid-flow-col">
          <div className="unid-flow-scroll">
            <div className="unid-flow-selected">
              <span className="unid-avatar" aria-hidden>
                {initials(selected.full_name)}
              </span>
              <span className="unid-emp-row-text">
                <span className="unid-emp-row-name">{selected.full_name}</span>
                <span className="unid-emp-row-meta mono">{selected.employee_code}</span>
              </span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStep("search")} disabled={mapMutation.isPending}>
                {t("unidentifiedFaces.change", { defaultValue: "Change" })}
              </button>
            </div>

            {workflow === "reference" &&
              (photoSelections.length === 0 ? (
                <p className="unid-flow-note">
                  {t(
                    "unidentifiedFaces.mapModal.noCropsToAdd",
                    "No face crops available. Events will be attributed without adding reference photos.",
                  )}
                </p>
              ) : (
                <>
                  <div className="unid-flow-section-head">
                    <span className="unid-flow-section-title">
                      {t("unidentifiedFaces.mapModal.selectPhotos", "Select reference photos to add")}
                    </span>
                    <span className="text-dim">
                      {t("unidentifiedFaces.mapModal.selectPhotosHint", "{{selected}} of {{total}} selected", {
                        selected: selectedPhotos.length,
                        total: photoSelections.length,
                      })}
                      {" · "}
                      {t("unidentifiedFaces.mapModal.slotsFree", {
                        defaultValue: "{{n}} of {{max}} slots free",
                        n: refRemaining,
                        max: MAX_REFERENCE_PHOTOS,
                      })}
                    </span>
                  </div>
                  {refOverLimit && (
                    <div role="alert" className="unid-flow-alert">
                      {PHOTO_MESSAGES.maxImages}
                    </div>
                  )}
                  {(() => {
                    const totalPages = Math.max(1, Math.ceil(photoSelections.length / CONFIRM_PHOTOS_PER_PAGE));
                    const safePage = Math.min(Math.max(1, confirmPhotoPage), totalPages);
                    const start = (safePage - 1) * CONFIRM_PHOTOS_PER_PAGE;
                    const pagePhotos = photoSelections.slice(start, start + CONFIRM_PHOTOS_PER_PAGE);
                    return (
                      <>
                        <div className="unid-pick-grid">
                          {pagePhotos.map((ps) => (
                            <div key={ps.event_id} className={`unid-pick${ps.selected ? " is-on" : ""}`}>
                              <button
                                type="button"
                                className="unid-pick-img"
                                onClick={() => togglePhoto(ps.event_id)}
                                aria-pressed={ps.selected}
                                aria-label={t("unidentifiedFaces.mapModal.attendanceTileAria", "Toggle event #{{id}}", { id: ps.event_id }) as string}
                              >
                                <img src={cropUrl(ps.event_id)} alt="" loading="lazy" decoding="async" />
                                <span className="unid-pick-check" aria-hidden>
                                  {ps.selected && <Icon name="check" size={10} />}
                                </span>
                              </button>
                              {ps.selected && (
                                <select
                                  className="select unid-pick-angle"
                                  value={ps.angle}
                                  onChange={(e) => setPhotoAngle(ps.event_id, e.target.value as MapAngle)}
                                  aria-label={t("unidentifiedFaces.mapModal.angle", "Photo angle") as string}
                                >
                                  {ANGLES.map((a) => (
                                    <option key={a} value={a}>
                                      {ANGLE_LABELS[a]}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </div>
                          ))}
                        </div>
                        {photoSelections.length > CONFIRM_PHOTOS_PER_PAGE &&
                          pager(
                            safePage,
                            totalPages,
                            setConfirmPhotoPage,
                            `${photoSelections.length.toLocaleString()} ${photoSelections.length === 1 ? t("unidentifiedFaces.mapModal.photo", "photo") : t("unidentifiedFaces.mapModal.photos", "photos")}`,
                            false,
                            t("unidentifiedFaces.mapModal.prevPhotoPage", "Previous page of photos") as string,
                            t("unidentifiedFaces.mapModal.nextPhotoPage", "Next page of photos") as string,
                          )}
                      </>
                    );
                  })()}
                </>
              ))}

            {workflow === "attendance" &&
              (() => {
                const cropIds = cluster.crop_event_ids;
                const otherIds = cluster.event_ids.filter((id) => !cropIds.includes(id));
                const overCap = attSelectedCount > MAX_EVENTS_PER_REQUEST;
                const toggle = (id: number) =>
                  setAttendanceSelection((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                const setAll = (on: boolean) => setAttendanceSelection(on ? new Set(cluster.event_ids) : new Set());
                return (
                  <>
                    <div className="unid-flow-section-head">
                      <span className="unid-flow-section-title">
                        {t("unidentifiedFaces.mapModal.attendanceSelectTitle", "Pick events for this attendance correction")}
                      </span>
                      <span className="unid-flow-section-actions">
                        {cluster.event_ids.length > 1 && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setAll(attSelectedCount !== cluster.event_ids.length)}
                            disabled={mapMutation.isPending}
                          >
                            {attSelectedCount === cluster.event_ids.length
                              ? t("unidentifiedFaces.mapModal.deselectAll", "Deselect all")
                              : t("unidentifiedFaces.mapModal.selectAll", "Select all")}
                          </button>
                        )}
                        <span className={`pill ${overCap ? "pill-danger" : "pill-success"} unid-mini-pill`}>
                          {attSelectedCount} / {cluster.event_ids.length}
                          {overCap ? ` · max ${MAX_EVENTS_PER_REQUEST}` : ""}
                        </span>
                      </span>
                    </div>
                    {overCap && (
                      <div role="alert" className="unid-flow-alert">
                        {t(
                          "unidentifiedFaces.mapModal.tooManyEvents",
                          "Too many events selected. Deselect at least {{n}} — the server caps each request at {{max}}.",
                          { n: attSelectedCount - MAX_EVENTS_PER_REQUEST, max: MAX_EVENTS_PER_REQUEST },
                        )}
                      </div>
                    )}
                    {cropIds.length === 0 ? (
                      <p className="unid-flow-note">
                        {t(
                          "unidentifiedFaces.mapModal.attendanceNoCrops",
                          "No face crops available to preview. {{count}} event(s) will still be attributed if you continue.",
                          { count: cluster.event_ids.length },
                        )}
                      </p>
                    ) : (
                      <div className="unid-pick-grid unid-pick-grid-sm">
                        {cropIds.map((id) => {
                          const isOn = attendanceSelection.has(id);
                          return (
                            <div key={id} className={`unid-pick${isOn ? " is-on" : ""}`}>
                              <button
                                type="button"
                                className="unid-pick-img"
                                onClick={() => toggle(id)}
                                aria-pressed={isOn}
                                aria-label={t("unidentifiedFaces.mapModal.attendanceTileAria", "Toggle event #{{id}}", { id }) as string}
                              >
                                <img src={cropUrl(id)} alt="" loading="lazy" decoding="async" />
                                <span className="unid-pick-check" aria-hidden>
                                  {isOn && <Icon name="check" size={10} />}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {otherIds.length > 0 && (
                      <p className="unid-flow-note">
                        {t(
                          "unidentifiedFaces.mapModal.attendanceNoPreviewNote",
                          "+{{n}} event(s) without a saved crop. They follow the same selection as the preview tiles (toggle Select all to opt out).",
                          { n: otherIds.length },
                        )}
                      </p>
                    )}
                    <p className="unid-flow-note">
                      {t(
                        "unidentifiedFaces.mapModal.attendanceNoteRefs",
                        "No reference photos will be added — use the Reference workflow to also train the matcher with these crops.",
                      )}
                    </p>
                  </>
                );
              })()}

            <div className="unid-flow-summary">
              <Icon name="check" size={12} />
              <span>
                {t("unidentifiedFaces.mapModal.willMapEvents", "Will attribute {{count}} detection event(s) to {{name}}", {
                  count: cluster.event_ids.length,
                  name: selected.full_name,
                })}
              </span>
            </div>

            {mapMutation.isError && (
              <div role="alert" className="unid-flow-alert">
                {t("unidentifiedFaces.mapModal.errorFailed", "Mapping failed. Please try again.")}
              </div>
            )}
          </div>

          <div className="unid-flow-foot">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setStep("search");
                refMutation.reset();
                attMutation.reset();
              }}
              disabled={mapMutation.isPending}
            >
              {t("unidentifiedFaces.mapModal.back", "Back")}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                void handleConfirm();
              }}
              disabled={
                mapMutation.isPending ||
                (workflow === "attendance" && (attendanceSelection.size === 0 || attSelectedCount > MAX_EVENTS_PER_REQUEST)) ||
                refOverLimit
              }
            >
              {mapMutation.isPending
                ? t("unidentifiedFaces.mapModal.mapping", "Mapping…")
                : workflow === "attendance"
                  ? (t("unidentifiedFaces.mapModal.confirmBtnAtt", "Confirm ({{n}} event{{plural}})", {
                      n: attSelectedCount,
                      plural: attSelectedCount === 1 ? "" : "s",
                    }) as string)
                  : (t("unidentifiedFaces.mapModal.confirmBtn", "Confirm Mapping") as string)}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: done ── */}
      {step === "done" && result && <MapResultSummary result={result} onDone={onClose} />}
    </>
  );

  if (isPanel) {
    return (
      <section className="unid-flow is-panel" aria-label={stepTitle}>
        <div className="unid-flow-panel-head">
          <span className="unid-flow-title">{stepTitle}</span>
          {step !== "workflow" && step !== "done" && wfChip}
        </div>
        {body}
      </section>
    );
  }

  return createPortal(
    <div
      className="unid-scrim unid-center"
      style={{ zIndex: 800 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !mapMutation.isPending) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={t("unidentifiedFaces.mapModal.title", "Map to Employee") as string} className="unid-modal unid-flow is-modal">
        <div className="unid-modal-head">
          <div>
            <div className="unid-modal-title">{stepTitle}</div>
            {step !== "done" && (
              <div className="unid-modal-sub">
                <span>{t("unidentifiedFaces.clusterOf", "Cluster of {{count}} faces", { count: cluster.count })}</span>
                {step !== "workflow" && wfChip}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} className="btn btn-sm btn-ghost unid-icon-btn" aria-label={t("common.close", "Close") as string}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {body}
      </div>
    </div>,
    document.body,
  );
}

/** Success summary — reused by the viewer once a face is mapped. */
export function MapResultSummary({
  result,
  onDone,
  doneLabel,
  extra,
}: {
  result: AnyMapResult;
  onDone?: () => void;
  doneLabel?: string;
  extra?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="unid-flow-done" role="status">
      <span className="unid-flow-done-icon" aria-hidden>
        <Icon name="check" size={22} />
      </span>
      <div className="unid-flow-done-title">{t("unidentifiedFaces.mapModal.successTitle", "Mapping Complete")}</div>
      <p className="unid-flow-done-body">
        {result.kind === "reference"
          ? (t(
              "unidentifiedFaces.mapModal.successDetail",
              "Marked {{events}} event(s) as identified and added {{photos}} reference photo(s) for {{name}}.",
              { events: result.data.mapped_events, photos: result.data.photos_created, name: result.employee.full_name },
            ) as string)
          : (t(
              "unidentifiedFaces.mapModal.successDetailAttendance",
              "Marked {{events}} event(s) as {{name}}'s attendance and recomputed {{dates}} day(s).",
              {
                events: result.data.mapped_events,
                name: result.employee.full_name,
                dates: result.data.attendance_dates_recomputed.length,
              },
            ) as string)}
      </p>
      {result.kind === "attendance" && result.data.attendance_dates_recomputed.length > 0 && (
        <div className="unid-flow-dates">
          {result.data.attendance_dates_recomputed.map((d) => (
            <span key={d} className="pill pill-success unid-mini-pill mono">
              {d}
            </span>
          ))}
        </div>
      )}
      <div className="unid-flow-done-actions">
        {extra}
        {onDone && (
          <button type="button" onClick={onDone} className="btn btn-sm">
            {doneLabel ?? t("unidentifiedFaces.mapModal.done", "Done")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Modal wrapper kept for the cluster + bulk-selection paths. */
export function MapToEmployeeModal({
  cluster,
  onClose,
  onSuccess,
}: {
  cluster: FaceClusterOut;
  onClose: () => void;
  onSuccess: (result: AnyMapResult) => void;
}) {
  return <MapFlow cluster={cluster} variant="modal" onClose={onClose} onSuccess={onSuccess} />;
}
