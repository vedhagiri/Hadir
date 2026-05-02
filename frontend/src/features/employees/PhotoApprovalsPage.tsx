// /photo-approvals — Admin/HR queue for Employee self-uploaded
// reference photos. Each pending row shows the photo + employee +
// uploader + approve/reject actions.
//
// Backend:
// * GET    /api/employees/photos/pending           — list
// * POST   /api/employees/photos/{id}/approve      — flip to approved
// * POST   /api/employees/photos/{id}/reject       — drop file + row

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

export function PhotoApprovalsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["employees", "photo-approvals"],
    queryFn: () =>
      api<PendingListResponse>("/api/employees/photos/pending"),
  });

  const decide = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "approve" | "reject" }) => {
      await api(`/api/employees/photos/${id}/${action}`, { method: "POST" });
    },
    onSuccess: (_data, variables) => {
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

  const items = list.data?.items ?? [];

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
              count: items.length,
              defaultValue:
                items.length === 1
                  ? "1 photo waiting for review"
                  : `${items.length} photos waiting for review`,
            }) as string}
          </p>
        </div>
      </div>

      <div className="card">
        {list.isLoading && (
          <div className="text-sm text-dim" style={{ padding: 16 }}>
            {t("common.loading") as string}…
          </div>
        )}
        {list.isError && (
          <div
            className="text-sm"
            style={{ padding: 16, color: "var(--danger-text)" }}
          >
            {t("photoApprovals.loadFailed", {
              defaultValue: "Could not load the queue.",
            }) as string}
          </div>
        )}
        {!list.isLoading && !list.isError && items.length === 0 && (
          <div
            className="text-sm text-dim"
            style={{ padding: 24, textAlign: "center" }}
          >
            {t("photoApprovals.empty", {
              defaultValue: "No photos awaiting approval.",
            }) as string}
          </div>
        )}

        {items.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 14,
              padding: 14,
            }}
          >
            {items.map((p) => (
              <PendingTile
                key={p.photo_id}
                p={p}
                onApprove={() =>
                  decide.mutate({ id: p.photo_id, action: "approve" })
                }
                onReject={() =>
                  decide.mutate({ id: p.photo_id, action: "reject" })
                }
                busy={
                  decide.isPending && decide.variables?.id === p.photo_id
                }
              />
            ))}
          </div>
        )}
      </div>
    </>
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
            <span style={{ marginInlineStart: 4 }}>
              {p.uploaded_by_email}
            </span>
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 6,
            marginTop: 10,
          }}
        >
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
