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
import { Banner } from "./peopleUi";
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
      {/* Backdrop is presentation-only — close via the Cancel
          button. Operator-policy red line; see DrawerShell. */}
      <div role="dialog" aria-modal="true" className="modal pp-modal">
        <div className="modal-head pp-modal-head">
          <span aria-hidden className="pp-modal-icon tone-danger">
            <Icon name="trash" size={15} />
          </span>
          <div className="pp-modal-head-text">
            <h2 className="modal-title">
              {mode === "deactivate"
                ? (t("employees.delete.titleDeactivate", {
                    defaultValue: "Delete {{name}}?",
                    name: employee.full_name,
                  }) as string)
                : (t("employees.delete.titlePermanent", {
                    defaultValue: "Permanently delete {{name}}?",
                    name: employee.full_name,
                  }) as string)}
            </h2>
          </div>
        </div>

        <div className="modal-body">
          {/* Mode picker — two radio cards so the operator picks
              deliberately between reversible and permanent. */}
          <div
            role="radiogroup"
            aria-label={t("employees.delete.modeLabel", { defaultValue: "Delete mode" }) as string}
            className="pp-mode-grid"
          >
            <ModeCard
              checked={mode === "deactivate"}
              onSelect={() => setMode("deactivate")}
              title={t("employees.delete.modeDeactivate", { defaultValue: "Deactivate" }) as string}
              sub={t("employees.delete.modeDeactivateSub", {
                defaultValue: "Sets status to Inactive. Reversible — can be reactivated.",
              }) as string}
              recommended={t("employees.delete.recommended", { defaultValue: "Recommended" }) as string}
            />
            <ModeCard
              checked={mode === "permanent"}
              onSelect={() => setMode("permanent")}
              title={t("employees.delete.modePermanent", { defaultValue: "Permanent" }) as string}
              sub={t("employees.delete.modePermanentSub", {
                defaultValue: "Submits a delete request that purges photos + history after approval.",
              }) as string}
              danger
            />
          </div>

          {mode === "deactivate" ? (
            <Banner>
              {t("employees.delete.deactivateBody", {
                defaultValue:
                  "The employee row will be marked Inactive immediately. Their attendance + clip history is preserved and they can be reactivated from the Inactive filter.",
              }) as string}
            </Banner>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="pp-delete-reason">
                {t("employees.delete.reasonLabel") as string}{" "}
                <span className="text-dim">({t("common.optional", { defaultValue: "optional" }) as string})</span>
              </label>
              <textarea
                id="pp-delete-reason"
                className="textarea"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder={t("employees.delete.reasonPlaceholder", {
                  defaultValue: "Optional — add context for the audit trail (max 500 chars).",
                }) as string}
              />
              <div className="field-help">
                {t("employees.delete.reasonHint", {
                  defaultValue: "The reason is recorded in the audit log if provided.",
                }) as string}
              </div>
            </div>
          )}

          {error && (
            <div style={{ marginTop: 12 }}>
              <Banner tone="danger" role="alert" title={error} />
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("common.cancel") as string}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void onSubmit()}
            disabled={busy}
          >
            {busy
              ? (t("employees.delete.working", { defaultValue: "Working…" }) as string)
              : mode === "deactivate"
                ? (t("employees.delete.deactivateNow", { defaultValue: "Deactivate now" }) as string)
                : (t("employees.delete.submitRequest", { defaultValue: "Submit delete request" }) as string)}
          </button>
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
  recommended?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      role="radio"
      aria-checked={checked}
      className={`radio-card${checked ? " active" : ""}${danger ? " is-danger" : ""}`}
    >
      <span className={`pp-mode-title${checked && danger ? " pp-text-danger" : ""}`}>
        {title}
        {recommended && <span className="pill pill-success">{recommended}</span>}
      </span>
      <span className="pp-mode-sub">{sub}</span>
    </button>
  );
}
