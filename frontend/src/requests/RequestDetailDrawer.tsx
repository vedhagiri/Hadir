// Request detail drawer used by My Requests + the Approvals inbox.
// Shows the workflow as a vertical stepper (Submitted → Manager → HR
// with optional Admin override), the attachment list (with download
// links), and a cancel button when the row is still ``submitted`` and
// owned by the viewer.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DrawerShell } from "../components/DrawerShell";
import { ApiError } from "../api/client";
import { Icon } from "../shell/Icon";
import { useTenantDateTime } from "../util/datetime";
import { StatusPill } from "./StatusPill";
import {
  useAdminOverride,
  useCancelRequest,
  useDeleteAttachment,
  useHrDecide,
  useManagerDecide,
  useRequest,
  useRequestAttachments,
  useUploadAttachment,
} from "./hooks";
import type { RequestRecord } from "./types";
import { SkeletonLine, SkeletonLines } from "../components/Skeleton";
import { Field, FormNotice } from "../components/FormKit";
import { Alert, SectionLabel, errorDetail } from "./workflowUi";

export type DecisionRole = "Manager" | "HR" | "Admin" | null;

interface Props {
  requestId: number;
  onClose: () => void;
  // ``allowOwnerActions`` keeps the cancel + add-attachment affordances
  // confined to the My Requests page; the Approvals inbox passes
  // ``false`` so HR/Manager don't see them.
  allowOwnerActions: boolean;
  // P15: when set, the drawer renders a decision footer scoped to the
  // active reviewer role. ``null`` hides the footer (read-only view).
  decisionRole?: DecisionRole;
}

export function RequestDetailDrawer({
  requestId,
  onClose,
  allowOwnerActions,
  decisionRole = null,
}: Props) {
  const { t } = useTranslation();
  const detail = useRequest(requestId);
  const attachments = useRequestAttachments(requestId);
  const cancel = useCancelRequest();
  const upload = useUploadAttachment();
  const delAttachment = useDeleteAttachment(requestId);
  const dt = useTenantDateTime();
  const [error, setError] = useState<string | null>(null);

  const onCancel = async () => {
    setError(null);
    try {
      await cancel.mutateAsync(requestId);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? errorDetail(err, t("requestDetail.cancelFailed", { defaultValue: "Cancel failed" }))
          : t("requestDetail.cancelFailed", { defaultValue: "Cancel failed" }),
      );
    }
  };

  const onAddFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const f = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!f) return;
    try {
      await upload.mutateAsync({ requestId, file: f });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? errorDetail(err, t("requestDetail.uploadFailed", { defaultValue: "Upload failed" }))
          : t("requestDetail.uploadFailed", { defaultValue: "Upload failed" }),
      );
    }
  };

  const downloadAttachment = async (
    attachmentId: number,
    filename: string,
  ) => {
    setError(null);
    try {
      const resp = await fetch(
        `/api/requests/${requestId}/attachments/${attachmentId}/download`,
        { credentials: "same-origin" },
      );
      if (!resp.ok) {
        throw new Error(`download failed (${resp.status})`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Browsers need the URL to remain valid until the click; release on
      // next tick.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError(t("requestDetail.downloadFailed", { defaultValue: "Could not download attachment." }));
    }
  };

  const r = detail.data;
  const typeLabel = r
    ? r.type === "leave"
      ? t("myRequests.filters.leave")
      : t("myRequests.filters.exception")
    : "";
  const closeLabel = t("common.close");

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div className="wf-grow">
            <div className="wf-row">
              <span className="mono text-xs text-dim">{r ? `#${r.id}` : ""}</span>
              {r && <StatusPill status={r.status} />}
            </div>
            <div className="drawer-title" style={{ fontSize: 16, marginTop: 2 }}>
              {r ? (
                <>
                  {typeLabel} · <span className="mono">{r.target_date_start}</span>
                  {r.target_date_end && r.target_date_end !== r.target_date_start && (
                    <>
                      {" → "}
                      <span className="mono">{r.target_date_end}</span>
                    </>
                  )}
                </>
              ) : (
                <SkeletonLine width={200} height={16} />
              )}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-body">
          {!r ? (
            <SkeletonLines lines={8} />
          ) : (
            <>
              {/* Submitter */}
              <div className="wf-submitter">
                <div className="avatar">{initials(r.employee.full_name)}</div>
                <div className="wf-grow">
                  <div className="wf-sub">{t("requestDetail.submittedBy", { defaultValue: "Submitted by" })}</div>
                  <div className="wf-primary-name">
                    {r.employee.full_name}{" "}
                    <span className="mono text-xs text-dim">{r.employee.employee_code}</span>
                  </div>
                </div>
                <div className="mono text-xs text-dim wf-nowrap">{dt.formatDateTime(r.submitted_at)}</div>
              </div>

              {/* Timeline */}
              <SectionLabel>{t("requestDetail.workflow", { defaultValue: "Workflow" })}</SectionLabel>
              <Timeline request={r} />

              {/* Details */}
              <SectionLabel>{t("requestDetail.details", { defaultValue: "Details" })}</SectionLabel>
              <div className="wf-fact-grid">
                <Fact label={t("requestDetail.reason", { defaultValue: "Reason" })} value={r.reason_category} />
                {r.leave_type_name && (
                  <Fact label={t("requestDetail.leaveType", { defaultValue: "Leave type" })} value={r.leave_type_name} />
                )}
                <Fact label={t("requestDetail.start", { defaultValue: "Start" })} value={r.target_date_start} mono />
                {r.target_date_end && (
                  <Fact label={t("requestDetail.end", { defaultValue: "End" })} value={r.target_date_end} mono />
                )}
              </div>
              {r.reason_text && (
                <div className="wf-note" style={{ marginTop: 10 }}>
                  {r.reason_text}
                </div>
              )}

              {/* Attachments */}
              <SectionLabel>{t("requestDetail.attachments", { defaultValue: "Attachments" })}</SectionLabel>
              {attachments.isLoading ? (
                <SkeletonLines lines={2} />
              ) : (attachments.data ?? []).length === 0 ? (
                <div className="text-sm text-dim">
                  {t("requestDetail.noAttachments", { defaultValue: "No files attached." })}
                </div>
              ) : (
                <div className="wf-attach-list">
                  {attachments.data!.map((a) => (
                    <div key={a.id} className="wf-attach">
                      <span className="wf-attach-icon">
                        <Icon name="fileText" size={14} />
                      </span>
                      <button
                        type="button"
                        className="wf-attach-name"
                        onClick={() => void downloadAttachment(a.id, a.original_filename)}
                        title={t("requestDetail.download", { defaultValue: "Download" })}
                      >
                        {a.original_filename}
                      </button>
                      <span className="wf-attach-size">{(a.size_bytes / 1024).toFixed(0)} KB</span>
                      {allowOwnerActions && r.status === "submitted" && (
                        <button
                          type="button"
                          className="icon-btn wf-icon-btn-sm"
                          aria-label={t("requestDetail.removeAttachment", { defaultValue: "Remove attachment" })}
                          title={t("requestDetail.removeAttachment", { defaultValue: "Remove attachment" })}
                          onClick={() => delAttachment.mutate(a.id)}
                        >
                          <Icon name="x" size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {allowOwnerActions && r.status === "submitted" && (
                <label className="btn btn-sm btn-ghost" style={{ marginTop: 8, cursor: "pointer" }}>
                  <Icon name="plus" size={12} /> {t("requestDetail.addFile", { defaultValue: "Add another file" })}
                  <input
                    type="file"
                    className="wf-file-input"
                    accept="image/*,application/pdf,.docx"
                    onChange={onAddFile}
                  />
                </label>
              )}

              {error && (
                <div style={{ marginTop: 12 }}>
                  <Alert>{error}</Alert>
                </div>
              )}
            </>
          )}
        </div>
        <div className="drawer-foot">
          {r && decisionRole ? (
            <DecisionFooter
              request={r}
              role={decisionRole}
              onDone={onClose}
            />
          ) : r && allowOwnerActions && r.status === "submitted" ? (
            <>
              <button type="button" className="btn btn-ghost wf-danger-text" onClick={onCancel} disabled={cancel.isPending}>
                {cancel.isPending
                  ? t("requestDetail.cancelling", { defaultValue: "Cancelling…" })
                  : t("requestDetail.cancelRequest", { defaultValue: "Cancel request" })}
              </button>
              <button type="button" className="btn" onClick={onClose} disabled={cancel.isPending}>
                {closeLabel}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={onClose}>
              {closeLabel}
            </button>
          )}
        </div>
      </div>
    </DrawerShell>
  );
}

type StepState = "done" | "rejected" | "active" | "pending";

function Timeline({ request }: { request: RequestRecord }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const stages: Array<{
    name: string;
    at: string | null;
    comment?: string | null;
    state: StepState;
    override?: boolean;
  }> = [
    {
      name: t("myRequests.track.submitted", { defaultValue: "Submitted" }),
      at: request.submitted_at,
      state: "done",
    },
    {
      name: t("myRequests.track.manager", { defaultValue: "Manager" }),
      at: request.manager_decision_at,
      comment: request.manager_comment,
      state:
        request.manager_decision_at != null
          ? request.status === "manager_rejected"
            ? "rejected"
            : "done"
          : request.status === "submitted"
            ? "active"
            : "pending",
    },
    {
      name: t("myRequests.track.hr", { defaultValue: "HR" }),
      at: request.hr_decision_at,
      comment: request.hr_comment,
      state:
        request.hr_decision_at != null
          ? request.status === "hr_rejected"
            ? "rejected"
            : "done"
          : request.status === "manager_approved"
            ? "active"
            : "pending",
    },
  ];
  if (
    request.admin_decision_at != null ||
    request.status === "admin_approved" ||
    request.status === "admin_rejected"
  ) {
    // P16: the override stage is flagged visually (warning dot + label)
    // so it pops even when the rest of the row reads neutral.
    stages.push({
      name: t("requestDetail.overriddenByAdmin", { defaultValue: "Overridden by admin" }),
      at: request.admin_decision_at,
      comment: request.admin_comment,
      state: request.status === "admin_rejected" ? "rejected" : "done",
      override: true,
    });
  }

  return (
    <ol className="wf-stepper">
      {stages.map((s, i) => (
        <li key={i} className={`wf-step is-${s.state}${s.override ? " is-override" : ""}`}>
          <div className="wf-step-rail">
            <span className="wf-step-dot" aria-hidden>
              {s.state === "done" && !s.override && <Icon name="check" size={12} />}
              {s.state === "rejected" && <Icon name="x" size={12} />}
              {s.override && s.state === "done" && <Icon name="zap" size={12} />}
            </span>
            <span className="wf-step-line" aria-hidden />
          </div>
          <div className="wf-step-body">
            <div className="wf-step-name">
              {s.override && <span aria-hidden>⚠</span>}
              {s.name}
              {s.state === "active" && (
                <span className="pill pill-accent">
                  {t("requestDetail.awaitingDecision", { defaultValue: "awaiting decision" })}
                </span>
              )}
            </div>
            {s.at ? (
              <div className="wf-step-time">{dt.formatDateTime(s.at)}</div>
            ) : s.state === "pending" ? (
              <div className="wf-step-time">{t("requestDetail.notReached", { defaultValue: "Not reached" })}</div>
            ) : null}
            {s.comment && <div className="wf-step-comment">{s.comment}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="wf-fact">
      <div className="wf-fact-label">{label}</div>
      <div className={`wf-fact-value${mono ? " mono" : ""}`}>{value}</div>
    </div>
  );
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}

// ---------------------------------------------------------------------------
// Decision footer (P15)
// ---------------------------------------------------------------------------

function DecisionFooter({
  request,
  role,
  onDone,
}: {
  request: RequestRecord;
  role: NonNullable<DecisionRole>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const managerDecide = useManagerDecide(request.id);
  const hrDecide = useHrDecide(request.id);
  const adminOverride = useAdminOverride(request.id);

  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);

  // Per-role gating that mirrors the backend state machine.
  const status = request.status;
  const canManager = role === "Manager" && status === "submitted";
  const canHr = role === "HR" && status === "manager_approved";
  // Admin can override at any time per BRD FR-REQ-006 — comment
  // mandatory.
  const canAdmin = role === "Admin";
  const canAct = canManager || canHr || canAdmin;

  const decide = async (decision: "approve" | "reject") => {
    setError(null);
    setCommentError(null);
    if (role === "Admin" && !comment.trim()) {
      setCommentError(t("requestDetail.adminCommentRequired", { defaultValue: "Admin override requires a comment." }));
      return;
    }
    if (decision === "reject" && !comment.trim()) {
      setCommentError(t("requestDetail.rejectCommentRequired", { defaultValue: "Rejection requires a comment." }));
      return;
    }
    try {
      const body = { decision, comment: comment.trim() };
      if (role === "Manager") await managerDecide.mutateAsync(body);
      else if (role === "HR") await hrDecide.mutateAsync(body);
      else await adminOverride.mutateAsync(body);
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? errorDetail(err, t("requestDetail.decisionFailed", { defaultValue: "Decision failed" }))
          : t("requestDetail.decisionFailed", { defaultValue: "Decision failed" }),
      );
    }
  };

  const pending =
    managerDecide.isPending || hrDecide.isPending || adminOverride.isPending;

  if (!canAct) {
    return (
      <button type="button" className="btn" onClick={onDone}>
        {t("common.close")}
      </button>
    );
  }

  return (
    <div className="wf-decision">
      {error && <FormNotice tone="danger">{error}</FormNotice>}
      <Field
        label={t("requestDetail.decisionComment", { defaultValue: "Decision comment" })}
        htmlFor="rq-decision-comment"
        required={role === "Admin"}
        error={commentError}
      >
        <textarea
          id="rq-decision-comment"
          className="textarea"
          rows={2}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
            setCommentError(null);
          }}
          aria-label={t("requestDetail.decisionComment", { defaultValue: "Decision comment" })}
          placeholder={
            role === "Admin"
              ? t("requestDetail.overridePlaceholder", { defaultValue: "Override comment (required)…" })
              : t("requestDetail.commentPlaceholder", { defaultValue: "Optional on approve · required on reject" })
          }
        />
      </Field>
      <div className="wf-row wf-row-end">
        <button type="button" className="btn btn-ghost wf-danger-text" onClick={() => void decide("reject")} disabled={pending}>
          <Icon name="x" size={12} /> {t("requestDetail.reject", { defaultValue: "Reject" })}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void decide("approve")} disabled={pending}>
          <Icon name="check" size={12} /> {t("requestDetail.approve", { defaultValue: "Approve" })}
        </button>
      </div>
    </div>
  );
}
