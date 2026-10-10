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
import { Icon } from "../shell/Icon";
import { useTenantDateTime } from "../util/datetime";
import { SkeletonTable } from "../components/Skeleton";
import { EmptyPanel } from "../components/ListPageUi";
import { Field, FormFooter, FormNotice } from "../components/FormKit";
import { Alert, FormModal, SectionHead, SoftPill, TableCard, WF_ICON, WfSvg, errorDetail } from "./workflowUi";

interface Props {
  role: "Admin" | "HR";
}

export function DeleteRequestsTab({ role }: Props) {
  const { t } = useTranslation();
  const list = useDeleteRequestList();
  const decide = useDecideDeleteRequest();
  const dt = useTenantDateTime();

  const [drawerEmpId, setDrawerEmpId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectComment, setRejectComment] = useState("");
  // Reject dialog — the min-length rule shows under the comment field,
  // a failed decide call shows as a notice at the top of the dialog.
  const [rejectFieldError, setRejectFieldError] = useState<string | null>(null);
  const [rejectServerError, setRejectServerError] = useState<string | null>(null);

  const onApprove = async (req: DeleteRequest) => {
    setError(null);
    try {
      await decide.mutateAsync({
        employeeId: req.employee_id,
        requestId: req.id,
        decision: "approve",
      });
    } catch (e) {
      if (e instanceof ApiError) setError(errorDetail(e, t("common.errorGeneric")));
    }
  };

  const onReject = async (req: DeleteRequest) => {
    if (rejectComment.trim().length < 5) {
      setRejectFieldError(t("employees.delete.rejectMin") as string);
      return;
    }
    setError(null);
    setRejectFieldError(null);
    setRejectServerError(null);
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
      if (e instanceof ApiError) setRejectServerError(errorDetail(e, t("common.errorGeneric")));
    }
  };

  const closeReject = () => {
    setRejectingId(null);
    setRejectComment("");
    setRejectFieldError(null);
    setRejectServerError(null);
  };

  const items = list.data?.items ?? [];
  const rejectingReq = items.find((r) => r.id === rejectingId) ?? null;

  return (
    <div className="wf-stack">
      <SectionHead
        title={t("approvals.deleteRequests.title") as string}
        actions={
          <SoftPill tone={items.length > 0 ? "warning" : "neutral"}>
            {items.length} {t("approvals.deleteRequests.pendingSuffix") as string}
          </SoftPill>
        }
      />
      {error && <Alert>{error}</Alert>}

      {list.isLoading ? (
        <SkeletonTable rows={4} cols={5} />
      ) : list.error ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
            title={t("approvals.deleteRequests.loadError", { defaultValue: "Couldn't load delete requests" })}
            body={errorDetail(list.error, t("common.errorGeneric"))}
            actions={
              <button type="button" className="btn" onClick={() => void list.refetch()}>
                <Icon name="refresh" size={12} /> {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="success"
            icon={<WfSvg>{WF_ICON.check}</WfSvg>}
            title={t("approvals.caughtUp.title", { defaultValue: "You're all caught up!" })}
            body={t("approvals.deleteRequests.empty") as string}
          />
        </div>
      ) : (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th>{t("approvals.deleteRequests.col.employee") as string}</th>
                <th>{t("approvals.deleteRequests.col.requestedBy") as string}</th>
                <th>{t("approvals.deleteRequests.col.reason") as string}</th>
                <th>{t("approvals.deleteRequests.col.submitted") as string}</th>
                <th style={{ width: 260, textAlign: "end" }}>
                  {t("approvals.deleteRequests.col.action") as string}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((req) => {
                const rejecting = rejectingId === req.id;
                return (
                  <tr key={req.id}>
                    <td className="wf-row-click" onClick={() => setDrawerEmpId(req.employee_id)}>
                      <div className="row-person">
                        <div className="avatar">{initials(req.employee_full_name)}</div>
                        <div>
                          <div className="row-person-name wf-nowrap">{req.employee_full_name}</div>
                          <div className="row-person-meta text-dim mono">{req.employee_code}</div>
                        </div>
                      </div>
                    </td>
                    <td className="text-sm">{req.requested_by_full_name ?? "—"}</td>
                    <td className="text-sm wf-clip" style={{ maxWidth: 280 }}>
                      {req.reason}
                    </td>
                    <td className="text-sm text-dim wf-nowrap mono">{dt.formatDate(req.created_at)}</td>
                    <td style={{ textAlign: "end" }}>
                      {role === "HR" ? (
                        rejecting ? (
                          <SoftPill tone="danger" dot={false}>{t("approvals.deleteRequests.reject") as string}…</SoftPill>
                        ) : (
                          <div className="wf-row wf-row-end" style={{ flexWrap: "nowrap" }}>
                            <button type="button" className="btn btn-sm" onClick={() => void onApprove(req)} disabled={decide.isPending}>
                              <Icon name="check" size={11} /> {t("approvals.deleteRequests.approve") as string}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost wf-danger-text"
                              onClick={() => {
                                setRejectingId(req.id);
                                setRejectComment("");
                                setRejectFieldError(null);
                                setRejectServerError(null);
                              }}
                            >
                              {t("approvals.deleteRequests.reject") as string}
                            </button>
                          </div>
                        )
                      ) : (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDrawerEmpId(req.employee_id)}>
                          {t("approvals.deleteRequests.review") as string}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableCard>
      )}

      {rejectingReq && (
        <FormModal
          onClose={closeReject}
          onSubmit={() => void onReject(rejectingReq)}
          busy={decide.isPending}
          size="sm"
          icon={<Icon name="x" size={18} />}
          title={t("approvals.deleteRequests.rejectTitle", { defaultValue: "Reject delete request" }) as string}
          subtitle={t("approvals.deleteRequests.rejectSubtitle", {
            defaultValue: "{{name}} stays on file. The requester sees your reason.",
            name: rejectingReq.employee_full_name,
          }) as string}
          footer={
            <FormFooter
              onCancel={closeReject}
              danger
              submitting={decide.isPending}
              canSubmit={rejectComment.trim().length > 0}
              submitLabel={t("approvals.deleteRequests.confirmReject") as string}
            />
          }
        >
          {rejectServerError && <FormNotice tone="danger">{rejectServerError}</FormNotice>}
          <Field
            label={t("approvals.deleteRequests.rejectReason", { defaultValue: "Reason for rejection" }) as string}
            htmlFor="dr-reject-comment"
            required
            error={rejectFieldError}
            help={t("approvals.deleteRequests.rejectHelp", { defaultValue: "At least 5 characters." }) as string}
          >
            <textarea
              id="dr-reject-comment"
              className="textarea"
              rows={3}
              value={rejectComment}
              onChange={(e) => {
                setRejectComment(e.target.value);
                setRejectFieldError(null);
              }}
              placeholder={t("approvals.deleteRequests.rejectPlaceholder") as string}
            />
          </Field>
        </FormModal>
      )}

      {drawerEmpId !== null && (
        <EmployeeDrawer
          employeeId={drawerEmpId}
          onClose={() => setDrawerEmpId(null)}
        />
      )}
    </div>
  );
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}
