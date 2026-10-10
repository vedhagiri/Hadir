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
import { SkeletonCards, SkeletonPage, SkeletonTable } from "../components/Skeleton";
import {
  EmptyPanel,
  FilterSelect,
  ResetButton,
  SearchField,
  StatCard,
  StatGrid,
  Toolbar,
} from "../components/ListPageUi";
import {
  SoftPill,
  TabButton,
  TabStrip,
  TableCard,
  WF_ICON,
  WfSvg,
  errorDetail,
} from "./workflowUi";

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
  const showDeleteTab = role === "HR" || role === "Admin";
  const deleteRequests = useDeleteRequestList({ enabled: showDeleteTab });

  const [tab, setTab] = useState<Tab>("pending");
  const [openId, setOpenId] = useState<number | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<RequestRecord | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | "leave" | "exception">("");
  const [slaOnly, setSlaOnly] = useState(false);

  const reviewerRole: DecisionRole = useMemo(() => {
    if (role === "Manager") return "Manager";
    if (role === "HR") return "HR";
    if (role === "Admin") return "Admin";
    return null;
  }, [role]);

  // Employees should never see this page; bounce them with a hint.
  if (me.isLoading) return <SkeletonPage />;
  if (role === "Employee") {
    return (
      <div className="wf-page">
        <div className="card">
          <EmptyPanel
            tone="warning"
            icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
            title={t("common.forbidden")}
            body={t("approvals.employeeHint", { defaultValue: "Approvals are for managers, HR and admins. Your own requests live on the My requests page." })}
            actions={
              <a className="btn" href="/my-requests">
                {t("nav.items.my-requests")}
              </a>
            }
          />
        </div>
      </div>
    );
  }

  const pendingItems = pending.data ?? [];
  const decidedItems = decided.data ?? [];
  const slaBreachedCount = pendingItems.filter((r) => r.sla_breached).length;
  const deleteCount = deleteRequests.data?.items.length ?? 0;

  const baseItems =
    tab === "pending"
      ? pendingItems
      : tab === "decided"
        ? decidedItems
        : all.data ?? [];

  const q = search.trim().toLowerCase();
  const items = baseItems.filter((r) => {
    if (typeFilter && r.type !== typeFilter) return false;
    if (slaOnly && !r.sla_breached) return false;
    if (!q) return true;
    return (
      r.employee.full_name.toLowerCase().includes(q) ||
      r.employee.employee_code.toLowerCase().includes(q) ||
      r.reason_category.toLowerCase().includes(q) ||
      (r.reason_text ?? "").toLowerCase().includes(q) ||
      `#${r.id}`.includes(q)
    );
  });
  const filtersActive = q !== "" || typeFilter !== "" || slaOnly;
  const activeQuery = tab === "pending" ? pending : tab === "decided" ? decided : all;
  const listLoading = activeQuery.isLoading;

  // Page-level states: the three list queries drive loading / error /
  // "no records at all"; the delete-requests tab is counted so a tenant
  // with only delete requests still gets the stat row + tabs.
  const pageLoading = pending.isLoading || decided.isLoading || all.isLoading;
  const pageError = pending.error ?? decided.error ?? all.error ?? null;
  const totalRecords =
    (all.data?.length ?? 0) + pendingItems.length + decidedItems.length + deleteCount;
  const noRecords = !pageLoading && !pageError && totalRecords === 0;

  const resetFilters = () => {
    setSearch("");
    setTypeFilter("");
    setSlaOnly(false);
  };

  const retryAll = () => {
    void pending.refetch();
    void decided.refetch();
    void all.refetch();
  };

  const caughtUp = {
    title: t("approvals.caughtUp.title", { defaultValue: "You're all caught up!" }),
    body: t("approvals.caughtUp.body", { defaultValue: "No pending approvals right now." }),
  };

  const emptyBody = () => {
    if (baseItems.length > 0) {
      return {
        title: t("approvals.emptyFiltered.title", { defaultValue: "No requests match these filters" }),
        body: t("approvals.emptyFiltered.body", { defaultValue: "Try a different search or clear the filters to see every request in this tab." }),
      };
    }
    if (tab === "pending") return caughtUp;
    if (tab === "decided") {
      return {
        title: t("approvals.emptyDecided.title", { defaultValue: "No decisions yet" }),
        body: t("approvals.emptyDecided.body", { defaultValue: "Requests you approve or reject will be listed here for reference." }),
      };
    }
    return {
      title: t("approvals.emptyAll.title", { defaultValue: "No requests filed yet" }),
      body: t("approvals.emptyAll.body", { defaultValue: "When employees submit exception or leave requests they will show up here." }),
    };
  };

  return (
    <div className="wf-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("approvals.title")}</h1>
          <p className="page-sub">{t("approvals.subtitle")}</p>
        </div>
        <div className="page-actions">
          {role && <SoftPill tone="neutral" dot={false}>{role}</SoftPill>}
        </div>
      </div>

      {pageLoading ? (
        <>
          <SkeletonCards count={3} />
          <SkeletonTable rows={6} cols={7} />
        </>
      ) : pageError ? (
        <div className="card">
          <EmptyPanel
            tone="danger"
            icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
            title={t("approvals.loadError.title", { defaultValue: "Couldn't load approvals" })}
            body={errorDetail(pageError, t("common.errorGeneric"))}
            actions={
              <button type="button" className="btn" onClick={retryAll}>
                <Icon name="refresh" size={12} /> {t("common.retry", { defaultValue: "Retry" })}
              </button>
            }
          />
        </div>
      ) : noRecords ? (
        <div className="card">
          <EmptyPanel
            tone="success"
            icon={<WfSvg>{WF_ICON.check}</WfSvg>}
            title={caughtUp.title}
            body={caughtUp.body}
          />
        </div>
      ) : (
        <>
          <StatGrid>
            <StatCard
              tone="warning"
              icon={WF_ICON.inbox}
              label={t("approvals.stats.pending", { defaultValue: "Pending my decision" })}
              value={pendingItems.length}
              sub={t("approvals.stats.pendingSub", { defaultValue: "Waiting for your approval" })}
              active={tab === "pending" && !slaOnly}
              onClick={() => {
                setTab("pending");
                setSlaOnly(false);
              }}
            />
            <StatCard
              tone="danger"
              icon={WF_ICON.clockAlert}
              label={t("approvals.stats.sla", { defaultValue: "Past SLA" })}
              value={slaBreachedCount}
              sub={t("approvals.stats.slaSub", { defaultValue: "Pending beyond the business-hours target" })}
              active={tab === "pending" && slaOnly}
              onClick={() => {
                setTab("pending");
                setSlaOnly((v) => !(v && tab === "pending"));
              }}
            />
            <StatCard
              tone="success"
              icon={WF_ICON.check}
              label={t("approvals.stats.decided", { defaultValue: "Decided by me" })}
              value={decidedItems.length}
              sub={t("approvals.stats.decidedSub", { defaultValue: "Approved or rejected by you" })}
              active={tab === "decided"}
              onClick={() => {
                setTab("decided");
                setSlaOnly(false);
              }}
            />
          </StatGrid>

          <TabStrip label={t("approvals.title")}>
            <TabButton
              active={tab === "pending"}
              onClick={() => setTab("pending")}
              count={pending.data ? pending.data.length : null}
            >
              {t("approvals.tabs.pending")}
            </TabButton>
            <TabButton
              active={tab === "decided"}
              onClick={() => {
                setTab("decided");
                setSlaOnly(false);
              }}
              count={decided.data ? decided.data.length : null}
            >
              {t("approvals.tabs.decided")}
            </TabButton>
            {role === "Admin" && (
              <TabButton
                active={tab === "all"}
                onClick={() => {
                  setTab("all");
                  setSlaOnly(false);
                }}
                count={all.data ? all.data.length : null}
              >
                {t("approvals.tabs.all")}
              </TabButton>
            )}
            {showDeleteTab && (
              <TabButton
                active={tab === "delete-requests"}
                onClick={() => setTab("delete-requests")}
                count={deleteRequests.data ? deleteRequests.data.items.length : null}
              >
                {t("approvals.tabs.deleteRequests")}
              </TabButton>
            )}
          </TabStrip>

          {tab === "delete-requests" && showDeleteTab ? (
            <DeleteRequestsTab role={role as "Admin" | "HR"} />
          ) : (
            <div>
              {baseItems.length > 0 && (
                <Toolbar>
                  <SearchField
                    value={search}
                    onChange={setSearch}
                    placeholder={t("approvals.searchPlaceholder", { defaultValue: "Search by employee, code or reason" })}
                    clearLabel={t("approvals.clearSearch", { defaultValue: "Clear search" })}
                  />
                  <FilterSelect
                    label={t("approvals.columns.type")}
                    value={typeFilter}
                    onChange={(v) => setTypeFilter(v as "" | "leave" | "exception")}
                    options={[
                      ["", t("approvals.filters.allTypes", { defaultValue: "All types" })],
                      ["exception", t("myRequests.filters.exception")],
                      ["leave", t("myRequests.filters.leave")],
                    ]}
                  />
                  <FilterSelect
                    label={t("approvals.filters.sla", { defaultValue: "SLA" })}
                    value={slaOnly ? "breached" : ""}
                    onChange={(v) => setSlaOnly(v === "breached")}
                    options={[
                      ["", t("approvals.filters.slaAll", { defaultValue: "Any" })],
                      ["breached", t("approvals.filters.slaBreached", { defaultValue: "Past SLA only" })],
                    ]}
                  />
                  <ResetButton
                    active={filtersActive}
                    label={t("approvals.filters.reset", { defaultValue: "Reset" })}
                    onClick={resetFilters}
                  />
                </Toolbar>
              )}
              <TableCard>
                {listLoading ? (
                  <SkeletonTable rows={6} cols={7} />
                ) : items.length === 0 ? (
                  <EmptyPanel
                    tone={baseItems.length > 0 ? "neutral" : tab === "pending" ? "success" : "accent"}
                    icon={<WfSvg>{baseItems.length > 0 ? WF_ICON.search : tab === "pending" ? WF_ICON.check : WF_ICON.inbox}</WfSvg>}
                    {...emptyBody()}
                    actions={
                      filtersActive ? (
                        <button type="button" className="btn" onClick={resetFilters}>
                          {t("approvals.filters.clear", { defaultValue: "Clear filters" })}
                        </button>
                      ) : undefined
                    }
                  />
                ) : (
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
                      {items.map((r) => (
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
                      ))}
                    </tbody>
                  </table>
                )}
              </TableCard>
            </div>
          )}
        </>
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
    <tr className="wf-row-click" onClick={onOpen}>
      <td className="mono text-xs wf-nowrap">#{request.id}</td>
      <td>
        <div className="wf-primary-name wf-nowrap">{request.employee.full_name}</div>
        <div className="wf-sub wf-nowrap">
          <span className="mono">{request.employee.employee_code}</span>
          {request.is_primary_for_viewer && (
            <span className="pill pill-accent" style={{ marginInlineStart: 6 }}>
              {t("approvals.primary")}
            </span>
          )}
        </div>
      </td>
      <td>
        <SoftPill tone={request.type === "leave" ? "info" : "neutral"} dot={false}>
          {request.type === "leave"
            ? t("myRequests.filters.leave")
            : t("myRequests.filters.exception")}
        </SoftPill>
      </td>
      <td>
        <div>{request.reason_category}</div>
        {request.reason_text && (
          <div className="wf-sub wf-clip" style={{ maxWidth: 240 }}>
            {request.reason_text}
          </div>
        )}
      </td>
      <td className="mono text-sm wf-nowrap">
        {request.target_date_start}
        {request.target_date_end &&
          request.target_date_end !== request.target_date_start &&
          ` → ${request.target_date_end}`}
      </td>
      <td>
        <SoftPill
          tone={request.sla_breached ? "danger" : "neutral"}
          title={
            request.sla_breached
              ? t("approvals.slaBreachedTitle", { defaultValue: "Past SLA threshold (business hours)" })
              : t("approvals.slaOkTitle", { defaultValue: "Within SLA" })
          }
        >
          <span className="mono">{Math.round(businessHours)}h</span>
          {request.sla_breached && " · SLA"}
        </SoftPill>
      </td>
      <td>
        <StatusPill status={request.status} />
        <div className="wf-sub wf-nowrap">{stage}</div>
      </td>
      <td className="mono text-sm">
        {request.attachment_count > 0 ? (
          <span title={t("approvals.attachmentsTitle", { defaultValue: "{{n}} attachment(s)", n: request.attachment_count })}>
            <Icon name="fileText" size={12} /> {request.attachment_count}
          </span>
        ) : (
          <span className="text-dim">—</span>
        )}
      </td>
      <td className="wf-nowrap" style={{ textAlign: "end" }}>
        {onOverride && (
          <button
            type="button"
            className="btn btn-sm btn-ghost wf-danger-text"
            onClick={(e) => {
              e.stopPropagation();
              onOverride();
            }}
            title={t("approvals.overrideTitle")}
          >
            {t("approvals.override")}
          </button>
        )}
        <Icon name="chevronRight" size={13} className="text-dim" />
      </td>
    </tr>
  );
}
