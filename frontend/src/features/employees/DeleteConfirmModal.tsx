// Direct-delete confirmation modal for the trash action on the
// employees row. Operator request: Admin / HR / Manager can all
// soft-delete an employee directly (sets status=inactive) without
// routing through the HR-approval workflow.
//
// The previous P28.7 delete-request workflow stays available as a
// secondary "Submit delete request" option that runs PDPL hard-delete
// (purges crops + history) — surface that explicitly so the operator
// chooses deliberately.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { useSoftDeleteEmployee, useSubmitDeleteRequest } from "./hooks";
import type { Employee } from "./types";

interface Props {
  employee: Employee;
  onClose: () => void;
  onSubmitted: () => void;
}

type DeleteMode = "deactivate" | "permanent";

export function DeleteConfirmModal({ employee, onClose, onSubmitted }: Props) {
  const { t } = useTranslation();
  // Default to the reversible soft-delete. Permanent hard-delete is
  // explicit opt-in (requires a reason ≥ 10 chars and routes through
  // the HR-approval workflow).
  const [mode, setMode] = useState<DeleteMode>("deactivate");

  const softDelete = useSoftDeleteEmployee();
  const submit = useSubmitDeleteRequest();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    if (mode === "deactivate") {
      try {
        await softDelete.mutateAsync(employee.id);
        onSubmitted();
      } catch (e) {
        setError(extractApiError(e, "Could not deactivate employee"));
      }
      return;
    }
    // Permanent (hard-delete via approval workflow). Reason is
    // optional — operator request. The hint below the textarea
    // explains it's audited so an operator who wants to write
    // context still can.
    try {
      await submit.mutateAsync({
        employeeId: employee.id,
        reason: reason.trim() || null,
      });
      onSubmitted();
    } catch (e) {
      setError(extractApiError(e, "Could not submit"));
    }
  };

  const busy = softDelete.isPending || submit.isPending;

  return (
    <ModalShell onClose={onClose}>
      <div
        // Fullscreen wrapper centers the modal card via grid. More
        // robust than top:50%/transform:translate against parent
        // stacking contexts; also gives us a backdrop-click target
        // outside the card.
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
        // Backdrop is presentation-only — close via the Cancel
        // button. Operator-policy red line; see DrawerShell.
      >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          width: 460,
          maxWidth: "calc(100vw - 32px)",
          padding: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "var(--danger-soft)",
              display: "grid",
              placeItems: "center",
              color: "var(--danger-text)",
            }}
          >
            <Icon name="trash" size={14} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {mode === "deactivate"
              ? `Delete ${employee.full_name}?`
              : `Permanently delete ${employee.full_name}?`}
          </div>
        </div>

        {/* Mode picker — two radio cards so the operator picks
            deliberately between reversible and permanent. */}
        <div
          role="radiogroup"
          aria-label="Delete mode"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginBottom: 14,
          }}
        >
          <ModeCard
            checked={mode === "deactivate"}
            onSelect={() => setMode("deactivate")}
            title="Deactivate"
            sub="Sets status to Inactive. Reversible — can be reactivated."
            recommended
          />
          <ModeCard
            checked={mode === "permanent"}
            onSelect={() => setMode("permanent")}
            title="Permanent"
            sub="Submits a delete request that purges photos + history after approval."
            danger
          />
        </div>

        {mode === "deactivate" ? (
          <div
            className="text-sm text-dim"
            style={{
              padding: "10px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg)",
              marginBottom: 4,
            }}
          >
            The employee row will be marked <strong>Inactive</strong>{" "}
            immediately. Their attendance + clip history is preserved
            and they can be reactivated from the Inactive tab.
          </div>
        ) : (
          <>
            <label
              className="text-xs"
              style={{ fontWeight: 500, color: "var(--text-secondary)" }}
            >
              {t("employees.delete.reasonLabel") as string}{" "}
              <span style={{ color: "var(--text-tertiary, var(--text-secondary))" }}>
                (optional)
              </span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Optional — add context for the audit trail (max 500 chars)."
              style={{
                width: "100%",
                marginTop: 4,
                padding: 8,
                fontSize: 13,
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-elev)",
                color: "var(--text)",
              }}
            />
            <div className="text-xs text-dim" style={{ marginTop: 4 }}>
              The reason is recorded in the audit log if provided.
            </div>
          </>
        )}

        {error && (
          <div
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              padding: "6px 8px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
              marginTop: 10,
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
            marginTop: 16,
          }}
        >
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("common.cancel") as string}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ background: "var(--danger)", color: "white" }}
            onClick={() => void onSubmit()}
            disabled={busy}
          >
            {busy
              ? "Working…"
              : mode === "deactivate"
                ? "Deactivate now"
                : "Submit delete request"}
          </button>
        </div>
      </div>
      </div>
    </ModalShell>
  );
}


function ModeCard({
  checked,
  onSelect,
  title,
  sub,
  recommended,
  danger,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  sub: string;
  recommended?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      role="radio"
      aria-checked={checked}
      style={{
        textAlign: "start",
        padding: "10px 12px",
        border: checked
          ? `2px solid ${danger ? "var(--danger)" : "var(--accent, #0b6e4f)"}`
          : "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: checked
          ? danger
            ? "var(--danger-soft)"
            : "var(--accent-soft, rgba(11,110,79,0.10))"
          : "var(--bg)",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 700,
          color: checked
            ? danger
              ? "var(--danger-text)"
              : "var(--accent, #0b6e4f)"
            : "var(--text)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {title}
        {recommended && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "#0b6e4f",
              background: "rgba(11,110,79,0.12)",
              padding: "1px 6px",
              borderRadius: 999,
            }}
          >
            Recommended
          </span>
        )}
      </span>
      <span style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 }}>
        {sub}
      </span>
    </button>
  );
}
