// Manager / HR / Admin approvals inbox. Replaces the pilot
// placeholder. Three tabs (Pending mine / Decided by me / All —
// Admin only), per-row metadata column for attachments + days open
// + SLA badge, and a row-click that opens the detail drawer with
// the role-scoped decision footer.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMe } from "../auth/AuthProvider";
import { useDeleteRequestList } from "../features/employees/hooks";
import { Icon } from "../shell/Icon";
import { DeleteRequestsTab } from "./DeleteRequestsTab";
import { OverrideModal } from "./OverrideModal";
import { RequestDetailDrawer } from "./RequestDetailDrawer";
import type { DecisionRole } from "./RequestDetailDrawer";
import { StatusPill } from "./StatusPill";
import {
  useInboxDecided,
  useInboxPending,
  useRequests,
} from "./hooks";
import type { RequestRecord, RequestStatus } from "./types";

type Tab = "pending" | "decided" | "all" | "delete-requests";

const STAGE_KEY: Record<RequestStatus, string> = {
  submitted: "submitted",
  manager_approved: "managerApproved",
  manager_rejected: "managerRejected",
  hr_approved: "hrApproved",
  hr_rejected: "hrRejected",
  admin_approved: "adminApproved",
  admin_rejected: "adminRejected",
  cancelled: "cancelled",
};

export function ApprovalsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const role = (me.data?.active_role ?? null) as
    | "Admin"
    | "HR"
    | "Manager"
    | "Employee"
    | null;

  const pending = useInboxPending();
  const decided = useInboxDecided();
  const all = useRequests();
  const deleteRequests = useDeleteRequestList();
  const showDeleteTab = role === "HR" || role === "Admin";

  const [tab, setTab] = useState<Tab>("pending");
  const [openId, setOpenId] = useState<number | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<RequestRecord | null>(
    null,
  );

  const reviewerRole: DecisionRole = useMemo(() => {
    if (role === "Manager") return "Manager";
    if (role === "HR") return "HR";
    if (role === "Admin") return "Admin";
    return null;
  }, [role]);

  // Employees should never see this page; bounce them with a hint.
  if (me.isLoading) return <p>{t("common.loading")}</p>;
  if (role === "Employee") {
    return (
      <p style={{ color: "var(--text-secondary)" }}>
        {t("common.forbidden")}{" "}
        <a href="/my-requests" style={{ textDecoration: "underline" }}>
          {t("nav.items.my-requests")}
        </a>
      </p>
    );
  }

  const items =
    tab === "pending"
      ? pending.data ?? []
      : tab === "decided"
        ? decided.data ?? []
        : all.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 28,
              margin: "0 0 4px 0",
              fontWeight: 400,
            }}
          >
            {t("approvals.title")}
          </h1>
          <p
            style={{
              margin: 0,
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            {t("approvals.subtitle")}
          </p>
        </div>
        <span className="text-xs text-dim">{role}</span>
      </header>

      <div className="seg" role="tablist">
        <Tab
          label={`${t("approvals.tabs.pending")}${
            pending.data ? ` · ${pending.data.length}` : ""
          }`}
          active={tab === "pending"}
          onSelect={() => setTab("pending")}
        />
        <Tab
          label={`${t("approvals.tabs.decided")}${
            decided.data ? ` · ${decided.data.length}` : ""
          }`}
          active={tab === "decided"}
          onSelect={() => setTab("decided")}
        />
        {role === "Admin" && (
          <Tab
            label={`${t("approvals.tabs.all")}${all.data ? ` · ${all.data.length}` : ""}`}
            active={tab === "all"}
            onSelect={() => setTab("all")}
          />
        )}
        {showDeleteTab && (
          <Tab
            label={`${t("approvals.tabs.deleteRequests")}${
              deleteRequests.data ? ` · ${deleteRequests.data.items.length}` : ""
            }`}
            active={tab === "delete-requests"}
            onSelect={() => setTab("delete-requests")}
          />
        )}
      </div>

      {tab === "delete-requests" && showDeleteTab ? (
        <DeleteRequestsTab role={role as "Admin" | "HR"} />
      ) : (
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 60 }}>{t("approvals.columns.id")}</th>
              <th>{t("approvals.columns.employee")}</th>
              <th>{t("approvals.columns.type")}</th>
              <th>{t("approvals.columns.reason")}</th>
              <th>{t("approvals.columns.dates")}</th>
              <th>{t("approvals.columns.daysOpen")}</th>
              <th>{t("approvals.columns.stage")}</th>
              <th style={{ width: 60 }}>{t("approvals.columns.files")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-sm text-dim">
                  {t("approvals.empty")}
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <Row
                  key={r.id}
                  request={r}
                  onOpen={() => setOpenId(r.id)}
                  onOverride={
                    role === "Admin"
                      ? () => setOverrideTarget(r)
                      : null
                  }
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      )}

      {openId !== null && (
        <RequestDetailDrawer
          requestId={openId}
          onClose={() => setOpenId(null)}
          allowOwnerActions={false}
          decisionRole={tab === "pending" ? reviewerRole : null}
        />
      )}
      {overrideTarget && (
        <OverrideModal
          request={overrideTarget}
          onClose={() => setOverrideTarget(null)}
        />
      )}
    </div>
  );
}

function Tab({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`seg-btn ${active ? "active" : ""}`}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

function Row({
  request,
  onOpen,
  onOverride,
}: {
  request: RequestRecord;
  onOpen: () => void;
  onOverride: (() => void) | null;
}) {
  const { t } = useTranslation();
  const stage = t(`approvals.stages.${STAGE_KEY[request.status]}`);
  const businessHours = request.business_hours_open;
  return (
    <tr style={{ cursor: "pointer" }} onClick={onOpen}>
      <td className="mono text-xs">#{request.id}</td>
      <td>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {request.employee.full_name}
        </div>
        <div className="text-xs text-dim mono">
          {request.employee.employee_code}
          {request.is_primary_for_viewer && (
            <span
              className="pill pill-accent"
              style={{ marginInlineStart: 6, padding: "0 6px" }}
            >
              {t("approvals.primary")}
            </span>
          )}
        </div>
      </td>
      <td>
        <span
          className={`pill ${
            request.type === "leave" ? "pill-info" : "pill-neutral"
          }`}
        >
          {request.type}
        </span>
      </td>
      <td>
        <div style={{ fontSize: 13 }}>{request.reason_category}</div>
        {request.reason_text && (
          <div
            className="text-xs text-dim"
            style={{
              maxWidth: 240,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {request.reason_text}
          </div>
        )}
      </td>
      <td className="mono text-sm">
        {request.target_date_start}
        {request.target_date_end &&
          request.target_date_end !== request.target_date_start &&
          ` → ${request.target_date_end}`}
      </td>
      <td>
        <span
          className={`pill ${
            request.sla_breached ? "pill-warning" : "pill-neutral"
          }`}
          title={
            request.sla_breached
              ? "Past SLA threshold (business hours)"
              : "Within SLA"
          }
        >
          {Math.round(businessHours)}h
          {request.sla_breached && " · SLA"}
        </span>
      </td>
      <td>
        <StatusPill status={request.status} />
        <div className="text-xs text-dim" style={{ marginTop: 2 }}>
          {stage}
        </div>
      </td>
      <td className="mono text-sm">
        {request.attachment_count > 0 ? (
          <span title={`${request.attachment_count} attachment(s)`}>
            <Icon name="fileText" size={12} /> {request.attachment_count}
          </span>
        ) : (
          <span className="text-dim">—</span>
        )}
      </td>
      <td style={{ textAlign: "end" }}>
        {onOverride && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onOverride();
            }}
            title={t("approvals.overrideTitle")}
            style={{
              color: "var(--danger-text)",
              marginInlineEnd: 4,
            }}
          >
            {t("approvals.override")}
          </button>
        )}
        <Icon name="chevronRight" size={13} className="text-dim" />
      </td>
    </tr>
  );
}
