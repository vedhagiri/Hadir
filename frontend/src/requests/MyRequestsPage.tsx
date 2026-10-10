// Employee-facing "My Requests" page. Lists the caller's own requests
// with filters by type and status, plus a "New request" button that
// opens the submission drawer.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../shell/Icon";
import { useTenantDateTime } from "../util/datetime";
import { NewRequestDrawer } from "./NewRequestDrawer";
import { RequestDetailDrawer } from "./RequestDetailDrawer";
import { StatusPill } from "./StatusPill";
import { useMyRequests } from "./hooks";
import type { RequestStatus, RequestType } from "./types";
import { SkeletonCards, SkeletonTable } from "../components/Skeleton";
import {
  EmptyPanel,
  FilterSelect,
  ResetButton,
  StatCard,
  StatGrid,
  Toolbar,
} from "../components/ListPageUi";
import { SoftPill, TableCard, WF_ICON, WfSvg, errorDetail } from "./workflowUi";

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
  const requests = useMyRequests();
  const dt = useTenantDateTime();
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

  const all = requests.data ?? [];
  const countIn = (g: StatusFilter) => all.filter((r) => STATUS_GROUPS[g].includes(r.status)).length;
  const filtersActive = typeFilter !== "all" || statusFilter !== "all";
  const resetFilters = () => {
    setTypeFilter("all");
    setStatusFilter("all");
  };
  const pickStatus = (g: StatusFilter) => setStatusFilter(statusFilter === g ? "all" : g);

  const newRequestBtn = (primary: boolean) => (
    <button type="button" className={primary ? "btn btn-primary" : "btn"} onClick={() => setOpenDrawer("new")}>
      <Icon name="plus" size={12} /> {t("myRequests.newRequest")}
    </button>
  );

  return (
    <div className="wf-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("myRequests.title")}</h1>
          <p className="page-sub">{t("myRequests.subtitle")}</p>
        </div>
        <div className="page-actions">{newRequestBtn(true)}</div>
      </div>

      {requests.isLoading ? (
        <>
          <SkeletonCards count={3} />
          <SkeletonTable rows={5} cols={6} />
        </>
      ) : requests.error ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
            title={t("myRequests.loadError.title", { defaultValue: "Couldn't load your requests" })}
            body={errorDetail(requests.error, t("common.errorGeneric"))}
            actions={
              <button type="button" className="btn" onClick={() => void requests.refetch()}>
                <Icon name="refresh" size={12} /> {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : all.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<WfSvg>{WF_ICON.file}</WfSvg>}
            title={t("myRequests.emptyAll.title", { defaultValue: "No requests yet" })}
            body={t("myRequests.emptyAll.body", { defaultValue: "Need time off or want to explain a late arrival? File a leave or exception request and track it here." })}
            actions={newRequestBtn(true)}
          />
        </div>
      ) : (
        <>
          <StatGrid>
            <StatCard
              tone="warning"
              icon={WF_ICON.clockAlert}
              label={t("myRequests.filters.open")}
              value={countIn("open")}
              sub={t("myRequests.stats.openSub", { defaultValue: "Waiting for manager or HR" })}
              active={statusFilter === "open"}
              onClick={() => pickStatus("open")}
            />
            <StatCard
              tone="success"
              icon={WF_ICON.check}
              label={t("myRequests.filters.approved")}
              value={countIn("approved")}
              sub={t("myRequests.stats.approvedSub", { defaultValue: "Fully approved" })}
              active={statusFilter === "approved"}
              onClick={() => pickStatus("approved")}
            />
            <StatCard
              tone="danger"
              icon={WF_ICON.x}
              label={t("myRequests.filters.rejected")}
              value={countIn("rejected")}
              sub={t("myRequests.stats.rejectedSub", { defaultValue: "Declined by manager, HR or admin" })}
              active={statusFilter === "rejected"}
              onClick={() => pickStatus("rejected")}
            />
          </StatGrid>

          <Toolbar>
            <FilterSelect
              label={t("myRequests.filters.type")}
              value={typeFilter === "all" ? "" : typeFilter}
              onChange={(v) => setTypeFilter((v || "all") as TypeFilter)}
              options={[
                ["", t("myRequests.filters.all")],
                ["exception", t("myRequests.filters.exception")],
                ["leave", t("myRequests.filters.leave")],
              ]}
            />
            <FilterSelect
              label={t("myRequests.filters.status")}
              value={statusFilter === "all" ? "" : statusFilter}
              onChange={(v) => setStatusFilter((v || "all") as StatusFilter)}
              options={[
                ["", t("myRequests.filters.all")],
                ["open", t("myRequests.filters.open")],
                ["approved", t("myRequests.filters.approved")],
                ["rejected", t("myRequests.filters.rejected")],
                ["cancelled", t("myRequests.filters.cancelled")],
              ]}
            />
            <ResetButton
              active={filtersActive}
              label={t("myRequests.filters.reset", { defaultValue: "Reset" })}
              onClick={resetFilters}
            />
          </Toolbar>

          <TableCard>
            {filtered.length === 0 ? (
              <EmptyPanel
                icon={<WfSvg>{WF_ICON.search}</WfSvg>}
                title={t("myRequests.emptyFiltered.title", { defaultValue: "No requests match these filters" })}
                body={t("myRequests.emptyFiltered.body", { defaultValue: "Change the type or status filter to see more of your requests." })}
                actions={
                  <button type="button" className="btn" onClick={resetFilters}>
                    {t("myRequests.filters.clear", { defaultValue: "Clear filters" })}
                  </button>
                }
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>{t("myRequests.columns.id")}</th>
                    <th>{t("myRequests.columns.type")}</th>
                    <th>{t("myRequests.columns.reason")}</th>
                    <th>{t("myRequests.columns.dates")}</th>
                    <th>{t("myRequests.columns.status")}</th>
                    <th style={{ width: 170 }}>{t("myRequests.columns.submitted")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="wf-row-click" onClick={() => setOpenRequestId(r.id)}>
                      <td className="mono text-xs wf-nowrap">#{r.id}</td>
                      <td>
                        <SoftPill tone={r.type === "leave" ? "info" : "neutral"} dot={false}>
                          {r.type === "leave"
                            ? t("myRequests.filters.leave")
                            : t("myRequests.filters.exception")}
                        </SoftPill>
                      </td>
                      <td>
                        <div>{r.reason_category}</div>
                        {r.reason_text && (
                          <div className="wf-sub wf-clip" style={{ maxWidth: 300 }}>
                            {r.reason_text}
                          </div>
                        )}
                      </td>
                      <td className="mono text-sm wf-nowrap">
                        {r.target_date_start}
                        {r.target_date_end &&
                          r.target_date_end !== r.target_date_start &&
                          ` → ${r.target_date_end}`}
                      </td>
                      <td>
                        <StatusPill status={r.status} />
                        <StageTrack status={r.status} />
                      </td>
                      <td className="mono text-xs text-dim wf-nowrap">
                        {dt.formatDateTime(r.submitted_at)}
                      </td>
                      <td style={{ textAlign: "end" }}>
                        <Icon name="chevronRight" size={13} className="text-dim" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableCard>
        </>
      )}

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

type StepState = "done" | "current" | "rejected" | "skipped" | "todo";

/** Three-step progress track: Submitted → Manager → HR. */
function StageTrack({ status }: { status: RequestStatus }) {
  const { t } = useTranslation();
  let steps: [StepState, StepState, StepState];
  switch (status) {
    case "submitted":
      steps = ["done", "current", "todo"];
      break;
    case "manager_approved":
      steps = ["done", "done", "current"];
      break;
    case "manager_rejected":
      steps = ["done", "rejected", "skipped"];
      break;
    case "hr_approved":
    case "admin_approved":
      steps = ["done", "done", "done"];
      break;
    case "hr_rejected":
    case "admin_rejected":
      steps = ["done", "done", "rejected"];
      break;
    default:
      steps = ["done", "skipped", "skipped"];
  }
  const labels = [
    t("myRequests.track.submitted", { defaultValue: "Submitted" }),
    t("myRequests.track.manager", { defaultValue: "Manager" }),
    t("myRequests.track.hr", { defaultValue: "HR" }),
  ];
  return (
    <div aria-hidden className="wf-track" title={labels.join(" → ")}>
      {steps.map((st, i) => (
        <span key={i} className={`wf-track-step is-${st}`}>
          <span className="wf-track-dot" />
          <span className="wf-track-label">{labels[i]}</span>
          {i < 2 && <span className="wf-track-line" />}
        </span>
      ))}
    </div>
  );
}
