// /my-profile — Employee self-service. Read-only profile facts +
// photo gallery with provenance + approval-status pills + the
// upload control. Self-uploaded photos can be deleted; HR/Admin
// uploads (and legacy NULL-uploader rows) render but show no
// trash icon.
//
// Backend surface:
// * GET  /api/employees/me            — read-only profile fact set
// * GET  /api/employees/me/photos     — list of own photos with
//                                       uploaded_by_user_id +
//                                       approval_status fields
// * POST /api/employees/me/photos     — upload (lands as 'pending'
//                                       until Admin/HR approves)
// * GET  /api/employees/me/photos/{id}/image — decrypted bytes
// * DELETE /api/employees/me/photos/{id}     — refuses 403 when
//                                              uploader != self

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import type { Employee, PhotoAngle } from "./types";

const ANGLES: PhotoAngle[] = ["front", "left", "right", "other"];

interface SelfPhoto {
  id: number;
  employee_id: number;
  angle: PhotoAngle;
  uploaded_by_user_id: number | null;
  approval_status: "approved" | "pending" | "rejected";
}

interface SelfPhotoListResponse {
  items: SelfPhoto[];
}

export function MyProfilePage() {
  const { t } = useTranslation();
  const me = useMe();
  const myUserId = me.data?.id ?? null;

  const profile = useQuery({
    queryKey: ["employees", "me"],
    queryFn: () => api<Employee>("/api/employees/me"),
    retry: false,
  });

  const photos = useQuery({
    queryKey: ["employees", "me", "photos"],
    queryFn: () =>
      api<SelfPhotoListResponse>("/api/employees/me/photos"),
    retry: false,
    enabled: !!profile.data,
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("myProfile.title", {
              defaultValue: "Profile & Photo",
            }) as string}
          </h1>
          <p className="page-sub">
            {t("myProfile.subtitle", {
              defaultValue:
                "Your employee details and reference photos for face detection.",
            }) as string}
          </p>
        </div>
      </div>

      {profile.isLoading && (
        <div className="text-sm text-dim">
          {t("common.loading") as string}…
        </div>
      )}

      {profile.isError && (
        <div className="card" style={{ padding: 18 }}>
          <div className="text-sm" style={{ color: "var(--danger-text)" }}>
            {profile.error instanceof ApiError && profile.error.status === 404
              ? (t("myProfile.noLink", {
                  defaultValue:
                    "Your account isn't linked to an employee record yet. Ask an Admin or HR to wire your email to an employee row.",
                }) as string)
              : (t("myProfile.loadFailed", {
                  defaultValue: "Could not load your profile.",
                }) as string)}
          </div>
        </div>
      )}

      {profile.data && (
        <>
          <ProfileCard employee={profile.data} />
          <PhotosCard
            employee={profile.data}
            photos={photos.data?.items ?? []}
            loading={photos.isLoading}
            myUserId={myUserId}
          />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Profile card — read-only facts
// ---------------------------------------------------------------------------

function ProfileCard({ employee: e }: { employee: Employee }) {
  const { t } = useTranslation();
  return (
    <div className="card" style={{ marginBottom: 16, padding: 18 }}>
      <h3 className="card-title" style={{ marginBottom: 12 }}>
        {t("myProfile.facts", { defaultValue: "Profile" }) as string}
      </h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "14px 24px",
        }}
      >
        <Fact label={t("employees.field.code", { defaultValue: "Employee ID" }) as string} value={e.employee_code} mono />
        <Fact label={t("employees.field.fullName", { defaultValue: "Name" }) as string} value={e.full_name} />
        <Fact label={t("employees.field.designation", { defaultValue: "Designation" }) as string} value={e.designation ?? "—"} />
        <Fact label={t("employees.field.email", { defaultValue: "Email" }) as string} value={e.email ?? "—"} />
        <Fact label={t("employees.field.phone", { defaultValue: "Phone" }) as string} value={e.phone ?? "—"} />
        {e.division && (
          <Fact label={t("employees.team.col.division", { defaultValue: "Division" }) as string} value={e.division.name} />
        )}
        <Fact label={t("employees.team.col.department", { defaultValue: "Department" }) as string} value={e.department.name} />
        {e.section && (
          <Fact label={t("employees.team.col.section", { defaultValue: "Section" }) as string} value={e.section.name} />
        )}
        {e.joining_date && (
          <Fact label={t("employees.field.joinDate", { defaultValue: "Joining date" }) as string} value={e.joining_date} mono />
        )}
      </div>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Photos card — gallery + upload
// ---------------------------------------------------------------------------

function PhotosCard({
  employee,
  photos,
  loading,
  myUserId,
}: {
  employee: Employee;
  photos: SelfPhoto[];
  loading: boolean;
  myUserId: number | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [angle, setAngle] = useState<PhotoAngle>("front");
  const [uploading, setUploading] = useState(false);

  const pendingCount = useMemo(
    () => photos.filter((p) => p.approval_status === "pending").length,
    [photos],
  );

  const deleteMutation = useMutation({
    mutationFn: async (photoId: number) => {
      await api(`/api/employees/me/photos/${photoId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees", "me", "photos"] });
      toast.success(
        t("myProfile.photoDeleted", {
          defaultValue: "Photo removed",
        }) as string,
      );
    },
    onError: (e) => {
      const detail =
        e instanceof ApiError && e.status === 403
          ? (t("myProfile.cannotDeleteOthers", {
              defaultValue:
                "Only Admin or HR can remove photos they uploaded.",
            }) as string)
          : (t("myProfile.deleteFailed", {
              defaultValue: "Could not remove photo.",
            }) as string);
      toast.error(detail);
    },
  });

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("angle", angle);
      for (const f of Array.from(files)) fd.append("files", f);
      const r = await fetch("/api/employees/me/photos", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      if (!r.ok) {
        const detail = await r.text();
        toast.error(
          (t("myProfile.uploadFailed", {
            defaultValue: "Upload failed",
          }) as string) +
            (detail ? ` (${r.status})` : ""),
        );
        return;
      }
      qc.invalidateQueries({ queryKey: ["employees", "me", "photos"] });
      toast.success(
        t("myProfile.uploadQueued", {
          defaultValue: "Uploaded — pending HR/Admin approval",
        }) as string,
      );
    } catch {
      toast.error(
        t("myProfile.uploadNetwork", {
          defaultValue: "Network error",
        }) as string,
      );
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <h3 className="card-title">
            {t("myProfile.photos", {
              defaultValue: "Reference photos",
            }) as string}
          </h3>
          <div className="text-xs text-dim" style={{ marginTop: 2 }}>
            {t("myProfile.photosHint", {
              defaultValue:
                "Front-facing photos work best. Each upload is reviewed by HR/Admin before face detection picks it up.",
            }) as string}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            value={angle}
            onChange={(e) => setAngle(e.target.value as PhotoAngle)}
            disabled={uploading}
            style={{
              padding: "6px 10px",
              fontSize: 12.5,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-elev)",
              color: "var(--text)",
            }}
            aria-label="Angle"
          >
            {ANGLES.map((a) => (
              <option key={a} value={a}>
                {t(`employees.photos.angle.${a}`, {
                  defaultValue: a[0]!.toUpperCase() + a.slice(1),
                }) as string}
              </option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            style={{ display: "none" }}
            onChange={(e) => void onUpload(e.target.files)}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            <Icon name="upload" size={12} />
            {uploading
              ? (t("myProfile.uploading", {
                  defaultValue: "Uploading…",
                }) as string)
              : (t("myProfile.uploadBtn", {
                  defaultValue: "Upload photo",
                }) as string)}
          </button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            background: "var(--warning-soft)",
            color: "var(--warning-text, var(--warning))",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
          }}
        >
          {t("myProfile.pendingBanner", {
            count: pendingCount,
            defaultValue:
              pendingCount === 1
                ? "1 photo waiting for HR/Admin approval."
                : `${pendingCount} photos waiting for HR/Admin approval.`,
          }) as string}
        </div>
      )}

      {loading && (
        <div className="text-sm text-dim">
          {t("common.loading") as string}…
        </div>
      )}

      {!loading && photos.length === 0 && (
        <div
          className="text-sm text-dim"
          style={{
            padding: 24,
            textAlign: "center",
            border: "1px dashed var(--border)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          {t("myProfile.noPhotos", {
            defaultValue:
              "No reference photos yet. Click Upload to add one.",
          }) as string}
        </div>
      )}

      {photos.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          {photos.map((p) => (
            <PhotoTile
              key={p.id}
              photo={p}
              employee={employee}
              myUserId={myUserId}
              onDelete={() => deleteMutation.mutate(p.id)}
              deleting={
                deleteMutation.isPending &&
                deleteMutation.variables === p.id
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PhotoTile({
  photo: p,
  employee: _e,
  myUserId,
  onDelete,
  deleting,
}: {
  photo: SelfPhoto;
  employee: Employee;
  myUserId: number | null;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  const isMine =
    myUserId !== null && p.uploaded_by_user_id === myUserId;
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        background: "var(--bg-sunken)",
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
          src={`/api/employees/me/photos/${p.id}/image`}
          alt={`${p.angle} reference`}
          loading="lazy"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
        <span
          className={`pill ${
            p.approval_status === "approved"
              ? "pill-success"
              : p.approval_status === "pending"
                ? "pill-warning"
                : "pill-danger"
          }`}
          style={{
            position: "absolute",
            top: 6,
            insetInlineStart: 6,
            fontSize: 10.5,
          }}
        >
          {t(`myProfile.status.${p.approval_status}`, {
            defaultValue:
              p.approval_status === "approved"
                ? "Approved"
                : p.approval_status === "pending"
                  ? "Pending"
                  : "Rejected",
          }) as string}
        </span>
      </div>
      <div
        style={{
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <div>
          <div className="text-xs" style={{ fontWeight: 500 }}>
            {t(`employees.photos.angle.${p.angle}`, {
              defaultValue: p.angle[0]!.toUpperCase() + p.angle.slice(1),
            }) as string}
          </div>
          <div className="text-xs text-dim">
            {isMine
              ? (t("myProfile.uploader.self", {
                  defaultValue: "by you",
                }) as string)
              : (t("myProfile.uploader.operator", {
                  defaultValue: "by HR/Admin",
                }) as string)}
          </div>
        </div>
        {isMine && (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={onDelete}
            disabled={deleting}
            aria-label="Delete photo"
            title={t("myProfile.deleteBtn", {
              defaultValue: "Delete",
            }) as string}
          >
            <Icon name="trash" size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
