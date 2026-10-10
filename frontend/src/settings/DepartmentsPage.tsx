// Departments management page (Settings → Departments).
//
// Operator workflow: Admin or HR creates / renames / deletes
// departments here, then the Add Employee drawer + Excel import pull
// from this list. Hard-delete refuses when the department still has
// employees referencing it; the UI surfaces the count so the operator
// knows where to look.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, api } from "../api/client";
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
import { useDivisions } from "../features/divisions/hooks";
import { Icon } from "../shell/Icon";
import { toast } from "../shell/Toaster";
import {
  CloseFooter,
  ConfirmModal,
  LoadErrorPanel,
  PersonChip,
  SettingsFormModal,
  SettingsPage,
  TableCard,
  nowrap,
} from "./settingsUi";
import { Field, FormFooter, FormNotice, FormSection } from "../components/FormKit";
import { EmptyPanel, KebabMenu, FilterSelect, ResetButton, SearchField, Toolbar } from "../components/ListPageUi";

import { useQuery } from "@tanstack/react-query";
import { SkeletonChip, SkeletonLines, SkeletonRows } from "../components/Skeleton";

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
  const [q, setQ] = useState("");
  const [divisionF, setDivisionF] = useState("");

  const allItems = list.data?.items ?? [];
  const divisionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of allItems) {
      if (d.division_id != null) seen.set(String(d.division_id), d.division_name ?? d.division_code ?? "");
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allItems]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allItems.filter((d) => {
      if (divisionF === "none" && d.division_id != null) return false;
      if (divisionF && divisionF !== "none" && String(d.division_id) !== divisionF) return false;
      if (!needle) return true;
      return [d.code, d.name, d.division_code ?? "", d.division_name ?? ""].some((v) =>
        v.toLowerCase().includes(needle),
      );
    });
  }, [allItems, q, divisionF]);
  const filtersActive = !!(q || divisionF);
  const resetFilters = () => {
    setQ("");
    setDivisionF("");
  };

  const [deleting, setDeleting] = useState<Department | null>(null);
  const onDelete = (d: Department) => {
    del.mutate(d.id, {
      onSuccess: () => {
        toast.success(t("departments.toast.deleted") as string);
        setDeleting(null);
      },
      onError: (err) => {
        const detail =
          err instanceof ApiError
            ? (err.body as { detail?: { message?: string } })?.detail?.message
            : null;
        toast.error(detail ?? (t("departments.toast.deleteFailed") as string));
      },
    });
  };

  const hasRecords = allItems.length > 0;
  const showToolbar = list.isLoading || (hasRecords && !list.isError);

  return (
    <SettingsPage
      wide
      title={t("departments.title") as string}
      subtitle={
        <>
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
        </>
      }
      actions={
        <>
          <button className="btn" onClick={() => setShowImport(true)}>
            <Icon name="download" size={12} />
            {t("departments.import") as string}
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={12} />
            {t("departments.add") as string}
          </button>
        </>
      }
    >
      {showToolbar && (
        <Toolbar>
          <SearchField
            value={q}
            onChange={setQ}
            placeholder={t("settingsUi.org.searchDepartments", { defaultValue: "Search by code, name or division" })}
            clearLabel={t("settingsUi.org.clearSearch", { defaultValue: "Clear search" })}
          />
          <FilterSelect
            label={t("departments.col.division")}
            value={divisionF}
            onChange={setDivisionF}
            options={[
              ["", t("settingsUi.org.allDivisions", { defaultValue: "All divisions" })],
              ["none", t("settingsUi.org.noDivision", { defaultValue: "No division" })],
              ...divisionOptions,
            ]}
          />
          <ResetButton
            active={filtersActive}
            label={t("settingsUi.org.reset", { defaultValue: "Reset" })}
            onClick={resetFilters}
          />
        </Toolbar>
      )}

      {list.isLoading ? (
        <TableCard>
          <table className="table">
            <tbody>
              <SkeletonRows cols={6} />
            </tbody>
          </table>
        </TableCard>
      ) : list.isError ? (
        <LoadErrorPanel
          title={t("settingsUi.org.departmentsLoadFailed", { defaultValue: "Couldn't load departments" })}
          onRetry={() => void list.refetch()}
        />
      ) : !hasRecords ? (
        <EmptyPanel
          tone="accent"
          icon={<Icon name="users" size={28} />}
          title={t("departments.empty") as string}
          body={t("settingsUi.org.departmentsEmptyBody", {
            defaultValue: "Add your first department, or import a list from a CSV file.",
          })}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setShowImport(true)}>
                <Icon name="download" size={12} />
                {t("departments.import") as string}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
                <Icon name="plus" size={12} />
                {t("departments.add") as string}
              </button>
            </>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyPanel
          tone="neutral"
          icon={<Icon name="search" size={28} />}
          title={t("settingsUi.org.noMatchTitle", { defaultValue: "No matches" })}
          body={t("settingsUi.org.noMatchBody", {
            defaultValue: "Nothing matches the current search or filters. Try a different term or clear the filters.",
          })}
          actions={
            <button type="button" className="btn" onClick={resetFilters}>
              <Icon name="refresh" size={12} />
              {t("settingsUi.org.clearFilters", { defaultValue: "Clear filters" })}
            </button>
          }
        />
      ) : (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>{t("departments.col.code")}</th>
                <th>{t("departments.col.name")}</th>
                <th style={{ width: 200 }}>{t("departments.col.division")}</th>
                <th style={{ width: 110 }}>{t("departments.col.employees")}</th>
                <th style={{ minWidth: 200 }}>{t("departments.col.managers")}</th>
                <th style={{ width: 64, textAlign: "end" }}>{t("departments.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id}>
                  <td className="mono text-sm" style={nowrap}>
                    {d.code}
                  </td>
                  <td className="text-sm">
                    <strong>{d.name}</strong>
                  </td>
                  <td className="text-sm">
                    {d.division_code ? (
                      <span title={d.division_name ?? undefined}>
                        <span className="mono text-xs text-dim">{d.division_code}</span>
                        {" · "}
                        {d.division_name}
                      </span>
                    ) : (
                      <span className="text-xs text-dim">{t("departments.divisionNone")}</span>
                    )}
                  </td>
                  <td className="mono text-sm">{d.employee_count}</td>
                  <td className="text-sm">
                    <ManagerChips departmentId={d.id} />
                  </td>
                  <td>
                    <div className="st-row-actions">
                      <KebabMenu
                        label={t("common.actions", { defaultValue: "Actions" }) as string}
                        items={[
                          { label: t("departments.managersBtn") as string, icon: <Icon name="users" size={13} />, onClick: () => setManagingDept(d) },
                          { label: t("common.edit") as string, icon: <Icon name="edit" size={13} />, onClick: () => setEditing(d) },
                          {
                            label: t("common.delete") as string,
                            icon: <Icon name="trash" size={13} />,
                            danger: true,
                            onClick: () => {
                              if (!del.isPending) setDeleting(d);
                            },
                          },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}

      {showAdd && (
        <DepartmentFormModal
          mode="add"
          initialCode={nextNumericCode(list.data?.items ?? [])}
          onClose={() => setShowAdd(false)}
          onSubmit={async (code, name, divisionId) => {
            await create.mutateAsync({
              code,
              name,
              division_id: divisionId,
            });
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
          initialDivisionId={editing.division_id ?? null}
          onClose={() => setEditing(null)}
          onSubmit={async (_code, name, divisionId) => {
            await update.mutateAsync({
              id: editing.id,
              name,
              division_id: divisionId,
            });
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
      {deleting && (
        <ConfirmModal
          titleId="dept-delete-title"
          title={t("settingsForms.dept.deleteTitle", { defaultValue: "Delete department" })}
          subtitle={`${deleting.code} · ${deleting.name}`}
          confirmLabel={t("settingsForms.dept.deleteAction", { defaultValue: "Delete department" })}
          busy={del.isPending}
          onConfirm={() => onDelete(deleting)}
          onClose={() => setDeleting(null)}
        >
          <p className="st-confirm-text">{t("departments.confirmDelete", { name: deleting.name }) as string}</p>
          {deleting.employee_count > 0 && (
            <FormNotice tone="warning">
              {t("settingsForms.dept.deleteHasEmployees", {
                count: deleting.employee_count,
                defaultValue: "{{count}} employee(s) still reference this department — the server will refuse the delete until they are moved.",
              })}
            </FormNotice>
          )}
        </ConfirmModal>
      )}
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------
// Manager chips (per row) + assignment modal
// ---------------------------------------------------------------------------

function ManagerChips({ departmentId }: { departmentId: number }) {
  const { t } = useTranslation();
  const list = useDepartmentManagers(departmentId);
  if (list.isLoading) {
    return <SkeletonChip />;
  }
  if (list.isError) {
    return (
      <span className="text-xs" style={{ color: "var(--danger-text)" }}>
        {t("departments.chips.loadFailed")}
      </span>
    );
  }
  const items = list.data?.items ?? [];
  if (items.length === 0) {
    return <span className="text-xs text-dim">{t("departments.chips.noManagers")}</span>;
  }
  return (
    <div className="st-chips" style={{ gap: 4 }}>
      {items.map((m) => (
        <PersonChip key={m.user_id} name={m.full_name} title={m.email} />
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
  const { t } = useTranslation();
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
          toast.success(t("departments.managersModal.assign") + ".");
          setPickedId("");
        },
        onError: (err) => {
          const detail =
            err instanceof ApiError
              ? (err.body as { detail?: { message?: string } })?.detail?.message
              : null;
          toast.error(detail ?? t("departments.managersModal.assign") + " failed.");
        },
      },
    );
  };

  const onRemove = (m: DepartmentManager) => {
    remove.mutate(
      { departmentId: department.id, userId: m.user_id },
      {
        onSuccess: () => toast.success(`${m.full_name} ${t("departments.managersModal.remove")}.`),
        onError: () => toast.error(t("departments.managersModal.remove") + " failed."),
      },
    );
  };

  return (
    <SettingsFormModal
      icon={<Icon name="users" size={18} />}
      title={t("settingsForms.dept.managersTitle", { defaultValue: "Department managers" })}
      subtitle={`${department.code} · ${department.name}`}
      onClose={onClose}
      onSubmit={onAssign}
      size="lg"
      titleId="dept-managers-title"
      footer={
        <CloseFooter
          onClose={onClose}
          note={t("settingsForms.managersNote", { defaultValue: "Changes save as soon as you assign or remove." })}
        />
      }
    >
      <FormNotice tone="info">{t("departments.managersModal.desc")}</FormNotice>
      <FormSection
        step={1}
        title={t("departments.managersModal.addSection")}
        description={t("settingsForms.managersAddDesc", { defaultValue: "Only users holding the Manager role appear in this list." })}
        columns={1}
      >
        {!candidates.isLoading && (candidates.data?.items.length ?? 0) === 0 && (
          <FormNotice tone="warning">{t("departments.managersModal.noManagerUsers")}</FormNotice>
        )}
        <Field label={t("settingsForms.managerLabel", { defaultValue: "Manager" })} htmlFor="dept-manager-pick">
          <div className="st-pick-row">
            <select
              id="dept-manager-pick"
              className="select"
              value={pickedId}
              onChange={(e) => setPickedId(e.target.value === "" ? "" : Number(e.target.value))}
              disabled={candidates.isLoading || assign.isPending || available.length === 0}
            >
              <option value="">
                {candidates.isLoading
                  ? t("departments.managersModal.loadingManagers")
                  : (candidates.data?.items.length ?? 0) === 0
                    ? t("departments.managersModal.noManagerUsersOption")
                    : available.length === 0
                      ? t("departments.managersModal.allAssigned")
                      : t("departments.managersModal.pickPlaceholder")}
              </option>
              {available.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name} · {u.email}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={pickedId === "" || assign.isPending}>
              <Icon name="plus" size={12} />
              {assign.isPending ? t("departments.managersModal.assigning") : t("departments.managersModal.assign")}
            </button>
          </div>
        </Field>
      </FormSection>

      <FormSection
        step={2}
        title={t("departments.managersModal.assignedSection")}
        description={t("settingsForms.managersAssignedDesc", { defaultValue: "Remove a manager to stop their visibility over this unit." })}
        columns={1}
      >
        {assigned.isLoading && <SkeletonLines lines={2} />}
        {!assigned.isLoading && (assigned.data?.items.length ?? 0) === 0 && (
          <div className="text-sm text-dim">{t("departments.managersModal.noAssigned")}</div>
        )}
        {(assigned.data?.items.length ?? 0) > 0 && (
          <div className="st-list">
            {assigned.data?.items.map((m) => (
              <div key={m.user_id} className="st-list-row">
                <div className="st-list-row-main">
                  <div className="st-list-row-title">{m.full_name}</div>
                  <div className="text-xs text-dim">{m.email}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost st-danger"
                  onClick={() => onRemove(m)}
                  disabled={remove.isPending}
                  title={t("departments.managersModal.removeBtnTitle")}
                >
                  <Icon name="x" size={11} />
                  {t("departments.managersModal.remove")}
                </button>
              </div>
            ))}
          </div>
        )}
      </FormSection>
    </SettingsFormModal>
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
    <SettingsFormModal
      icon={<Icon name="upload" size={18} />}
      title={t("departments.importTitle") as string}
      subtitle={t("settingsForms.dept.importSubtitle", { defaultValue: "Create or update many departments at once from a CSV file." })}
      onClose={onClose}
      onSubmit={() => {
        if (!result && !submitting) void submit();
      }}
      titleId="dept-import-title"
      footer={
        result ? (
          <CloseFooter onClose={onClose} label={t("common.done") as string} />
        ) : (
          <FormFooter
            onCancel={onClose}
            submitLabel={t("departments.importAction") as string}
            submittingLabel={t("common.uploading") as string}
            submitting={submitting}
            canSubmit={!!file}
          />
        )
      }
    >
      {error && !result && <FormNotice tone="danger">{error}</FormNotice>}
      <FormSection
        title={t("settingsForms.dept.importFileSection", { defaultValue: "Upload file" })}
        description={t("departments.importHint") as string}
        columns={1}
      >
        <Field
          label={t("settingsUi.org.csvFile", { defaultValue: "CSV file" })}
          htmlFor="dept-import-file"
          required
          help={t("settingsForms.dept.importFileHelp", { defaultValue: "Headers: code,name — one department per row." })}
        >
          <input
            id="dept-import-file"
            className="input"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
      </FormSection>
      {result && (
        <FormSection title={t("settingsForms.importResultSection", { defaultValue: "Import result" })} columns={1}>
          <div className="st-result-pills">
            <span className="pill pill-success">{t("departments.importResult.created", { n: result.created })}</span>
            <span className="pill pill-info">{t("departments.importResult.updated", { n: result.updated })}</span>
            <span className={`pill ${result.errors > 0 ? "pill-warning" : "pill-neutral"}`}>
              {t("departments.importResult.errors", { n: result.errors })}
            </span>
          </div>
          {result.errors > 0 && (
            <div className="st-table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>{t("departments.importResult.colRow")}</th>
                    <th style={{ width: 120 }}>{t("departments.importResult.colCode")}</th>
                    <th>{t("departments.importResult.colError")}</th>
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
            </div>
          )}
        </FormSection>
      )}
    </SettingsFormModal>
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
  initialDivisionId,
  onClose,
  onSubmit,
}: {
  mode: "add" | "edit";
  initialCode?: string;
  initialName?: string;
  initialDivisionId?: number | null;
  onClose: () => void;
  onSubmit: (
    code: string,
    name: string,
    divisionId: number | null,
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState(initialCode ?? "");
  const [name, setName] = useState(initialName ?? "");
  const [divisionId, setDivisionId] = useState<number | "">(
    initialDivisionId ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ code?: string | undefined; name?: string | undefined }>({});
  const divisions = useDivisions();

  const blurRequired = (key: "code" | "name", value: string) => {
    if (key === "code" && mode !== "add") return;
    setFieldErrors((prev) => ({
      ...prev,
      [key]: value.trim()
        ? undefined
        : (t(key === "code" ? "departments.errors.codeRequired" : "departments.errors.nameRequired") as string),
    }));
  };

  const submit = async () => {
    if (mode === "add" && !code.trim()) {
      setFieldErrors({ code: t("departments.errors.codeRequired") as string });
      return;
    }
    if (!name.trim()) {
      setFieldErrors({ name: t("departments.errors.nameRequired") as string });
      return;
    }
    setFieldErrors({});
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(
        code.trim().toUpperCase(),
        name.trim(),
        divisionId === "" ? null : Number(divisionId),
      );
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

  const isAdd = mode === "add";
  const complete = (!isAdd || !!code.trim()) && !!name.trim();

  return (
    <SettingsFormModal
      icon={<Icon name="users" size={18} />}
      title={
        isAdd
          ? (t("departments.add") as string)
          : t("settingsForms.dept.editTitle", { defaultValue: "Edit department" })
      }
      subtitle={
        isAdd
          ? t("settingsForms.dept.addSubtitle", { defaultValue: "Create a department employees can be assigned to." })
          : t("settingsForms.dept.editSubtitle", { defaultValue: "Rename the department or move it to another division." })
      }
      onClose={onClose}
      onSubmit={() => void submit()}
      titleId="dept-form-title"
      footer={
        <FormFooter
          onCancel={onClose}
          submitLabel={
            isAdd
              ? (t("departments.add") as string)
              : t("settingsForms.saveChanges", { defaultValue: "Save changes" })
          }
          submittingLabel={t("common.saving") as string}
          submitting={submitting}
          canSubmit={complete}
        />
      }
    >
      {error && <FormNotice tone="danger">{error}</FormNotice>}
      <FormSection
        title={t("settingsForms.identitySection", { defaultValue: "Identity" })}
        description={t("settingsForms.dept.identityDesc", { defaultValue: "The code is the stable key used by imports; the name is what people see." })}
      >
        <Field
          label={t("departments.field.code") as string}
          htmlFor="dept-code"
          required={isAdd}
          error={fieldErrors.code}
          help={isAdd ? (t("departments.hint.code") as string) : t("settingsForms.codeLocked", { defaultValue: "Codes can't be changed after create." })}
        >
          <input
            id="dept-code"
            type="text"
            value={code}
            disabled={!isAdd}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              if (fieldErrors.code) setFieldErrors((p) => ({ ...p, code: undefined }));
            }}
            onBlur={(e) => blurRequired("code", e.target.value)}
            placeholder="ENG"
            className="input mono"
          />
        </Field>
        <Field label={t("departments.field.name") as string} htmlFor="dept-name" required error={fieldErrors.name}>
          <input
            id="dept-name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (fieldErrors.name) setFieldErrors((p) => ({ ...p, name: undefined }));
            }}
            onBlur={(e) => blurRequired("name", e.target.value)}
            placeholder={t("departments.placeholder.name") as string}
            className="input"
          />
        </Field>
      </FormSection>
      <FormSection
        title={t("settingsForms.placementSection", { defaultValue: "Placement" })}
        description={t("settingsForms.dept.placementDesc", { defaultValue: "Where this department sits in the org hierarchy." })}
      >
        <Field
          label={t("departments.field.division")}
          htmlFor="dept-division"
          help={t("departments.field.divisionHint")}
          span={2}
        >
          <select
            id="dept-division"
            className="select"
            value={divisionId}
            onChange={(e) => setDivisionId(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">{t("departments.divisionNoneForm")}</option>
            {divisions.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} · {d.name}
              </option>
            ))}
          </select>
        </Field>
      </FormSection>
    </SettingsFormModal>
  );
}
