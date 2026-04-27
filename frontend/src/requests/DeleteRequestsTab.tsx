// P28.7 — Delete requests tab on the Approvals page (HR + Admin only).
//
// HR sees Approve/Reject in the row. Admin sees a read-only "Pending"
// pill (Admin override happens on the Edit drawer of the affected
// employee, not from this list). Click a row to open the affected
// employee's Edit drawer where the override is reachable.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { EmployeeDrawer } from "../features/employees/EmployeeDrawer";
import {
  useDecideDeleteRequest,
  useDeleteRequestList,
} from "../features/employees/hooks";
import type { DeleteRequest } from "../features/employees/types";

interface Props {
  role: "Admin" | "HR";
}

export function DeleteRequestsTab({ role }: Props) {
  const { t } = useTranslation();
  const list = useDeleteRequestList();
  const decide = useDecideDeleteRequest();

  const [drawerEmpId, setDrawerEmpId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectComment, setRejectComment] = useState("");

  const onApprove = async (req: DeleteRequest) => {
    setError(null);
    try {
      await decide.mutateAsync({
        employeeId: req.employee_id,
        requestId: req.id,
        decision: "approve",
      });
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string })?.detail;
        setError(typeof detail === "string" ? detail : `Error ${e.status}`);
      }
    }
  };

  const onReject = async (req: DeleteRequest) => {
    if (rejectComment.trim().length < 5) {
      setError(t("employees.delete.rejectMin") as string);
      return;
    }
    setError(null);
    try {
      await decide.mutateAsync({
        employeeId: req.employee_id,
        requestId: req.id,
        decision: "reject",
        comment: rejectComment.trim(),
      });
      setRejectingId(null);
      setRejectComment("");
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string })?.detail;
        setError(typeof detail === "string" ? detail : `Error ${e.status}`);
      }
    }
  };

  const items = list.data?.items ?? [];

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">
            {t("approvals.deleteRequests.title") as string}
          </h3>
          <span className="text-xs text-dim">
            {items.length} {t("approvals.deleteRequests.pendingSuffix") as string}
          </span>
        </div>

        {error && (
          <div
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger-text)",
              padding: "8px 10px",
              fontSize: 12.5,
              margin: 12,
              borderRadius: "var(--radius-sm)",
            }}
          >
            {error}
          </div>
        )}

        <table className="table">
          <thead>
            <tr>
              <th>{t("approvals.deleteRequests.col.employee") as string}</th>
              <th>{t("approvals.deleteRequests.col.requestedBy") as string}</th>
              <th>{t("approvals.deleteRequests.col.reason") as string}</th>
              <th>{t("approvals.deleteRequests.col.submitted") as string}</th>
              <th style={{ width: 220, textAlign: "end" }}>
                {t("approvals.deleteRequests.col.action") as string}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={5} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("common.loading") as string}
                </td>
              </tr>
            )}
            {!list.isLoading && items.length === 0 && (
              <tr>
                <td colSpan={5} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("approvals.deleteRequests.empty") as string}
                </td>
              </tr>
            )}
            {items.map((req) => {
              const rejecting = rejectingId === req.id;
              return (
                <tr key={req.id}>
                  <td
                    style={{ cursor: "pointer" }}
                    onClick={() => setDrawerEmpId(req.employee_id)}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div className="avatar">{initials(req.employee_full_name)}</div>
                      <div>
                        <div style={{ fontWeight: 500 }}>
                          {req.employee_full_name}
                        </div>
                        <div className="text-xs text-dim mono">
                          {req.employee_code}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="text-sm">
                    {req.requested_by_full_name ?? "—"}
                  </td>
                  <td
                    className="text-sm"
                    style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {req.reason}
                  </td>
                  <td className="text-sm text-dim">
                    {new Date(req.created_at).toLocaleDateString()}
                  </td>
                  <td style={{ textAlign: "end" }}>
                    {role === "HR" ? (
                      rejecting ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input
                            value={rejectComment}
                            onChange={(e) => setRejectComment(e.target.value)}
                            placeholder={
                              t("approvals.deleteRequests.rejectPlaceholder") as string
                            }
                            style={{
                              flex: 1,
                              padding: "4px 8px",
                              fontSize: 12,
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void onReject(req)}
                          >
                            {t("approvals.deleteRequests.confirmReject") as string}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              setRejectingId(null);
                              setRejectComment("");
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => void onApprove(req)}
                            disabled={decide.isPending}
                          >
                            {t("approvals.deleteRequests.approve") as string}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              setRejectingId(req.id);
                              setRejectComment("");
                            }}
                          >
                            {t("approvals.deleteRequests.reject") as string}
                          </button>
                        </div>
                      )
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setDrawerEmpId(req.employee_id)}
                      >
                        {t("approvals.deleteRequests.review") as string}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {drawerEmpId !== null && (
        <EmployeeDrawer
          employeeId={drawerEmpId}
          onClose={() => setDrawerEmpId(null)}
        />
      )}
    </>
  );
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}
