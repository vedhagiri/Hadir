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
import { DatePicker } from "../../components/DatePicker";
import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { toast } from "../../shell/Toaster";
import { useDepartments } from "../departments/hooks";
import { useDivisions } from "../divisions/hooks";
import { useSections } from "../sections/hooks";
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
} from "./hooks";
import type { Employee, EmployeeWritePayload, PhotoAngle } from "./types";

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
  const [showDeleteModal, setShowDeleteModal] = useState(false);

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
    // BUG-003 / BUG-004 / BUG-005 — explicit length-cap message rather
    // than the silent maxLength truncation (which the input already
    // enforces). Belt-and-braces in case browser autofill bypasses.
    if (form.employee_code.trim().length > 64) {
      setServerError("Employee ID must be 64 characters or fewer.");
      return null;
    }
    if (form.full_name.trim().length > 200) {
      setServerError("Full name must be 200 characters or fewer.");
      return null;
    }
    if (form.designation.trim().length > 80) {
      setServerError("Designation must be 80 characters or fewer.");
      return null;
    }
    // BUG-006 — email format validation. Empty string is allowed (the
    // field is optional); when present it must be a plausible
    // ``user@host.tld`` shape (matches the backend's lenient regex).
    if (form.email.trim()) {
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
      if (!emailOk) {
        setServerError("Email address is not valid.");
        return null;
      }
    }
    // BUG-007 — phone must be digit-only (with optional + and separators).
    if (form.phone.trim()) {
      const phoneOk = /^\+?[\d\s\-]{4,30}$/.test(form.phone.trim());
      if (!phoneOk) {
        setServerError("Phone number must contain digits only (with optional + and - or spaces).");
        return null;
      }
    }
    // ``department_id === 0`` is the in-form sentinel for "no department
    // picked yet" — happens when the operator chose a division that
    // didn't include the previously-selected department.
    if (!form.department_id) {
      setServerError(t("employees.errors.departmentRequired") as string);
      return null;
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
      if (!form.email.trim()) {
        setServerError(t("employees.errors.emailRequiredForLogin") as string);
        return;
      }
      if (loginPassword.length < 12) {
        setServerError(t("employees.errors.passwordTooShort") as string);
        return;
      }
      if (selectedRoleCodes.length === 0) {
        setServerError(t("employees.errors.atLeastOneRole") as string);
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
              {pendingDelete.data.reason && (
                <div
                  className="text-xs"
                  style={{ marginTop: 4, color: "var(--text-secondary)" }}
                >
                  {t("employees.delete.reasonLabel")}: {pendingDelete.data.reason}
                </div>
              )}
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
              maxLength={64}
            />
            <Field
              label={t("employees.field.fullName") as string}
              value={form.full_name}
              onChange={(v) => onField("full_name", v)}
              required
              maxLength={200}
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
              maxLength={120}
            />
            <Field
              label={t("employees.field.phone") as string}
              value={form.phone}
              // Strip any non-digit / +/- chars on input so the field
              // simply refuses string letters (BUG-007).
              onChange={(v) =>
                onField("phone", v.replace(/[^\d+\-\s]/g, ""))
              }
              maxLength={30}
              inputMode="tel"
            />
          </div>

          {/* Assignment */}
          <SectionLabel>{t("employees.section.assignment") as string}</SectionLabel>
          {/* Division → Department → Section is the org chain. The
              dropdowns cascade: changing the division narrows the
              department list to those linked to it (or shows every
              department when no division is picked); changing the
              department clears the now-incompatible section. */}
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <Select
              label={t("employees.field.division") as string}
              value={form.division_id === null ? "" : String(form.division_id)}
              onChange={(v) => {
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
              options={[
                {
                  value: "",
                  // BUG-011 / BUG-036 — when the tenant hasn't
                  // configured any divisions yet, surface the empty
                  // state in the dropdown placeholder rather than
                  // silently showing a single "All Divisions" entry
                  // (which an operator can reasonably mistake for
                  // dummy data).
                  label:
                    divisionsQuery.isLoading
                      ? (t("common.loading") as string)
                      : (divisionsQuery.data?.items.length ?? 0) === 0
                        ? "No divisions yet — add in Settings → Divisions"
                        : (t("employees.field.allDivisions") as string),
                },
                ...(divisionsQuery.data?.items ?? []).map((d) => ({
                  value: String(d.id),
                  label: `${d.name} (${d.code})`,
                })),
              ]}
            />
            <Select
              label={t("employees.field.department") as string}
              value={form.department_id ? String(form.department_id) : ""}
              onChange={(v) =>
                // Department change clears the section so the picker
                // can't carry a stale section that belongs to the old
                // department.
                setForm((s) => ({
                  ...s,
                  department_id: Number(v),
                  section_id: null,
                }))
              }
              options={[
                ...(form.department_id === 0
                  ? [{ value: "", label: t("employees.field.pickDepartment") as string }]
                  : []),
                ...(departmentsQuery.data?.items ?? [])
                  .filter((d) =>
                    form.division_id === null
                      ? true
                      : (d.division_id ?? null) === form.division_id,
                  )
                  .map((d) => ({
                    value: String(d.id),
                    label: `${d.name} (${d.code})`,
                  })),
              ]}
            />
            <Select
              label={t("employees.field.section") as string}
              value={form.section_id === null ? "" : String(form.section_id)}
              onChange={(v) =>
                onField("section_id", v === "" ? null : Number(v))
              }
              options={[
                {
                  value: "",
                  // BUG-012 / BUG-037 — same empty-state treatment as
                  // Division. If no department is picked yet, prompt
                  // for that first; if a department is picked but has
                  // no sections, point at Settings → Sections.
                  label:
                    sectionsQuery.isLoading
                      ? (t("common.loading") as string)
                      : form.department_id === 0 || form.department_id === null
                        ? "Pick a department first"
                        : (sectionsQuery.data?.items.length ?? 0) === 0
                          ? "No sections in this department — add in Settings → Sections"
                          : (t("employees.field.noSection") as string),
                },
                ...(sectionsQuery.data?.items ?? []).map((s) => ({
                  value: String(s.id),
                  label: `${s.name} (${s.code})`,
                })),
              ]}
            />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
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
            <div />
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
              <div>
                <Field
                  label={t("employees.field.relievingDate") as string}
                  value={form.relieving_date}
                  onChange={(v) => onField("relieving_date", v)}
                  type="date"
                />
                {/* BUG-013 — the DatePicker doesn't expose a "clear"
                    affordance, so once a date is picked there was no
                    way to un-pick it. This small button reverts the
                    relieving date to empty (which the backend treats
                    as null on PATCH). */}
                {form.relieving_date && (
                  <button
                    type="button"
                    onClick={() => onField("relieving_date", "")}
                    style={{
                      marginTop: 4,
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      fontSize: 11,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      textDecoration: "underline",
                    }}
                    aria-label="Clear relieving date"
                  >
                    Clear date
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Platform access (Add mode + Admin only). Surfaces an
              optional toggle that, when on, creates a login user with
              the chosen roles right after the employee row is
              persisted. */}
          {/* BUG-054 — HR can also create platform logins for new
              employees; backend permits POST /api/users for HR. */}
          {isAddMode && (isAdmin || isHr) && (
            <>
              <SectionLabel>
                {t("employees.section.platformAccess") as string}
              </SectionLabel>
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 16,
                  background: "var(--bg-sunken)",
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={createLogin}
                    onChange={(e) => setCreateLogin(e.target.checked)}
                  />
                  {t("employees.field.createLogin") as string}
                </label>
                <div
                  className="text-xs text-dim"
                  style={{ marginTop: 4 }}
                >
                  {t("employees.hint.createLogin") as string}
                </div>

                {createLogin && (
                  <div
                    style={{
                      marginTop: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                    }}
                  >
                    <div>
                      <label
                        className="text-xs text-dim"
                        style={{ display: "block", marginBottom: 4 }}
                      >
                        {t("employees.field.roles") as string}
                      </label>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 8,
                        }}
                      >
                        {(rolesQuery.data?.items ?? []).map((role) => {
                          const checked = selectedRoleCodes.includes(role.code);
                          return (
                            <label
                              key={role.id}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "4px 10px",
                                borderRadius: "var(--radius-sm)",
                                border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                                background: checked
                                  ? "var(--accent-soft)"
                                  : "transparent",
                                color: checked
                                  ? "var(--accent-text)"
                                  : "var(--text)",
                                fontSize: 12,
                                cursor: "pointer",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleRoleCode(role.code)}
                              />
                              {role.name}
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label
                        className="text-xs text-dim"
                        style={{ display: "block", marginBottom: 4 }}
                      >
                        {t("employees.field.password") as string}
                      </label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          type="text"
                          value={loginPassword}
                          onChange={(e) => setLoginPassword(e.target.value)}
                          placeholder={
                            t("employees.placeholder.password") as string
                          }
                          style={{
                            flex: 1,
                            fontFamily:
                              "var(--font-mono, ui-monospace, monospace)",
                            fontSize: 13,
                            padding: "6px 10px",
                            borderRadius: "var(--radius-sm)",
                            border: "1px solid var(--border)",
                            background: "var(--bg-elev)",
                            color: "var(--text)",
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={generatePassword}
                        >
                          <Icon name="refresh" size={11} />
                          {t("employees.action.generatePassword") as string}
                        </button>
                      </div>
                      <div
                        className="text-xs text-dim"
                        style={{ marginTop: 4 }}
                      >
                        {t("employees.hint.password") as string}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Login & Roles (Edit + Admin/HR only). Surfaces the linked
              user's current roles, lets Admin add/remove roles, and
              offers a Reset password action. */}
          {!isAddMode && (isAdmin || isHr) && (
            <>
              <SectionLabel>
                {t("employees.section.loginRoles") as string}
              </SectionLabel>
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 16,
                  background: "var(--bg-sunken)",
                }}
              >
                {linkedUser.isLoading && (
                  <div className="text-sm text-dim">
                    {t("common.loading") as string}…
                  </div>
                )}
                {linkedUser.isError && (
                  // BUG-019 — when an employee has been added without
                  // platform access, the drawer now offers an explicit
                  // "Enable platform access" inline form (Admin only)
                  // so the operator can grant a login after creation.
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
                    canResetPassword={isAdmin}
                    availableRoles={rolesQuery.data?.items ?? []}
                    onChanged={() => linkedUser.refetch()}
                  />
                )}
              </div>
            </>
          )}

          {/* Reference photos (Edit only). Two distinct sub-sections:
              "Existing" lists what's already on the employee with
              position label + delete; "Upload" is a separate panel
              with a position picker + file input. No more empty
              placeholder slots — adding a photo is always explicit.*/}
          {!isAddMode && (
            <>
              <SectionLabel>
                {t("employees.section.referencePhotos") as string}
              </SectionLabel>

              {/* Existing photos — preview + delete + position label.*/}
              {(photos.data?.items.length ?? 0) > 0 ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(112px, 1fr))",
                    gap: 8,
                    marginBottom: 14,
                  }}
                >
                  {(photos.data?.items ?? []).map((p) => (
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
                        onClick={() => setZoomPhotoId(p.id)}
                        style={{
                          display: "block",
                          width: "100%",
                          aspectRatio: "1 / 1",
                          objectFit: "cover",
                          cursor: "zoom-in",
                        }}
                      />
                      {/* Position pill (top-left). Always visible so the
                          operator can tell front/left/right at a glance. */}
                      <span
                        className="pill pill-accent mono text-xs"
                        style={{
                          position: "absolute",
                          top: 6,
                          insetInlineStart: 6,
                          padding: "1px 6px",
                          fontSize: 10,
                        }}
                      >
                        {t(`employees.photos.angles.${p.angle}`, {
                          defaultValue: p.angle,
                        }) as string}
                      </span>
                      {/* Delete button (top-right). */}
                      <button
                        type="button"
                        className="icon-btn"
                        style={{
                          position: "absolute",
                          top: 6,
                          insetInlineEnd: 6,
                          background: "rgba(0,0,0,0.55)",
                          color: "white",
                        }}
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
                          deletePhoto.mutate({
                            employeeId: employeeId!,
                            photoId: p.id,
                          });
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
                <div
                  className="text-sm text-dim"
                  style={{
                    padding: "10px 12px",
                    border: "1px dashed var(--border)",
                    borderRadius: 8,
                    marginBottom: 14,
                  }}
                >
                  {t("employees.photos.empty", {
                    defaultValue:
                      "No reference photos yet. Use the upload panel below.",
                  }) as string}
                </div>
              )}

              {/* Upload panel — explicit position picker + file input.
                  No empty placeholder tiles; the operator always picks
                  a position before adding files. */}
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 16,
                  background: "var(--bg-sunken)",
                }}
              >
                <div
                  className="text-xs"
                  style={{
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-tertiary)",
                    marginBottom: 8,
                  }}
                >
                  {t("employees.photos.uploadTitle", {
                    defaultValue: "Upload reference photos",
                  }) as string}
                </div>

                <label
                  className="text-xs text-dim"
                  style={{ display: "block", marginBottom: 4 }}
                >
                  {t("employees.photos.angleLabel") as string}
                </label>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    marginBottom: 10,
                  }}
                >
                  {ANGLES.map((a) => (
                    <button
                      type="button"
                      key={a}
                      onClick={() => setPhotoAngle(a)}
                      className={`pill ${photoAngle === a ? "pill-accent" : "pill-neutral"}`}
                      style={{ cursor: "pointer", border: "none" }}
                    >
                      {t(`employees.photos.angles.${a}`, {
                        defaultValue: a,
                      }) as string}
                    </button>
                  ))}
                </div>

                {/* BUG-010 — operator confusion: photo uploads commit
                    instantly, no Save needed. Spell that out so they
                    don't get stuck looking for a "save photos" button
                    when the form's Save is disabled (because no other
                    field changed). */}
                <div
                  className="text-xs"
                  style={{
                    marginBottom: 8,
                    color: "var(--accent, #0b6e4f)",
                    fontWeight: 500,
                  }}
                >
                  Photo uploads commit immediately — you can close the
                  drawer right after.
                </div>
                <div className="text-xs text-dim" style={{ marginBottom: 6 }}>
                  {t("employees.photos.uploadHint", {
                    defaultValue:
                      "Multiple files share the same position. Switch the position above to add a different angle.",
                  }) as string}
                </div>

                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={upload.isPending}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) {
                      upload.mutate({
                        employeeId: employeeId!,
                        files,
                        angle: photoAngle,
                      });
                      // Reset the input so re-selecting the same file
                      // re-triggers onChange.
                      e.target.value = "";
                    }
                  }}
                  style={{
                    fontSize: 12.5,
                    padding: "6px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-elev)",
                    color: "var(--text)",
                    width: "100%",
                  }}
                />
                {upload.isPending && (
                  <div
                    className="text-xs text-dim"
                    style={{ marginTop: 6 }}
                  >
                    {t("common.uploading") as string}…
                  </div>
                )}
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
              disabled={
                create.isPending ||
                update.isPending ||
                (!isAddMode && !isDirty)
              }
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
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: 32,
          }}
        >
          <div style={{ position: "relative", maxWidth: "90vw", maxHeight: "90vh" }}>
            <img
              src={`/api/employees/${employeeId}/photos/${zoomPhotoId}/image`}
              alt="Reference photo"
              style={{
                maxWidth: "90vw",
                maxHeight: "90vh",
                objectFit: "contain",
                borderRadius: 8,
                boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
              }}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                setZoomPhotoId(null);
              }}
              aria-label="Close photo viewer"
              style={{
                position: "absolute",
                top: 8,
                insetInlineEnd: 8,
                background: "rgba(0,0,0,0.6)",
                color: "white",
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
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
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
  inputMode?: "text" | "tel" | "email" | "numeric" | "decimal";
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
      {type === "date" ? (
        <div style={{ marginTop: 4 }}>
          <DatePicker
            value={value}
            onChange={onChange}
            disabled={disabled ?? false}
            ariaLabel={label}
            triggerStyle={{ width: "100%" }}
          />
        </div>
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          maxLength={maxLength}
          inputMode={inputMode}
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
      )}
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

interface LinkedUser {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  role_codes: string[];
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
      <div>
        <div className="text-sm" style={{ marginBottom: 6, fontWeight: 500 }}>
          {t("employees.login.notLinked") as string}
        </div>
        <div className="text-xs text-dim">
          {t("employees.login.notLinkedHint") as string}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="text-sm" style={{ marginBottom: 6, fontWeight: 500 }}>
        {t("employees.login.notLinked") as string}
      </div>
      <div className="text-xs text-dim" style={{ marginBottom: 10 }}>
        This employee can log in to Maugood after you enable platform access.
        {!hasEmail && " Add an email in the Identity section above first."}
      </div>
      {!open && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            setOpen(true);
            setError(null);
          }}
          disabled={!hasEmail}
          style={{
            background: "var(--accent, #0b6e4f)",
            color: "#fff",
            fontWeight: 600,
          }}
        >
          Enable platform access
        </button>
      )}
      {open && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginTop: 8,
            background: "var(--bg)",
          }}
        >
          <div className="text-xs text-dim" style={{ marginBottom: 8 }}>
            A login will be created for <strong>{employeeEmail}</strong>. The
            password must be at least 12 characters.
          </div>
          <div style={{ marginBottom: 10 }}>
            <label
              className="text-xs"
              style={{ display: "block", marginBottom: 4, fontWeight: 500 }}
            >
              {t("employees.field.password") as string}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              style={{
                width: "100%",
                padding: "6px 8px",
                fontSize: 13,
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
              }}
              placeholder="Minimum 12 characters"
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label
              className="text-xs"
              style={{ display: "block", marginBottom: 4, fontWeight: 500 }}
            >
              {t("employees.field.roles") as string}
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {availableRoles.map((r) => {
                const checked = roleCodes.includes(r.code);
                return (
                  <label
                    key={r.code}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "4px 9px",
                      borderRadius: 999,
                      border: `1px solid ${checked ? "var(--accent, #0b6e4f)" : "var(--border)"}`,
                      background: checked
                        ? "var(--accent-soft, rgba(11, 110, 79, 0.10))"
                        : "var(--bg-elev)",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRole(r.code)}
                      style={{ accentColor: "var(--accent, #0b6e4f)" }}
                    />
                    {r.name}
                  </label>
                );
              })}
            </div>
          </div>
          {error && (
            <div
              style={{
                color: "var(--danger-text)",
                fontSize: 12,
                marginBottom: 8,
              }}
            >
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onSubmit}
              disabled={busy}
              style={{
                background: "var(--accent, #0b6e4f)",
                color: "#fff",
                fontWeight: 600,
              }}
            >
              {busy ? "Enabling…" : "Enable access"}
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
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div>
          <div className="text-sm" style={{ fontWeight: 500 }}>
            {user.email}
          </div>
          <div className="text-xs text-dim mono">
            {t("employees.login.userId") as string}: #{user.id} ·{" "}
            {user.is_active
              ? (t("employees.login.active") as string)
              : (t("employees.login.inactive") as string)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {canEditRoles && !editing && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setEditing(true)}
            >
              <Icon name="settings" size={11} />
              {t("employees.action.editRoles") as string}
            </button>
          )}
          {canResetPassword && (
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

      {/* Roles row — read-only chips by default; toggleable when editing */}
      <div
        style={{
          marginTop: 10,
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        {(editing
          ? availableRoles.map((r) => r.code)
          : user.role_codes
        ).map((code) => {
          const isOn = editing ? draft.includes(code) : true;
          return (
            <span
              key={code}
              onClick={editing ? () => toggleDraft(code) : undefined}
              className={`pill ${isOn ? "pill-success" : "pill-neutral"}`}
              style={{
                cursor: editing ? "pointer" : "default",
                opacity: editing && !isOn ? 0.55 : 1,
              }}
            >
              {availableRoles.find((r) => r.code === code)?.name ?? code}
            </span>
          );
        })}
      </div>

      {editing && (
        <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={saveRoles}
            disabled={saving}
          >
            {saving
              ? (t("common.saving") as string)
              : (t("common.save") as string)}
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
      )}

      {resetOpen && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-elev)",
          }}
        >
          <div className="text-sm" style={{ fontWeight: 500, marginBottom: 6 }}>
            {t("employees.action.resetPassword") as string}
          </div>
          <div className="text-xs text-dim" style={{ marginBottom: 8 }}>
            {t("employees.hint.resetPassword") as string}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={{
                flex: 1,
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontSize: 13,
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--bg-elev)",
                color: "var(--text)",
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={generate}
            >
              <Icon name="refresh" size={11} />
              {t("employees.action.generatePassword") as string}
            </button>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
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
