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
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api } from "../../api/client";
import { useMe } from "../../auth/AuthProvider";
import { primaryRole } from "../../types";
import { DatePicker } from "../../components/DatePicker";
import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { Field, FormFooter, FormHeader, FormNotice, FormSection, SwitchField } from "../../components/FormKit";
import { Banner } from "./peopleUi";
import { toast } from "../../shell/Toaster";
import { validateReferencePhotos } from "../../util/photoValidation";
import { useDepartments } from "../departments/hooks";
import { useDivisions } from "../divisions/hooks";
import { useSections } from "../sections/hooks";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import {
  useBulkDeletePhotos,
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
import { SkeletonLines } from "../../components/Skeleton";

const ANGLES: PhotoAngle[] = ["front", "left", "right", "other"];

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
  // P29 (#3): division — filters which departments are pickable.
  // Optional: tenants without a division-tier set this to null and
  // see every department in the dropdown.
  division_id: number | null;
  department_id: number;
  // P29 (#3): finest-grained tier. null when no section is
  // assigned (sections are optional). Cleared automatically when
  // the department changes — a section under the old department
  // wouldn't be valid under the new one.
  section_id: number | null;
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
    division_id: null,
    department_id: 1,
    section_id: null,
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
    division_id: e.division?.id ?? null,
    department_id: e.department.id,
    section_id: e.section?.id ?? null,
    joining_date: e.joining_date ?? "",
    relieving_date: e.relieving_date ?? "",
    status: e.status,
    deactivation_reason: e.deactivation_reason ?? "",
  };
}

export function EmployeeDrawer({ employeeId, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const role = me.data ? primaryRole(me.data.roles) : "Employee";
  const isAdmin = role === "Admin";
  const isHr = role === "HR";
  const isAddMode = employeeId === null;

  const detail = useEmployeeDetail(employeeId);
  const photos = useEmployeePhotos(employeeId);
  const departmentsQuery = useDepartments();
  const divisionsQuery = useDivisions();
  const pendingDelete = useEmployeePendingDeleteRequest(employeeId);
  const create = useCreateEmployee();
  const update = useUpdateEmployee();
  const decide = useDecideDeleteRequest();
  const adminOverride = useAdminOverrideDeleteRequest();
  const upload = useEmployeePhotoUpload();
  const deletePhoto = useDeletePhoto();

  // Manager picker — BUG-038: only show users who actually hold the
  // ``Manager`` role. The previous "list every user" behaviour
  // surfaced HR / Admin / Employee entries that wouldn't be valid
  // ``reports_to`` targets in a chain-of-command sense. Backend
  // already supports the ``role`` filter (see ``list_tenant_users``).
  const managers = useQuery({
    queryKey: ["users", "tenant-list", "manager"],
    queryFn: () =>
      api<ManagerListResponse>("/api/users?active_only=true&role=Manager"),
    staleTime: 5 * 60 * 1000,
  });

  const [form, setForm] = useState<FormState>(emptyForm());
  // Snapshot of the form taken at hydration time. Used by Edit mode
  // to disable Save until something actually changes.
  const [initialForm, setInitialForm] = useState<FormState | null>(null);
  // Sections under the currently-selected department. Re-fetches
  // automatically when the operator picks a different department —
  // and we clear ``form.section_id`` in the same change handler so a
  // stale section can't survive the swap.
  const sectionsQuery = useSections(form.department_id ?? null);
  const [photoAngle, setPhotoAngle] = useState<PhotoAngle>("front");
  const [serverError, setServerError] = useState<string | null>(null);
  // Inline, per-field validation messages (rendered under the field by
  // the form kit). Same rules as before — only the placement changed.
  const [errors, setErrors] = useState<FieldErrors>({});
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideComment, setOverrideComment] = useState("");

  // "Platform access" — Add mode defaults this on so every imported
  // or hand-added employee gets a login by default (operator can opt
  // out per row). Defaults to the Employee role; Admin can promote
  // to HR/Manager/Admin via the role chips. The password is auto-
  // generated on mount but the operator can edit/regenerate it.
  const [createLogin, setCreateLogin] = useState(true);
  const [loginPassword, setLoginPassword] = useState("");
  const [selectedRoleCodes, setSelectedRoleCodes] = useState<string[]>([
    "Employee",
  ]);
  // Lightbox state for reference-photo zoom (click thumbnail → modal).
  const [zoomPhotoId, setZoomPhotoId] = useState<number | null>(null);

  // Reference-photo multi-select state. ``selectedPhotoIds`` is empty
  // when not in select mode; toggling any tile's checkbox enters
  // select mode and the bulk action toolbar appears. ``bulkConfirm``
  // gates the destructive POST behind a confirmation modal.
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkResultMessage, setBulkResultMessage] = useState<{
    tone: "ok" | "warn";
    text: string;
  } | null>(null);
  const bulkDelete = useBulkDeletePhotos();

  const rolesQuery = useQuery({
    queryKey: ["users", "roles"],
    queryFn: () =>
      api<{ items: { id: number; code: string; name: string }[] }>(
        "/api/users/roles",
      ),
    staleTime: 10 * 60 * 1000,
    // BUG-054 — HR also needs the roles list when adding an employee
    // with platform access. Backend already permits HR on /roles +
    // POST /api/users.
    enabled: isAdmin || isHr,
  });

  // Edit-mode: look up the linked user by email so we can show
  // current roles + offer reset-password / edit-roles. 404 = no
  // linked user (operator skipped login creation at Add time).
  const linkedUserEmail = (detail.data?.email ?? "").trim().toLowerCase();
  const linkedUser = useQuery({
    queryKey: ["users", "by-email", linkedUserEmail],
    queryFn: () =>
      api<{
        id: number;
        email: string;
        full_name: string;
        is_active: boolean;
        role_codes: string[];
        // 'entra' = AD-synced, SSO-only (no local password to reset).
        source: string;
        auth_provider: string | null;
      }>(`/api/users/by-email/${encodeURIComponent(linkedUserEmail)}`),
    enabled: !isAddMode && !!linkedUserEmail && (isAdmin || isHr),
    retry: false,
    staleTime: 30 * 1000,
  });

  const toggleRoleCode = (code: string) =>
    setSelectedRoleCodes((cur) =>
      cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code],
    );

  const generatePassword = () => {
    // Operator-readable but not weak: 14 chars from a wide alphabet,
    // skipping ambiguous lookalikes (0/O, 1/l/I).
    const alpha =
      "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    setLoginPassword(
      Array.from(arr, (n) => alpha[n % alpha.length]).join(""),
    );
  };

  // Pre-fill an auto-generated password the moment Add mode mounts.
  // Operator can edit/regenerate before submit.
  useEffect(() => {
    if (isAddMode && !loginPassword) generatePassword();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAddMode]);

  // Hydrate form when the detail loads (Edit mode).
  useEffect(() => {
    if (detail.data) {
      const snapshot = fromEmployee(detail.data);
      setForm(snapshot);
      setInitialForm(snapshot);
    } else if (isAddMode) {
      setForm(emptyForm());
      setInitialForm(null);
    }
  }, [detail.data, isAddMode]);

  // Compare the live form against the hydration snapshot. Edit-mode
  // Save button stays disabled until something actually changes.
  const isDirty = useMemo(() => {
    if (initialForm === null) return false;
    return (Object.keys(form) as (keyof FormState)[]).some(
      (k) => form[k] !== initialForm[k],
    );
  }, [form, initialForm]);

  // Add-mode: all required fields must be non-empty before the Create
  // button enables. Edit-mode uses isDirty instead.
  const canSubmitAdd = useMemo(() => {
    if (!form.employee_code.trim()) return false;
    if (!form.full_name.trim()) return false;
    // department_id === 0 is the "division cleared it" sentinel.
    if (!form.department_id) return false;
    // Email is required when platform login creation is requested.
    if ((isAdmin || isHr) && createLogin && !form.email.trim()) return false;
    return true;
  }, [
    form.employee_code,
    form.full_name,
    form.department_id,
    form.email,
    isAdmin,
    isHr,
    createLogin,
  ]);

  const clearError = (key: FieldKey) =>
    setErrors((cur) => {
      if (!(key in cur)) return cur;
      const next = { ...cur };
      delete next[key];
      return next;
    });

  const onField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((s) => ({ ...s, [key]: value }));
    if (isFieldKey(key)) clearError(key);
  };

  // Bring the first invalid field into view and focus its control.
  const focusFirstError = () =>
    window.requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        ".pp-emp-form .fk-field.has-error",
      );
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.querySelector<HTMLElement>("input, select, textarea, button")?.focus({
        preventScroll: true,
      });
    });

  const failWith = (errs: FieldErrors) => {
    setErrors(errs);
    focusFirstError();
  };

  const buildPayload = (): EmployeeWritePayload | null => {
    setServerError(null);
    const errs: FieldErrors = {};
    if (isAddMode) {
      if (!form.employee_code.trim()) {
        errs.employee_code = t("employees.errors.codeRequired", {
          defaultValue: "Employee ID is required.",
        }) as string;
      }
      if (!form.full_name.trim()) {
        errs.full_name = t("employees.errors.nameRequired", {
          defaultValue: "Full name is required.",
        }) as string;
      }
    }
    // BUG-003 / BUG-004 / BUG-005 — explicit length-cap message rather
    // than the silent maxLength truncation (which the input already
    // enforces). Belt-and-braces in case browser autofill bypasses.
    if (form.employee_code.trim().length > 64) {
      errs.employee_code = "Employee ID must be 64 characters or fewer.";
    }
    if (form.full_name.trim().length > 200) {
      errs.full_name = "Full name must be 200 characters or fewer.";
    }
    if (form.designation.trim().length > 80) {
      errs.designation = "Designation must be 80 characters or fewer.";
    }
    // BUG-006 — email format validation. Empty string is allowed (the
    // field is optional); when present it must be a plausible
    // ``user@host.tld`` shape (matches the backend's lenient regex).
    if (form.email.trim()) {
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
      if (!emailOk) errs.email = "Email address is not valid.";
    }
    // BUG-007 — phone must be digit-only (with optional + and separators).
    if (form.phone.trim()) {
      const phoneOk = /^\+?[\d\s\-]{4,30}$/.test(form.phone.trim());
      if (!phoneOk) {
        errs.phone = "Phone number must contain digits only (with optional + and - or spaces).";
      }
    }
    // ``department_id === 0`` is the in-form sentinel for "no department
    // picked yet" — happens when the operator chose a division that
    // didn't include the previously-selected department.
    if (!form.department_id) {
      errs.department_id = t("employees.errors.departmentRequired") as string;
    }
    if (form.status === "inactive") {
      const reason = form.deactivation_reason.trim();
      if (reason.length < 5) {
        errs.deactivation_reason = t("employees.errors.reasonRequired") as string;
      }
    }
    if (
      form.joining_date &&
      form.relieving_date &&
      form.relieving_date < form.joining_date
    ) {
      errs.relieving_date = t("employees.errors.relievingBeforeJoining") as string;
    }
    if (Object.keys(errs).length > 0) {
      failWith(errs);
      return null;
    }
    setErrors({});

    const payload: EmployeeWritePayload = {
      full_name: form.full_name.trim(),
      email: form.email.trim() || null,
      designation: form.designation.trim() || null,
      phone: form.phone.trim() || null,
      reports_to_user_id: form.reports_to_user_id ?? null,
      department_id: form.department_id,
      // P29 (#3): explicitly include section_id (null clears the
      // assignment, an int sets it). Backend validates the section
      // sits under the resolved department.
      section_id: form.section_id,
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
    // Add-mode platform-access pre-flight: validate before we POST
    // the employee, so a bad password doesn't leave a half-created
    // state (employee yes, login no).
    if (isAddMode && createLogin) {
      const errs: FieldErrors = {};
      if (!form.email.trim()) {
        errs.email = t("employees.errors.emailRequiredForLogin") as string;
      }
      if (loginPassword.length < 12) {
        errs.password = t("employees.errors.passwordTooShort") as string;
      }
      if (selectedRoleCodes.length === 0) {
        errs.roles = t("employees.errors.atLeastOneRole") as string;
      }
      if (Object.keys(errs).length > 0) {
        failWith(errs);
        return;
      }
    }
    try {
      if (isAddMode) {
        const created = await create.mutateAsync(payload);
        // Step 2: create the platform login if requested. Failures
        // here surface as a toast — the employee row is still
        // created, the operator can retry login creation later.
        if (createLogin && form.email.trim()) {
          try {
            await api("/api/users", {
              method: "POST",
              body: {
                email: form.email.trim().toLowerCase(),
                full_name: form.full_name.trim(),
                password: loginPassword,
                role_codes: selectedRoleCodes,
              },
            });
            toast.success(
              t("employees.toast.loginCreated") as string,
            );
          } catch (e) {
            const msg =
              e instanceof ApiError
                ? typeof (e.body as { detail?: { message?: string } })?.detail
                  === "object"
                  ? ((e.body as { detail?: { message?: string } }).detail
                      ?.message ?? `Login creation error ${e.status}`)
                  : `Login creation error ${e.status}`
                : "Could not create login";
            toast.error(msg);
          }
        }
        // Re-invalidate after login creation so the employee list
        // refetches with role_codes populated. The first invalidation
        // (from useCreateEmployee.onSuccess) fires before the user row
        // exists and caches an empty role. This second invalidation
        // fires after the user is in the DB, giving the list the
        // correct roles on the very next background refetch.
        void qc.invalidateQueries({ queryKey: ["employees"] });
        if (form.email.trim()) {
          void qc.invalidateQueries({
            queryKey: ["users", "by-email", form.email.trim().toLowerCase()],
          });
        }
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
      setOverrideError(t("employees.errors.overrideCommentMin") as string);
      return;
    }
    setOverrideError(null);
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

  const submitting = create.isPending || update.isPending;
  const canSubmit = isAddMode ? canSubmitAdd : isDirty;
  const titleId = "emp-form-title";
  const photoList = photos.data?.items ?? [];
  const selectedCount = selectedPhotoIds.size;
  const allSelected = photoList.length > 0 && selectedCount === photoList.length;
  // Numbered sections read as a linear flow; the count shifts by mode
  // because some sections only exist in Add (platform access) or Edit
  // (login & roles, reference photos).
  let stepNo = 0;
  const nextStep = () => ++stepNo;

  const divisionPlaceholder = divisionsQuery.isLoading
    ? (t("common.loading") as string)
    : (divisionsQuery.data?.items.length ?? 0) === 0
      ? "No divisions yet — add in Settings → Divisions"
      : (t("employees.field.allDivisions") as string);
  const sectionPlaceholder = sectionsQuery.isLoading
    ? (t("common.loading") as string)
    : form.department_id === 0 || form.department_id === null
      ? "Pick a department first"
      : (sectionsQuery.data?.items.length ?? 0) === 0
        ? "No sections in this department — add in Settings → Sections"
        : (t("employees.field.noSection") as string);

  const togglePhoto = (id: number) =>
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <DrawerShell onClose={onClose}>
      <form
        className="drawer fk-drawer fk-wide pp-emp-form"
        role="dialog"
        aria-labelledby={titleId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (submitting || !canSubmit) return;
          void onSave();
        }}
      >
        <FormHeader
          titleId={titleId}
          icon={<Icon name={isAddMode ? "plus" : "user"} size={18} />}
          eyebrow={
            isAddMode
              ? (t("employees.drawer.newEmployee") as string)
              : detail.data
                ? `${detail.data.employee_code} · ${detail.data.full_name}`
                : undefined
          }
          title={
            isAddMode
              ? (t("employees.drawer.addTitle") as string)
              : (t("employees.drawer.editTitle") as string)
          }
          subtitle={
            isAddMode
              ? (t("employees.form.addSubtitle", {
                  defaultValue:
                    "Create the employee record, place them in the org chart and optionally give them a login.",
                }) as string)
              : (t("employees.form.editSubtitle", {
                  defaultValue:
                    "Update details, team, login and reference photos. Changes are audited.",
                }) as string)
          }
          onClose={onClose}
        />

        <div className="drawer-body fk-body">
          {serverError && (
            <FormNotice
              tone="danger"
              title={t("employees.form.saveFailed", { defaultValue: "Couldn't save the employee" }) as string}
            >
              {serverError}
            </FormNotice>
          )}

          {!isAddMode && detail.isLoading && <SkeletonLines lines={4} />}

          {/* Pending delete banner (Edit only) */}
          {!isAddMode && pendingDelete.data && (
            <Banner
              tone="warning"
              title={t("employees.delete.pendingBannerTitle") as string}
              actions={
                <>
                  {isHr && (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void onDecide("approve")}
                        disabled={decide.isPending}
                      >
                        {t("employees.delete.approve") as string}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
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
                    </>
                  )}
                  {showOverrideButton && !overrideOpen && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setOverrideOpen(true)}
                    >
                      {t("employees.delete.overrideAndApprove") as string}
                    </button>
                  )}
                </>
              }
            >
              {t("employees.delete.pendingBannerBody", {
                name:
                  pendingDelete.data.requested_by_full_name ??
                  t("employees.delete.unknownActor"),
                date: new Date(
                  pendingDelete.data.created_at,
                ).toLocaleDateString(),
              }) as string}
              {pendingDelete.data.reason && (
                <div className="pp-banner-line">
                  {t("employees.delete.reasonLabel")}: {pendingDelete.data.reason}
                </div>
              )}
              {overrideOpen && (
                <div className={`pp-override-box fk-field${overrideError ? " has-error" : ""}`}>
                  <label className="fk-label" htmlFor="emp-override-comment">
                    {t("employees.form.overrideCommentLabel", { defaultValue: "Override comment" }) as string}
                    <span className="fk-req">*</span>
                  </label>
                  <textarea
                    id="emp-override-comment"
                    className="textarea"
                    placeholder={
                      t("employees.delete.overridePromptComment") as string
                    }
                    value={overrideComment}
                    onChange={(e) => {
                      setOverrideComment(e.target.value);
                      setOverrideError(null);
                    }}
                    rows={3}
                  />
                  {overrideError && (
                    <span className="fk-error" role="alert">
                      <Icon name="info" size={12} />
                      {overrideError}
                    </span>
                  )}
                  <div className="pp-inline-actions">
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
                        setOverrideError(null);
                      }}
                    >
                      {t("common.cancel") as string}
                    </button>
                  </div>
                </div>
              )}
            </Banner>
          )}

          {/* 1 · Identity */}
          <FormSection
            step={nextStep()}
            title={t("employees.section.identity") as string}
            description={t("employees.form.identityHelp", {
              defaultValue: "How this person shows up across Maugood — lists, reports and approvals.",
            }) as string}
          >
            <Field
              label={t("employees.field.code") as string}
              htmlFor="emp-code"
              required
              error={errors.employee_code}
              help={
                isAddMode
                  ? (t("employees.form.codeHelp", { defaultValue: "Your HR or payroll ID. Can't be changed later." }) as string)
                  : (t("employees.form.codeLocked", { defaultValue: "Locked — the ID can't change after creation." }) as string)
              }
            >
              <input
                id="emp-code"
                className="input mono"
                value={form.employee_code}
                onChange={(e) => onField("employee_code", e.target.value)}
                disabled={!isAddMode}
                maxLength={64}
                autoComplete="off"
                placeholder={isAddMode ? "e.g. EMP-0142" : undefined}
              />
            </Field>
            <Field
              label={t("employees.field.fullName") as string}
              htmlFor="emp-name"
              required
              error={errors.full_name}
            >
              <input
                id="emp-name"
                className="input"
                value={form.full_name}
                onChange={(e) => onField("full_name", e.target.value)}
                maxLength={200}
                autoComplete="off"
                placeholder="e.g. Aisha Al-Balushi"
              />
            </Field>
            <Field
              label={t("employees.field.designation") as string}
              htmlFor="emp-designation"
              error={errors.designation}
            >
              <input
                id="emp-designation"
                className="input"
                value={form.designation}
                onChange={(e) => onField("designation", e.target.value)}
                maxLength={80}
                placeholder="e.g. Site Engineer"
              />
            </Field>
            <Field
              label={t("employees.field.phone") as string}
              htmlFor="emp-phone"
              error={errors.phone}
            >
              <input
                id="emp-phone"
                className="input"
                value={form.phone}
                // Strip any non-digit / +/- chars on input so the field
                // simply refuses string letters (BUG-007).
                onChange={(e) =>
                  onField("phone", e.target.value.replace(/[^\d+\-\s]/g, ""))
                }
                maxLength={30}
                inputMode="tel"
                placeholder="e.g. +968 9123 4567"
              />
            </Field>
            <Field
              label={t("employees.field.email") as string}
              htmlFor="emp-email"
              span={2}
              required={isAddMode && (isAdmin || isHr) && createLogin}
              error={errors.email}
              help={
                isAddMode && (isAdmin || isHr)
                  ? (t("employees.form.emailHelpLogin", {
                      defaultValue: "Used as the sign-in email when a platform login is created below.",
                    }) as string)
                  : (t("employees.form.emailHelp", {
                      defaultValue: "Optional. Links this employee to their Maugood login.",
                    }) as string)
              }
            >
              <input
                id="emp-email"
                className="input"
                type="email"
                value={form.email}
                onChange={(e) => onField("email", e.target.value)}
                maxLength={120}
                autoComplete="off"
                placeholder="e.g. aisha@company.com"
              />
            </Field>
          </FormSection>

          {/* 2 · Assignment — Division → Department → Section is the org
              chain. The dropdowns cascade: changing the division narrows
              the department list to those linked to it (or shows every
              department when no division is picked); changing the
              department clears the now-incompatible section. */}
          <FormSection
            step={nextStep()}
            title={t("employees.section.assignment") as string}
            description={t("employees.form.assignmentHelp", {
              defaultValue: "Where they sit in the org chart and who approves their requests.",
            }) as string}
          >
            <Field label={t("employees.field.division") as string} htmlFor="emp-division">
              <select
                id="emp-division"
                className="select"
                value={form.division_id === null ? "" : String(form.division_id)}
                onChange={(e) => {
                  const v = e.target.value;
                  const newDivisionId = v === "" ? null : Number(v);
                  // If the currently-selected department isn't under
                  // the new division, clear it (and the section). When
                  // the operator un-picks the division (back to "All"),
                  // leave the existing department alone.
                  setForm((s) => {
                    const currentDept = (departmentsQuery.data?.items ?? [])
                      .find((d) => d.id === s.department_id);
                    const deptStillValid =
                      newDivisionId === null ||
                      (currentDept?.division_id ?? null) === newDivisionId;
                    return {
                      ...s,
                      division_id: newDivisionId,
                      department_id: deptStillValid ? s.department_id : 0,
                      section_id: deptStillValid ? s.section_id : null,
                    };
                  });
                }}
              >
                {/* BUG-011 / BUG-036 — when the tenant hasn't configured
                    any divisions yet, surface the empty state in the
                    placeholder rather than a lone "All divisions". */}
                <option value="">{divisionPlaceholder}</option>
                {(divisionsQuery.data?.items ?? []).map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    {`${d.name} (${d.code})`}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("employees.field.department") as string}
              htmlFor="emp-department"
              required
              error={errors.department_id}
            >
              <select
                id="emp-department"
                className="select"
                value={form.department_id ? String(form.department_id) : ""}
                onChange={(e) => {
                  // Department change clears the section so the picker
                  // can't carry a stale section from the old department.
                  setForm((s) => ({
                    ...s,
                    department_id: Number(e.target.value),
                    section_id: null,
                  }));
                  clearError("department_id");
                }}
              >
                {form.department_id === 0 && (
                  <option value="">{t("employees.field.pickDepartment") as string}</option>
                )}
                {(departmentsQuery.data?.items ?? [])
                  .filter((d) =>
                    form.division_id === null
                      ? true
                      : (d.division_id ?? null) === form.division_id,
                  )
                  .map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {`${d.name} (${d.code})`}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t("employees.field.section") as string} htmlFor="emp-section">
              <select
                id="emp-section"
                className="select"
                value={form.section_id === null ? "" : String(form.section_id)}
                onChange={(e) =>
                  onField("section_id", e.target.value === "" ? null : Number(e.target.value))
                }
              >
                {/* BUG-012 / BUG-037 — same empty-state treatment. */}
                <option value="">{sectionPlaceholder}</option>
                {(sectionsQuery.data?.items ?? []).map((sec) => (
                  <option key={sec.id} value={String(sec.id)}>
                    {`${sec.name} (${sec.code})`}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("employees.field.reportsTo") as string}
              htmlFor="emp-reports-to"
              help={t("employees.form.reportsToHelp", {
                defaultValue: "Only users with the Manager role are listed.",
              }) as string}
            >
              <select
                id="emp-reports-to"
                className="select"
                value={form.reports_to_user_id === null ? "" : String(form.reports_to_user_id)}
                onChange={(e) =>
                  onField("reports_to_user_id", e.target.value === "" ? null : Number(e.target.value))
                }
              >
                <option value="">{t("employees.field.noManager") as string}</option>
                {(managers.data?.items ?? []).map((m) => (
                  <option key={m.id} value={String(m.id)}>
                    {`${m.full_name} · ${m.email}`}
                  </option>
                ))}
              </select>
            </Field>
          </FormSection>

          {/* 3 · Lifecycle dates */}
          <FormSection
            step={nextStep()}
            title={t("employees.section.lifecycle") as string}
            description={t("employees.form.lifecycleHelp", {
              defaultValue: "Attendance is only tracked between these dates. The relieving date flips the employee to inactive automatically.",
            }) as string}
          >
            <Field label={t("employees.field.joinDate") as string}>
              <DatePicker
                value={form.joining_date}
                onChange={(v) => {
                  onField("joining_date", v);
                  clearError("relieving_date");
                }}
                ariaLabel={t("employees.field.joinDate") as string}
                triggerStyle={{ width: "100%", height: 38 }}
              />
            </Field>
            {(form.status === "active" || form.relieving_date) ? (
              <Field
                label={t("employees.field.relievingDate") as string}
                error={errors.relieving_date}
              >
                <div className="pp-date-row">
                  <DatePicker
                    value={form.relieving_date}
                    onChange={(v) => onField("relieving_date", v)}
                    ariaLabel={t("employees.field.relievingDate") as string}
                    triggerStyle={{ width: "100%", height: 38 }}
                  />
                  {/* BUG-013 — the DatePicker has no "clear" affordance;
                      this reverts the relieving date to empty (null on
                      PATCH). */}
                  {form.relieving_date && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onField("relieving_date", "")}
                      aria-label={t("employees.field.clearRelievingDate", { defaultValue: "Clear relieving date" }) as string}
                      title={t("employees.field.clearDate", { defaultValue: "Clear date" }) as string}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  )}
                </div>
              </Field>
            ) : (
              <div />
            )}
          </FormSection>

          {/* 4a · Platform access (Add + Admin/HR). When on, a login user
              with the chosen roles is created right after the employee
              row is persisted. BUG-054 — HR may create logins too. */}
          {isAddMode && (isAdmin || isHr) && (
            <FormSection
              step={nextStep()}
              title={t("employees.form.platformAccessTitle", { defaultValue: "Platform access" }) as string}
              description={t("employees.form.platformAccessHelp", {
                defaultValue: "Optional. Give this employee a Maugood login so they can see their attendance and submit requests.",
              }) as string}
            >
              <SwitchField
                id="emp-create-login"
                label={t("employees.form.createLoginLabel", { defaultValue: "Create a login for this employee" }) as string}
                description={t("employees.hint.createLogin") as string}
                checked={createLogin}
                onChange={(next) => {
                  setCreateLogin(next);
                  if (!next) {
                    clearError("password");
                    clearError("roles");
                    clearError("email");
                  }
                }}
              />
              {createLogin && (
                <>
                  <Field
                    label={t("employees.field.roles") as string}
                    required
                    span={2}
                    error={errors.roles}
                    help={t("employees.form.rolesHelp", {
                      defaultValue: "Pick one or more. Employee is the self-service default.",
                    }) as string}
                  >
                    <RoleChips
                      roles={rolesQuery.data?.items ?? []}
                      selected={selectedRoleCodes}
                      loading={rolesQuery.isLoading}
                      label={t("employees.field.roles") as string}
                      onToggle={(code) => {
                        toggleRoleCode(code);
                        clearError("roles");
                      }}
                    />
                  </Field>
                  <Field
                    label={t("employees.field.password") as string}
                    htmlFor="emp-login-password"
                    required
                    span={2}
                    error={errors.password}
                    help={t("employees.hint.password") as string}
                  >
                    <div className="pp-input-row">
                      <input
                        id="emp-login-password"
                        type="text"
                        className="input mono"
                        value={loginPassword}
                        onChange={(e) => {
                          setLoginPassword(e.target.value);
                          clearError("password");
                        }}
                        autoComplete="off"
                        placeholder={t("employees.placeholder.password") as string}
                      />
                      <button type="button" className="btn" onClick={generatePassword}>
                        <Icon name="refresh" size={12} />
                        {t("employees.action.generatePassword") as string}
                      </button>
                    </div>
                  </Field>
                </>
              )}
            </FormSection>
          )}

          {/* 4b · Login & roles (Edit + Admin/HR). Shows the linked user's
              roles, lets Admin edit them and reset the password, or offers
              "Enable platform access" when no login exists yet. */}
          {!isAddMode && (isAdmin || isHr) && (
            <FormSection
              step={nextStep()}
              columns={1}
              title={t("employees.section.loginRoles") as string}
              description={t("employees.form.loginRolesHelp", {
                defaultValue: "The Maugood login linked to this employee by email. Role and password changes apply immediately.",
              }) as string}
            >
              <div className="pp-subcard">
                {linkedUser.isLoading && <SkeletonLines lines={2} />}
                {linkedUser.isError && (
                  // BUG-019 — "Enable platform access" inline form so the
                  // operator can grant a login after creation.
                  <EnablePlatformAccessPanel
                    employeeEmail={(detail.data?.email ?? "").trim()}
                    employeeName={(detail.data?.full_name ?? "").trim()}
                    canEnable={isAdmin || isHr}
                    availableRoles={rolesQuery.data?.items ?? []}
                    onEnabled={() => linkedUser.refetch()}
                  />
                )}
                {linkedUser.data && (
                  <LinkedUserPanel
                    user={linkedUser.data}
                    canEditRoles={isAdmin}
                    // AD-synced accounts are SSO-only — no local password
                    // to reset, so hide the action for them.
                    canResetPassword={isAdmin && linkedUser.data.source !== "entra"}
                    availableRoles={rolesQuery.data?.items ?? []}
                    onChanged={() => {
                      void linkedUser.refetch();
                      void qc.invalidateQueries({ queryKey: ["employees"] });
                    }}
                  />
                )}
              </div>
            </FormSection>
          )}

          {/* 5 · Reference photos (Edit only). Existing photos with
              position label + delete + multi-select; then an explicit
              upload panel (pick a position, then files). */}
          {!isAddMode && (
            <FormSection
              step={nextStep()}
              columns={1}
              title={t("employees.section.referencePhotos") as string}
              description={t("employees.form.photosHelp", {
                defaultValue: "Clear, well-lit face photos used for recognition. Uploads and deletes apply immediately — no Save needed.",
              }) as string}
              aside={
                photoList.length > 0 ? (
                  <span className="pill pill-neutral">
                    {t("employees.photos.count", { count: photoList.length }) as string}
                  </span>
                ) : undefined
              }
            >
              {/* Bulk-select toolbar. */}
              {photoList.length > 0 && (
                <div className={`pp-photo-toolbar${selectedCount > 0 ? " is-active" : ""}`}>
                  <label className="pp-check-row">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      // ``indeterminate`` is DOM-only — set via ref so the
                      // visual state matches a partial selection.
                      ref={(el) => {
                        if (el) el.indeterminate = selectedCount > 0 && !allSelected;
                      }}
                      onChange={() => {
                        if (allSelected) setSelectedPhotoIds(new Set());
                        else setSelectedPhotoIds(new Set(photoList.map((x) => x.id)));
                      }}
                      aria-label={t("employees.photos.selectAll", {
                        defaultValue: "Select all reference photos",
                      }) as string}
                    />
                    <span className="pp-strong">
                      {selectedCount > 0
                        ? (t("employees.photos.selectedCount", {
                            defaultValue: "{{n}} selected",
                            n: selectedCount,
                          }) as string)
                        : (t("employees.photos.selectMode", {
                            defaultValue: "Select photos",
                          }) as string)}
                    </span>
                  </label>
                  <div className="pp-spacer" />
                  {selectedCount > 0 && (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setSelectedPhotoIds(new Set())}
                        disabled={bulkDelete.isPending}
                      >
                        {t("common.clear", { defaultValue: "Clear" }) as string}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => setBulkConfirmOpen(true)}
                        disabled={bulkDelete.isPending}
                        aria-label={t("employees.photos.bulkDeleteAria", {
                          defaultValue: "Delete {{n}} selected photo(s)",
                          n: selectedCount,
                        }) as string}
                      >
                        <Icon name="trash" size={11} />
                        {bulkDelete.isPending
                          ? (t("employees.photos.deleting", { defaultValue: "Deleting…" }) as string)
                          : (t("employees.photos.deleteSelected", {
                              defaultValue: "Delete Selected ({{n}})",
                              n: selectedCount,
                            }) as string)}
                      </button>
                    </>
                  )}
                </div>
              )}

              {bulkResultMessage && (
                <Banner
                  tone={bulkResultMessage.tone === "ok" ? "success" : "warning"}
                  role="status"
                  actions={
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setBulkResultMessage(null)}
                    >
                      {t("common.dismiss", { defaultValue: "Dismiss" }) as string}
                    </button>
                  }
                >
                  {bulkResultMessage.text}
                </Banner>
              )}

              {photoList.length > 0 ? (
                <div className="pp-thumb-grid pp-thumb-grid-lg">
                  {photoList.map((p) => (
                    <div
                      key={p.id}
                      className={`pp-thumb-tile${selectedPhotoIds.has(p.id) ? " is-selected" : ""}${selectedCount > 0 ? " is-selecting" : ""}`}
                    >
                      <img
                        src={`/api/employees/${employeeId}/photos/${p.id}/image`}
                        alt={p.angle}
                        onClick={() => {
                          // In select mode a click toggles the selection
                          // rather than opening the zoom.
                          if (selectedCount > 0) togglePhoto(p.id);
                          else setZoomPhotoId(p.id);
                        }}
                      />
                      <label onClick={(e) => e.stopPropagation()} className="pp-thumb-check">
                        <input
                          type="checkbox"
                          checked={selectedPhotoIds.has(p.id)}
                          onChange={() => togglePhoto(p.id)}
                          aria-label={t("employees.photos.selectOne", {
                            defaultValue: "Select reference photo",
                          }) as string}
                        />
                      </label>
                      <span className="pill pill-accent pp-thumb-angle">
                        {t(`employees.photos.angles.${p.angle}`, { defaultValue: p.angle }) as string}
                      </span>
                      <button
                        type="button"
                        className="icon-btn pp-thumb-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            !confirm(
                              t("employees.photos.confirmDelete", {
                                defaultValue: "Delete this reference photo?",
                              }) as string,
                            )
                          )
                            return;
                          deletePhoto.mutate({ employeeId: employeeId!, photoId: p.id });
                        }}
                        aria-label={t("common.delete") as string}
                        title={t("common.delete") as string}
                      >
                        <Icon name="trash" size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="pp-dashed-note">
                  {t("employees.photos.empty", {
                    defaultValue: "No reference photos yet. Use the upload panel below.",
                  }) as string}
                </div>
              )}

              {/* Upload panel — pick a position, then files. */}
              <div className="pp-upload-card">
                <div className="pp-upload-head">
                  <div className="pp-upload-title">
                    {t("employees.photos.uploadTitle", { defaultValue: "Upload reference photos" }) as string}
                  </div>
                  <div className="seg" role="group" aria-label={t("employees.photos.angleLabel") as string}>
                    {ANGLES.map((a) => (
                      <button
                        type="button"
                        key={a}
                        onClick={() => setPhotoAngle(a)}
                        aria-pressed={photoAngle === a}
                        className={`seg-btn${photoAngle === a ? " active" : ""}`}
                      >
                        {t(`employees.photos.angles.${a}`, { defaultValue: a }) as string}
                      </button>
                    ))}
                  </div>
                </div>
                <label className={`pp-upload-drop${upload.isPending ? " is-busy" : ""}`}>
                  <input
                    type="file"
                    className="pp-visually-hidden"
                    accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                    multiple
                    disabled={upload.isPending}
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      // Reset so re-selecting the same file re-fires.
                      e.target.value = "";
                      if (picked.length === 0) return;
                      const currentCount =
                        photos.data?.items.length ?? detail.data?.photo_count ?? 0;
                      const { valid, errors: photoErrors } = validateReferencePhotos(
                        picked,
                        currentCount,
                      );
                      for (const msg of photoErrors) toast.error(msg);
                      if (valid.length > 0) {
                        upload.mutate({ employeeId: employeeId!, files: valid, angle: photoAngle });
                      }
                    }}
                  />
                  <span className="pp-upload-icon" aria-hidden>
                    {upload.isPending ? <span className="fk-spinner" /> : <Icon name="upload" size={16} />}
                  </span>
                  <span className="pp-upload-text">
                    <span className="pp-upload-cta">
                      {upload.isPending
                        ? (t("common.uploading") as string)
                        : (t("employees.form.choosePhotos", {
                            defaultValue: "Choose photos for the “{{angle}}” position",
                            angle: t(`employees.photos.angles.${photoAngle}`, { defaultValue: photoAngle }),
                          }) as string)}
                    </span>
                    <span className="pp-upload-sub">
                      {t("employees.form.photoTypes", { defaultValue: "JPG, PNG or WEBP · several files at once" }) as string}
                    </span>
                  </span>
                </label>
                {/* BUG-010 — uploads commit instantly; spell it out. */}
                <div className="fk-help pp-commit-hint">
                  <Icon name="check" size={11} />
                  {t("employees.photos.commitHint", {
                    defaultValue: "Photo uploads commit immediately — you can close the drawer right after.",
                  }) as string}
                </div>
                <div className="fk-help">
                  {t("employees.photos.uploadHint", {
                    defaultValue:
                      "Multiple files share the same position. Switch the position above to add a different angle.",
                  }) as string}
                </div>
              </div>
            </FormSection>
          )}

          {isAddMode && (
            <FormNotice tone="info">
              {t("employees.form.photosAfterCreate", {
                defaultValue: "Reference photos can be added once the employee is created — open them from the list and choose Edit.",
              }) as string}
            </FormNotice>
          )}

          {/* 6 · Status */}
          <FormSection
            step={nextStep()}
            title={t("employees.section.status") as string}
            description={t("employees.form.statusHelp", {
              defaultValue: "Inactive employees stay in history but are not matched or tracked.",
            }) as string}
          >
            <SwitchField
              id="emp-active"
              label={t("employees.field.active") as string}
              description={t("employees.field.activeHint") as string}
              checked={form.status === "active"}
              onChange={(next) => {
                onField("status", next ? "active" : "inactive");
                if (next) clearError("deactivation_reason");
              }}
            />
            {form.status === "inactive" && (
              <Field
                label={t("employees.field.deactivationReasonLabel") as string}
                htmlFor="emp-deactivation-reason"
                required
                span={2}
                error={errors.deactivation_reason}
                help={
                  detail.data?.deactivated_at
                    ? `${t("employees.field.deactivatedAt") as string}: ${new Date(detail.data.deactivated_at).toLocaleString()}`
                    : (t("employees.form.reasonHelp", { defaultValue: "At least 5 characters. Saved to the audit log." }) as string)
                }
              >
                <textarea
                  id="emp-deactivation-reason"
                  className="textarea"
                  placeholder={t("employees.field.deactivationReasonPlaceholder") as string}
                  value={form.deactivation_reason}
                  onChange={(e) => onField("deactivation_reason", e.target.value)}
                  rows={3}
                />
              </Field>
            )}
          </FormSection>
        </div>

        <FormFooter
          onCancel={onClose}
          submitLabel={
            isAddMode
              ? (t("employees.form.submitAdd", { defaultValue: "Add employee" }) as string)
              : (t("employees.drawer.save") as string)
          }
          submitting={submitting}
          submittingLabel={t("common.saving") as string}
          canSubmit={canSubmit}
          {...(!isAddMode && !pendingDelete.data
            ? {
                note: (
                  <button
                    type="button"
                    className="btn btn-ghost pp-text-danger"
                    onClick={() => setShowDeleteModal(true)}
                  >
                    <Icon name="trash" size={12} /> {t("common.delete") as string}
                  </button>
                ),
              }
            : {})}
        />
      </form>

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

      {/* Bulk-delete confirmation modal — counts + warning about face
          training dataset / recognition cache impact. Operator must
          explicitly click "Delete N photos" to commit; backdrop/Esc
          dismiss WITHOUT deleting. While the mutation is in flight the
          buttons are disabled and the primary action shows a spinner
          label. Per-photo failures are reported via ``bulkResultMessage``. */}
      {bulkConfirmOpen && employeeId !== null && (
        <div
          className="modal-scrim"
          onClick={() => {
            if (!bulkDelete.isPending) setBulkConfirmOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-photo-delete-title"
            className="modal pp-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head pp-modal-head">
              <span aria-hidden className="pp-modal-icon tone-danger">
                <Icon name="trash" size={15} />
              </span>
              <div className="pp-modal-head-text">
                <h2 id="bulk-photo-delete-title" className="modal-title">
                  {t("employees.photos.bulkConfirmTitle", {
                    defaultValue: "Delete {{n}} reference photo(s)?",
                    n: selectedPhotoIds.size,
                  }) as string}
                </h2>
              </div>
            </div>
            <div className="modal-body">
              <p className="text-sm text-dim" style={{ margin: 0, lineHeight: 1.5 }}>
                {t("employees.photos.bulkConfirmBody", {
                  defaultValue:
                    "This permanently removes the selected photos and their encrypted files. The employee's face training dataset, recognition cache, and downstream face matching will refresh on the next match — past detections are not affected.",
                }) as string}
              </p>
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="btn"
                onClick={() => setBulkConfirmOpen(false)}
                disabled={bulkDelete.isPending}
              >
                {t("common.cancel", { defaultValue: "Cancel" }) as string}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={bulkDelete.isPending || selectedPhotoIds.size === 0}
                onClick={() => {
                  setBulkResultMessage(null);
                  const ids = Array.from(selectedPhotoIds);
                  bulkDelete.mutate(
                    { employeeId: employeeId, photoIds: ids },
                    {
                      onSuccess: (res) => {
                        setBulkConfirmOpen(false);
                        setSelectedPhotoIds(new Set());
                        // Compose a single status line so the operator
                        // sees the outcome inline rather than via a
                        // toast that disappears.
                        const parts: string[] = [];
                        parts.push(
                          t("employees.photos.bulkResultDeleted", {
                            defaultValue:
                              "Deleted {{n}} photo(s).",
                            n: res.deleted_count,
                          }) as string,
                        );
                        if (res.not_found_ids.length > 0) {
                          parts.push(
                            t("employees.photos.bulkResultNotFound", {
                              defaultValue:
                                "{{n}} were already removed.",
                              n: res.not_found_ids.length,
                            }) as string,
                          );
                        }
                        if (res.errors.length > 0) {
                          parts.push(
                            t("employees.photos.bulkResultErrors", {
                              defaultValue:
                                "{{n}} failed — re-try or check the audit log.",
                              n: res.errors.length,
                            }) as string,
                          );
                        }
                        setBulkResultMessage({
                          tone:
                            res.errors.length === 0 &&
                            res.not_found_ids.length === 0
                              ? "ok"
                              : "warn",
                          text: parts.join(" "),
                        });
                      },
                      onError: (err) => {
                        setBulkResultMessage({
                          tone: "warn",
                          text:
                            (t("employees.photos.bulkResultFailed", {
                              defaultValue:
                                "Bulk delete failed — please try again.",
                            }) as string) +
                            ` (${(err as Error).message})`,
                        });
                      },
                    },
                  );
                }}
              >
                <Icon name="trash" size={11} />
                {bulkDelete.isPending
                  ? (t("employees.photos.deleting", {
                      defaultValue: "Deleting…",
                    }) as string)
                  : (t("employees.photos.bulkConfirmAction", {
                      defaultValue: "Delete {{n}} photos",
                      n: selectedPhotoIds.size,
                    }) as string)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Photo zoom lightbox — clicking a thumbnail opens this; click
          backdrop or Esc/Close to dismiss. The image element is the
          same auth-gated /image endpoint as the thumbnail, so the
          decrypt happens server-side either way. */}
      {zoomPhotoId !== null && employeeId !== null && (
        <div
          role="dialog"
          aria-modal="true"
          // Backdrop / Esc no longer close — operator-policy red
          // line. The X button in the top-right of the lightbox is
          // the only close affordance.
          className="pp-lightbox"
          style={{ zIndex: 9999 }}
        >
          <img
            src={`/api/employees/${employeeId}/photos/${zoomPhotoId}/image`}
            alt="Reference photo"
          />
          <button
            type="button"
            className="pp-lightbox-close"
            onClick={(e) => {
              e.stopPropagation();
              setZoomPhotoId(null);
            }}
            aria-label={t("employees.photos.closeViewer", { defaultValue: "Close photo viewer" }) as string}
          >
            <Icon name="x" size={18} />
          </button>
        </div>
      )}
    </DrawerShell>
  );
}

type FieldKey =
  | "employee_code"
  | "full_name"
  | "designation"
  | "email"
  | "phone"
  | "department_id"
  | "relieving_date"
  | "deactivation_reason"
  | "password"
  | "roles";

type FieldErrors = Partial<Record<FieldKey, string>>;

const FIELD_KEYS: readonly string[] = [
  "employee_code",
  "full_name",
  "designation",
  "email",
  "phone",
  "department_id",
  "relieving_date",
  "deactivation_reason",
];

function isFieldKey(k: string): k is FieldKey {
  return FIELD_KEYS.includes(k);
}

// Swallow Enter inside the inline sub-forms (enable access / reset
// password) so it doesn't implicitly submit the surrounding employee
// form — those panels have their own explicit action buttons.
function stopEnter(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") e.preventDefault();
}

/** Multi-select role chips (checkbox semantics). */
function RoleChips({
  roles,
  selected,
  onToggle,
  label,
  loading,
}: {
  roles: { id: number; code: string; name: string }[];
  selected: string[];
  onToggle: (code: string) => void;
  label: string;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  if (loading && roles.length === 0) {
    return <span className="fk-help">{t("common.loading") as string}</span>;
  }
  return (
    <div className="pp-chips" role="group" aria-label={label}>
      {roles.map((role) => {
        const checked = selected.includes(role.code);
        return (
          <label key={role.id} className={`pp-choice${checked ? " is-on" : ""}`}>
            <input type="checkbox" checked={checked} onChange={() => onToggle(role.code)} />
            {role.name}
          </label>
        );
      })}
    </div>
  );
}

interface LinkedUser {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  role_codes: string[];
  // 'entra' = AD-synced (SSO-only). Optional so pre-existing callers
  // that build a LinkedUser without it still typecheck.
  source?: string;
  auth_provider?: string | null;
}

// BUG-019 — "Enable Platform Access" inline form. Shown in the Edit
// drawer when an employee has no matching ``users`` row by email
// (i.e. they were added without platform access at creation time).
// Admin-only; HR gets a read-only "Not linked yet" message instead.
function EnablePlatformAccessPanel({
  employeeEmail,
  employeeName,
  canEnable,
  availableRoles,
  onEnabled,
}: {
  employeeEmail: string;
  employeeName: string;
  canEnable: boolean;
  availableRoles: { id: number; code: string; name: string }[];
  onEnabled: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [roleCodes, setRoleCodes] = useState<string[]>(["Employee"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasEmail = !!employeeEmail;
  const toggleRole = (code: string) => {
    setRoleCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const onSubmit = async () => {
    setError(null);
    if (!hasEmail) {
      setError("This employee has no email. Add one in the Identity section first.");
      return;
    }
    if (password.length < 12) {
      setError(t("employees.errors.passwordTooShort") as string);
      return;
    }
    if (roleCodes.length === 0) {
      setError(t("employees.errors.atLeastOneRole") as string);
      return;
    }
    setBusy(true);
    try {
      await api("/api/users", {
        method: "POST",
        body: {
          email: employeeEmail.toLowerCase(),
          full_name: employeeName || employeeEmail,
          password,
          role_codes: roleCodes,
        },
      });
      toast.success(t("employees.toast.loginCreated") as string);
      setOpen(false);
      setPassword("");
      onEnabled();
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? typeof (e.body as { detail?: { message?: string } })?.detail === "object"
            ? ((e.body as { detail?: { message?: string } }).detail?.message
                ?? `Login creation error ${e.status}`)
            : `Login creation error ${e.status}`
          : "Could not create login";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  if (!canEnable) {
    return (
      <div className="pp-login-empty">
        <span className="pp-login-empty-icon" aria-hidden>
          <Icon name="user" size={16} />
        </span>
        <div>
          <div className="pp-login-title">{t("employees.login.notLinked") as string}</div>
          <div className="fk-help">{t("employees.login.notLinkedHint") as string}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="pp-stack-12">
      <div className="pp-login-empty">
        <span className="pp-login-empty-icon" aria-hidden>
          <Icon name="user" size={16} />
        </span>
        <div className="pp-grow">
          <div className="pp-login-title">{t("employees.login.notLinked") as string}</div>
          <div className="fk-help">
            This employee can log in to Maugood after you enable platform access.
            {!hasEmail && " Add an email in the Identity section above first."}
          </div>
        </div>
        {!open && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setOpen(true);
              setError(null);
            }}
            disabled={!hasEmail}
          >
            <Icon name="plus" size={11} />
            {t("employees.login.enableAccess", { defaultValue: "Enable platform access" }) as string}
          </button>
        )}
      </div>
      {open && (
        <div className="pp-subform">
          <p className="fk-help pp-m0">
            {t("employees.login.enableHint", {
              defaultValue: "A login will be created for {{email}}. The password must be at least 12 characters.",
              email: employeeEmail,
            }) as string}
          </p>
          <div className="fk-grid fk-grid-1">
            <Field
              label={t("employees.field.password") as string}
              htmlFor="pp-enable-password"
              required
            >
              <input
                id="pp-enable-password"
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={stopEnter}
                autoComplete="new-password"
                placeholder={t("employees.placeholder.minPassword", { defaultValue: "Minimum 12 characters" }) as string}
              />
            </Field>
            <Field label={t("employees.field.roles") as string} required>
              <RoleChips
                roles={availableRoles}
                selected={roleCodes}
                onToggle={toggleRole}
                label={t("employees.field.roles") as string}
              />
            </Field>
          </div>
          {error && <FormNotice tone="danger">{error}</FormNotice>}
          <div className="pp-inline-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onSubmit}
              disabled={busy}
            >
              {busy
                ? (t("employees.login.enabling", { defaultValue: "Enabling…" }) as string)
                : (t("employees.login.enableConfirm", { defaultValue: "Enable access" }) as string)}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setOpen(false);
                setPassword("");
                setError(null);
              }}
              disabled={busy}
            >
              {t("common.cancel") as string}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LinkedUserPanel({
  user,
  canEditRoles,
  canResetPassword,
  availableRoles,
  onChanged,
}: {
  user: LinkedUser;
  canEditRoles: boolean;
  canResetPassword: boolean;
  availableRoles: { id: number; code: string; name: string }[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(user.role_codes);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  // Re-sync the editor's draft if the parent reloads the user.
  useEffect(() => {
    setDraft(user.role_codes);
  }, [user.role_codes]);

  const generate = () => {
    const alpha =
      "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    setNewPassword(Array.from(arr, (n) => alpha[n % alpha.length]).join(""));
  };

  const toggleDraft = (code: string) =>
    setDraft((cur) =>
      cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code],
    );

  const saveRoles = async () => {
    if (draft.length === 0) {
      toast.error(t("employees.errors.atLeastOneRole") as string);
      return;
    }
    setSaving(true);
    try {
      await api(`/api/users/${user.id}`, {
        method: "PATCH",
        body: { role_codes: draft },
      });
      toast.success(t("employees.toast.rolesUpdated") as string);
      setEditing(false);
      onChanged();
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `Error ${e.status}: ${typeof e.body === "string" ? e.body : "could not save"}`
          : "Could not save";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const submitReset = async () => {
    if (newPassword.length < 12) {
      toast.error(t("employees.errors.passwordTooShort") as string);
      return;
    }
    setResetting(true);
    try {
      await api(`/api/users/${user.id}/password-reset`, {
        method: "POST",
        body: { password: newPassword },
      });
      try {
        await navigator.clipboard.writeText(newPassword);
      } catch {
        /* clipboard write blocked; toast still tells the operator */
      }
      toast.success(t("employees.toast.passwordReset") as string);
      setResetOpen(false);
      setNewPassword("");
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `Error ${e.status}: ${typeof e.body === "string" ? e.body : "could not reset"}`
          : "Could not reset password";
      toast.error(msg);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="pp-stack-12">
      <div className="pp-login-head">
        <span className="pp-login-empty-icon is-linked" aria-hidden>
          <Icon name="shield" size={16} />
        </span>
        <div className="pp-grow">
          <div className="pp-login-title">{user.email}</div>
          <div className="fk-help">
            {t("employees.login.userId") as string}: <span className="mono">#{user.id}</span> ·{" "}
            {user.is_active
              ? (t("employees.login.active") as string)
              : (t("employees.login.inactive") as string)}
          </div>
        </div>
        <div className="pp-head-actions">
          {user.source === "entra" && (
            <span className="pill pill-info pp-nowrap">
              <Icon name="shield" size={11} />
              {t("employees.login.ssoOnly") as string}
            </span>
          )}
          {canEditRoles && !editing && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              <Icon name="edit" size={11} />
              {t("employees.action.editRoles") as string}
            </button>
          )}
          {canResetPassword && !resetOpen && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setResetOpen(true);
                generate();
              }}
            >
              <Icon name="refresh" size={11} />
              {t("employees.action.resetPassword") as string}
            </button>
          )}
        </div>
      </div>

      {/* Roles — read-only pills by default; toggleable chips when editing */}
      {editing ? (
        <div className="pp-subform">
          <RoleChips
            roles={availableRoles}
            selected={draft}
            onToggle={toggleDraft}
            label={t("employees.field.roles") as string}
          />
          <div className="pp-inline-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={saveRoles}
              disabled={saving}
            >
              {saving ? (t("common.saving") as string) : (t("common.save") as string)}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraft(user.role_codes);
                setEditing(false);
              }}
            >
              {t("common.cancel") as string}
            </button>
          </div>
        </div>
      ) : (
        <div className="pp-chips">
          {user.role_codes.map((code) => (
            <span key={code} className="pill pill-success">
              {availableRoles.find((r) => r.code === code)?.name ?? code}
            </span>
          ))}
        </div>
      )}

      {resetOpen && (
        <div className="pp-subform">
          <Field
            label={t("employees.action.resetPassword") as string}
            htmlFor="pp-reset-password"
            help={t("employees.hint.resetPassword") as string}
          >
            <div className="pp-input-row">
              <input
                id="pp-reset-password"
                type="text"
                className="input mono"
                aria-label={t("employees.field.password") as string}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={stopEnter}
                autoComplete="off"
              />
              <button type="button" className="btn btn-sm" onClick={generate}>
                <Icon name="refresh" size={11} />
                {t("employees.action.generatePassword") as string}
              </button>
            </div>
          </Field>
          <div className="pp-inline-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={submitReset}
              disabled={resetting}
            >
              {resetting
                ? (t("common.saving") as string)
                : (t("employees.action.applyReset") as string)}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setResetOpen(false);
                setNewPassword("");
              }}
            >
              {t("common.cancel") as string}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
