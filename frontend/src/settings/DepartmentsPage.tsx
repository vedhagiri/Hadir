// Departments management page (Settings → Departments).
//
// Operator workflow: Admin or HR creates / renames / deletes
// departments here, then the Add Employee drawer + Excel import pull
// from this list. Hard-delete refuses when the department still has
// employees referencing it; the UI surfaces the count so the operator
// knows where to look.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../api/client";
import { ModalShell } from "../components/DrawerShell";
import {
  type Department,
  type DepartmentManager,
  useAssignDepartmentManager,
  useCreateDepartment,
  useDeleteDepartment,
  useDepartmentManagers,
  useDepartments,
  useRemoveDepartmentManager,
  useUpdateDepartment,
} from "../features/departments/hooks";
import { Icon } from "../shell/Icon";
import { toast } from "../shell/Toaster";
import { SettingsTabs } from "./SettingsTabs";

import { useQuery } from "@tanstack/react-query";

export function DepartmentsPage() {
  const { t } = useTranslation();
  const list = useDepartments();
  const create = useCreateDepartment();
  const update = useUpdateDepartment();
  const del = useDeleteDepartment();

  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [managingDept, setManagingDept] = useState<Department | null>(null);

  const onDelete = (d: Department) => {
    if (
      !confirm(
        t("departments.confirmDelete", {
          name: d.name,
        }) as string,
      )
    ) {
      return;
    }
    del.mutate(d.id, {
      onSuccess: () => toast.success(t("departments.toast.deleted") as string),
      onError: (err) => {
        const detail =
          err instanceof ApiError
            ? (err.body as { detail?: { message?: string } })?.detail?.message
            : null;
        toast.error(detail ?? (t("departments.toast.deleteFailed") as string));
      },
    });
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("departments.title") as string}</h1>
          <p className="page-sub">
            {t("departments.subtitle") as string}
            {list.data && (
              <>
                {" · "}
                {list.data.items.length}{" "}
                {t("departments.deptCount", {
                  count: list.data.items.length,
                }) as string}
              </>
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setShowImport(true)}>
            <Icon name="download" size={12} />
            {t("departments.import") as string}
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={12} />
            {t("departments.add") as string}
          </button>
        </div>
      </div>

      <SettingsTabs />

      <div className="card" style={{ marginTop: 12 }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>{t("departments.col.code")}</th>
              <th>{t("departments.col.name")}</th>
              <th style={{ width: 120 }}>{t("departments.col.employees")}</th>
              <th style={{ minWidth: 220 }}>Managers</th>
              <th style={{ width: 240, textAlign: "right" }}>
                {t("departments.col.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td
                  colSpan={5}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  {t("common.loading") as string}…
                </td>
              </tr>
            )}
            {list.data?.items.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="text-sm text-dim"
                  style={{ padding: 16 }}
                >
                  {t("departments.empty") as string}
                </td>
              </tr>
            )}
            {list.data?.items.map((d) => (
              <tr key={d.id}>
                <td className="mono text-sm">{d.code}</td>
                <td className="text-sm">{d.name}</td>
                <td className="mono text-sm">{d.employee_count}</td>
                <td className="text-sm">
                  <ManagerChips departmentId={d.id} />
                </td>
                <td>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      className="btn btn-sm"
                      onClick={() => setManagingDept(d)}
                      title="Assign or remove department managers"
                    >
                      <Icon name="users" size={11} />
                      Managers
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => setEditing(d)}
                    >
                      <Icon name="settings" size={11} />
                      {t("common.edit") as string}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => onDelete(d)}
                      disabled={del.isPending}
                    >
                      <Icon name="x" size={11} />
                      {t("common.delete") as string}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <DepartmentFormModal
          mode="add"
          initialCode={nextNumericCode(list.data?.items ?? [])}
          onClose={() => setShowAdd(false)}
          onSubmit={async (code, name) => {
            await create.mutateAsync({ code, name });
            toast.success(t("departments.toast.created") as string);
            setShowAdd(false);
          }}
        />
      )}
      {editing && (
        <DepartmentFormModal
          mode="edit"
          initialCode={editing.code}
          initialName={editing.name}
          onClose={() => setEditing(null)}
          onSubmit={async (_code, name) => {
            await update.mutateAsync({ id: editing.id, name });
            toast.success(t("departments.toast.updated") as string);
            setEditing(null);
          }}
        />
      )}
      {showImport && (
        <DepartmentImportModal
          onClose={() => setShowImport(false)}
          onImported={() => list.refetch()}
        />
      )}
      {managingDept && (
        <DepartmentManagersModal
          department={managingDept}
          onClose={() => setManagingDept(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Manager chips (per row) + assignment modal
// ---------------------------------------------------------------------------

function ManagerChips({ departmentId }: { departmentId: number }) {
  const list = useDepartmentManagers(departmentId);
  if (list.isLoading) {
    return <span className="text-xs text-dim">Loading…</span>;
  }
  if (list.isError) {
    return (
      <span className="text-xs" style={{ color: "var(--danger-text)" }}>
        Failed to load
      </span>
    );
  }
  const items = list.data?.items ?? [];
  if (items.length === 0) {
    return <span className="text-xs text-dim">— No managers assigned —</span>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {items.map((m) => (
        <span
          key={m.user_id}
          className="pill pill-info"
          title={m.email}
          style={{ fontSize: 11 }}
        >
          {m.full_name}
        </span>
      ))}
    </div>
  );
}

interface ManagerCandidate {
  id: number;
  full_name: string;
  email: string;
  is_active: boolean;
}

interface ManagerCandidateListResponse {
  items: ManagerCandidate[];
}

function DepartmentManagersModal({
  department,
  onClose,
}: {
  department: Department;
  onClose: () => void;
}) {
  const assigned = useDepartmentManagers(department.id);
  const assign = useAssignDepartmentManager();
  const remove = useRemoveDepartmentManager();
  // All Manager-role users in the tenant. The picker filters out
  // already-assigned users so an operator can't pick a duplicate.
  const candidates = useQuery({
    queryKey: ["users", "managers"],
    queryFn: () =>
      api<ManagerCandidateListResponse>(
        "/api/users?role=Manager&active_only=true",
      ),
    staleTime: 60 * 1000,
  });
  const [pickedId, setPickedId] = useState<number | "">("");

  const assignedIds = new Set(
    (assigned.data?.items ?? []).map((m) => m.user_id),
  );
  const available =
    candidates.data?.items.filter((u) => !assignedIds.has(u.id)) ?? [];

  const onAssign = () => {
    if (pickedId === "") return;
    assign.mutate(
      { departmentId: department.id, userId: Number(pickedId) },
      {
        onSuccess: () => {
          toast.success("Manager assigned to department.");
          setPickedId("");
        },
        onError: (err) => {
          const detail =
            err instanceof ApiError
              ? (err.body as { detail?: { message?: string } })?.detail?.message
              : null;
          toast.error(detail ?? "Assignment failed.");
        },
      },
    );
  };

  const onRemove = (m: DepartmentManager) => {
    remove.mutate(
      { departmentId: department.id, userId: m.user_id },
      {
        onSuccess: () => toast.success(`${m.full_name} removed.`),
        onError: () => toast.error("Remove failed."),
      },
    );
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        className="card"
        style={{ width: "min(540px, 92vw)", padding: 22 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              {department.code} · {department.name}
            </h2>
            <p
              className="text-xs text-dim"
              style={{ margin: "4px 0 0", maxWidth: 440 }}
            >
              Managers added here can see every employee in this department
              on the dashboard, attendance, calendar, approvals, and reports
              — automatically, regardless of designation.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-tertiary)",
            marginBottom: 6,
          }}
        >
          Add a manager
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <select
            value={pickedId}
            onChange={(e) =>
              setPickedId(e.target.value === "" ? "" : Number(e.target.value))
            }
            disabled={candidates.isLoading || assign.isPending}
            style={{
              flex: 1,
              padding: "7px 10px",
              fontSize: 13,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-elev)",
              color: "var(--text)",
            }}
          >
            <option value="">
              {candidates.isLoading
                ? "Loading managers…"
                : available.length === 0
                  ? "All managers are already assigned"
                  : "— Pick a Manager-role user —"}
            </option>
            {available.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} · {u.email}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onAssign}
            disabled={pickedId === "" || assign.isPending}
          >
            <Icon name="check" size={11} />
            {assign.isPending ? "Assigning…" : "Assign"}
          </button>
        </div>

        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-tertiary)",
            marginBottom: 6,
          }}
        >
          Currently assigned
        </div>
        {assigned.isLoading && (
          <div className="text-sm text-dim">Loading…</div>
        )}
        {!assigned.isLoading &&
          (assigned.data?.items.length ?? 0) === 0 && (
            <div className="text-sm text-dim">
              No managers assigned. Pick one above.
            </div>
          )}
        {assigned.data?.items.map((m) => (
          <div
            key={m.user_id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-sunken)",
              marginBottom: 6,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 500,
                  fontSize: 13,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {m.full_name}
              </div>
              <div className="text-xs text-dim mono">{m.email}</div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onRemove(m)}
              disabled={remove.isPending}
              title="Remove from this department"
            >
              <Icon name="x" size={11} />
              Remove
            </button>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

function DepartmentImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<null | {
    created: number;
    updated: number;
    errors: number;
    rows: { row: number; code: string; name: string; status: string; error?: string }[];
  }>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) {
      setError(t("departments.errors.fileRequired") as string);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/departments/import", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const body = await r.json();
      if (!r.ok) {
        setError(
          typeof body?.detail === "object"
            ? body.detail.message ?? "Import failed"
            : (body?.detail ?? "Import failed"),
        );
        return;
      }
      setResult(body);
      onImported();
      toast.success(
        t("departments.toast.imported", {
          created: body.created,
          updated: body.updated,
        }) as string,
      );
    } catch {
      setError(t("departments.errors.importFailed") as string);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
        }}
        // Backdrop is presentation-only — close via the Cancel
        // button. Operator-policy red line; see DrawerShell.
      >
        <div
          className="card"
          style={{ width: 520, maxWidth: "92vw", maxHeight: "80vh", overflow: "auto", padding: 18 }}
        >
          <div className="card-head" style={{ marginBottom: 12 }}>
            <h3 className="card-title">
              {t("departments.importTitle") as string}
            </h3>
          </div>
          <p className="text-xs text-dim" style={{ marginBottom: 12 }}>
            {t("departments.importHint") as string}
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{
              padding: "6px 10px",
              fontSize: 13,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-elev)",
              width: "100%",
            }}
          />
          {error && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                marginTop: 8,
              }}
            >
              {error}
            </div>
          )}
          {result && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <span className="pill pill-success">created {result.created}</span>
                <span className="pill pill-info">updated {result.updated}</span>
                <span
                  className={`pill ${result.errors > 0 ? "pill-warning" : "pill-neutral"}`}
                >
                  errors {result.errors}
                </span>
              </div>
              {result.errors > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>Row</th>
                      <th style={{ width: 120 }}>Code</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows
                      .filter((r) => r.status === "error")
                      .map((r) => (
                        <tr key={r.row}>
                          <td className="mono text-sm">{r.row}</td>
                          <td className="mono text-sm">{r.code}</td>
                          <td className="text-sm">{r.error ?? "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 6,
              marginTop: 12,
            }}
          >
            <button className="btn" onClick={onClose} disabled={submitting}>
              {result
                ? (t("common.done") as string)
                : (t("common.cancel") as string)}
            </button>
            {!result && (
              <button
                className="btn btn-primary"
                onClick={submit}
                disabled={!file || submitting}
              >
                {submitting
                  ? (t("common.uploading") as string)
                  : (t("departments.importAction") as string)}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * Suggest the next 3-digit numeric code by scanning existing dept
 * codes for purely numeric values, taking max+1, and zero-padding to
 * 3 chars. Returns "001" when no numeric codes exist yet.
 *
 * Existing alphabetic codes (ENG, OPS, ADM) are ignored — operators
 * can keep them or rename later. The auto-suggestion is just a hint;
 * the operator can clear or replace the field freely before saving.
 */
function nextNumericCode(items: Department[]): string {
  let max = 0;
  for (const d of items) {
    if (/^\d+$/.test(d.code)) {
      const n = parseInt(d.code, 10);
      if (n > max) max = n;
    }
  }
  return String(max + 1).padStart(3, "0");
}

function DepartmentFormModal({
  mode,
  initialCode,
  initialName,
  onClose,
  onSubmit,
}: {
  mode: "add" | "edit";
  initialCode?: string;
  initialName?: string;
  onClose: () => void;
  onSubmit: (code: string, name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState(initialCode ?? "");
  const [name, setName] = useState(initialName ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (mode === "add" && !code.trim()) {
      setError(t("departments.errors.codeRequired") as string);
      return;
    }
    if (!name.trim()) {
      setError(t("departments.errors.nameRequired") as string);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(code.trim().toUpperCase(), name.trim());
    } catch (e) {
      const detail =
        e instanceof ApiError
          ? (e.body as { detail?: { message?: string } | string })?.detail
          : null;
      const msg =
        typeof detail === "string"
          ? detail
          : typeof detail === "object" && detail?.message
            ? detail.message
            : (t("departments.errors.saveFailed") as string);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
        }}
        // Backdrop is presentation-only — close via the Cancel
        // button. Operator-policy red line; see DrawerShell.
      >
      <div
        className="card"
        style={{ width: 420, maxWidth: "90vw", padding: 18 }}
      >
        <div className="card-head" style={{ marginBottom: 12 }}>
          <h3 className="card-title">
            {mode === "add"
              ? (t("departments.addTitle") as string)
              : (t("departments.editTitle") as string)}
          </h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label
            className="text-xs text-dim"
            style={{ display: "block", fontWeight: 500 }}
          >
            {t("departments.field.code") as string}
            <input
              type="text"
              value={code}
              disabled={mode === "edit"}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ENG"
              className="mono"
              style={{
                marginTop: 4,
                width: "100%",
                padding: "6px 10px",
                fontSize: 14,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: mode === "edit" ? "var(--bg-sunken)" : "var(--bg-elev)",
                color: "var(--text)",
                textTransform: "uppercase",
              }}
            />
            {mode === "add" && (
              <span className="text-xs text-dim" style={{ display: "block", marginTop: 4 }}>
                {t("departments.hint.code") as string}
              </span>
            )}
          </label>
          <label
            className="text-xs text-dim"
            style={{ display: "block", fontWeight: 500 }}
          >
            {t("departments.field.name") as string}
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("departments.placeholder.name") as string}
              style={{
                marginTop: 4,
                width: "100%",
                padding: "6px 10px",
                fontSize: 14,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--bg-elev)",
                color: "var(--text)",
              }}
            />
          </label>
          {error && (
            <div
              role="alert"
              style={{
                background: "var(--danger-soft)",
                color: "var(--danger-text)",
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 6,
              marginTop: 6,
            }}
          >
            <button className="btn" onClick={onClose} disabled={submitting}>
              {t("common.cancel") as string}
            </button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={submitting}
            >
              {submitting
                ? (t("common.saving") as string)
                : (t("common.save") as string)}
            </button>
          </div>
        </div>
      </div>
      </div>
    </ModalShell>
  );
}
