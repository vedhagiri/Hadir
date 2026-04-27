// P28.7 — full Add/Edit drawer.
//
// Modes:
//   - employeeId === null  → Add mode, every field editable.
//   - employeeId  > 0      → Edit mode, employee_code locked, identity
//                            + assignment + status + photos editable.
//
// Sections (in order):
//   1. Identity      — code (locked on edit), full name, designation,
//                      email, phone
//   2. Assignment    — department, reports_to (manager picker)
//   3. Lifecycle     — joining_date, relieving_date
//   4. Reference     — photo gallery + upload (only on edit; the row
//      photos          must exist before photos can attach to it)
//   5. Status        — Active toggle. When flipping to inactive an
//                      inline reason textarea is required.
//
// Pending-delete banner above the body when there's an open
// delete_request — HR sees inline approve/reject; Admin sees the
// override CTA. The delete-modal lives in DeleteConfirmModal.tsx.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { ApiError, api } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { primaryRole } from "../../types";
import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import {
  useCreateEmployee,
  useDecideDeleteRequest,
  useDeletePhoto,
  useEmployeeDetail,
  useEmployeePendingDeleteRequest,
  useEmployeePhotoUpload,
  useEmployeePhotos,
  useUpdateEmployee,
  useAdminOverrideDeleteRequest,
} from "./hooks";
import type { Employee, EmployeeWritePayload, PhotoAngle } from "./types";

const ANGLES: PhotoAngle[] = ["front", "left", "right", "other"];
const PILOT_DEPARTMENTS: { id: number; code: string; name: string }[] = [
  { id: 1, code: "ENG", name: "Engineering" },
  { id: 2, code: "OPS", name: "Operations" },
  { id: 3, code: "ADM", name: "Administration" },
];

interface ManagerOption {
  id: number;
  full_name: string;
  email: string;
}

interface ManagerListResponse {
  items: ManagerOption[];
}

interface Props {
  // ``null`` → Add mode; otherwise Edit mode for that id.
  employeeId: number | null;
  onClose: () => void;
  // Optional callback when a row is created/updated so the caller can
  // refresh the list selection. Defaults to a no-op.
  onSaved?: (employee: Employee) => void;
}

interface FormState {
  employee_code: string;
  full_name: string;
  email: string;
  designation: string;
  phone: string;
  reports_to_user_id: number | null;
  department_id: number;
  joining_date: string;
  relieving_date: string;
  status: "active" | "inactive";
  deactivation_reason: string;
}

function emptyForm(): FormState {
  return {
    employee_code: "",
    full_name: "",
    email: "",
    designation: "",
    phone: "",
    reports_to_user_id: null,
    department_id: 1,
    joining_date: "",
    relieving_date: "",
    status: "active",
    deactivation_reason: "",
  };
}

function fromEmployee(e: Employee): FormState {
  return {
    employee_code: e.employee_code,
    full_name: e.full_name,
    email: e.email ?? "",
    designation: e.designation ?? "",
    phone: e.phone ?? "",
    reports_to_user_id: e.reports_to_user_id ?? null,
    department_id: e.department.id,
    joining_date: e.joining_date ?? "",
    relieving_date: e.relieving_date ?? "",
    status: e.status,
    deactivation_reason: e.deactivation_reason ?? "",
  };
}

export function EmployeeDrawer({ employeeId, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const me = useMe();
  const role = me.data ? primaryRole(me.data.roles) : "Employee";
  const isAdmin = role === "Admin";
  const isHr = role === "HR";
  const isAddMode = employeeId === null;

  const detail = useEmployeeDetail(employeeId);
  const photos = useEmployeePhotos(employeeId);
  const pendingDelete = useEmployeePendingDeleteRequest(employeeId);
  const create = useCreateEmployee();
  const update = useUpdateEmployee();
  const decide = useDecideDeleteRequest();
  const adminOverride = useAdminOverrideDeleteRequest();
  const upload = useEmployeePhotoUpload();
  const deletePhoto = useDeletePhoto();

  // Manager picker — query users in the tenant. Cached for the drawer's
  // lifetime; the dropdown filters client-side via the search input.
  const managers = useQuery({
    queryKey: ["users", "tenant-list"],
    queryFn: () => api<ManagerListResponse>("/api/users?active_only=true"),
    staleTime: 5 * 60 * 1000,
  });

  const [form, setForm] = useState<FormState>(emptyForm());
  const [photoAngle, setPhotoAngle] = useState<PhotoAngle>("front");
  const [serverError, setServerError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideComment, setOverrideComment] = useState("");

  // Hydrate form when the detail loads (Edit mode).
  useEffect(() => {
    if (detail.data) {
      setForm(fromEmployee(detail.data));
    } else if (isAddMode) {
      setForm(emptyForm());
    }
  }, [detail.data, isAddMode]);

  const onField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((s) => ({ ...s, [key]: value }));

  const buildPayload = (): EmployeeWritePayload | null => {
    setServerError(null);
    if (isAddMode) {
      if (!form.employee_code.trim() || !form.full_name.trim()) {
        setServerError(t("employees.errors.codeAndNameRequired") as string);
        return null;
      }
    }
    if (form.status === "inactive") {
      const reason = form.deactivation_reason.trim();
      if (reason.length < 5) {
        setServerError(t("employees.errors.reasonRequired") as string);
        return null;
      }
    }
    if (
      form.joining_date &&
      form.relieving_date &&
      form.relieving_date < form.joining_date
    ) {
      setServerError(t("employees.errors.relievingBeforeJoining") as string);
      return null;
    }

    const payload: EmployeeWritePayload = {
      full_name: form.full_name.trim(),
      email: form.email.trim() || null,
      designation: form.designation.trim() || null,
      phone: form.phone.trim() || null,
      reports_to_user_id: form.reports_to_user_id ?? null,
      department_id: form.department_id,
      joining_date: form.joining_date || null,
      relieving_date: form.relieving_date || null,
      status: form.status,
    };
    if (isAddMode) {
      payload.employee_code = form.employee_code.trim();
    }
    if (form.status === "inactive") {
      payload.deactivation_reason = form.deactivation_reason.trim();
    }
    return payload;
  };

  const onSave = async () => {
    const payload = buildPayload();
    if (payload === null) return;
    try {
      if (isAddMode) {
        const created = await create.mutateAsync(payload);
        onSaved?.(created);
        toast.success(
          t("employees.toast.created", { name: created.full_name }) as string,
        );
      } else {
        const updated = await update.mutateAsync({
          employeeId: employeeId!,
          payload,
        });
        onSaved?.(updated);
        toast.success(
          t("employees.toast.updated", { name: updated.full_name }) as string,
        );
      }
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string })?.detail;
        const msg =
          typeof detail === "string" ? detail : `Error ${e.status}`;
        setServerError(msg);
        toast.error(msg);
      } else {
        setServerError("Could not save");
        toast.error("Could not save");
      }
    }
  };

  const onDecide = async (decision: "approve" | "reject", comment?: string) => {
    if (!pendingDelete.data || !employeeId) return;
    try {
      await decide.mutateAsync({
        employeeId,
        requestId: pendingDelete.data.id,
        decision,
        ...(comment !== undefined ? { comment } : {}),
      });
      // After approve, the employee row is gone — close the drawer.
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string })?.detail;
        setServerError(typeof detail === "string" ? detail : `Error ${e.status}`);
      }
    }
  };

  const onOverrideSubmit = async () => {
    if (!pendingDelete.data || !employeeId) return;
    if (overrideComment.trim().length < 10) {
      setServerError(t("employees.errors.overrideCommentMin") as string);
      return;
    }
    try {
      await adminOverride.mutateAsync({
        employeeId,
        requestId: pendingDelete.data.id,
        decision: "approve",
        comment: overrideComment.trim(),
      });
      setOverrideOpen(false);
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string })?.detail;
        setServerError(typeof detail === "string" ? detail : `Error ${e.status}`);
      }
    }
  };

  const isDifferentAdminFromRequester = useMemo(() => {
    if (!pendingDelete.data || !me.data) return false;
    return pendingDelete.data.requested_by !== me.data.id;
  }, [pendingDelete.data, me.data]);

  const showOverrideButton =
    isAdmin && !!pendingDelete.data && isDifferentAdminFromRequester;

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">
              {isAddMode
                ? (t("employees.drawer.addTitle") as string)
                : (t("employees.drawer.editTitle") as string)}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {isAddMode ? t("employees.drawer.newEmployee") : form.full_name || "—"}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close") as string}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="drawer-body">
          {/* Pending delete banner (Edit only) */}
          {!isAddMode && pendingDelete.data && (
            <div
              style={{
                background: "var(--warning-soft)",
                border: "1px solid var(--warning-border, var(--border))",
                borderRadius: "var(--radius-sm)",
                padding: "10px 12px",
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                {t("employees.delete.pendingBannerTitle") as string}
              </div>
              <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                {t("employees.delete.pendingBannerBody", {
                  name:
                    pendingDelete.data.requested_by_full_name ??
                    t("employees.delete.unknownActor"),
                  date: new Date(
                    pendingDelete.data.created_at,
                  ).toLocaleDateString(),
                }) as string}
              </div>
              <div
                className="text-xs"
                style={{ marginTop: 4, color: "var(--text-secondary)" }}
              >
                {t("employees.delete.reasonLabel")}: {pendingDelete.data.reason}
              </div>
              {isHr && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void onDecide("approve")}
                    disabled={decide.isPending}
                  >
                    {t("employees.delete.approve") as string}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const comment = window.prompt(
                        t("employees.delete.rejectPromptComment") as string,
                      );
                      if (comment && comment.trim().length >= 5) {
                        void onDecide("reject", comment.trim());
                      }
                    }}
                    disabled={decide.isPending}
                  >
                    {t("employees.delete.reject") as string}
                  </button>
                </div>
              )}
              {showOverrideButton && !overrideOpen && (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={() => setOverrideOpen(true)}
                >
                  {t("employees.delete.overrideAndApprove") as string}
                </button>
              )}
              {overrideOpen && (
                <div style={{ marginTop: 8 }}>
                  <textarea
                    placeholder={
                      t("employees.delete.overridePromptComment") as string
                    }
                    value={overrideComment}
                    onChange={(e) => setOverrideComment(e.target.value)}
                    rows={3}
                    style={{
                      width: "100%",
                      padding: 8,
                      fontSize: 12.5,
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg-elev)",
                    }}
                  />
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => void onOverrideSubmit()}
                      disabled={adminOverride.isPending}
                    >
                      {t("employees.delete.confirmOverride") as string}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setOverrideOpen(false);
                        setOverrideComment("");
                      }}
                    >
                      {t("common.cancel") as string}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Identity */}
          <SectionLabel>{t("employees.section.identity") as string}</SectionLabel>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
            <Field
              label={t("employees.field.code") as string}
              value={form.employee_code}
              onChange={(v) => onField("employee_code", v)}
              disabled={!isAddMode}
              mono
              required
            />
            <Field
              label={t("employees.field.fullName") as string}
              value={form.full_name}
              onChange={(v) => onField("full_name", v)}
              required
            />
            <Field
              label={t("employees.field.designation") as string}
              value={form.designation}
              onChange={(v) => onField("designation", v)}
              maxLength={80}
            />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
            <Field
              label={t("employees.field.email") as string}
              value={form.email}
              onChange={(v) => onField("email", v)}
              type="email"
            />
            <Field
              label={t("employees.field.phone") as string}
              value={form.phone}
              onChange={(v) => onField("phone", v)}
              maxLength={30}
            />
          </div>

          {/* Assignment */}
          <SectionLabel>{t("employees.section.assignment") as string}</SectionLabel>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
            <Select
              label={t("employees.field.department") as string}
              value={String(form.department_id)}
              onChange={(v) => onField("department_id", Number(v))}
              options={PILOT_DEPARTMENTS.map((d) => ({
                value: String(d.id),
                label: `${d.name} (${d.code})`,
              }))}
            />
            <Select
              label={t("employees.field.reportsTo") as string}
              value={form.reports_to_user_id === null ? "" : String(form.reports_to_user_id)}
              onChange={(v) =>
                onField("reports_to_user_id", v === "" ? null : Number(v))
              }
              options={[
                { value: "", label: t("employees.field.noManager") as string },
                ...((managers.data?.items ?? []).map((m) => ({
                  value: String(m.id),
                  label: `${m.full_name} · ${m.email}`,
                })) as { value: string; label: string }[]),
              ]}
            />
          </div>

          {/* Lifecycle dates */}
          <SectionLabel>{t("employees.section.lifecycle") as string}</SectionLabel>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
            <Field
              label={t("employees.field.joinDate") as string}
              value={form.joining_date}
              onChange={(v) => onField("joining_date", v)}
              type="date"
            />
            {(form.status === "active" || form.relieving_date) && (
              <Field
                label={t("employees.field.relievingDate") as string}
                value={form.relieving_date}
                onChange={(v) => onField("relieving_date", v)}
                type="date"
              />
            )}
          </div>

          {/* Reference photos (Edit only) */}
          {!isAddMode && (
            <>
              <SectionLabel>
                {t("employees.section.referencePhotos") as string}
              </SectionLabel>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(5, 1fr)",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                {(photos.data?.items ?? []).slice(0, 5).map((p) => (
                  <div
                    key={p.id}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "var(--bg-sunken)",
                      position: "relative",
                    }}
                  >
                    <img
                      src={`/api/employees/${employeeId}/photos/${p.id}/image`}
                      alt={p.angle}
                      style={{
                        display: "block",
                        width: "100%",
                        aspectRatio: "1 / 1",
                        objectFit: "cover",
                      }}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      style={{
                        position: "absolute",
                        top: 4,
                        insetInlineEnd: 4,
                        background: "rgba(0,0,0,0.4)",
                        color: "white",
                      }}
                      onClick={() =>
                        deletePhoto.mutate({
                          employeeId: employeeId!,
                          photoId: p.id,
                        })
                      }
                      aria-label="Remove photo"
                    >
                      <Icon name="x" size={11} />
                    </button>
                    <div className="text-xs mono" style={{ padding: "2px 6px" }}>
                      {p.angle}
                    </div>
                  </div>
                ))}
                {Array.from({
                  length: Math.max(0, 5 - (photos.data?.items.length ?? 0)),
                }).map((_, i) => (
                  <label
                    key={`slot-${i}`}
                    style={{
                      border: "1px dashed var(--border-strong)",
                      borderRadius: 8,
                      aspectRatio: "1 / 1",
                      display: "grid",
                      placeItems: "center",
                      cursor: "pointer",
                      fontSize: 11,
                      color: "var(--text-tertiary)",
                      background: "var(--bg-sunken)",
                    }}
                  >
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length > 0) {
                          upload.mutate({
                            employeeId: employeeId!,
                            files,
                            angle: photoAngle,
                          });
                        }
                      }}
                    />
                    <Icon name="plus" size={14} />
                  </label>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginBottom: 16,
                  alignItems: "center",
                }}
              >
                <span className="text-xs text-dim">
                  {t("employees.photos.angleLabel") as string}:
                </span>
                {ANGLES.map((a) => (
                  <button
                    type="button"
                    key={a}
                    className={`pill ${photoAngle === a ? "pill-accent" : "pill-neutral"}`}
                    onClick={() => setPhotoAngle(a)}
                    style={{ cursor: "pointer", border: "none" }}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Status */}
          <SectionLabel>{t("employees.section.status") as string}</SectionLabel>
          <div
            style={{
              padding: 12,
              border: "1px solid var(--border)",
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={form.status === "active"}
                onChange={(e) =>
                  onField("status", e.target.checked ? "active" : "inactive")
                }
              />
              <span style={{ fontWeight: 500 }}>
                {t("employees.field.active") as string}
              </span>
            </label>
            <div className="text-xs text-dim" style={{ marginTop: 6 }}>
              {t("employees.field.activeHint") as string}
            </div>

            {form.status === "inactive" && (
              <div style={{ marginTop: 10 }}>
                <label
                  className="text-xs"
                  style={{ fontWeight: 500, color: "var(--text-secondary)" }}
                >
                  {t("employees.field.deactivationReasonLabel") as string}
                </label>
                <textarea
                  placeholder={
                    t("employees.field.deactivationReasonPlaceholder") as string
                  }
                  value={form.deactivation_reason}
                  onChange={(e) =>
                    onField("deactivation_reason", e.target.value)
                  }
                  rows={2}
                  style={{
                    width: "100%",
                    marginTop: 4,
                    padding: 8,
                    fontSize: 12.5,
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-elev)",
                  }}
                />
                {detail.data?.deactivated_at && (
                  <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                    {t("employees.field.deactivatedAt") as string}:{" "}
                    {new Date(detail.data.deactivated_at).toLocaleString()}
                  </div>
                )}
              </div>
            )}
          </div>

          {serverError && (
            <div
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12.5,
                marginTop: 8,
              }}
            >
              {serverError}
            </div>
          )}
        </div>

        <div
          className="drawer-foot"
          style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            {!isAddMode && !pendingDelete.data && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ color: "var(--danger-text)" }}
                onClick={() => setShowDeleteModal(true)}
              >
                <Icon name="trash" size={12} /> {t("common.delete") as string}
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              {t("common.cancel") as string}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onSave()}
              disabled={create.isPending || update.isPending}
            >
              {isAddMode
                ? (t("employees.drawer.create") as string)
                : (t("employees.drawer.save") as string)}
            </button>
          </div>
        </div>
      </div>

      {!isAddMode && showDeleteModal && employeeId !== null && detail.data && (
        <DeleteConfirmModal
          employee={detail.data}
          onClose={() => setShowDeleteModal(false)}
          onSubmitted={() => {
            setShowDeleteModal(false);
            // For HR self-delete the employee is gone — close the drawer.
            // For Admin → pending, keep the drawer open so they see the
            // banner.
            if (isHr) onClose();
          }}
        />
      )}
    </DrawerShell>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  mono,
  required,
  disabled,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <div>
      <label
        className="text-xs"
        style={{ fontWeight: 500, color: "var(--text-secondary)" }}
      >
        {label}
        {required ? " *" : ""}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        maxLength={maxLength}
        className={mono ? "mono" : ""}
        style={{
          width: "100%",
          marginTop: 4,
          padding: "6px 8px",
          fontSize: 13,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: disabled ? "var(--bg-sunken)" : "var(--bg-elev)",
          color: disabled ? "var(--text-tertiary)" : "var(--text)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      />
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label
        className="text-xs"
        style={{ fontWeight: 500, color: "var(--text-secondary)" }}
      >
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          marginTop: 4,
          padding: "6px 8px",
          fontSize: 13,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-elev)",
          color: "var(--text)",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-tertiary)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}
