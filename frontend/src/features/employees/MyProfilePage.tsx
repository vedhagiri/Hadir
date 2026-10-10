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
import { validateReferencePhotos } from "../../util/photoValidation";
import type { Employee, PhotoAngle } from "./types";
import { SkeletonGrid, SkeletonPanel } from "../../components/Skeleton";
import { EmptyPanel } from "../../components/ListPageUi";
import { avatarBg, initials } from "./EmployeesPage";
import { Banner, DotPill, FormGrid, LoadErrorPanel, Section } from "./peopleUi";

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
        <SkeletonPanel lines={5} />
      )}

      {profile.isError && (
        <div className="card">
          {profile.error instanceof ApiError && profile.error.status === 404 ? (
            <EmptyPanel
              tone="warning"
              icon={<Icon name="user" size={30} />}
              title={t("myProfile.noLinkTitle", {
                defaultValue: "No employee record linked",
              }) as string}
              body={t("myProfile.noLink", {
                defaultValue:
                  "Your account isn't linked to an employee record yet. Ask an Admin or HR to wire your email to an employee row.",
              }) as string}
            />
          ) : (
            <LoadErrorPanel
              title={t("myProfile.loadFailed", {
                defaultValue: "Could not load your profile.",
              }) as string}
              body={t("myProfile.loadFailedBody", {
                defaultValue: "Check your connection and try again.",
              }) as string}
              onRetry={() => void profile.refetch()}
            />
          )}
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
  // BUG-035 — employees can now self-edit phone + designation.
  // Other fields stay HR/Admin-managed (the panel surfaces a hint).
  const [editing, setEditing] = useState(false);
  const [draftPhone, setDraftPhone] = useState(e.phone ?? "");
  const [draftDesignation, setDraftDesignation] = useState(e.designation ?? "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const qc = useQueryClient();
  const onSaveProfile = async () => {
    setSavingProfile(true);
    setProfileError(null);
    try {
      await api<Employee>("/api/employees/me", {
        method: "PATCH",
        body: {
          phone: draftPhone.trim() || null,
          designation: draftDesignation.trim() || null,
        },
      });
      qc.invalidateQueries({ queryKey: ["employees", "me"] });
      setEditing(false);
    } catch (err) {
      const detail =
        err instanceof ApiError
          ? typeof err.body === "object" &&
            err.body !== null &&
            "detail" in (err.body as Record<string, unknown>)
            ? String(
                (err.body as { detail: unknown }).detail ??
                  (t("myProfile.errSaveStatus", { status: err.status }) as string),
              )
            : (t("myProfile.errSaveStatus", { status: err.status }) as string)
          : (t("myProfile.errSaveGeneric") as string);
      setProfileError(detail);
    } finally {
      setSavingProfile(false);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-body">
        <div className="pp-profile-head" style={{ marginBottom: 18 }}>
          <div className="pp-drawer-identity">
            <div className="avatar pp-avatar pp-avatar-lg" aria-hidden style={{ background: avatarBg(e.full_name) }}>
              {initials(e.full_name)}
            </div>
            <div className="pp-drawer-identity-text">
              <h3 className="card-title" style={{ margin: 0, fontSize: 17 }}>
                {e.full_name}
              </h3>
              <div className="pp-profile-meta">
                <span className="mono">{e.employee_code}</span>
                <span aria-hidden>·</span>
                <span>{e.designation ?? e.department.name}</span>
                <DotPill tone={e.status === "active" ? "success" : "neutral"}>
                  {t(`employees.statusValue.${e.status}`) as string}
                </DotPill>
              </div>
            </div>
          </div>
          {!editing ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraftPhone(e.phone ?? "");
                setDraftDesignation(e.designation ?? "");
                setEditing(true);
                setProfileError(null);
              }}
            >
              <Icon name="edit" size={11} /> {t("myProfile.edit") as string}
            </button>
          ) : (
            <div className="pp-head-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setEditing(false);
                  setProfileError(null);
                }}
                disabled={savingProfile}
              >
                {t("myProfile.cancel") as string}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={onSaveProfile}
                disabled={savingProfile}
              >
                {savingProfile
                  ? (t("myProfile.saving") as string)
                  : (t("myProfile.save") as string)}
              </button>
            </div>
          )}
        </div>
        {editing && (
          <div className="pp-edit-panel">
            <FormGrid cols={2}>
              <div className="field">
                <label className="field-label" htmlFor="pp-profile-designation">
                  {t("employees.field.designation", { defaultValue: "Designation" }) as string}
                </label>
                <input
                  id="pp-profile-designation"
                  className="input"
                  type="text"
                  value={draftDesignation}
                  onChange={(ev) => setDraftDesignation(ev.target.value)}
                  maxLength={80}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="pp-profile-phone">
                  {t("employees.field.phone", { defaultValue: "Phone" }) as string}
                </label>
                <input
                  id="pp-profile-phone"
                  className="input"
                  type="tel"
                  value={draftPhone}
                  onChange={(ev) =>
                    setDraftPhone(ev.target.value.replace(/[^\d+\-\s]/g, ""))
                  }
                  maxLength={30}
                  inputMode="tel"
                />
              </div>
            </FormGrid>
            {profileError && <div className="pp-inline-error">{profileError}</div>}
            <div className="pp-hint">{t("myProfile.editHint") as string}</div>
          </div>
        )}
        <Section title={t("myProfile.facts", { defaultValue: "Profile" }) as string}>
          <div className="pp-fact-tiles">
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
        </Section>
      </div>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="pp-fact-tile-label">{label}</div>
      <div className={`pp-fact-tile-value${mono ? " mono" : ""}`}>{value}</div>
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
    const currentCount = photos.length;
    const { valid, errors } = validateReferencePhotos(
      Array.from(files),
      currentCount,
    );
    for (const msg of errors) toast.error(msg);
    if (valid.length === 0) {
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("angle", angle);
      for (const f of valid) fd.append("files", f);
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
    <div className="card">
      <div className="card-head pp-profile-head">
        <div>
          <h3 className="card-title">
            {t("myProfile.photos", {
              defaultValue: "Reference photos",
            }) as string}
          </h3>
          <div className="card-sub">
            {t("myProfile.photosHint", {
              defaultValue:
                "Front-facing photos work best. Each upload is reviewed by HR/Admin before face detection picks it up.",
            }) as string}
          </div>
        </div>
        <div className="pp-head-actions">
          <select
            className="select"
            value={angle}
            onChange={(e) => setAngle(e.target.value as PhotoAngle)}
            disabled={uploading}
            aria-label={t("myProfile.angleAria") as string}
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
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
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

      <div className="card-body">
        {pendingCount > 0 && (
          <Banner tone="warning" role="status">
            {t("myProfile.pendingBanner", {
              count: pendingCount,
              defaultValue:
                pendingCount === 1
                  ? "1 photo waiting for HR/Admin approval."
                  : `${pendingCount} photos waiting for HR/Admin approval.`,
            }) as string}
          </Banner>
        )}

        {loading && <SkeletonGrid count={4} minWidth={180} />}

        {!loading && photos.length === 0 && (
          <div className="pp-dashed">
            <EmptyPanel
              tone="accent"
              icon={<Icon name="camera" size={30} />}
              title={t("myProfile.noPhotosTitle", {
                defaultValue: "Add your first reference photo",
              }) as string}
              body={t("myProfile.noPhotos", {
                defaultValue:
                  "No reference photos yet. Click Upload to add one.",
              }) as string}
              actions={
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  <Icon name="upload" size={12} />
                  {t("myProfile.uploadBtn", { defaultValue: "Upload photo" }) as string}
                </button>
              }
            />
          </div>
        )}

        {photos.length > 0 && (
          <div className="pp-photo-grid">
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
    <div className="pp-tile">
      <div className="pp-tile-img">
        <img
          src={`/api/employees/me/photos/${p.id}/image`}
          alt={`${p.angle} reference`}
          loading="lazy"
        />
        <span
          className={`pill pp-tile-badge ${
            p.approval_status === "approved"
              ? "pill-success"
              : p.approval_status === "pending"
                ? "pill-warning"
                : "pill-danger"
          }`}
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
      <div className="pp-tile-foot">
        <div>
          <div className="text-xs" style={{ fontWeight: 600 }}>
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
            className="btn btn-sm btn-ghost"
            onClick={onDelete}
            disabled={deleting}
            aria-label={t("myProfile.deletePhotoAria") as string}
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
