// Settings → Sections (P29 #3b).
//
// Finest-grained tier of the org hierarchy: division → department →
// section. Each section nests inside one department. Section
// managers (assigned via user_sections) see ONLY employees in that
// specific section — narrower than department-tier visibility.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import { useDepartments } from "../features/departments/hooks";
import {
  type Section,
  type SectionManager,
  useAssignSectionManager,
  useCreateSection,
  useDeleteSection,
  useRemoveSectionManager,
  useSectionManagers,
  useSections,
  useUpdateSection,
} from "../features/sections/hooks";
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
import { EmptyPanel, KebabMenu, FilterSelect, ResetButton, SearchField, Toolbar } from "../components/ListPageUi";
import { SkeletonChip, SkeletonLines, SkeletonRows } from "../components/Skeleton";
import { Field, FormFooter, FormNotice, FormSection } from "../components/FormKit";

export function SectionsPage() {
  const { t } = useTranslation();
  const [filterDept, setFilterDept] = useState<number | "">("");
  const list = useSections(filterDept === "" ? null : Number(filterDept));
  const departments = useDepartments();
  const create = useCreateSection();
  const update = useUpdateSection();
  const del = useDeleteSection();

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Section | null>(null);
  const [managing, setManaging] = useState<Section | null>(null);
  const [q, setQ] = useState("");

  const allItems = list.data?.items ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allItems;
    return allItems.filter((s) =>
      [s.code, s.name, s.department_code ?? "", s.department_name ?? ""].some((v) =>
        v.toLowerCase().includes(needle),
      ),
    );
  }, [allItems, q]);
  const filtersActive = !!q || filterDept !== "";
  const resetFilters = () => {
    setQ("");
    setFilterDept("");
  };

  const [deleting, setDeleting] = useState<Section | null>(null);
  const onDelete = (s: Section) => {
    del.mutate(s.id, {
      onSuccess: () => {
        toast.success(t("sectionsPage.toastDeleted"));
        setDeleting(null);
      },
      onError: (err) => {
        const detail =
          err instanceof ApiError
            ? (err.body as { detail?: { message?: string } })?.detail?.message
            : null;
        toast.error(detail ?? t("sectionsPage.toastDeleteFailed"));
      },
    });
  };

  const noDepartments = !departments.data || departments.data.items.length === 0;
  // The list is server-filtered by department, so "no records at all"
  // is only certain when no filter is applied.
  const trulyEmpty = !list.isLoading && !list.isError && allItems.length === 0 && !filtersActive;
  const showToolbar = !list.isError && !trulyEmpty;

  const addButton = (
    <button
      type="button"
      className="btn btn-primary"
      onClick={() => setShowAdd(true)}
      disabled={noDepartments}
      title={noDepartments ? t("sectionsPage.needDepartmentFirst") : ""}
    >
      <Icon name="plus" size={11} />
      {t("sectionsPage.addSection")}
    </button>
  );

  return (
    <SettingsPage
      wide
      title={t("sectionsPage.title")}
      subtitle={t("sectionsPage.subtitle")}
      actions={addButton}
    >
      {showToolbar && (
        <Toolbar>
          <SearchField
            value={q}
            onChange={setQ}
            placeholder={t("settingsUi.org.searchSections", { defaultValue: "Search by code, name or department" })}
            clearLabel={t("settingsUi.org.clearSearch", { defaultValue: "Clear search" })}
          />
          <FilterSelect
            label={t("sectionsPage.col.department")}
            value={filterDept === "" ? "" : String(filterDept)}
            onChange={(v) => setFilterDept(v === "" ? "" : Number(v))}
            options={[
              ["", t("sectionsPage.allDepartments")],
              ...(departments.data?.items ?? []).map(
                (d) => [String(d.id), `${d.code} · ${d.name}`] as [string, string],
              ),
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
          title={t("settingsUi.org.sectionsLoadFailed", { defaultValue: "Couldn't load sections" })}
          onRetry={() => void list.refetch()}
        />
      ) : trulyEmpty ? (
        <EmptyPanel
          tone="accent"
          icon={<Icon name="fileText" size={28} />}
          title={t("sectionsPage.emptyAll")}
          body={
            noDepartments
              ? t("sectionsPage.needDepartmentFirst")
              : t("settingsUi.org.sectionsEmptyBody", {
                  defaultValue: "Sections split a department into smaller teams. Add the first one to get started.",
                })
          }
          actions={addButton}
        />
      ) : filtered.length === 0 ? (
        <EmptyPanel
          tone="neutral"
          icon={<Icon name="search" size={28} />}
          title={
            q
              ? t("settingsUi.org.noMatchTitle", { defaultValue: "No matches" })
              : t("sectionsPage.emptyDept")
          }
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
                <th style={{ width: 140 }}>{t("sectionsPage.col.code")}</th>
                <th>{t("sectionsPage.col.name")}</th>
                <th style={{ width: 220 }}>{t("sectionsPage.col.department")}</th>
                <th style={{ width: 110 }}>{t("sectionsPage.col.employees")}</th>
                <th style={{ minWidth: 200 }}>{t("sectionsPage.col.managers")}</th>
                <th style={{ width: 64, textAlign: "end" }}>{t("sectionsPage.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td className="mono text-sm" style={nowrap}>
                    {s.code}
                  </td>
                  <td className="text-sm">
                    <strong>{s.name}</strong>
                  </td>
                  <td className="text-sm">
                    <span className="mono text-xs text-dim">{s.department_code}</span>
                    {" · "}
                    {s.department_name}
                  </td>
                  <td className="mono text-sm">{s.employee_count}</td>
                  <td className="text-sm">
                    <SectionManagerChips sectionId={s.id} />
                  </td>
                  <td>
                    <div className="st-row-actions">
                      <KebabMenu
                        label={t("common.actions", { defaultValue: "Actions" }) as string}
                        items={[
                          { label: t("sectionsPage.managersBtn") as string, icon: <Icon name="users" size={13} />, onClick: () => setManaging(s) },
                          { label: t("common.edit") as string, icon: <Icon name="edit" size={13} />, onClick: () => setEditing(s) },
                          {
                            label: t("common.delete") as string,
                            icon: <Icon name="trash" size={13} />,
                            danger: true,
                            onClick: () => {
                              if (!del.isPending) setDeleting(s);
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
        <SectionFormModal
          onClose={() => setShowAdd(false)}
          departments={departments.data?.items ?? []}
          defaultDepartmentId={
            filterDept === "" ? null : Number(filterDept)
          }
          onSubmit={(data) => {
            create.mutate(data, {
              onSuccess: () => {
                toast.success(t("sectionsPage.toastCreated"));
                setShowAdd(false);
              },
              onError: (err) => {
                const detail =
                  err instanceof ApiError
                    ? (err.body as { detail?: { message?: string } })?.detail?.message
                    : null;
                toast.error(detail ?? t("sectionsPage.toastCreateFailed"));
              },
            });
          }}
          submitting={create.isPending}
        />
      )}

      {editing && (
        <SectionFormModal
          initial={editing}
          departments={departments.data?.items ?? []}
          onClose={() => setEditing(null)}
          onSubmit={(data) => {
            update.mutate(
              { id: editing.id, name: data.name },
              {
                onSuccess: () => {
                  toast.success(t("sectionsPage.toastUpdated"));
                  setEditing(null);
                },
                onError: () => toast.error(t("sectionsPage.toastUpdateFailed")),
              },
            );
          }}
          submitting={update.isPending}
        />
      )}

      {managing && (
        <SectionManagersModal
          section={managing}
          onClose={() => setManaging(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          titleId="section-delete-title"
          title={t("settingsForms.section.deleteTitle", { defaultValue: "Delete section" })}
          subtitle={`${deleting.department_code ?? ""}/${deleting.code} · ${deleting.name}`}
          confirmLabel={t("settingsForms.section.deleteAction", { defaultValue: "Delete section" })}
          busy={del.isPending}
          onConfirm={() => onDelete(deleting)}
          onClose={() => setDeleting(null)}
        >
          <p className="st-confirm-text">{t("sectionsPage.confirmDelete", { name: deleting.name })}</p>
        </ConfirmModal>
      )}
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------
// Form modal
// ---------------------------------------------------------------------------

function SectionFormModal({
  initial,
  departments,
  defaultDepartmentId,
  onClose,
  onSubmit,
  submitting,
}: {
  initial?: Section;
  departments: { id: number; code: string; name: string }[];
  defaultDepartmentId?: number | null;
  onClose: () => void;
  onSubmit: (data: { code: string; name: string; department_id: number }) => void;
  submitting: boolean;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [departmentId, setDepartmentId] = useState<number | "">(
    initial?.department_id ?? defaultDepartmentId ?? "",
  );
  const isEdit = !!initial;
  const [errors, setErrors] = useState<{ department?: string | undefined; code?: string | undefined; name?: string | undefined }>({});

  const deptError = (v: number | ""): string | undefined =>
    isEdit || v !== "" ? undefined : t("settingsForms.section.departmentRequired", { defaultValue: "Pick a department." });
  const codeError = (v: string): string | undefined => {
    if (isEdit) return undefined;
    if (!v.trim()) return t("settingsForms.codeRequired", { defaultValue: "Code is required." });
    if (!/^[A-Z0-9_]{1,16}$/.test(v.trim()))
      return t("settingsForms.codePattern", { defaultValue: "Use 1-16 uppercase letters, digits or underscores." });
    return undefined;
  };
  const nameError = (v: string): string | undefined =>
    v.trim() ? undefined : t("settingsForms.nameRequired", { defaultValue: "Name is required." });

  const handleSubmit = () => {
    const next = { department: deptError(departmentId), code: codeError(code), name: nameError(name) };
    setErrors(next);
    if (next.department || next.code || next.name) return;
    if (!code.trim() || !name.trim() || departmentId === "") return;
    onSubmit({
      code: code.trim().toUpperCase(),
      name: name.trim(),
      department_id: Number(departmentId),
    });
  };

  return (
    <SettingsFormModal
      icon={<Icon name="user" size={18} />}
      title={isEdit ? t("sectionsPage.editTitle") : t("sectionsPage.addTitle")}
      subtitle={
        isEdit
          ? t("settingsForms.section.editSubtitle", { defaultValue: "Rename this section. Department and code stay fixed." })
          : t("settingsForms.section.addSubtitle", { defaultValue: "Create a team inside a department with its own managers." })
      }
      onClose={onClose}
      onSubmit={handleSubmit}
      titleId="section-form-title"
      footer={
        <FormFooter
          onCancel={onClose}
          submitLabel={isEdit ? t("settingsForms.saveChanges", { defaultValue: "Save changes" }) : t("sectionsPage.addSection")}
          submittingLabel={t("sectionsPage.saving")}
          submitting={submitting}
          canSubmit={!!code.trim() && !!name.trim() && departmentId !== ""}
        />
      }
    >
      <FormSection
        step={1}
        title={t("settingsForms.placementSection", { defaultValue: "Placement" })}
        description={t("sectionsPage.field.departmentHint")}
        columns={1}
      >
        <Field label={t("sectionsPage.field.department")} htmlFor="section-department" required={!isEdit} error={errors.department}>
          <select
            id="section-department"
            className="select"
            value={departmentId}
            onChange={(e) => {
              const v = e.target.value === "" ? "" : Number(e.target.value);
              setDepartmentId(v);
              if (errors.department) setErrors((p) => ({ ...p, department: deptError(v) }));
            }}
            onBlur={() => setErrors((p) => ({ ...p, department: deptError(departmentId) }))}
            disabled={isEdit}
            required
          >
            <option value="">{t("sectionsPage.pickDepartment")}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} · {d.name}
              </option>
            ))}
          </select>
        </Field>
      </FormSection>
      <FormSection
        step={2}
        title={t("settingsForms.identitySection", { defaultValue: "Identity" })}
        description={t("settingsForms.section.identityDesc", { defaultValue: "The code is unique within its department; the name is what people see." })}
      >
        <Field
          label={t("sectionsPage.field.code")}
          htmlFor="section-code"
          required={!isEdit}
          error={errors.code}
          help={isEdit ? t("settingsForms.codeLocked", { defaultValue: "Codes can't be changed after create." }) : t("sectionsPage.field.codeHint")}
        >
          <input
            id="section-code"
            className="input mono"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              if (errors.code) setErrors((p) => ({ ...p, code: undefined }));
            }}
            onBlur={(e) => setErrors((p) => ({ ...p, code: codeError(e.target.value) }))}
            disabled={isEdit}
            placeholder={t("sectionsPage.field.codePlaceholder")}
            required
            maxLength={16}
            pattern="[A-Z0-9_]{1,16}"
          />
        </Field>
        <Field label={t("sectionsPage.field.name")} htmlFor="section-name" required error={errors.name}>
          <input
            id="section-name"
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
            }}
            onBlur={(e) => setErrors((p) => ({ ...p, name: nameError(e.target.value) }))}
            placeholder={t("sectionsPage.field.namePlaceholder")}
            required
            maxLength={120}
          />
        </Field>
      </FormSection>
    </SettingsFormModal>
  );
}

// ---------------------------------------------------------------------------
// Manager chips + assignment modal
// ---------------------------------------------------------------------------

function SectionManagerChips({ sectionId }: { sectionId: number }) {
  const { t } = useTranslation();
  const list = useSectionManagers(sectionId);
  if (list.isLoading) return <SkeletonChip />;
  if (list.isError)
    return (
      <span className="text-xs" style={{ color: "var(--danger-text)" }}>
        {t("sectionsPage.chipsLoadFailed")}
      </span>
    );
  const items = list.data?.items ?? [];
  if (items.length === 0)
    return <span className="text-xs text-dim">{t("sectionsPage.noManagersInline")}</span>;
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

function SectionManagersModal({
  section,
  onClose,
}: {
  section: Section;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const assigned = useSectionManagers(section.id);
  const assign = useAssignSectionManager();
  const remove = useRemoveSectionManager();
  const candidates = useQuery({
    queryKey: ["users", "managers"],
    queryFn: () =>
      api<ManagerCandidateListResponse>(
        "/api/users?role=Manager&active_only=true",
      ),
    staleTime: 60 * 1000,
  });
  const [pickedId, setPickedId] = useState<number | "">("");

  const assignedIds = useMemo(
    () => new Set((assigned.data?.items ?? []).map((m) => m.user_id)),
    [assigned.data],
  );
  const available =
    candidates.data?.items.filter((u) => !assignedIds.has(u.id)) ?? [];

  const onAssign = () => {
    if (pickedId === "") return;
    assign.mutate(
      { sectionId: section.id, userId: Number(pickedId) },
      {
        onSuccess: () => {
          toast.success(t("sectionsPage.toastManagerAssigned"));
          setPickedId("");
        },
        onError: (err) => {
          const detail =
            err instanceof ApiError
              ? (err.body as { detail?: { message?: string } })?.detail?.message
              : null;
          toast.error(detail ?? t("sectionsPage.toastAssignFailed"));
        },
      },
    );
  };

  const onRemove = (m: SectionManager) => {
    remove.mutate(
      { sectionId: section.id, userId: m.user_id },
      {
        onSuccess: () => toast.success(t("sectionsPage.toastManagerRemoved", { name: m.full_name })),
        onError: () => toast.error(t("sectionsPage.toastRemoveFailed")),
      },
    );
  };

  return (
    <SettingsFormModal
      icon={<Icon name="users" size={18} />}
      title={t("settingsForms.section.managersTitle", { defaultValue: "Section managers" })}
      subtitle={`${section.department_code}/${section.code} · ${section.name}`}
      onClose={onClose}
      onSubmit={onAssign}
      size="lg"
      titleId="section-managers-title"
      footer={
        <CloseFooter
          onClose={onClose}
          label={t("sectionsPage.close")}
          note={t("settingsForms.managersNote", { defaultValue: "Changes save as soon as you assign or remove." })}
        />
      }
    >
      <FormNotice tone="info">{t("sectionsPage.managers.scopeHint")}</FormNotice>
      <FormSection
        step={1}
        title={t("sectionsPage.managers.addLabel")}
        description={t("settingsForms.managersAddDesc", { defaultValue: "Only users holding the Manager role appear in this list." })}
        columns={1}
      >
        <Field label={t("settingsForms.managerLabel", { defaultValue: "Manager" })} htmlFor="section-manager-pick">
          <div className="st-pick-row">
            <select
              id="section-manager-pick"
              className="select"
              value={pickedId}
              onChange={(e) => setPickedId(e.target.value === "" ? "" : Number(e.target.value))}
              disabled={candidates.isLoading || assign.isPending}
            >
              <option value="">
                {candidates.isLoading
                  ? t("sectionsPage.managers.loadingCandidates")
                  : available.length === 0
                    ? t("sectionsPage.managers.allAssigned")
                    : t("sectionsPage.managers.pickPlaceholder")}
              </option>
              {available.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name} · {u.email}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={pickedId === "" || assign.isPending}>
              <Icon name="plus" size={12} />
              {assign.isPending ? t("sectionsPage.managers.assigning") : t("sectionsPage.managers.assignBtn")}
            </button>
          </div>
        </Field>
      </FormSection>

      <FormSection
        step={2}
        title={t("sectionsPage.managers.currentlyAssigned")}
        description={t("settingsForms.managersAssignedDesc", { defaultValue: "Remove a manager to stop their visibility over this unit." })}
        columns={1}
      >
        {assigned.isLoading && <SkeletonLines lines={2} />}
        {!assigned.isLoading && (assigned.data?.items.length ?? 0) === 0 && (
          <div className="text-sm text-dim">{t("sectionsPage.managers.emptyAssigned")}</div>
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
                  title={t("sectionsPage.managers.removeBtnTitle")}
                >
                  <Icon name="x" size={11} />
                  {t("sectionsPage.managers.removeBtn")}
                </button>
              </div>
            ))}
          </div>
        )}
      </FormSection>
    </SettingsFormModal>
  );
}
