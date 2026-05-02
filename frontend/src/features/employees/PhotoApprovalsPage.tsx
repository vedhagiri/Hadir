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
          ? (t("photoApprovals.approved", {
              defaultValue: "Photo approved",
            }) as string)
          : (t("photoApprovals.rejected", {
              defaultValue: "Photo rejected",
            }) as string),
      );
    },
    onError: () => {
      toast.error(
        t("photoApprovals.actionFailed", {
          defaultValue: "Action failed",
        }) as string,
      );
    },
  });

  const pendingItems = pending.data?.items ?? [];
  const approvedItems = approved.data?.items ?? [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("photoApprovals.title", {
              defaultValue: "Photo approvals",
            }) as string}
          </h1>
          <p className="page-sub">
            {t("photoApprovals.subtitle", {
              count: pendingItems.length,
              defaultValue:
                pendingItems.length === 1
                  ? "1 photo waiting for review"
                  : `${pendingItems.length} photos waiting for review`,
            }) as string}
          </p>
        </div>
      </div>

      {/* Tab strip */}
      <div
        role="tablist"
        aria-label={t("photoApprovals.tabsLabel", {
          defaultValue: "Photo approval queue",
        }) as string}
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 12,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <TabButton
          active={tab === "pending"}
          count={pendingItems.length}
          onClick={() => setTab("pending")}
        >
          {t("photoApprovals.tab.pending", { defaultValue: "Pending" }) as string}
        </TabButton>
        <TabButton
          active={tab === "approved"}
          count={approved.data ? approvedItems.length : null}
          onClick={() => setTab("approved")}
        >
          {t("photoApprovals.tab.approved", {
            defaultValue: "Approved",
          }) as string}
        </TabButton>
      </div>

      <div className="card">
        {tab === "pending" && (
          <PendingPanel
            isLoading={pending.isLoading}
            isError={pending.isError}
            items={pendingItems}
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
            items={approvedItems}
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
      style={{
        background: "transparent",
        border: "none",
        borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
        padding: "8px 14px",
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        color: active ? "var(--text)" : "var(--text-secondary)",
        cursor: "pointer",
        marginBottom: -1,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {children}
      {count !== null && (
        <span
          style={{
            fontSize: 11,
            padding: "1px 7px",
            borderRadius: 999,
            background: active ? "var(--accent-soft)" : "var(--bg-sunken)",
            color: active ? "var(--accent-text)" : "var(--text-tertiary)",
            fontWeight: 600,
          }}
        >
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
  onApprove,
  onReject,
  decidingId,
}: {
  isLoading: boolean;
  isError: boolean;
  items: PendingPhoto[];
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  decidingId: number | null;
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <div className="text-sm text-dim" style={{ padding: 16 }}>
        {t("common.loading") as string}…
      </div>
    );
  }
  if (isError) {
    return (
      <div
        className="text-sm"
        style={{ padding: 16, color: "var(--danger-text)" }}
      >
        {t("photoApprovals.loadFailed", {
          defaultValue: "Could not load the queue.",
        }) as string}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div
        className="text-sm text-dim"
        style={{ padding: 24, textAlign: "center" }}
      >
        {t("photoApprovals.empty", {
          defaultValue: "No photos awaiting approval.",
        }) as string}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        gap: 14,
        padding: 14,
      }}
    >
      {items.map((p) => (
        <PendingTile
          key={p.photo_id}
          p={p}
          onApprove={() => onApprove(p.photo_id)}
          onReject={() => onReject(p.photo_id)}
          busy={decidingId === p.photo_id}
        />
      ))}
    </div>
  );
}

function ApprovedPanel({
  isLoading,
  isError,
  items,
}: {
  isLoading: boolean;
  isError: boolean;
  items: ApprovedPhoto[];
}) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <div className="text-sm text-dim" style={{ padding: 16 }}>
        {t("common.loading") as string}…
      </div>
    );
  }
  if (isError) {
    return (
      <div
        className="text-sm"
        style={{ padding: 16, color: "var(--danger-text)" }}
      >
        {t("photoApprovals.loadFailed", {
          defaultValue: "Could not load the queue.",
        }) as string}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div
        className="text-sm text-dim"
        style={{ padding: 24, textAlign: "center" }}
      >
        {t("photoApprovals.approvedEmpty", {
          defaultValue: "No approved photos yet.",
        }) as string}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        gap: 14,
        padding: 14,
      }}
    >
      {items.map((p) => (
        <ApprovedTile key={p.photo_id} p={p} />
      ))}
    </div>
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
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md, 10px)",
        overflow: "hidden",
        background: "var(--bg-elev)",
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          background: "var(--bg-sunken)",
          position: "relative",
        }}
      >
        <img
          src={`/api/employees/${p.employee_id}/photos/${p.photo_id}/image`}
          alt={`${p.angle} reference for ${p.employee_full_name}`}
          loading="lazy"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
        <span
          className="pill pill-warning"
          style={{
            position: "absolute",
            top: 6,
            insetInlineStart: 6,
            fontSize: 10.5,
          }}
        >
          {t("photoApprovals.pendingPill", {
            defaultValue: "Pending",
          }) as string}
        </span>
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          {p.employee_full_name}
        </div>
        <div className="mono text-xs text-dim" style={{ marginTop: 2 }}>
          {p.employee_code} ·{" "}
          {t(`employees.photos.angle.${p.angle}`, {
            defaultValue: p.angle[0]!.toUpperCase() + p.angle.slice(1),
          }) as string}
        </div>
        {p.uploaded_by_email && (
          <div
            className="text-xs text-dim"
            style={{
              marginTop: 4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={p.uploaded_by_email}
          >
            <Icon name="user" size={10} />
            <span style={{ marginInlineStart: 4 }}>{p.uploaded_by_email}</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onApprove}
            disabled={busy}
            style={{ flex: 1 }}
          >
            <Icon name="check" size={11} />{" "}
            {t("photoApprovals.approve", {
              defaultValue: "Approve",
            }) as string}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={onReject}
            disabled={busy}
            style={{ flex: 1 }}
          >
            <Icon name="x" size={11} />{" "}
            {t("photoApprovals.reject", {
              defaultValue: "Reject",
            }) as string}
          </button>
        </div>
      </div>
    </div>
  );
}

const ROLE_PILL_STYLES: Record<string, { bg: string; fg: string }> = {
  Admin: { bg: "var(--accent-soft)", fg: "var(--accent-text)" },
  HR: { bg: "var(--info-soft, #dbeafe)", fg: "var(--info-text, #1e40af)" },
  Manager: { bg: "var(--bg-sunken)", fg: "var(--text-secondary)" },
  Employee: { bg: "var(--bg-sunken)", fg: "var(--text-secondary)" },
};

function ApprovedTile({ p }: { p: ApprovedPhoto }) {
  const { t } = useTranslation();
  const roleStyle =
    (p.approved_by_role && ROLE_PILL_STYLES[p.approved_by_role]) ||
    ROLE_PILL_STYLES.Employee!;
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md, 10px)",
        overflow: "hidden",
        background: "var(--bg-elev)",
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          background: "var(--bg-sunken)",
          position: "relative",
        }}
      >
        <img
          src={`/api/employees/${p.employee_id}/photos/${p.photo_id}/image`}
          alt={`${p.angle} reference for ${p.employee_full_name}`}
          loading="lazy"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
        <span
          className="pill pill-success"
          style={{
            position: "absolute",
            top: 6,
            insetInlineStart: 6,
            fontSize: 10.5,
          }}
        >
          {t("photoApprovals.approvedPill", {
            defaultValue: "Approved",
          }) as string}
        </span>
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          {p.employee_full_name}
        </div>
        <div className="mono text-xs text-dim" style={{ marginTop: 2 }}>
          {p.employee_code} ·{" "}
          {t(`employees.photos.angle.${p.angle}`, {
            defaultValue: p.angle[0]!.toUpperCase() + p.angle.slice(1),
          }) as string}
        </div>
        {p.approved_by_email && (
          <div
            style={{
              marginTop: 8,
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: roleStyle.bg,
                color: roleStyle.fg,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {p.approved_by_role ??
                (t("photoApprovals.unknownRole", {
                  defaultValue: "User",
                }) as string)}
            </span>
            <span
              className="text-xs text-dim"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                flex: 1,
              }}
              title={p.approved_by_email}
            >
              {p.approved_by_email}
            </span>
          </div>
        )}
        {p.approved_at && (
          <div
            className="text-xs text-dim"
            style={{ marginTop: 4 }}
            title={new Date(p.approved_at).toLocaleString()}
          >
            <Icon name="check" size={10} />
            <span style={{ marginInlineStart: 4 }}>
              {t("photoApprovals.approvedAt", {
                defaultValue: "Approved",
              }) as string}{" "}
              {new Date(p.approved_at).toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
