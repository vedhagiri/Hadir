// Tiny shared status pill for the request workflow. Maps each of the
// eight statuses to a soft tone (success / danger / warning / info /
// neutral) + a human-readable label, rendered with a leading dot.

import { useTranslation } from "react-i18next";

import type { RequestStatus } from "./types";
import { SoftPill } from "./workflowUi";
import type { SoftTone } from "./workflowUi";

const TONE: Record<RequestStatus, SoftTone> = {
  submitted: "warning",
  manager_approved: "info",
  manager_rejected: "danger",
  hr_approved: "success",
  hr_rejected: "danger",
  admin_approved: "success",
  admin_rejected: "danger",
  cancelled: "neutral",
};

const LABEL: Record<RequestStatus, string> = {
  submitted: "Submitted",
  manager_approved: "Manager approved",
  manager_rejected: "Rejected by manager",
  hr_approved: "Approved",
  hr_rejected: "Rejected by HR",
  admin_approved: "Admin override · approved",
  admin_rejected: "Admin override · rejected",
  cancelled: "Cancelled",
};

export function statusTone(status: RequestStatus): SoftTone {
  return TONE[status] ?? "neutral";
}

export function StatusPill({ status }: { status: RequestStatus }) {
  const { t } = useTranslation();
  return (
    <SoftPill tone={statusTone(status)}>
      {t(`requestStatus.${status}`, { defaultValue: LABEL[status] ?? status })}
    </SoftPill>
  );
}

export function statusLabel(status: RequestStatus): string {
  return LABEL[status] ?? status;
}
