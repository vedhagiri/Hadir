// Manager / HR / Admin approvals inbox. Replaces the pilot
// placeholder. Three tabs (Pending mine / Decided by me / All —
// Admin only), per-row metadata column for attachments + days open
// + SLA badge, and a row-click that opens the detail drawer with
// the role-scoped decision footer.

import { useMemo, useState } from "react";

import { useMe } from "../auth/AuthProvider";
import { Icon } from "../shell/Icon";
import { RequestDetailDrawer } from "./RequestDetailDrawer";
import type { DecisionRole } from "./RequestDetailDrawer";
import { StatusPill } from "./StatusPill";
import {
  useInboxDecided,
  useInboxPending,
  useRequests,
} from "./hooks";
import type { RequestRecord } from "./types";

type Tab = "pending" | "decided" | "all";

export function ApprovalsPage() {
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

  const [tab, setTab] = useState<Tab>("pending");
  const [openId, setOpenId] = useState<number | null>(null);

  const reviewerRole: DecisionRole = useMemo(() => {
    if (role === "Manager") return "Manager";
    if (role === "HR") return "HR";
    if (role === "Admin") return "Admin";
    return null;
  }, [role]);

  // Employees should never see this page; bounce them with a hint.
  if (me.isLoading) return <p>Loading…</p>;
  if (role === "Employee") {
    return (
      <p style={{ color: "var(--text-secondary)" }}>
        Approvals is for managers, HR, and administrators. Use{" "}
        <a href="/my-requests" style={{ textDecoration: "underline" }}>
          My Requests
        </a>{" "}
        to file a request instead.
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
            Approvals
          </h1>
          <p
            style={{
              margin: 0,
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            Two-stage workflow · Manager → HR · Admin override per BRD
            FR-REQ-006. Manager rejection is final unless overridden.
          </p>
        </div>
        <span className="text-xs text-dim">Active role: {role}</span>
      </header>

      <div className="seg" role="tablist">
        <Tab
          label={`Pending my decision${
            pending.data ? ` · ${pending.data.length}` : ""
          }`}
          active={tab === "pending"}
          onSelect={() => setTab("pending")}
        />
        <Tab
          label={`Decided by me${
            decided.data ? ` · ${decided.data.length}` : ""
          }`}
          active={tab === "decided"}
          onSelect={() => setTab("decided")}
        />
        {role === "Admin" && (
          <Tab
            label={`All${all.data ? ` · ${all.data.length}` : ""}`}
            active={tab === "all"}
            onSelect={() => setTab("all")}
          />
        )}
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 60 }}>ID</th>
              <th>Employee</th>
              <th>Type</th>
              <th>Reason</th>
              <th>Date(s)</th>
              <th>Days open</th>
              <th>Stage</th>
              <th style={{ width: 60 }}>Files</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-sm text-dim">
                  Nothing here.
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <Row
                  key={r.id}
                  request={r}
                  onOpen={() => setOpenId(r.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {openId !== null && (
        <RequestDetailDrawer
          requestId={openId}
          onClose={() => setOpenId(null)}
          allowOwnerActions={false}
          decisionRole={tab === "pending" ? reviewerRole : null}
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
}: {
  request: RequestRecord;
  onOpen: () => void;
}) {
  const stage = stageLabel(request);
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
              style={{ marginLeft: 6, padding: "0 6px" }}
            >
              primary
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
      <td style={{ textAlign: "right" }}>
        <Icon name="chevronRight" size={13} className="text-dim" />
      </td>
    </tr>
  );
}

function stageLabel(r: RequestRecord): string {
  switch (r.status) {
    case "submitted":
      return "awaiting manager";
    case "manager_approved":
      return "awaiting HR";
    case "manager_rejected":
      return "manager rejected";
    case "hr_approved":
      return "HR approved";
    case "hr_rejected":
      return "HR rejected";
    case "admin_approved":
      return "admin override · approved";
    case "admin_rejected":
      return "admin override · rejected";
    case "cancelled":
      return "cancelled";
  }
}
