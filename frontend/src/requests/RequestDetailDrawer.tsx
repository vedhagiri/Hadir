// Request detail drawer used by My Requests + the future Approvals
// inbox. Shows the workflow timeline (Submitted → Manager → HR with
// optional Admin override), the attachment list (with download
// links), and a cancel button when the row is still ``submitted`` and
// owned by the viewer.

import { useState } from "react";

import { ApiError } from "../api/client";
import { Icon } from "../shell/Icon";
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
  const detail = useRequest(requestId);
  const attachments = useRequestAttachments(requestId);
  const cancel = useCancelRequest();
  const upload = useUploadAttachment();
  const delAttachment = useDeleteAttachment(requestId);
  const [error, setError] = useState<string | null>(null);

  const onCancel = async () => {
    setError(null);
    try {
      await cancel.mutateAsync(requestId);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setError(
          typeof body?.detail === "string"
            ? body.detail
            : `Cancel failed (${err.status}).`,
        );
      } else {
        setError("Cancel failed.");
      }
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
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setError(
          typeof body?.detail === "string"
            ? body.detail
            : `Upload failed (${err.status}).`,
        );
      } else {
        setError("Upload failed.");
      }
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
      setError("Could not download attachment.");
    }
  };

  const r = detail.data;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="flex items-center gap-2">
              <span className="mono text-xs text-dim">
                {r ? `#${r.id}` : ""}
              </span>
              {r && <StatusPill status={r.status} />}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {r
                ? `${r.type === "leave" ? "Leave" : "Exception"} · ${r.target_date_start}${r.target_date_end && r.target_date_end !== r.target_date_start ? ` → ${r.target_date_end}` : ""}`
                : "Loading…"}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-body">
          {!r ? (
            <div className="text-sm text-dim">Loading…</div>
          ) : (
            <>
              {/* Submitter */}
              <div
                style={{
                  background: "var(--bg-sunken)",
                  padding: "8px 10px",
                  borderRadius: 8,
                  marginBottom: 14,
                }}
              >
                <div className="text-xs text-dim">Submitted by</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {r.employee.full_name}{" "}
                  <span className="mono text-xs text-dim">
                    {r.employee.employee_code}
                  </span>
                </div>
                <div className="text-xs text-dim">
                  {new Date(r.submitted_at).toLocaleString()}
                </div>
              </div>

              {/* Timeline */}
              <SectionLabel>Workflow</SectionLabel>
              <Timeline request={r} />

              {/* Details */}
              <SectionLabel>Details</SectionLabel>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <Fact label="Reason" value={r.reason_category} />
                {r.leave_type_name && (
                  <Fact label="Leave type" value={r.leave_type_name} />
                )}
                <Fact label="Start" value={r.target_date_start} mono />
                {r.target_date_end && (
                  <Fact label="End" value={r.target_date_end} mono />
                )}
              </div>
              {r.reason_text && (
                <div
                  style={{
                    padding: 12,
                    background: "var(--bg-sunken)",
                    borderRadius: 8,
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginBottom: 14,
                  }}
                >
                  {r.reason_text}
                </div>
              )}

              {/* Attachments */}
              <SectionLabel>Attachments</SectionLabel>
              {attachments.isLoading ? (
                <div className="text-sm text-dim">Loading attachments…</div>
              ) : (attachments.data ?? []).length === 0 ? (
                <div className="text-sm text-dim" style={{ marginBottom: 8 }}>
                  None.
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    marginBottom: 8,
                  }}
                >
                  {attachments.data!.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 10px",
                        background: "var(--bg-sunken)",
                        borderRadius: 8,
                      }}
                    >
                      <Icon name="fileText" size={14} />
                      <button
                        type="button"
                        onClick={() =>
                          void downloadAttachment(a.id, a.original_filename)
                        }
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          textDecoration: "underline",
                          cursor: "pointer",
                          color: "var(--text)",
                          fontSize: 13,
                          textAlign: "left",
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {a.original_filename}
                      </button>
                      <span className="text-xs text-dim">
                        {(a.size_bytes / 1024).toFixed(0)} KB
                      </span>
                      {allowOwnerActions && r.status === "submitted" && (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Remove attachment"
                          onClick={() => delAttachment.mutate(a.id)}
                          style={{ width: 22, height: 22 }}
                        >
                          <Icon name="x" size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {allowOwnerActions && r.status === "submitted" && (
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 12.5,
                    cursor: "pointer",
                    color: "var(--text)",
                    textDecoration: "underline",
                  }}
                >
                  + Add another file
                  <input
                    type="file"
                    accept="image/*,application/pdf,.docx"
                    onChange={onAddFile}
                    style={{ display: "none" }}
                  />
                </label>
              )}

              {error && (
                <div
                  role="alert"
                  style={{
                    background: "var(--danger-soft)",
                    color: "var(--danger-text)",
                    border: "1px solid var(--border)",
                    padding: "8px 10px",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12.5,
                    marginTop: 12,
                  }}
                >
                  {error}
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
              <button
                className="btn"
                onClick={onClose}
                disabled={cancel.isPending}
              >
                Close
              </button>
              <button
                className="btn"
                onClick={onCancel}
                disabled={cancel.isPending}
                style={{ color: "var(--danger-text)" }}
              >
                {cancel.isPending ? "Cancelling…" : "Cancel request"}
              </button>
            </>
          ) : (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function Timeline({ request }: { request: RequestRecord }) {
  const stages = [
    {
      name: "Submitted",
      at: request.submitted_at,
      state: "done" as const,
    },
    {
      name: "Manager",
      at: request.manager_decision_at,
      comment: request.manager_comment,
      state:
        request.manager_decision_at != null
          ? request.status === "manager_rejected"
            ? ("rejected" as const)
            : ("done" as const)
          : request.status === "submitted"
            ? ("active" as const)
            : ("pending" as const),
    },
    {
      name: "HR",
      at: request.hr_decision_at,
      comment: request.hr_comment,
      state:
        request.hr_decision_at != null
          ? request.status === "hr_rejected"
            ? ("rejected" as const)
            : ("done" as const)
          : request.status === "manager_approved"
            ? ("active" as const)
            : ("pending" as const),
    },
  ];
  if (
    request.admin_decision_at != null ||
    request.status === "admin_approved" ||
    request.status === "admin_rejected"
  ) {
    // P16: prefix with the warning glyph so it visually pops in the
    // timeline even when the rest of the row reads neutral.
    stages.push({
      name: "⚠ Overridden by admin",
      at: request.admin_decision_at,
      comment: request.admin_comment,
      state:
        request.status === "admin_rejected"
          ? ("rejected" as const)
          : ("done" as const),
    });
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginBottom: 14,
      }}
    >
      {stages.map((s, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "8px 10px",
            background: "var(--bg-sunken)",
            borderRadius: 8,
            border: `1px solid ${
              s.state === "rejected"
                ? "var(--danger-border)"
                : s.state === "active"
                  ? "var(--accent-border)"
                  : "transparent"
            }`,
          }}
        >
          <div style={{ width: 20, paddingTop: 2 }}>
            {s.state === "done" && <Icon name="check" size={14} />}
            {s.state === "rejected" && <Icon name="x" size={14} />}
            {s.state === "active" && (
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  display: "inline-block",
                  marginTop: 2,
                }}
              />
            )}
            {s.state === "pending" && (
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  border: "1px solid var(--border-strong)",
                  display: "inline-block",
                  marginTop: 2,
                }}
              />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 13, fontWeight: 600, display: "flex", gap: 8 }}
            >
              {s.name}
              {s.state === "active" && (
                <span className="text-xs text-dim">awaiting decision</span>
              )}
            </div>
            {s.at && (
              <div className="text-xs text-dim">
                {new Date(s.at as string).toLocaleString()}
              </div>
            )}
            {"comment" in s && s.comment && (
              <div
                style={{
                  fontSize: 12.5,
                  marginTop: 4,
                  color: "var(--text-secondary)",
                }}
              >
                {s.comment}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
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
    <div
      style={{
        padding: "8px 10px",
        background: "var(--bg-sunken)",
        borderRadius: 8,
      }}
    >
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        className={mono ? "mono" : ""}
        style={{ fontSize: 13, marginTop: 2 }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-tertiary)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
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
  const managerDecide = useManagerDecide(request.id);
  const hrDecide = useHrDecide(request.id);
  const adminOverride = useAdminOverride(request.id);

  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    if (role === "Admin" && !comment.trim()) {
      setError("Admin override requires a comment.");
      return;
    }
    if (decision === "reject" && !comment.trim()) {
      setError("Rejection requires a comment.");
      return;
    }
    try {
      const body = { decision, comment: comment.trim() };
      if (role === "Manager") await managerDecide.mutateAsync(body);
      else if (role === "HR") await hrDecide.mutateAsync(body);
      else await adminOverride.mutateAsync(body);
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setError(
          typeof body?.detail === "string"
            ? body.detail
            : `Decision failed (${err.status}).`,
        );
      } else {
        setError("Decision failed.");
      }
    }
  };

  const pending =
    managerDecide.isPending || hrDecide.isPending || adminOverride.isPending;

  if (!canAct) {
    return <button className="btn" onClick={onDone}>Close</button>;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: "100%",
      }}
    >
      <textarea
        className="input"
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={
          role === "Admin"
            ? "Override comment (required)…"
            : "Optional on approve · required on reject"
        }
        style={{ resize: "vertical" }}
      />
      {error && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            border: "1px solid var(--border)",
            padding: "6px 8px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button
          className="btn"
          onClick={() => void decide("reject")}
          disabled={pending}
          style={{ color: "var(--danger-text)" }}
        >
          <Icon name="x" size={12} /> Reject
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void decide("approve")}
          disabled={pending}
        >
          <Icon name="check" size={12} /> Approve
        </button>
      </div>
    </div>
  );
}
