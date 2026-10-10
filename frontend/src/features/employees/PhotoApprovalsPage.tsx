// /photo-approvals — Admin/HR queue for Employee self-uploaded
// reference photos. Two tabs:
//
// * Pending — tiles with Approve / Reject actions on each.
// * Approved — read-only audit view of who approved what + when.
//
// Backend:
// * GET    /api/employees/photos/pending           — list pending
// * GET    /api/employees/photos/approved          — list approved + approver
// * POST   /api/employees/photos/{id}/approve      — flip to approved
// * POST   /api/employees/photos/{id}/reject       — drop file + row

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import { SkeletonCards, SkeletonGrid } from "../../components/Skeleton";
import {
  CardGrid,
  EmptyPanel,
  FilterSelect,
  ResetButton,
  SearchField,
  StatGrid,
  Toolbar,
} from "../../components/ListPageUi";
import { DotPill, LoadErrorPanel, PEOPLE_ICON, StatTile } from "./peopleUi";
import { rolePillClass } from "./EmployeesPage";

interface PendingPhoto {
  photo_id: number;
  employee_id: number;
  employee_code: string;
  employee_full_name: string;
  angle: "front" | "left" | "right" | "other";
  uploaded_by_user_id: number | null;
  uploaded_by_email: string | null;
  uploaded_at: string;
}

interface PendingListResponse {
  items: PendingPhoto[];
}

interface ApprovedPhoto extends PendingPhoto {
  approved_by_user_id: number | null;
  approved_by_email: string | null;
  approved_by_role: string | null;
  approved_at: string | null;
}

interface ApprovedListResponse {
  items: ApprovedPhoto[];
}

type Tab = "pending" | "approved";

export function PhotoApprovalsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("pending");

  const pending = useQuery({
    queryKey: ["employees", "photo-approvals", "pending"],
    queryFn: () =>
      api<PendingListResponse>("/api/employees/photos/pending"),
  });
  const approved = useQuery({
    queryKey: ["employees", "photo-approvals", "approved"],
    queryFn: () =>
      api<ApprovedListResponse>("/api/employees/photos/approved"),
    // Only fetch when the operator switches to the Approved tab —
    // pending is the hot path; the audit tab is incidental.
    enabled: tab === "approved",
  });

  const decide = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "approve" | "reject" }) => {
      await api(`/api/employees/photos/${id}/${action}`, { method: "POST" });
    },
    onSuccess: (_data, variables) => {
      // Invalidate both lists — an approved row leaves Pending and
      // joins Approved; a rejected row leaves Pending and is gone.
      qc.invalidateQueries({ queryKey: ["employees", "photo-approvals"] });
      toast.success(
        variables.action === "approve"
          ? (t("photoApprovals.approved") as string)
          : (t("photoApprovals.rejected") as string),
      );
    },
    onError: () => {
      toast.error(t("photoApprovals.actionFailed") as string);
    },
  });

  const pendingItems = pending.data?.items ?? [];
  const approvedItems = approved.data?.items ?? [];

  // Client-side search + angle filter over whichever tab is open.
  const [q, setQ] = useState("");
  const [angleF, setAngleF] = useState("");
  const filtersActive = q.trim() !== "" || angleF !== "";
  const resetFilters = () => {
    setQ("");
    setAngleF("");
  };
  const matches = (p: PendingPhoto) => {
    if (angleF && p.angle !== angleF) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [p.employee_full_name, p.employee_code, p.uploaded_by_email ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  };
  const pendingShown = pendingItems.filter(matches);
  const approvedShown = approvedItems.filter(matches);
  const waitingPeople = new Set(pendingItems.map((p) => p.employee_id)).size;

  // Five-state rendering: stats + tabs + toolbar only once the pending
  // queue has loaded without error. An empty pending queue is a genuine
  // "all caught up" (the Approved tab can still hold history).
  const showChrome = !pending.isLoading && !pending.isError;
  // No records at all (nothing pending, nothing approved yet) → hide the
  // stat row; the tab strip stays so the Approved history is reachable.
  const showStats = showChrome && (pendingItems.length > 0 || approvedItems.length > 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("photoApprovals.title") as string}
          </h1>
          <p className="page-sub">
            {t("photoApprovals.subtitle", { count: pendingItems.length }) as string}
            {" · "}
            {t("photoApprovals.subHint", {
              defaultValue:
                "Photos employees upload themselves are only used for recognition after you approve them.",
            }) as string}
          </p>
        </div>
      </div>

      {pending.isLoading ? (
        <SkeletonCards count={3} minWidth={220} />
      ) : showStats ? (
        <StatGrid>
          <StatTile
            tone="warning"
            icon={PEOPLE_ICON.clock}
            label={t("photoApprovals.tab.pending") as string}
            value={pendingItems.length}
            sub={t("photoApprovals.stats.pendingSub", {
              defaultValue: "Waiting for your review",
            }) as string}
            active={tab === "pending"}
            onClick={() => setTab("pending")}
          />
          <StatTile
            tone="info"
            icon={PEOPLE_ICON.people}
            label={t("photoApprovals.stats.people", { defaultValue: "Employees waiting" }) as string}
            value={waitingPeople}
            sub={t("photoApprovals.stats.peopleSub", {
              defaultValue: "People with at least one pending photo",
            }) as string}
          />
          <StatTile
            tone="success"
            icon={PEOPLE_ICON.check}
            label={t("photoApprovals.tab.approved") as string}
            value={approvedItems.length}
            sub={
              approved.data
                ? (t("photoApprovals.stats.approvedSub", {
                    defaultValue: "Already in use for recognition",
                  }) as string)
                : (t("photoApprovals.stats.approvedOpen", {
                    defaultValue: "Open to load the approval history",
                  }) as string)
            }
            active={tab === "approved"}
            onClick={() => setTab("approved")}
          />
        </StatGrid>
      ) : null}

      {showChrome && (
        <>
          <div
            className="tabs"
            role="tablist"
            aria-label={t("photoApprovals.tabsLabel") as string}
            style={{ marginBottom: 12 }}
          >
            <TabButton
              active={tab === "pending"}
              count={pendingItems.length}
              onClick={() => setTab("pending")}
            >
              {t("photoApprovals.tab.pending") as string}
            </TabButton>
            <TabButton
              active={tab === "approved"}
              count={approved.data ? approvedItems.length : null}
              onClick={() => setTab("approved")}
            >
              {t("photoApprovals.tab.approved") as string}
            </TabButton>
          </div>

          <Toolbar>
            <SearchField
              value={q}
              onChange={setQ}
              placeholder={t("photoApprovals.filters.search", {
                defaultValue: "Search by employee name, ID or uploader…",
              }) as string}
              clearLabel={t("employees.filters.clearSearch", { defaultValue: "Clear search" }) as string}
            />
            <FilterSelect
              label={t("photoApprovals.filters.angle", { defaultValue: "Angle" }) as string}
              value={angleF}
              onChange={setAngleF}
              options={[
                ["", t("photoApprovals.filters.allAngles", { defaultValue: "All angles" }) as string],
                ...(["front", "left", "right", "other"] as const).map(
                  (a) => [a, t(`employees.photos.angles.${a}`) as string] as [string, string],
                ),
              ]}
            />
            <ResetButton
              active={filtersActive}
              label={t("employees.filters.reset", { defaultValue: "Reset" }) as string}
              onClick={resetFilters}
            />
          </Toolbar>
        </>
      )}

      <div className="card">
        {tab === "pending" && (
          <PendingPanel
            isLoading={pending.isLoading}
            isError={pending.isError}
            onRetry={() => void pending.refetch()}
            items={pendingShown}
            hasAny={pendingItems.length > 0}
            onClear={resetFilters}
            onApprove={(id) => decide.mutate({ id, action: "approve" })}
            onReject={(id) => decide.mutate({ id, action: "reject" })}
            decidingId={
              decide.isPending ? decide.variables?.id ?? null : null
            }
          />
        )}
        {tab === "approved" && (
          <ApprovedPanel
            isLoading={approved.isLoading}
            isError={approved.isError}
            onRetry={() => void approved.refetch()}
            items={approvedShown}
            hasAny={approvedItems.length > 0}
            onClear={resetFilters}
          />
        )}
      </div>
    </>
  );
}

function TabButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`tab${active ? " active" : ""}`}
    >
      {children}
      {count !== null && (
        <span className={`pill ${active ? "pill-accent" : "pill-neutral"}`} style={{ marginInlineStart: 6 }}>
          {count}
        </span>
      )}
    </button>
  );
}

function PendingPanel({
  isLoading,
  isError,
  items,
  hasAny,
  onClear,
  onApprove,
  onReject,
  decidingId,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  items: PendingPhoto[];
  hasAny: boolean;
  onClear: () => void;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  decidingId: number | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <SkeletonGrid count={6} minWidth={210} />
    );
  }
  if (isError) {
    return (
      <LoadErrorPanel title={t("photoApprovals.loadFailed") as string} onRetry={onRetry} />
    );
  }
  if (items.length === 0) {
    return hasAny ? (
      <NoMatch onClear={onClear} />
    ) : (
      <EmptyPanel
        tone="success"
        icon={<Icon name="check" size={30} />}
        title={t("photoApprovals.emptyState.pendingTitle", {
          defaultValue: "You're all caught up!",
        }) as string}
        body={t("photoApprovals.emptyState.pendingBody", {
          defaultValue: "No pending approvals right now.",
        }) as string}
      />
    );
  }
  return (
    <CardGrid minWidth={210}>
      {items.map((p) => (
        <PendingTile
          key={p.photo_id}
          p={p}
          onApprove={() => onApprove(p.photo_id)}
          onReject={() => onReject(p.photo_id)}
          busy={decidingId === p.photo_id}
        />
      ))}
    </CardGrid>
  );
}

function ApprovedPanel({
  isLoading,
  isError,
  items,
  hasAny,
  onClear,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  items: ApprovedPhoto[];
  hasAny: boolean;
  onClear: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <SkeletonGrid count={6} minWidth={210} />
    );
  }
  if (isError) {
    return (
      <LoadErrorPanel title={t("photoApprovals.loadFailed") as string} onRetry={onRetry} />
    );
  }
  if (items.length === 0) {
    return hasAny ? (
      <NoMatch onClear={onClear} />
    ) : (
      <EmptyPanel
        icon={<Icon name="camera" size={30} />}
        title={t("photoApprovals.emptyState.approvedTitle", {
          defaultValue: "No approvals yet",
        }) as string}
        body={t("photoApprovals.approvedEmpty") as string}
      />
    );
  }
  return (
    <CardGrid minWidth={210}>
      {items.map((p) => (
        <ApprovedTile key={p.photo_id} p={p} />
      ))}
    </CardGrid>
  );
}

function PendingTile({
  p,
  onApprove,
  onReject,
  busy,
}: {
  p: PendingPhoto;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="pp-tile">
      <div className="pp-tile-img">
        <img
          src={`/api/employees/${p.employee_id}/photos/${p.photo_id}/image`}
          alt={`${p.angle} reference for ${p.employee_full_name}`}
          loading="lazy"
        />
        <span className="pp-tile-badge">
          <DotPill tone="warning">{t("photoApprovals.pendingPill") as string}</DotPill>
        </span>
      </div>
      <div className="pp-tile-body">
        <div className="pp-tile-title pp-truncate" title={p.employee_full_name}>
          {p.employee_full_name}
        </div>
        <div className="pp-tile-meta">
          <span className="mono">{p.employee_code}</span>
          <span>· {t(`employees.photos.angles.${p.angle}`) as string}</span>
        </div>
        <div className="pp-tile-meta" title={new Date(p.uploaded_at).toLocaleString()}>
          <Icon name="clock" size={10} />
          <span>
            {t("photoApprovals.uploadedAt", { defaultValue: "Uploaded" }) as string}{" "}
            <span className="mono">{new Date(p.uploaded_at).toLocaleString()}</span>
          </span>
        </div>
        {p.uploaded_by_email && (
          <div className="pp-tile-meta" title={p.uploaded_by_email}>
            <Icon name="user" size={10} />
            <span>{p.uploaded_by_email}</span>
          </div>
        )}
        <div className="pp-tile-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={onApprove}
            disabled={busy}
          >
            <Icon name="check" size={11} />{" "}
            {t("photoApprovals.approve") as string}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={onReject}
            disabled={busy}
          >
            <Icon name="x" size={11} />{" "}
            {t("photoApprovals.reject") as string}
          </button>
        </div>
      </div>
    </div>
  );
}

function NoMatch({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyPanel
      icon={<Icon name="search" size={28} />}
      title={t("photoApprovals.emptyState.noMatchTitle", {
        defaultValue: "No photos match your search",
      }) as string}
      body={t("photoApprovals.emptyState.noMatchBody", {
        defaultValue: "Try another name or ID, or clear the filters.",
      }) as string}
      actions={
        <button type="button" className="btn" onClick={onClear}>
          <Icon name="refresh" size={12} />
          {t("employees.emptyState.clearFilters", { defaultValue: "Clear filters" }) as string}
        </button>
      }
    />
  );
}

function ApprovedTile({ p }: { p: ApprovedPhoto }) {
  const { t } = useTranslation();
  return (
    <div className="pp-tile">
      <div className="pp-tile-img">
        <img
          src={`/api/employees/${p.employee_id}/photos/${p.photo_id}/image`}
          alt={`${p.angle} reference for ${p.employee_full_name}`}
          loading="lazy"
        />
        <span className="pp-tile-badge">
          <DotPill tone="success">{t("photoApprovals.approvedPill") as string}</DotPill>
        </span>
      </div>
      <div className="pp-tile-body">
        <div className="pp-tile-title pp-truncate" title={p.employee_full_name}>
          {p.employee_full_name}
        </div>
        <div className="pp-tile-meta">
          <span className="mono">{p.employee_code}</span>
          <span>· {t(`employees.photos.angles.${p.angle}`) as string}</span>
        </div>
        {p.approved_by_email && (
          <div className="pp-tile-meta" style={{ marginTop: 8 }} title={p.approved_by_email}>
            <span className={`pill ${rolePillClass(p.approved_by_role ?? "")}`}>
              {p.approved_by_role ?? (t("photoApprovals.unknownRole") as string)}
            </span>
            <span>{p.approved_by_email}</span>
          </div>
        )}
        {p.approved_at && (
          <div className="pp-tile-meta" title={new Date(p.approved_at).toLocaleString()}>
            <Icon name="check" size={10} />
            <span>
              {t("photoApprovals.approvedAt") as string}{" "}
              <span className="mono">{new Date(p.approved_at).toLocaleString()}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
