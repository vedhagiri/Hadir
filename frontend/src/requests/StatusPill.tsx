// Tiny shared status pill for the request workflow. Maps each of the
// eight statuses to a tone (success / danger / warning / neutral) +
// a human-readable label.

import type { RequestStatus } from "./types";

const TONE: Record<RequestStatus, string> = {
  submitted: "pill-warning",
  manager_approved: "pill-info",
  manager_rejected: "pill-danger",
  hr_approved: "pill-success",
  hr_rejected: "pill-danger",
  admin_approved: "pill-success",
  admin_rejected: "pill-danger",
  cancelled: "pill-neutral",
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

export function StatusPill({ status }: { status: RequestStatus }) {
  return (
    <span className={`pill ${TONE[status] ?? "pill-neutral"}`}>
      {LABEL[status] ?? status}
    </span>
  );
}

export function statusLabel(status: RequestStatus): string {
  return LABEL[status] ?? status;
}
