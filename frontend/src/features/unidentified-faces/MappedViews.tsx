// Mapped views — read-only surfaces over detection_events rows that an
// operator manually attributed (mapping_source = manual_*):
//   * MappedFaceTile      — one detection (Mapped faces tab)
//   * MappedEmployeeCard  — per-employee rollup (Mapped by employee tab)
// plus the two revert ("unmap") confirmation modals.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { useUnmapByEmployee, useUnmapEvents } from "./hooks";
import type { MappedEmployeeGroupOut, MappedFaceEventOut, UnmapEventsResponse } from "./types";
import { EmployeeChip, FaceImg, MappingSourceChip, TonePill, similarityTone, useFmtDate } from "./ufUi";

// ── Shared revert copy ─────────────────────────────────────────────────

function UnmapNotes() {
  const { t } = useTranslation();
  return (
    <ul className="unid-confirm-notes">
      <li>{t("unidentifiedFaces.unmapModal.note1", { defaultValue: "Events reappear in Unknown Faces + Similarity Groups" }) as string}</li>
      <li>{t("unidentifiedFaces.unmapModal.note2", { defaultValue: "Camera Logs + Matched Clips drop the employee tag" }) as string}</li>
      <li>{t("unidentifiedFaces.unmapModal.note3", { defaultValue: "Attendance for the affected dates is recomputed" }) as string}</li>
      <li>
        {t("unidentifiedFaces.unmapModal.note4", {
          defaultValue: "Reference photos copied earlier are NOT removed — manage them via Employee → Reference Photos.",
        }) as string}
      </li>
    </ul>
  );
}

function ConfirmShell({
  title,
  body,
  error,
  pending,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  error: string | null;
  pending: boolean;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);

  // Portal to body so card overflow / animation never clips the modal.
  return createPortal(
    <div className="unid-scrim unid-center" style={{ zIndex: 9000 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="unid-unmap-title" className="unid-modal unid-confirm">
        <div className="unid-confirm-head">
          <span className="unid-confirm-icon" aria-hidden>
            <Icon name="refresh" size={15} />
          </span>
          <h2 id="unid-unmap-title" className="unid-confirm-title">
            {title}
          </h2>
        </div>
        <p className="unid-confirm-body">{body}</p>
        <UnmapNotes />
        {error && (
          <div role="alert" className="unid-flow-alert">
            {error}
          </div>
        )}
        <div className="unid-confirm-foot">
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={pending}>
            {t("common.cancel", { defaultValue: "Cancel" }) as string}
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={onConfirm} disabled={pending}>
            <Icon name="refresh" size={12} />
            {pending ? (t("unidentifiedFaces.unmapModal.unmapping", { defaultValue: "Reverting…" }) as string) : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Revert specific event ids — POST /unmap-events. */
export function UnmapConfirmModal({
  eventIds,
  subject,
  onClose,
  onDone,
}: {
  eventIds: number[];
  subject: string;
  onClose: () => void;
  onDone: (result: UnmapEventsResponse) => void;
}) {
  const { t } = useTranslation();
  const unmap = useUnmapEvents();
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmShell
      title={t("unidentifiedFaces.unmapModal.title", { defaultValue: "Revert this employee mapping?" }) as string}
      body={
        t("unidentifiedFaces.unmapModal.body", {
          defaultValue:
            "{{count}} detection event(s) for {{subject}} will be returned to the Unknown Faces pool. Attendance for the affected dates will be recomputed and the live matcher cache will be refreshed.",
          count: eventIds.length,
          subject,
        }) as string
      }
      error={error}
      pending={unmap.isPending}
      confirmLabel={t("unidentifiedFaces.unmapModal.confirm", { defaultValue: "Revert {{n}} event(s)", n: eventIds.length }) as string}
      onClose={onClose}
      onConfirm={() => {
        setError(null);
        unmap.mutate(
          { event_ids: eventIds },
          {
            onSuccess: (res) => onDone(res),
            onError: (err) =>
              setError(
                (t("unidentifiedFaces.unmapModal.failed", { defaultValue: "Unmap failed — please try again." }) as string) +
                  ` (${(err as Error).message})`,
              ),
          },
        );
      }}
    />
  );
}

/** Revert every mapping for one employee within the page filter — POST /unmap-by-employee. */
export function UnmapByEmployeeModal({
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
  filter: { start: string | null; end: string | null; camera_id: number | null };
  onClose: () => void;
  onDone: (res: UnmapEventsResponse) => void;
}) {
  const { t } = useTranslation();
  const unmap = useUnmapByEmployee();
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmShell
      title={t("unidentifiedFaces.unmapModal.titleAll", { defaultValue: "Revert all mappings for {{name}}?", name: subject }) as string}
      body={
        t("unidentifiedFaces.unmapModal.bodyAll", {
          defaultValue:
            "All {{count}} mapped detection(s) attributed to {{name}} within the current filter (date range + camera) will be returned to the Unknown Faces pool. Attendance for the affected dates will be recomputed.",
          count,
          name: subject,
        }) as string
      }
      error={error}
      pending={unmap.isPending}
      confirmLabel={t("unidentifiedFaces.unmapModal.confirmAll", { defaultValue: "Revert {{n}} mapping(s)", n: count }) as string}
      onClose={onClose}
      onConfirm={() => {
        setError(null);
        // Same date encoding as the listing queries (start/end of day UTC).
        unmap.mutate(
          {
            employee_id: employeeId,
            start: filter.start ? filter.start + "T00:00:00Z" : null,
            end: filter.end ? filter.end + "T23:59:59Z" : null,
            camera_id: filter.camera_id,
          },
          {
            onSuccess: (res) => onDone(res),
            onError: (err) =>
              setError(
                (t("unidentifiedFaces.unmapModal.failed", { defaultValue: "Unmap failed — please try again." }) as string) +
                  ` (${(err as Error).message})`,
              ),
          },
        );
      }}
    />
  );
}

// ── Mapped face tile ───────────────────────────────────────────────────

export function MappedFaceTile({
  event,
  onOpen,
  onUnmap,
}: {
  event: MappedFaceEventOut;
  onOpen: () => void;
  onUnmap: () => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const fmtDate = useFmtDate();
  const confPct = event.confidence !== null ? Math.round(event.confidence * 100) : null;
  return (
    <div className="unid-face unid-face-mapped" role="article" aria-label={t("unidentifiedFaces.mappedTileAria", "Mapped detection") as string}>
      <button
        type="button"
        className="unid-face-img"
        onClick={onOpen}
        aria-label={t("unidentifiedFaces.viewFace", "View face detected at {{time}}", { time: fmtDate(event.captured_at) }) as string}
      >
        <FaceImg id={event.id} hasCrop={event.has_crop} />
      </button>
      <span className="unid-face-badge">{confPct !== null ? `${confPct}%` : t("unidentifiedFaces.mappedChip", "MAPPED")}</span>
      <button
        type="button"
        className="unid-face-action"
        onClick={(e) => {
          e.stopPropagation();
          onUnmap();
        }}
        aria-label={t("unidentifiedFaces.unmapTileAria", { defaultValue: "Revert this employee mapping" }) as string}
        title={t("unidentifiedFaces.unmapTileTitle", { defaultValue: "Revert mapping" }) as string}
      >
        <Icon name="refresh" size={13} />
      </button>
      <div className="unid-face-meta">
        <EmployeeChip id={event.employee_id} name={event.employee_name} size="sm" />
        <div className="unid-face-caption">
          <span className="mono">{dt.formatTime(event.captured_at) || fmtDate(event.captured_at)}</span>
          <span className="unid-face-cam" title={event.camera_name}>
            {event.camera_name}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Viewer side panel for a mapped face. */
export function MappedFacePanel({ event, onUnmap }: { event: MappedFaceEventOut; onUnmap: () => void }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const confPct = event.confidence !== null ? Math.round(event.confidence * 100) : null;
  return (
    <>
      <div className="unid-viewer-emp">
        <EmployeeChip id={event.employee_id} name={event.employee_name} code={event.employee_code} />
      </div>
      <dl className="unid-facts">
        <div className="unid-fact">
          <dt>{t("unidentifiedFaces.detectionTimeLabel", "Detection time")}</dt>
          <dd>{dt.formatTimeWithSeconds(event.captured_at) || "—"}</dd>
        </div>
        <div className="unid-fact">
          <dt>{t("unidentifiedFaces.detectionDateLabel", "Detection date")}</dt>
          <dd>{dt.formatDate(event.captured_at) || "—"}</dd>
        </div>
        <div className="unid-fact">
          <dt>{t("unidentifiedFaces.camera", "Camera")}</dt>
          <dd>{event.camera_name}</dd>
        </div>
        <div className="unid-fact">
          <dt>{t("unidentifiedFaces.mappedVia", { defaultValue: "Mapped via" })}</dt>
          <dd>{event.mapping_source ? <MappingSourceChip source={event.mapping_source} /> : "—"}</dd>
        </div>
        {confPct !== null && (
          <div className="unid-fact">
            <dt>{t("unidentifiedFaces.confidence", { defaultValue: "Match confidence" })}</dt>
            <dd>
              <TonePill tone={similarityTone(confPct)}>{confPct}%</TonePill>
            </dd>
          </div>
        )}
        <div className="unid-fact">
          <dt>{t("unidentifiedFaces.eventId", "Event ID")}</dt>
          <dd className="mono">#{event.id}</dd>
        </div>
      </dl>
      <div className="unid-viewer-cta">
        <button type="button" className="btn btn-sm" onClick={onUnmap}>
          <Icon name="refresh" size={12} />
          {t("unidentifiedFaces.unmapTileTitle", { defaultValue: "Revert mapping" })}
        </button>
      </div>
    </>
  );
}

// ── Mapped employee card ───────────────────────────────────────────────

export function MappedEmployeeCard({
  group,
  unmapFilter,
  onViewFaces,
}: {
  group: MappedEmployeeGroupOut;
  unmapFilter: { start: string | null; end: string | null; camera_id: number | null };
  onViewFaces: (group: MappedEmployeeGroupOut) => void;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [unmapOpen, setUnmapOpen] = useState(false);
  const [unmapResult, setUnmapResult] = useState<string | null>(null);
  const previews = group.sample_event_ids.slice(0, 4);
  const confPct = group.avg_confidence !== null ? Math.round(group.avg_confidence * 100) : null;
  const subject = group.employee_name ?? (t("unidentifiedFaces.employeeN", { defaultValue: "Employee #{{id}}", id: group.employee_id }) as string);
  const sameDay = dt.formatDate(group.first_seen) === dt.formatDate(group.last_seen);

  return (
    <article className="unid-group-card" aria-label={t("unidentifiedFaces.mappedEmployeeCardAria", "Mapped employee") as string}>
      <button
        type="button"
        className="unid-strip"
        onClick={() => onViewFaces(group)}
        aria-label={t("unidentifiedFaces.viewMappedFaces", { defaultValue: "View {{n}} mapped faces", n: group.count }) as string}
      >
        {previews.length === 0 ? (
          <span className="unid-img-fallback" aria-hidden>
            <Icon name="user" size={28} />
          </span>
        ) : (
          previews.map((eid) => (
            <span key={eid} className="unid-strip-cell">
              <FaceImg id={eid} />
            </span>
          ))
        )}
        <span className="unid-group-count">
          <strong>{group.count}</strong>
          {group.count === 1 ? t("unidentifiedFaces.detectionSingular", "detection") : t("unidentifiedFaces.detectionPlural", "detections")}
        </span>
      </button>
      <div className="unid-group-body">
        <div className="unid-group-top">
          <EmployeeChip id={group.employee_id} name={group.employee_name} code={group.employee_code} />
          {confPct !== null && (
            <TonePill tone={similarityTone(confPct)} title={t("unidentifiedFaces.avgConfidenceTooltip", "Average match confidence") as string}>
              {confPct}%
            </TonePill>
          )}
        </div>
        <div className="unid-group-facts">
          <span>
            <Icon name="clock" size={12} />
            {sameDay
              ? `${dt.formatDate(group.first_seen)} · ${dt.formatTime(group.first_seen)} – ${dt.formatTime(group.last_seen)}`
              : `${dt.formatDate(group.first_seen)} → ${dt.formatDate(group.last_seen)}`}
          </span>
          <span title={group.camera_names.join(", ")}>
            <Icon name="camera" size={12} />
            {group.camera_names[0] ?? "—"}
            {group.camera_names.length > 1 && <span className="text-dim"> +{group.camera_names.length - 1}</span>}
          </span>
        </div>
        {group.mapping_sources && group.mapping_sources.length > 0 && (
          <div className="unid-group-sources">
            {group.mapping_sources.length === 1 ? (
              <MappingSourceChip source={group.mapping_sources[0]} />
            ) : (
              <span className="pill pill-neutral unid-mini-pill" title={group.mapping_sources.join(", ")}>
                {t("unidentifiedFaces.sourceMixed", "Mixed") as string}
              </span>
            )}
          </div>
        )}
        {unmapResult && (
          <div role="status" className="unid-inline-ok">
            {unmapResult}
          </div>
        )}
      </div>
      <div className="unid-group-foot">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onViewFaces(group)}>
          <Icon name="eye" size={13} />
          {t("unidentifiedFaces.viewFaces", { defaultValue: "View faces" })}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost unid-btn-danger-ghost"
          onClick={() => setUnmapOpen(true)}
          aria-label={t("unidentifiedFaces.unmapCardAria", { defaultValue: "Revert all sample mappings for this employee" }) as string}
          title={t("unidentifiedFaces.unmapCardTitle", { defaultValue: "Revert sample mappings" }) as string}
        >
          <Icon name="refresh" size={12} />
          {t("unidentifiedFaces.unmapCardBtn", { defaultValue: "Unmap" }) as string}
        </button>
      </div>

      {unmapOpen && (
        <UnmapByEmployeeModal
          employeeId={group.employee_id}
          subject={subject}
          count={group.count}
          filter={unmapFilter}
          onClose={() => setUnmapOpen(false)}
          onDone={(res) => {
            setUnmapOpen(false);
            setUnmapResult(
              t("unidentifiedFaces.unmapModal.cardSuccess", {
                defaultValue: "Reverted {{n}} mapping(s). {{dates}} day(s) recomputed.",
                n: res.unmapped_events,
                dates: res.attendance_dates_recomputed.length,
              }) as string,
            );
          }}
        />
      )}
    </article>
  );
}
