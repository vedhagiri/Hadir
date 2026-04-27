// P28.7 — confirmation modal for the trash icon on the employees row.
//
// Role-aware copy:
//   - HR    → "Delete employee" + "Confirm". The submission runs the
//             auto-approve path on the backend and the row is gone in
//             a single click.
//   - Admin → "Submit delete request to HR" + the same reason
//             textarea. Backend creates a pending row and HR decides.
//
// Both surfaces share the same shape — only the verb on the button
// and the help text below the textarea differ.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { ModalShell } from "../../components/DrawerShell";
import { primaryRole } from "../../types";
import { Icon } from "../../shell/Icon";
import { useSubmitDeleteRequest } from "./hooks";
import type { Employee } from "./types";

interface Props {
  employee: Employee;
  onClose: () => void;
  onSubmitted: () => void;
}

export function DeleteConfirmModal({ employee, onClose, onSubmitted }: Props) {
  const { t } = useTranslation();
  const me = useMe();
  const role = me.data ? primaryRole(me.data.roles) : "Employee";
  const isHr = role === "HR";

  const submit = useSubmitDeleteRequest();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (reason.trim().length < 10) {
      setError(t("employees.delete.reasonMin") as string);
      return;
    }
    setError(null);
    try {
      await submit.mutateAsync({
        employeeId: employee.id,
        reason: reason.trim(),
      });
      onSubmitted();
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string })?.detail;
        setError(typeof detail === "string" ? detail : `Error ${e.status}`);
      } else {
        setError("Could not submit");
      }
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          top: "50%",
          insetInlineStart: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 51,
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
            {isHr
              ? (t("employees.delete.hrTitle") as string)
              : (t("employees.delete.adminTitle") as string)}
          </div>
        </div>

        <div className="text-sm text-dim" style={{ marginBottom: 12 }}>
          {isHr
            ? (t("employees.delete.hrBody", { name: employee.full_name }) as string)
            : (t("employees.delete.adminBody", { name: employee.full_name }) as string)}
        </div>

        <label
          className="text-xs"
          style={{ fontWeight: 500, color: "var(--text-secondary)" }}
        >
          {t("employees.delete.reasonLabel") as string} *
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder={t("employees.delete.reasonPlaceholder") as string}
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
          {t("employees.delete.reasonHint") as string}
        </div>

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
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel") as string}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ background: "var(--danger)", color: "white" }}
            onClick={() => void onSubmit()}
            disabled={submit.isPending}
          >
            {isHr
              ? (t("employees.delete.hrConfirm") as string)
              : (t("employees.delete.adminConfirm") as string)}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
