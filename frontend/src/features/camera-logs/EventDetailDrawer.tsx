// Detection-event detail drawer. Opens from a list row or grid card.
// Read-only: shows the large crop (the crop endpoint audits each view —
// expected), when / where / who, confidence and the raw track id. For
// unknown faces it links to the Unidentified Faces review page — no
// mapping API is called from here.

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { DrawerShell } from "../../components/DrawerShell";
import { FormHeader } from "../../components/FormKit";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { ConfidenceBar, EventStatusPill, PersonCell, cropUrl } from "./clUi";
import type { DetectionEvent } from "./types";

export interface DetailGroupInfo {
  size: number;
  firstAt: string;
  lastAt: string;
}

export function EventDetailDrawer({
  ev,
  group,
  onClose,
  onPrev,
  onNext,
}: {
  ev: DetectionEvent;
  group: DetailGroupInfo | null;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const unknown = !ev.employee_id && !ev.former_employee_match;
  const personName = ev.employee_id
    ? (ev.employee_name ?? t("cameraLogs.empFallback", { id: ev.employee_id }))
    : ev.former_employee_match
      ? (ev.former_match_employee_name ?? t("cameraLogs.pill.former"))
      : t("cameraLogs.unknownPerson", { defaultValue: "Unknown person" });

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer fk-drawer cl-log-drawer" role="dialog" aria-labelledby="cl-log-detail-title">
        <FormHeader
          titleId="cl-log-detail-title"
          icon={<Icon name="camera" size={18} />}
          eyebrow={t("cameraLogs.detail.eyebrow", { defaultValue: "Detection event" })}
          title={personName}
          subtitle={`${dt.formatDate(ev.captured_at)} ${dt.formatTimeWithSeconds(ev.captured_at)} · ${ev.camera_name}`}
          actions={<EventStatusPill ev={ev} />}
          onClose={onClose}
        />

        <div className="drawer-body cl-log-drawer-body">
          <DetailCrop key={ev.id} ev={ev} />

          {unknown && (
            <div className="cl-log-callout">
              <span className="cl-log-callout-icon" aria-hidden>
                <Icon name="user" size={15} />
              </span>
              <div className="cl-log-callout-text">
                <strong>{t("cameraLogs.detail.unknownTitle", { defaultValue: "Nobody was matched to this face" })}</strong>
                <span>
                  {t("cameraLogs.detail.unknownBody", {
                    defaultValue: "Review unknown faces to map them to an employee, which also fixes attendance.",
                  })}
                </span>
              </div>
              <Link to="/unidentified-faces" className="btn btn-sm">
                {t("cameraLogs.detail.review", { defaultValue: "Review in Unidentified Faces" })}
                <Icon name="chevronRight" size={12} />
              </Link>
            </div>
          )}

          <dl className="cl-log-facts">
            <Fact label={t("cameraLogs.col.captured")}>
              <span className="mono">{dt.formatTimeWithSeconds(ev.captured_at)}</span>
              <span className="cl-log-dim"> · {dt.formatDate(ev.captured_at)} · </span>
              <span className="cl-log-dim">
                <RelativeTime iso={ev.captured_at} />
              </span>
            </Fact>
            <Fact label={t("cameraLogs.col.camera")}>{ev.camera_name}</Fact>
            <Fact label={t("cameraLogs.col.status")}>
              <EventStatusPill ev={ev} />
            </Fact>
            <Fact label={t("cameraLogs.col.person")}>
              <PersonCell ev={ev} />
            </Fact>
            <Fact label={t("cameraLogs.col.confidence")}>
              <ConfidenceBar value={ev.confidence} />
            </Fact>
            {group && group.size > 1 && (
              <Fact label={t("cameraLogs.detail.sightings", { defaultValue: "Sightings" })}>
                {t("cameraLogs.detail.sightingsValue", {
                  count: group.size,
                  from: dt.formatTimeWithSeconds(group.firstAt),
                  to: dt.formatTimeWithSeconds(group.lastAt),
                  defaultValue: `${group.size} captures, ${dt.formatTimeWithSeconds(group.firstAt)} → ${dt.formatTimeWithSeconds(group.lastAt)}`,
                })}
              </Fact>
            )}
            <Fact label={t("cameraLogs.col.track")}>
              <span className="mono cl-log-break">{ev.track_id}</span>
            </Fact>
            <Fact label={t("cameraLogs.detail.eventId", { defaultValue: "Event ID" })}>
              <span className="mono">#{ev.id}</span>
            </Fact>
            {ev.detection_metadata && (
              <Fact label={t("cameraLogs.detail.detector", { defaultValue: "Detector" })}>
                <span className="mono cl-log-break" title={JSON.stringify(ev.detection_metadata, null, 2)}>
                  {ev.detection_metadata.detector_mode} · {ev.detection_metadata.detector_pack}
                  {ev.detection_metadata.insightface_version ? ` · v${ev.detection_metadata.insightface_version}` : ""}
                </span>
              </Fact>
            )}
          </dl>
        </div>

        <div className="drawer-foot cl-log-drawer-foot">
          <div className="cl-log-drawer-nav">
            <button
              type="button"
              className="btn btn-sm"
              onClick={onPrev ?? undefined}
              disabled={!onPrev}
              aria-label={t("cameraLogs.detail.newer", { defaultValue: "Newer event" })}
            >
              <Icon name="chevronLeft" size={12} />
              {t("cameraLogs.detail.newerShort", { defaultValue: "Newer" })}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onNext ?? undefined}
              disabled={!onNext}
              aria-label={t("cameraLogs.detail.older", { defaultValue: "Older event" })}
            >
              {t("cameraLogs.detail.olderShort", { defaultValue: "Older" })}
              <Icon name="chevronRight" size={12} />
            </button>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close", { defaultValue: "Close" })}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

function DetailCrop({ ev }: { ev: DetectionEvent }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (!ev.has_crop || failed) {
    return (
      <div className="cl-log-detail-crop is-empty">
        <Icon name="eyeOff" size={22} />
        <span>{t("cameraLogs.cropUnavailable")}</span>
      </div>
    );
  }
  return (
    <div className="cl-log-detail-crop">
      <img src={cropUrl(ev.id)} alt={t("cameraLogs.cropAlt", { id: ev.id, defaultValue: `Face crop ${ev.id}` })} onError={() => setFailed(true)} />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cl-log-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
