// Settings → Divisions (P29 #3b).
//
// Top tier of the org hierarchy. A division contains many
// departments; a division manager (assigned via user_divisions) sees
// every employee in every department under that division — picked up
// automatically by the existing get_manager_visible_employee_ids
// scope helper. Symmetric with DepartmentsPage's manager-modal flow.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import {
  type Division,
  type DivisionManager,
  useAssignDivisionManager,
  useCreateDivision,
  useDeleteDivision,
  useDivisionManagers,
  useDivisions,
  useRemoveDivisionManager,
  useUpdateDivision,
} from "../features/divisions/hooks";
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
import { EmptyPanel, KebabMenu, ResetButton, SearchField, Toolbar } from "../components/ListPageUi";
import { SkeletonChip, SkeletonLines, SkeletonRows } from "../components/Skeleton";
import { Field, FormFooter, FormNotice, FormSection } from "../components/FormKit";

export function DivisionsPage() {
  const { t } = useTranslation();
  const list = useDivisions();
  const create = useCreateDivision();
  const update = useUpdateDivision();
  const del = useDeleteDivision();

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Division | null>(null);
  const [managing, setManaging] = useState<Division | null>(null);
  const [q, setQ] = useState("");

  const allItems = list.data?.items ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allItems;
    return allItems.filter((d) =>
      [d.code, d.name].some((v) => v.toLowerCase().includes(needle)),
    );
  }, [allItems, q]);

  const [deleting, setDeleting] = useState<Division | null>(null);
  const onDelete = (d: Division) => {
    del.mutate(d.id, {
      onSuccess: () => {
        toast.success(t("divisions.toast.deleted") as string);
        setDeleting(null);
      },
      onError: (err) => {
        const detail =
          err instanceof ApiError
            ? (err.body as { detail?: { message?: string } })?.detail?.message
            : null;
        toast.error(detail ?? (t("divisions.toast.deleteFailed") as string));
      },
    });
  };

  const hasRecords = allItems.length > 0;
  const showToolbar = list.isLoading || (hasRecords && !list.isError);

  return (
    <SettingsPage
      wide
      title={t("divisions.title") as string}
      subtitle={t("divisions.subtitle") as string}
      actions={
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Icon name="plus" size={11} />
          {t("divisions.add") as string}
        </button>
      }
    >
      {showToolbar && (
        <Toolbar>
          <SearchField
            value={q}
            onChange={setQ}
            placeholder={t("settingsUi.org.searchDivisions", { defaultValue: "Search by code or name" })}
            clearLabel={t("settingsUi.org.clearSearch", { defaultValue: "Clear search" })}
          />
          <ResetButton
            active={!!q}
            label={t("settingsUi.org.reset", { defaultValue: "Reset" })}
            onClick={() => setQ("")}
          />
        </Toolbar>
      )}

      {list.isLoading ? (
        <TableCard>
          <table className="table">
            <tbody>
              <SkeletonRows cols={5} />
            </tbody>
          </table>
        </TableCard>
      ) : list.isError ? (
        <LoadErrorPanel
          title={t("settingsUi.org.divisionsLoadFailed", { defaultValue: "Couldn't load divisions" })}
          onRetry={() => void list.refetch()}
        />
      ) : !hasRecords ? (
        <EmptyPanel
          tone="accent"
          icon={<Icon name="database" size={28} />}
          title={t("divisions.empty") as string}
          body={t("settingsUi.org.divisionsEmptyBody", {
            defaultValue: "Divisions group departments together. Add your first division to get started.",
          })}
          actions={
            <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={12} />
              {t("divisions.add") as string}
            </button>
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
            <button type="button" className="btn" onClick={() => setQ("")}>
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
                <th style={{ width: 140 }}>{t("divisions.col.code") as string}</th>
                <th>{t("divisions.col.name") as string}</th>
                <th style={{ width: 130 }}>{t("divisions.col.departments") as string}</th>
                <th style={{ minWidth: 200 }}>{t("divisions.col.managers") as string}</th>
                <th style={{ width: 64, textAlign: "end" }}>{t("divisions.col.actions") as string}</th>
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
                  <td className="mono text-sm">{d.department_count}</td>
                  <td className="text-sm">
                    <DivisionManagerChips divisionId={d.id} />
                  </td>
                  <td>
                    <div className="st-row-actions">
                      <KebabMenu
                        label={t("common.actions", { defaultValue: "Actions" }) as string}
                        items={[
                          { label: t("divisions.managersBtn") as string, icon: <Icon name="users" size={13} />, onClick: () => setManaging(d) },
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
        <DivisionFormModal
          onClose={() => setShowAdd(false)}
          onSubmit={(data) => {
            create.mutate(data, {
              onSuccess: () => {
                toast.success(t("divisions.toast.created") as string);
                setShowAdd(false);
              },
              onError: (err) => {
                const detail =
                  err instanceof ApiError
                    ? (err.body as { detail?: { message?: string } })?.detail?.message
                    : null;
                toast.error(detail ?? (t("divisions.toast.createFailed") as string));
              },
            });
          }}
          submitting={create.isPending}
        />
      )}

      {editing && (
        <DivisionFormModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={(data) => {
            update.mutate(
              { id: editing.id, name: data.name },
              {
                onSuccess: () => {
                  toast.success(t("divisions.toast.updated") as string);
                  setEditing(null);
                },
                onError: () => toast.error(t("divisions.toast.updateFailed") as string),
              },
            );
          }}
          submitting={update.isPending}
        />
      )}

      {managing && (
        <DivisionManagersModal
          division={managing}
          onClose={() => setManaging(null)}
        />
      )}

      {deleting && (
        <ConfirmModal
          titleId="division-delete-title"
          title={t("settingsForms.division.deleteTitle", { defaultValue: "Delete division" })}
          subtitle={`${deleting.code} · ${deleting.name}`}
          confirmLabel={t("settingsForms.division.deleteAction", { defaultValue: "Delete division" })}
          busy={del.isPending}
          onConfirm={() => onDelete(deleting)}
          onClose={() => setDeleting(null)}
        >
          <p className="st-confirm-text">{t("divisions.confirmDelete", { name: deleting.name }) as string}</p>
        </ConfirmModal>
      )}
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------
// Form modal — Add / Edit
// ---------------------------------------------------------------------------

function DivisionFormModal({
  initial,
  onClose,
  onSubmit,
  submitting,
}: {
  initial?: Division;
  onClose: () => void;
  onSubmit: (data: { code: string; name: string }) => void;
  submitting: boolean;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const isEdit = !!initial;
  const [errors, setErrors] = useState<{ code?: string | undefined; name?: string | undefined }>({});

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
    const next = { code: codeError(code), name: nameError(name) };
    setErrors(next);
    if (next.code || next.name) return;
    if (!code.trim() || !name.trim()) return;
    onSubmit({ code: code.trim().toUpperCase(), name: name.trim() });
  };

  return (
    <SettingsFormModal
      icon={<Icon name="database" size={18} />}
      title={(isEdit ? t("divisions.editTitle") : t("divisions.addTitle")) as string}
      subtitle={
        isEdit
          ? t("settingsForms.division.editSubtitle", { defaultValue: "Rename this division. Its code stays fixed." })
          : t("settingsForms.division.addSubtitle", { defaultValue: "Create a top-level unit that groups departments." })
      }
      onClose={onClose}
      onSubmit={handleSubmit}
      titleId="division-form-title"
      footer={
        <FormFooter
          onCancel={onClose}
          submitLabel={
            isEdit
              ? t("settingsForms.saveChanges", { defaultValue: "Save changes" })
              : (t("divisions.add") as string)
          }
          submittingLabel={t("common.saving") as string}
          submitting={submitting}
          canSubmit={!!code.trim() && !!name.trim()}
        />
      }
    >
      <FormSection
        title={t("settingsForms.identitySection", { defaultValue: "Identity" })}
        description={t("settingsForms.division.identityDesc", { defaultValue: "The code is used in Excel imports; the name is what people see." })}
      >
        <Field
          label={t("divisions.field.code") as string}
          htmlFor="division-code"
          required={!isEdit}
          error={errors.code}
          help={isEdit ? t("settingsForms.codeLocked", { defaultValue: "Codes can't be changed after create." }) : (t("divisions.hint.code") as string)}
        >
          <input
            id="division-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              if (errors.code) setErrors((p) => ({ ...p, code: undefined }));
            }}
            onBlur={(e) => setErrors((p) => ({ ...p, code: codeError(e.target.value) }))}
            disabled={isEdit}
            placeholder={t("divisions.placeholder.code") as string}
            className="input mono"
            required
            maxLength={16}
            pattern="[A-Z0-9_]{1,16}"
          />
        </Field>
        <Field label={t("divisions.field.name") as string} htmlFor="division-name" required error={errors.name}>
          <input
            id="division-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
            }}
            onBlur={(e) => setErrors((p) => ({ ...p, name: nameError(e.target.value) }))}
            placeholder={t("divisions.placeholder.name") as string}
            className="input"
            required
            maxLength={120}
          />
        </Field>
      </FormSection>
    </SettingsFormModal>
  );
}

// ---------------------------------------------------------------------------
// Manager chips + assignment modal — mirror of department-managers UX
// ---------------------------------------------------------------------------

function DivisionManagerChips({ divisionId }: { divisionId: number }) {
  const { t } = useTranslation();
  const list = useDivisionManagers(divisionId);
  if (list.isLoading)
    return <SkeletonChip />;
  if (list.isError)
    return (
      <span className="text-xs" style={{ color: "var(--danger-text)" }}>
        {t("divisions.chips.failed") as string}
      </span>
    );
  const items = list.data?.items ?? [];
  if (items.length === 0)
    return <span className="text-xs text-dim">{t("divisions.chips.none") as string}</span>;
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

function DivisionManagersModal({
  division,
  onClose,
}: {
  division: Division;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const assigned = useDivisionManagers(division.id);
  const assign = useAssignDivisionManager();
  const remove = useRemoveDivisionManager();
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
      { divisionId: division.id, userId: Number(pickedId) },
      {
        onSuccess: () => {
          toast.success(t("divisions.managersModal.assignedToast") as string);
          setPickedId("");
        },
        onError: (err) => {
          const detail =
            err instanceof ApiError
              ? (err.body as { detail?: { message?: string } })?.detail?.message
              : null;
          toast.error(detail ?? (t("divisions.managersModal.assignFailed") as string));
        },
      },
    );
  };

  const onRemove = (m: DivisionManager) => {
    remove.mutate(
      { divisionId: division.id, userId: m.user_id },
      {
        onSuccess: () =>
          toast.success(
            t("divisions.managersModal.removedToast", { name: m.full_name }) as string,
          ),
        onError: () => toast.error(t("divisions.managersModal.removeFailed") as string),
      },
    );
  };

  return (
    <SettingsFormModal
      icon={<Icon name="users" size={18} />}
      title={t("settingsForms.division.managersTitle", { defaultValue: "Division managers" })}
      subtitle={`${division.code} · ${division.name}`}
      onClose={onClose}
      onSubmit={onAssign}
      size="lg"
      titleId="division-managers-title"
      footer={
        <CloseFooter
          onClose={onClose}
          note={t("settingsForms.managersNote", { defaultValue: "Changes save as soon as you assign or remove." })}
        />
      }
    >
      <FormNotice tone="info">{t("divisions.managersModal.subtitle") as string}</FormNotice>
      <FormSection
        step={1}
        title={t("divisions.managersModal.addLabel") as string}
        description={t("settingsForms.managersAddDesc", { defaultValue: "Only users holding the Manager role appear in this list." })}
        columns={1}
      >
        <Field label={t("settingsForms.managerLabel", { defaultValue: "Manager" })} htmlFor="division-manager-pick">
          <div className="st-pick-row">
            <select
              id="division-manager-pick"
              className="select"
              value={pickedId}
              onChange={(e) => setPickedId(e.target.value === "" ? "" : Number(e.target.value))}
              disabled={candidates.isLoading || assign.isPending}
            >
              <option value="">
                {(candidates.isLoading
                  ? t("divisions.managersModal.loadingManagers")
                  : available.length === 0
                    ? t("divisions.managersModal.allAssigned")
                    : t("divisions.managersModal.pickManager")) as string}
              </option>
              {available.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name} · {u.email}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={pickedId === "" || assign.isPending}>
              <Icon name="plus" size={12} />
              {(assign.isPending
                ? t("divisions.managersModal.assigning")
                : t("divisions.managersModal.assign")) as string}
            </button>
          </div>
        </Field>
      </FormSection>

      <FormSection
        step={2}
        title={t("divisions.managersModal.currentlyAssigned") as string}
        description={t("settingsForms.managersAssignedDesc", { defaultValue: "Remove a manager to stop their visibility over this unit." })}
        columns={1}
      >
        {assigned.isLoading && <SkeletonLines lines={2} />}
        {!assigned.isLoading && (assigned.data?.items.length ?? 0) === 0 && (
          <div className="text-sm text-dim">{t("divisions.managersModal.noneAssigned") as string}</div>
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
                  title={t("divisions.managersModal.removeTitle") as string}
                >
                  <Icon name="x" size={11} />
                  {t("divisions.managersModal.remove") as string}
                </button>
              </div>
            ))}
          </div>
        )}
      </FormSection>
    </SettingsFormModal>
  );
}
