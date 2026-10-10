// /my-profile — Employee self-service. Two-column layout: a sticky
// profile card + "face recognition readiness" panel on the start side,
// and "Your details" (phone + designation self-editable, BUG-035) +
// "Reference photos" (collapsible upload panel + gallery with
// provenance + approval-status pills) on the end side. Self-uploaded
// photos can be deleted; HR/Admin uploads (and legacy NULL-uploader
// rows) render but show no trash icon.
//
// Backend surface:
// * GET  /api/employees/me            — read-only profile fact set
// * PATCH /api/employees/me           — phone + designation only
// * GET  /api/employees/me/photos     — list of own photos with
//                                       uploaded_by_user_id +
//                                       approval_status fields
// * POST /api/employees/me/photos     — upload (lands as 'pending'
//                                       until Admin/HR approves)
// * GET  /api/employees/me/photos/{id}/image — decrypted bytes
// * DELETE /api/employees/me/photos/{id}     — refuses 403 when
//                                              uploader != self

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { ModalShell } from "../../components/DrawerShell";
import { Field, FormFooter, FormHeader } from "../../components/FormKit";
import { EmptyPanel } from "../../components/ListPageUi";
import { SkeletonLine, SkeletonLines } from "../../components/Skeleton";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import { useTenantDateTime } from "../../util/datetime";
import { MAX_REFERENCE_PHOTOS, validateReferencePhotos } from "../../util/photoValidation";
import { avatarBg, initials } from "./EmployeesPage";
import { primaryRoleFromCodes, rolePillClass } from "./employeeProfileTabs";
import { PhotoCard, PhotoViewer, PhotoViewerFact } from "./PhotoViewer";
import { Banner, DotPill, LoadErrorPanel } from "./peopleUi";
import type { Employee, PhotoAngle } from "./types";

const ANGLES: PhotoAngle[] = ["front", "left", "right", "other"];
/** Approved photos we recommend for reliable recognition. */
const RECOMMENDED_PHOTOS = 4;

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

const selfPhotoUrl = (id: number) => `/api/employees/me/photos/${id}/image`;

/** Small stroke icons the shared Icon set doesn't carry. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
const PHONE_PATH = (
  <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
);
const ORG_PATH = (
  <>
    <path d="M4 21V5l8-2v18M12 8h8v13M4 21h16" />
    <path d="M7.5 8h1M7.5 12h1M7.5 16h1M15.5 12h1M15.5 16h1" />
  </>
);

function useAngleLabel() {
  const { t } = useTranslation();
  return (a: PhotoAngle) =>
    t(`employees.photos.angles.${a}`, {
      defaultValue: a[0]!.toUpperCase() + a.slice(1),
    }) as string;
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

  const photoItems = photos.data?.items ?? [];

  return (
    <div className="pp-me">
      <div className="page-header pp-me-page-header">
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

      {profile.isLoading && <ProfileSkeleton />}

      {profile.isError && (
        <div className="card pp-me-state">
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
        <div className="pp-me-layout">
          <aside className="pp-me-side">
            <ProfileCard employee={profile.data} photos={photoItems} />
            <ReadinessCard
              photos={photoItems}
              loading={photos.isLoading}
              failed={photos.isError}
            />
          </aside>
          <div className="pp-me-main">
            <DetailsCard employee={profile.data} />
            <PhotosCard
              photos={photoItems}
              loading={photos.isLoading}
              loadError={photos.isError}
              onRetry={() => void photos.refetch()}
              myUserId={myUserId}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ProfileSkeleton() {
  return (
    <div className="pp-me-layout" aria-busy="true">
      <aside className="pp-me-side">
        <div className="card pp-me-profile">
          <span className="sk pp-me-avatar" aria-hidden />
          <SkeletonLine width={180} height={20} />
          <SkeletonLine width={120} height={12} />
          <div className="pp-me-skel-block">
            <SkeletonLines lines={5} />
          </div>
        </div>
        <div className="card pp-me-panel">
          <SkeletonLines lines={4} />
        </div>
      </aside>
      <div className="pp-me-main">
        <div className="card pp-me-panel">
          <SkeletonLine width={140} height={16} />
          <div className="pp-me-skel-block">
            <SkeletonLines lines={6} />
          </div>
        </div>
        <div className="card pp-me-panel">
          <SkeletonLine width={160} height={16} />
          <div className="pp-pv-gallery pp-me-skel-block">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="sk pp-pv-card-skel" aria-hidden />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start column — profile card + readiness
// ---------------------------------------------------------------------------

function MyAvatar({ employee, photos }: { employee: Employee; photos: SelfPhoto[] }) {
  // Initials render immediately; the approved photo fades in once it
  // has actually loaded. On error the initials simply stay.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const approved = photos.filter((p) => p.approval_status === "approved");
  const photo = approved.find((p) => p.angle === "front") ?? approved[0];
  const src = photo ? selfPhotoUrl(photo.id) : null;
  const showPhoto = src !== null && loadedSrc === src && failedSrc !== src;
  return (
    <span className="pp-me-avatar" aria-hidden>
      <span className="pp-me-avatar-initials" style={{ background: avatarBg(employee.full_name) }}>
        {initials(employee.full_name)}
      </span>
      {src && failedSrc !== src && (
        <img
          key={src}
          className={`pp-me-avatar-img${showPhoto ? " is-loaded" : ""}`}
          src={src}
          alt=""
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
      )}
    </span>
  );
}

function ProfileCard({ employee: e, photos }: { employee: Employee; photos: SelfPhoto[] }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const role = primaryRoleFromCodes(e.role_codes ?? []);
  return (
    <section className="card pp-me-profile">
      <MyAvatar employee={e} photos={photos} />
      <h2 className="pp-me-name">{e.full_name}</h2>
      <div className="pp-me-pills">
        {role && (
          <span className={`pill ${rolePillClass(role)}`}>
            {t(`role.${role}`, { defaultValue: role }) as string}
          </span>
        )}
        <DotPill tone={e.status === "active" ? "success" : "neutral"}>
          {t(`employees.statusValue.${e.status}`, { defaultValue: e.status }) as string}
        </DotPill>
      </div>
      <div className="pp-me-sub">
        <span className="mono">{e.employee_code}</span>
        {e.designation && (
          <>
            <span aria-hidden className="pp-me-dot">·</span>
            <span>{e.designation}</span>
          </>
        )}
      </div>
      <ul className="pp-me-facts">
        <ProfileFact icon={<Glyph>{ORG_PATH}</Glyph>} label={t("employees.field.department", { defaultValue: "Department" }) as string}>
          {e.department.name}
        </ProfileFact>
        <ProfileFact icon={<Icon name="user" size={14} />} label={t("employees.field.reportsTo", { defaultValue: "Reports to" }) as string}>
          {e.reports_to_full_name || null}
        </ProfileFact>
        <ProfileFact icon={<Icon name="mail" size={14} />} label={t("employees.field.email", { defaultValue: "Email" }) as string}>
          {e.email || null}
        </ProfileFact>
        <ProfileFact icon={<Glyph>{PHONE_PATH}</Glyph>} label={t("employees.field.phone", { defaultValue: "Phone" }) as string}>
          {e.phone ? <span className="mono">{e.phone}</span> : null}
        </ProfileFact>
        <ProfileFact icon={<Icon name="calendar" size={14} />} label={t("myProfile.joined", { defaultValue: "Joined" }) as string}>
          {e.joining_date ? dt.formatLocalDate(e.joining_date) : null}
        </ProfileFact>
      </ul>
    </section>
  );
}

function ProfileFact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <li className="pp-me-fact">
      <span className="pp-me-fact-icon" aria-hidden>
        {icon}
      </span>
      <span className="pp-me-fact-text">
        <span className="pp-me-fact-label">{label}</span>
        <span className="pp-me-fact-value">{children ?? <span className="text-dim">—</span>}</span>
      </span>
    </li>
  );
}

type Coverage = "approved" | "pending" | "none";

function ReadinessCard({
  photos,
  loading,
  failed,
}: {
  photos: SelfPhoto[];
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const angleLabel = useAngleLabel();

  const approved = photos.filter((p) => p.approval_status === "approved").length;
  const pending = photos.filter((p) => p.approval_status === "pending").length;
  const coverage = (a: PhotoAngle): Coverage =>
    photos.some((p) => p.angle === a && p.approval_status === "approved")
      ? "approved"
      : photos.some((p) => p.angle === a && p.approval_status === "pending")
        ? "pending"
        : "none";

  // One plain-language next step, most important first.
  const missing = (["front", "left", "right"] as PhotoAngle[]).filter((a) => coverage(a) === "none");
  let tone: "success" | "warning" | "info" = "info";
  let step: string;
  if (photos.length === 0) {
    step = t("myProfile.next.first", {
      defaultValue: "Upload a clear front-facing photo so cameras can recognise you.",
    }) as string;
  } else if (missing.length > 0) {
    const names = missing.map(angleLabel);
    const list =
      names.length === 1
        ? names[0]!
        : `${names.slice(0, -1).join(", ")} ${t("myProfile.next.and", { defaultValue: "and" }) as string} ${names[names.length - 1]!}`;
    step = t("myProfile.next.addAngles", {
      defaultValue: "Add a {{angles}} photo to improve recognition.",
      angles: list,
    }) as string;
  } else if (pending > 0) {
    tone = "warning";
    step = t("myProfile.next.waiting", {
      count: pending,
      defaultValue:
        pending === 1
          ? "1 photo is waiting for HR approval."
          : `${pending} photos are waiting for HR approval.`,
    }) as string;
  } else if (approved < RECOMMENDED_PHOTOS) {
    step = t("myProfile.next.more", {
      count: RECOMMENDED_PHOTOS - approved,
      defaultValue:
        RECOMMENDED_PHOTOS - approved === 1
          ? "Add 1 more photo to reach the recommended {{max}}."
          : "Add {{count}} more photos to reach the recommended {{max}}.",
      max: RECOMMENDED_PHOTOS,
    }) as string;
  } else {
    tone = "success";
    step = t("myProfile.next.done", {
      count: approved,
      defaultValue: "You're all set — {{count}} approved photos.",
    }) as string;
  }

  const ratio = Math.min(approved / RECOMMENDED_PHOTOS, 1);
  const R = 26;
  const C = 2 * Math.PI * R;

  return (
    <section className="card pp-me-panel pp-me-ready">
      <h3 className="pp-me-card-title">
        {t("myProfile.readiness.title", { defaultValue: "Face recognition readiness" }) as string}
      </h3>
      {loading ? (
        <SkeletonLines lines={3} />
      ) : failed ? (
        <p className="pp-me-muted">
          {t("myProfile.photosLoadFailed", { defaultValue: "Could not load your photos." }) as string}
        </p>
      ) : (
        <>
          <div className="pp-me-ready-top">
            <svg
              className={`pp-me-ring${ratio >= 1 ? " is-full" : ""}`}
              width="64"
              height="64"
              viewBox="0 0 64 64"
              role="img"
              aria-label={t("myProfile.readiness.ringAria", {
                defaultValue: "{{count}} of {{max}} recommended photos approved",
                count: approved,
                max: RECOMMENDED_PHOTOS,
              }) as string}
            >
              <circle className="pp-me-ring-track" cx="32" cy="32" r={R} />
              <circle
                className="pp-me-ring-fill"
                cx="32"
                cy="32"
                r={R}
                strokeDasharray={C}
                strokeDashoffset={C * (1 - ratio)}
              />
              <text x="32" y="36" textAnchor="middle" className="pp-me-ring-text">
                {approved}/{RECOMMENDED_PHOTOS}
              </text>
            </svg>
            <div className="pp-me-ready-copy">
              <div className="pp-me-ready-headline">
                {t("myProfile.readiness.approved", {
                  defaultValue: approved === 1 ? "1 approved photo" : "{{count}} approved photos",
                  count: approved,
                }) as string}
              </div>
              <div className="pp-me-muted">
                {t("myProfile.readiness.recommended", {
                  defaultValue: "{{max}} recommended",
                  max: RECOMMENDED_PHOTOS,
                }) as string}
              </div>
            </div>
          </div>
          <ul className="pp-me-cover" aria-label={t("myProfile.readiness.coverage", { defaultValue: "Angle coverage" }) as string}>
            {ANGLES.map((a) => {
              const c = coverage(a);
              const stateText =
                c === "approved"
                  ? (t("myProfile.status.approved", { defaultValue: "Approved" }) as string)
                  : c === "pending"
                    ? (t("myProfile.status.pendingApproval", { defaultValue: "Pending approval" }) as string)
                    : (t("myProfile.readiness.none", { defaultValue: "No photo" }) as string);
              return (
                <li key={a} className={`pp-me-chip is-${c}`} title={stateText}>
                  <span aria-hidden className="pp-me-chip-mark">
                    {c === "approved" ? <Icon name="check" size={11} /> : c === "pending" ? <Icon name="clock" size={11} /> : "—"}
                  </span>
                  {angleLabel(a)}
                  <span className="pp-visually-hidden">: {stateText}</span>
                </li>
              );
            })}
          </ul>
          <p className={`pp-me-next tone-${tone}`}>
            <Icon name={tone === "success" ? "check" : tone === "warning" ? "clock" : "info"} size={14} />
            <span>{step}</span>
          </p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// End column — details
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pp-me-dl-row">
      <dt>{label}</dt>
      <dd>{children ?? <span className="text-dim">—</span>}</dd>
    </div>
  );
}

function DetailsCard({ employee: e }: { employee: Employee }) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const role = primaryRoleFromCodes(e.role_codes ?? []);
  // BUG-035 — employees can self-edit phone + designation.
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

  const codeSuffix = (code: string) => <span className="mono text-xs text-dim"> ({code})</span>;
  const L = (key: string, def: string) => t(key, { defaultValue: def }) as string;

  return (
    <section className="card pp-me-panel">
      <div className="pp-me-card-head">
        <h3 className="pp-me-card-title">
          {t("myProfile.details", { defaultValue: "Your details" }) as string}
        </h3>
        {!editing && (
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
        )}
      </div>

      {editing && (
        <form
          className="pp-me-edit"
          onSubmit={(ev) => {
            ev.preventDefault();
            void onSaveProfile();
          }}
        >
          <div className="pp-me-edit-fields">
            <Field label={L("employees.field.designation", "Designation")} htmlFor="pp-profile-designation">
              <input
                id="pp-profile-designation"
                className="input"
                type="text"
                value={draftDesignation}
                onChange={(ev) => setDraftDesignation(ev.target.value)}
                maxLength={80}
                autoFocus
              />
            </Field>
            <Field
              label={L("employees.field.phone", "Phone")}
              htmlFor="pp-profile-phone"
              error={profileError ?? undefined}
            >
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
            </Field>
          </div>
          <div className="pp-me-edit-foot">
            <p className="pp-me-hint">
              <Icon name="info" size={12} />
              {t("myProfile.editHint") as string}
            </p>
            <div className="pp-me-edit-actions">
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
              <button type="submit" className="btn btn-sm btn-primary" disabled={savingProfile}>
                {savingProfile
                  ? (t("myProfile.saving") as string)
                  : (t("myProfile.save") as string)}
              </button>
            </div>
          </div>
        </form>
      )}

      <dl className="pp-me-dl">
        <DetailRow label={L("employees.field.code", "Employee ID")}>
          <span className="mono">{e.employee_code}</span>
        </DetailRow>
        <DetailRow label={L("employees.field.fullName", "Full name")}>{e.full_name}</DetailRow>
        {!editing && (
          <DetailRow label={L("employees.field.designation", "Designation")}>{e.designation || null}</DetailRow>
        )}
        <DetailRow label={L("employees.field.email", "Email")}>{e.email || null}</DetailRow>
        {!editing && (
          <DetailRow label={L("employees.field.phone", "Phone")}>
            {e.phone ? <span className="mono">{e.phone}</span> : null}
          </DetailRow>
        )}
        <DetailRow label={L("employees.field.department", "Department")}>
          {e.department.name}
          {codeSuffix(e.department.code)}
        </DetailRow>
        <DetailRow label={L("employees.field.division", "Division")}>
          {e.division ? (
            <>
              {e.division.name}
              {codeSuffix(e.division.code)}
            </>
          ) : null}
        </DetailRow>
        <DetailRow label={L("employees.field.section", "Section")}>
          {e.section ? (
            <>
              {e.section.name}
              {codeSuffix(e.section.code)}
            </>
          ) : null}
        </DetailRow>
        <DetailRow label={L("employees.field.reportsTo", "Reports to")}>{e.reports_to_full_name || null}</DetailRow>
        <DetailRow label={L("employees.field.joinDate", "Join date")}>
          {e.joining_date ? dt.formatLocalDate(e.joining_date) : null}
        </DetailRow>
        {e.relieving_date && (
          <DetailRow label={L("employees.field.relievingDate", "Relieving date")}>
            {dt.formatLocalDate(e.relieving_date)}
          </DetailRow>
        )}
        <DetailRow label={L("employees.col.role", "Role")}>
          {role ? (
            <span className={`pill ${rolePillClass(role)}`}>{t(`role.${role}`, { defaultValue: role }) as string}</span>
          ) : null}
        </DetailRow>
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// End column — reference photos (collapsible upload + gallery)
// ---------------------------------------------------------------------------

function PhotosCard({
  photos,
  loading,
  loadError,
  onRetry,
  myUserId,
}: {
  photos: SelfPhoto[];
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
  myUserId: number | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const angleLabel = useAngleLabel();
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [viewIndex, setViewIndex] = useState<number | null>(null);

  const pendingCount = useMemo(
    () => photos.filter((p) => p.approval_status === "pending").length,
    [photos],
  );
  const approvedCount = useMemo(
    () => photos.filter((p) => p.approval_status === "approved").length,
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

  /** Same POST + toasts as before; files are already validated by the
   *  modal. Resolves true on success so the modal can close. */
  async function onUpload(valid: File[], angle: PhotoAngle): Promise<boolean> {
    if (valid.length === 0) return false;
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
        return false;
      }
      qc.invalidateQueries({ queryKey: ["employees", "me", "photos"] });
      toast.success(
        t("myProfile.uploadQueued", {
          defaultValue: "Uploaded — pending HR/Admin approval",
        }) as string,
      );
      return true;
    } catch {
      toast.error(
        t("myProfile.uploadNetwork", {
          defaultValue: "Network error",
        }) as string,
      );
      return false;
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="card pp-me-panel pp-me-photos">
      <div className="pp-me-card-head">
        <div className="pp-me-photos-title">
          <h3 className="pp-me-card-title">
            {t("myProfile.photos", {
              defaultValue: "Reference photos",
            }) as string}
          </h3>
          <p className="pp-me-muted">
            {!loading && !loadError
              ? (t("myProfile.photoCounts", {
                  defaultValue: "{{count}} / {{max}} photos · {{approved}} approved",
                  count: photos.length,
                  max: MAX_REFERENCE_PHOTOS,
                  approved: approvedCount,
                }) as string) + " — "
              : ""}
            {t("myProfile.photosExplain", {
              defaultValue:
                "Photos you upload are used for face recognition after HR/Admin approves them.",
            }) as string}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          aria-haspopup="dialog"
          aria-expanded={showUpload}
          onClick={() => setShowUpload(true)}
          disabled={uploading}
        >
          <Icon name="upload" size={13} />
          {uploading
            ? (t("myProfile.uploading", { defaultValue: "Uploading…" }) as string)
            : (t("myProfile.uploadBtn", { defaultValue: "Upload photo" }) as string)}
        </button>
      </div>

      {showUpload && (
        <UploadModal
          existingCount={photos.length}
          uploading={uploading}
          angleLabel={angleLabel}
          onClose={() => setShowUpload(false)}
          onSubmit={async (files, angle) => {
            if (await onUpload(files, angle)) setShowUpload(false);
          }}
        />
      )}


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

      {loading && (
        <div className="pp-pv-gallery">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="sk pp-pv-card-skel" aria-hidden />
          ))}
        </div>
      )}

      {!loading && loadError && (
        <LoadErrorPanel
          title={t("myProfile.photosLoadFailed", {
            defaultValue: "Could not load your photos.",
          }) as string}
          onRetry={onRetry}
        />
      )}

      {!loading && !loadError && photos.length === 0 && (
        <div className="pp-me-empty">
          <Icon name="camera" size={16} />
          {t("myProfile.noPhotosUpload", {
            defaultValue:
              "No reference photos yet — use Upload photo to add a clear front-facing one.",
          }) as string}
        </div>
      )}

      {photos.length > 0 && (
        <ul className="pp-pv-gallery">
          {photos.map((p, i) => {
            const isMine = myUserId !== null && p.uploaded_by_user_id === myUserId;
            const { pill, text } = statusMeta(t, p.approval_status);
            return (
              <PhotoCard
                key={p.id}
                src={selfPhotoUrl(p.id)}
                alt={`${p.angle} reference`}
                openLabel={t("myProfile.viewer.open", {
                  defaultValue: "Open {{angle}} photo",
                  angle: angleLabel(p.angle),
                }) as string}
                onOpen={() => setViewIndex(i)}
                status={p.approval_status}
                statusPill={<span className={`pill ${pill}`}>{text}</span>}
                title={angleLabel(p.angle)}
                meta={uploaderText(t, isMine)}
                trailing={
                  isMine ? (
                    <button
                      type="button"
                      className="icon-btn pp-pv-card-del"
                      onClick={() => deleteMutation.mutate(p.id)}
                      disabled={deleteMutation.isPending && deleteMutation.variables === p.id}
                      aria-label={t("myProfile.deletePhotoAria") as string}
                      title={t("myProfile.deleteBtn", { defaultValue: "Delete" }) as string}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      )}

      {viewIndex !== null && photos.length > 0 && (
        <PhotoViewer
          photos={photos}
          index={Math.min(viewIndex, photos.length - 1)}
          onIndex={setViewIndex}
          onClose={() => setViewIndex(null)}
          title={t("myProfile.photos", { defaultValue: "Reference photos" }) as string}
          getKey={(p) => p.id}
          getSrc={(p) => selfPhotoUrl(p.id)}
          getAlt={(p) => `${p.angle} reference`}
          getLabel={(p) =>
            t("myProfile.viewer.open", {
              defaultValue: "Open {{angle}} photo",
              angle: angleLabel(p.angle),
            }) as string
          }
          getStatus={(p) => p.approval_status}
          renderInfo={(p) => {
            const { pill, text } = statusMeta(t, p.approval_status);
            const isMine = myUserId !== null && p.uploaded_by_user_id === myUserId;
            return (
              <>
                <dl className="pp-pv-facts">
                  <PhotoViewerFact label={t("myProfile.angleAria", { defaultValue: "Angle" }) as string}>
                    {angleLabel(p.angle)}
                  </PhotoViewerFact>
                  <PhotoViewerFact label={t("employees.col.status", { defaultValue: "Status" }) as string}>
                    <span className={`pill ${pill}`}>{text}</span>
                  </PhotoViewerFact>
                  <PhotoViewerFact label={t("myProfile.viewer.uploadedBy", { defaultValue: "Uploaded" }) as string}>
                    {uploaderText(t, isMine)}
                  </PhotoViewerFact>
                </dl>
                <p className="pp-pv-help">{statusHelp(t, p.approval_status)}</p>
              </>
            );
          }}
          actions={(p) =>
            myUserId !== null && p.uploaded_by_user_id === myUserId ? (
              <button
                type="button"
                className="btn btn-sm pp-pv-danger"
                onClick={() => deleteMutation.mutate(p.id)}
                disabled={deleteMutation.isPending && deleteMutation.variables === p.id}
              >
                <Icon name="trash" size={12} />
                {t("myProfile.deleteBtn", { defaultValue: "Delete" }) as string}
              </button>
            ) : null
          }
        />
      )}
    </section>
  );
}

/** Upload pop-up: pick the angle, add one or more photos (click, drop,
 *  or keyboard), preview + remove them, then Upload. Validation uses the
 *  shared reference-photo rules against existing + already-staged files. */
function UploadModal({
  existingCount,
  uploading,
  angleLabel,
  onClose,
  onSubmit,
}: {
  existingCount: number;
  uploading: boolean;
  angleLabel: (a: PhotoAngle) => string;
  onClose: () => void;
  onSubmit: (files: File[], angle: PhotoAngle) => Promise<void>;
}) {
  const { t } = useTranslation();
  const titleId = "pp-me-upload-title";
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [angle, setAngle] = useState<PhotoAngle>("front");
  const [staged, setStaged] = useState<{ file: File; url: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  // Revoke preview URLs when the modal unmounts.
  useEffect(
    () => () => {
      for (const s of stagedRef.current) URL.revokeObjectURL(s.url);
    },
    [],
  );

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const { valid, errors } = validateReferencePhotos(
      Array.from(files),
      existingCount + staged.length,
    );
    for (const msg of errors) toast.error(msg);
    if (valid.length > 0) {
      setStaged((prev) => [...prev, ...valid.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    }
    if (fileRef.current) fileRef.current.value = "";
  };
  const removeAt = (i: number) => {
    setStaged((prev) => {
      const next = [...prev];
      const [gone] = next.splice(i, 1);
      if (gone) URL.revokeObjectURL(gone.url);
      return next;
    });
  };

  const openPicker = () => {
    if (!uploading) fileRef.current?.click();
  };
  const onDropzoneKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      openPicker();
    }
  };
  const onDragOver = (ev: DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    if (!uploading) setDragOver(true);
  };
  const onDrop = (ev: DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setDragOver(false);
    if (uploading) return;
    addFiles(ev.dataTransfer.files);
  };

  const remaining = Math.max(MAX_REFERENCE_PHOTOS - existingCount - staged.length, 0);
  const tips = [
    t("myProfile.tips.light", { defaultValue: "Good, even lighting" }) as string,
    t("myProfile.tips.face", { defaultValue: "Face the camera" }) as string,
    t("myProfile.tips.clear", { defaultValue: "No sunglasses or mask" }) as string,
  ];

  return (
    <ModalShell onClose={onClose}>
      <div className="pp-me-modal-host">
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="modal fk-modal pp-me-upmodal"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!uploading && staged.length > 0) void onSubmit(staged.map((s) => s.file), angle);
          }}
        >
          <FormHeader
            icon={<Icon name="camera" size={18} />}
            title={t("myProfile.upload.title", { defaultValue: "Upload reference photo" }) as string}
            subtitle={t("myProfile.photosExplain", {
              defaultValue: "Photos you upload are used for face recognition after HR/Admin approves them.",
            }) as string}
            {...(uploading ? {} : { onClose })}
            titleId={titleId}
          />
          <div className="fk-body pp-me-upmodal-body">
            <div className="pp-me-upmodal-row">
              <span className="pp-me-label" id="pp-me-angle-label">
                {t("myProfile.angleAria", { defaultValue: "Angle" }) as string}
              </span>
              <div className="seg pp-me-seg" role="group" aria-labelledby="pp-me-angle-label">
                {ANGLES.map((a) => {
                  const active = a === angle;
                  return (
                    <button
                      key={a}
                      type="button"
                      className={`seg-btn${active ? " active" : ""}`}
                      aria-pressed={active}
                      onClick={() => setAngle(a)}
                      disabled={uploading}
                    >
                      {angleLabel(a)}
                    </button>
                  );
                })}
              </div>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              multiple
              className="pp-me-file"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => addFiles(e.target.files)}
            />
            <div
              className={`pp-me-dropzone${dragOver ? " is-over" : ""}${uploading ? " is-busy" : ""}`}
              role="button"
              tabIndex={uploading ? -1 : 0}
              aria-disabled={uploading}
              aria-label={t("myProfile.upload.dropzoneAria", {
                defaultValue: "Choose {{angle}} photos",
                angle: angleLabel(angle),
              }) as string}
              onClick={openPicker}
              onKeyDown={onDropzoneKey}
              onDragOver={onDragOver}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <span className="pp-me-dropzone-icon" aria-hidden>
                <Icon name="upload" size={18} />
              </span>
              <span className="pp-me-dropzone-title">
                {t("myProfile.dropTitle", {
                  defaultValue: "Drop photos here or click to browse",
                }) as string}
              </span>
              <span className="pp-me-dropzone-hint">
                {t("myProfile.upload.hint", {
                  defaultValue: "JPG, PNG or WEBP · up to 10 MB each · {{remaining}} more allowed",
                  remaining,
                }) as string}
              </span>
            </div>

            {staged.length > 0 && (
              <ul className="pp-me-staged" aria-label={t("myProfile.upload.selected", { defaultValue: "Selected photos" }) as string}>
                {staged.map((s, i) => (
                  <li key={s.url} className="pp-me-staged-item">
                    <img src={s.url} alt="" />
                    <span className="pp-me-staged-tag">{angleLabel(angle)}</span>
                    <button
                      type="button"
                      className="pp-me-staged-del"
                      onClick={() => removeAt(i)}
                      disabled={uploading}
                      aria-label={t("myProfile.upload.remove", {
                        defaultValue: "Remove {{name}}",
                        name: s.file.name,
                      }) as string}
                      title={s.file.name}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <ul className="pp-me-tips">
              {tips.map((tip) => (
                <li key={tip}>
                  <Icon name="check" size={12} />
                  {tip}
                </li>
              ))}
            </ul>
          </div>
          <FormFooter
            onCancel={onClose}
            showRequiredNote={false}
            note={
              <span className="pp-me-muted">
                {t("myProfile.upload.reviewNote", {
                  defaultValue: "HR/Admin reviews each photo before it's used.",
                }) as string}
              </span>
            }
            submitting={uploading}
            submittingLabel={t("myProfile.uploading", { defaultValue: "Uploading…" }) as string}
            canSubmit={staged.length > 0}
            submitLabel={
              staged.length > 0
                ? (t("myProfile.upload.submitN", {
                    count: staged.length,
                    defaultValue: staged.length === 1 ? "Upload 1 photo" : `Upload ${staged.length} photos`,
                  }) as string)
                : (t("myProfile.uploadBtn", { defaultValue: "Upload photo" }) as string)
            }
          />
        </form>
      </div>
    </ModalShell>
  );
}

function statusMeta(t: TFunction, s: SelfPhoto["approval_status"]) {
  const pill = s === "approved" ? "pill-success" : s === "pending" ? "pill-warning" : "pill-danger";
  const text =
    s === "pending"
      ? (t("myProfile.status.pendingApproval", { defaultValue: "Pending approval" }) as string)
      : (t(`myProfile.status.${s}`, { defaultValue: s === "approved" ? "Approved" : "Rejected" }) as string);
  return { pill, text };
}

function uploaderText(t: TFunction, isMine: boolean): string {
  return isMine
    ? (t("myProfile.uploader.self", { defaultValue: "by you" }) as string)
    : (t("myProfile.uploader.operator", { defaultValue: "by HR/Admin" }) as string);
}

function statusHelp(t: TFunction, s: SelfPhoto["approval_status"]): string {
  return s === "approved"
    ? (t("myProfile.viewer.helpApproved", { defaultValue: "Used for face recognition." }) as string)
    : s === "pending"
      ? (t("myProfile.viewer.helpPending", { defaultValue: "Waiting for HR/Admin review — not used yet." }) as string)
      : (t("myProfile.viewer.helpRejected", { defaultValue: "Not used. Upload a clearer photo instead." }) as string);
}
