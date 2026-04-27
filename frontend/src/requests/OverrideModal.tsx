// Admin override modal. Carries the load-bearing red banner ("This
// will be audit-logged and visible to all parties") and a comment
// field that requires at least 10 characters server-side; the
// client mirrors the rule for UX. Submit hits POST
// /api/requests/{id}/admin-override.

import { useState } from "react";

import { ApiError } from "../api/client";
import { ModalShell } from "../components/DrawerShell";
import { Icon } from "../shell/Icon";
import { useAdminOverride } from "./hooks";
import type { RequestRecord } from "./types";

const MIN_COMMENT = 10;

interface Props {
  request: RequestRecord;
  onClose: () => void;
}

function previousStageLabel(r: RequestRecord): string {
  // Mirror the backend's _identify_previous_decider precedence:
  // HR wins if there's an HR decision, then Manager. If neither has
  // decided yet (Admin acting on a fresh ``submitted`` row) we name
  // the workflow stage instead.
  if (r.hr_decision_at) return "HR";
  if (r.manager_decision_at) return "Manager";
  if (r.status === "submitted") return "the pending Manager";
  if (r.status === "manager_approved") return "the pending HR review";
  return "the prior";
}

export function OverrideModal({ request, onClose }: Props) {
  const override = useAdminOverride(request.id);
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const trimmedLength = comment.trim().length;
  const tooShort = trimmedLength < MIN_COMMENT;

  const submit = async () => {
    setError(null);
    if (tooShort) {
      setError(
        `Comment must be at least ${MIN_COMMENT} characters (you typed ${trimmedLength}).`,
      );
      return;
    }
    try {
      await override.mutateAsync({ decision, comment: comment.trim() });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setError(
          typeof body?.detail === "string"
            ? body.detail
            : `Override failed (${err.status}).`,
        );
      } else {
        setError("Override failed.");
      }
    }
  };

  const stage = previousStageLabel(request);

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-labelledby="override-title"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 520,
          maxWidth: "90vw",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius)",
          padding: 20,
          zIndex: 60,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div className="mono text-xs text-dim">Admin override</div>
            <h2
              id="override-title"
              style={{ margin: "2px 0 0 0", fontSize: 18 }}
            >
              Override request #{request.id}
            </h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </header>

        {/* Red banner — load-bearing copy. */}
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            border: "1px solid var(--danger-border, var(--border))",
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ display: "block", marginBottom: 2 }}>
            Overriding the {stage} decision.
          </strong>
          This will be audit-logged and visible to all parties (the
          original {stage} decider, the employee, and any administrator
          reviewing the request later).
        </div>

        <Field label="Decision">
          <div style={{ display: "flex", gap: 6 }}>
            {(["approve", "reject"] as const).map((d) => (
              <label
                key={d}
                className={`pill ${decision === d ? "pill-accent" : "pill-neutral"}`}
                style={{ cursor: "pointer", textTransform: "capitalize" }}
              >
                <input
                  type="radio"
                  name="override-decision"
                  value={d}
                  checked={decision === d}
                  onChange={() => setDecision(d)}
                  style={{ display: "none" }}
                />
                {d}
              </label>
            ))}
          </div>
        </Field>

        <Field
          label={`Comment (required, min ${MIN_COMMENT} characters)`}
          hint={
            tooShort
              ? `${trimmedLength} / ${MIN_COMMENT} — comment must be at least ${MIN_COMMENT} characters.`
              : `${trimmedLength} characters.`
          }
          hintTone={tooShort ? "danger" : "muted"}
        >
          <textarea
            className="input"
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Why are you overriding this decision? This is the audit record."
            style={{ resize: "vertical" }}
          />
        </Field>

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
            }}
          >
            {error}
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
            className="btn"
            onClick={onClose}
            disabled={override.isPending}
          >
            Cancel
          </button>
          <button
            className="btn"
            onClick={() => void submit()}
            disabled={override.isPending || tooShort}
            style={{
              background: "var(--danger-bg)",
              color: "var(--danger-text)",
              borderColor: "var(--danger-border, var(--border))",
            }}
          >
            {override.isPending
              ? "Submitting…"
              : decision === "approve"
                ? "Override · Approve"
                : "Override · Reject"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function Field({
  label,
  hint,
  hintTone,
  children,
}: {
  label: string;
  hint?: string;
  hintTone?: "danger" | "muted";
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span
          style={{
            fontSize: 11.5,
            color:
              hintTone === "danger"
                ? "var(--danger-text)"
                : "var(--text-tertiary)",
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}
