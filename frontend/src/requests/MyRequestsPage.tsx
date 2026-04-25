// Employee-facing "My Requests" page. Lists the caller's own requests
// with filters by type and status, plus a "New request" button that
// opens the submission drawer.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../shell/Icon";
import { NewRequestDrawer } from "./NewRequestDrawer";
import { RequestDetailDrawer } from "./RequestDetailDrawer";
import { StatusPill } from "./StatusPill";
import { useRequests } from "./hooks";
import type { RequestStatus, RequestType } from "./types";

type StatusFilter = "all" | "open" | "approved" | "rejected" | "cancelled";
type TypeFilter = "all" | RequestType;

const STATUS_GROUPS: Record<StatusFilter, ReadonlyArray<RequestStatus>> = {
  all: [],
  open: ["submitted", "manager_approved"],
  approved: ["hr_approved", "admin_approved"],
  rejected: ["manager_rejected", "hr_rejected", "admin_rejected"],
  cancelled: ["cancelled"],
};

export function MyRequestsPage() {
  const { t } = useTranslation();
  const requests = useRequests();
  const [openDrawer, setOpenDrawer] = useState<"new" | null>(null);
  const [openRequestId, setOpenRequestId] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const filtered = useMemo(() => {
    const items = requests.data ?? [];
    return items.filter((r) => {
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
      if (statusFilter !== "all") {
        const allowed = STATUS_GROUPS[statusFilter];
        if (!allowed.includes(r.status)) return false;
      }
      return true;
    });
  }, [requests.data, typeFilter, statusFilter]);

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
            {t("myRequests.title")}
          </h1>
          <p
            style={{
              margin: 0,
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            {t("myRequests.subtitle")}
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setOpenDrawer("new")}
        >
          <Icon name="plus" size={12} /> {t("myRequests.newRequest")}
        </button>
      </header>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <FilterChips
          label={t("myRequests.filters.type")}
          options={[
            ["all", t("myRequests.filters.all")],
            ["exception", t("myRequests.filters.exception")],
            ["leave", t("myRequests.filters.leave")],
          ]}
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as TypeFilter)}
        />
        <FilterChips
          label={t("myRequests.filters.status")}
          options={[
            ["all", t("myRequests.filters.all")],
            ["open", t("myRequests.filters.open")],
            ["approved", t("myRequests.filters.approved")],
            ["rejected", t("myRequests.filters.rejected")],
            ["cancelled", t("myRequests.filters.cancelled")],
          ]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
        />
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 60 }}>{t("myRequests.columns.id")}</th>
              <th>{t("myRequests.columns.type")}</th>
              <th>{t("myRequests.columns.reason")}</th>
              <th>{t("myRequests.columns.dates")}</th>
              <th>{t("myRequests.columns.status")}</th>
              <th style={{ width: 160 }}>{t("myRequests.columns.submitted")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.isLoading ? (
              <tr>
                <td colSpan={7} className="text-sm text-dim">
                  {t("common.loading")}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-sm text-dim">
                  {t("myRequests.empty")}
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr
                  key={r.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => setOpenRequestId(r.id)}
                >
                  <td className="mono text-xs">#{r.id}</td>
                  <td>
                    <span
                      className={`pill ${r.type === "leave" ? "pill-info" : "pill-neutral"}`}
                    >
                      {r.type}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontSize: 13 }}>{r.reason_category}</div>
                    {r.reason_text && (
                      <div
                        className="text-xs text-dim"
                        style={{
                          maxWidth: 300,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.reason_text}
                      </div>
                    )}
                  </td>
                  <td className="mono text-sm">
                    {r.target_date_start}
                    {r.target_date_end &&
                      r.target_date_end !== r.target_date_start &&
                      ` → ${r.target_date_end}`}
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td className="mono text-xs text-dim">
                    {new Date(r.submitted_at).toLocaleString()}
                  </td>
                  <td style={{ textAlign: "end" }}>
                    <Icon name="chevronRight" size={13} className="text-dim" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openDrawer === "new" && (
        <NewRequestDrawer
          onClose={() => setOpenDrawer(null)}
          onCreated={(id) => setOpenRequestId(id)}
        />
      )}
      {openRequestId !== null && (
        <RequestDetailDrawer
          requestId={openRequestId}
          onClose={() => setOpenRequestId(null)}
          allowOwnerActions
        />
      )}
    </div>
  );
}

function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        background: "var(--bg-sunken)",
        padding: "4px 8px",
        borderRadius: "var(--radius-sm)",
      }}
    >
      <span className="text-xs text-dim" style={{ marginInlineEnd: 4 }}>
        {label}
      </span>
      {options.map(([k, v]) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={`pill ${value === k ? "pill-accent" : "pill-neutral"}`}
          style={{ cursor: "pointer", border: "none", textTransform: "none" }}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
