// Settings → Custom Fields. Admin-only field definition editor.
//
// Three jobs in one page:
//   1. List existing fields with drag-handle reorder.
//   2. Add-field modal for a new field (text/number/date/select).
//   3. Per-row edit modal (rename, toggle required, edit options for
//      select) and delete-with-confirmation (warns the value cascade).
//
// Drag and drop uses native HTML5 — no new dependencies. Same approach
// as the P8 manager-assignments page.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../shell/Icon";
import {
  useCreateCustomField,
  useCustomFields,
  useDeleteCustomField,
  usePatchCustomField,
  useReorderCustomFields,
} from "./hooks";
import type {
  CustomField,
  CustomFieldCreateInput,
  CustomFieldType,
} from "./types";
import { CUSTOM_FIELD_TYPES } from "./types";
import { SkeletonTable } from "../components/Skeleton";
import { EmptyPanel } from "../components/ListPageUi";

import "./custom-fields.css";
import { ChoiceCards, Field, FormFooter, FormNotice, FormSection, SwitchField } from "../components/FormKit";
import {
  ConfirmModal,
  LoadErrorPanel,
  SettingsCard,
  SettingsFormModal,
  SettingsPage,
  SoftPill,
} from "../settings/settingsUi";

export function CustomFieldsPage() {
  const { t } = useTranslation();
  const fields = useCustomFields();
  const create = useCreateCustomField();
  const reorder = useReorderCustomFields();

  const [pendingDelete, setPendingDelete] = useState<CustomField | null>(null);
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Drag state — index of the row being dragged over (for the visual cue).
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [dragSourceIdx, setDragSourceIdx] = useState<number | null>(null);

  // Local optimistic ordering — when the user drops, we reorder this
  // array and PATCH; on success the query invalidates and refills.
  const [localOrder, setLocalOrder] = useState<CustomField[]>([]);
  useEffect(() => {
    if (fields.data) setLocalOrder(fields.data);
  }, [fields.data]);

  const orderedFields = useMemo(() => localOrder, [localOrder]);

  const handleDrop = (toIdx: number) => {
    if (dragSourceIdx === null || dragSourceIdx === toIdx) {
      setDragSourceIdx(null);
      setDragOverIdx(null);
      return;
    }
    const next = [...orderedFields];
    const [moved] = next.splice(dragSourceIdx, 1);
    if (moved) next.splice(toIdx, 0, moved);
    setLocalOrder(next);
    setDragSourceIdx(null);
    setDragOverIdx(null);
    void reorder.mutateAsync(
      next.map((f, idx) => ({ id: f.id, display_order: idx })),
    );
  };

  return (
    <SettingsPage
      title={t("customFields.title")}
      subtitle={
        <>
          {t("customFields.subtitlePrefix")}{" "}
          <span className="mono">badge_number</span>{" "}
          {t("customFields.subtitleSuffix")}
        </>
      }
      actions={
        <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Icon name="plus" size={12} />
          {t("customFields.addField")}
        </button>
      }
    >
      {showCreate && (
        <CreateForm
          onCreate={(input) => create.mutateAsync(input)}
          creating={create.isPending}
          onClose={() => setShowCreate(false)}
        />
      )}
      {editing && <EditForm field={editing} onClose={() => setEditing(null)} />}

      <SettingsCard
        icon={<Icon name="clipboard" size={17} />}
        title={t("settingsUi.customFields.listTitle", { defaultValue: "Fields" })}
        description={t("settingsUi.customFields.listDesc", {
          defaultValue: "Drag a field by its handle to change the order it appears in on the employee record.",
        })}
        actions={
          orderedFields.length > 0 ? (
            <SoftPill tone="neutral" dot={false}>
              {t("settingsUi.customFields.count", {
                defaultValue: "{{count}} fields",
                count: orderedFields.length,
              })}
            </SoftPill>
          ) : undefined
        }
        tight
      >
        {fields.isLoading ? (
          <SkeletonTable rows={5} cols={5} />
        ) : fields.error ? (
          <LoadErrorPanel
            title={t("customFields.loadFailed")}
            onRetry={() => void fields.refetch()}
          />
        ) : orderedFields.length === 0 ? (
          <EmptyPanel
            tone="accent"
            icon={<Icon name="clipboard" size={28} />}
            title={t("settingsUi.customFields.emptyTitle", { defaultValue: "No custom fields yet" })}
            body={t("settingsUi.customFields.emptyBody", {
              defaultValue: "Add extra details to every employee record, such as a badge number or blood group.",
            })}
            actions={
              <button type="button" className="btn" onClick={() => setShowCreate(true)}>
                <Icon name="plus" size={12} />
                {t("customFields.addField")}
              </button>
            }
          />
        ) : (
          <div className="st-list">
            {orderedFields.map((field, idx) => (
              <FieldRow
                key={field.id}
                field={field}
                onStartEdit={() => setEditing(field)}
                onAskDelete={() => setPendingDelete(field)}
                draggingOver={dragOverIdx === idx}
                onDragStart={() => setDragSourceIdx(idx)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverIdx(idx);
                }}
                onDragLeave={() => setDragOverIdx(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(idx);
                }}
              />
            ))}
          </div>
        )}
      </SettingsCard>

      {pendingDelete && (
        <DeleteConfirmModal
          field={pendingDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseOptions(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function OptionsField({
  id,
  label,
  value,
  onChange,
  error,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null | undefined;
  placeholder?: string | undefined;
}) {
  const { t } = useTranslation();
  const count = parseOptions(value).length;
  return (
    <Field
      label={label}
      htmlFor={id}
      required
      span={2}
      error={error}
      help={t("settingsUi.forms.customFields.optionsHelp", {
        defaultValue: "{{count}} options — the list employees pick from.",
        count,
      })}
    >
      <textarea
        id={id}
        className="textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
      />
    </Field>
  );
}

const TYPE_ICON: Record<CustomFieldType, "fileText" | "database" | "calendar" | "menu"> = {
  text: "fileText",
  number: "database",
  date: "calendar",
  select: "menu",
};

// ---------------------------------------------------------------------------
// Create form (modal)
// ---------------------------------------------------------------------------

type CreateErrors = { name?: string; code?: string; options?: string; form?: string };

function CreateForm({
  onCreate,
  creating,
  onClose,
}: {
  onCreate: (input: CustomFieldCreateInput) => Promise<unknown>;
  creating: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [required, setRequired] = useState(false);
  const [optionsText, setOptionsText] = useState("");
  const [errors, setErrors] = useState<CreateErrors>({});

  const typeDesc: Record<CustomFieldType, string> = {
    text: t("settingsUi.forms.customFields.typeTextDesc", { defaultValue: "Free text, e.g. a badge number." }),
    number: t("settingsUi.forms.customFields.typeNumberDesc", { defaultValue: "Whole or decimal numbers." }),
    date: t("settingsUi.forms.customFields.typeDateDesc", { defaultValue: "A calendar date." }),
    select: t("settingsUi.forms.customFields.typeSelectDesc", { defaultValue: "One value from a fixed list." }),
  };

  const submit = async () => {
    setErrors({});
    const trimmedCode = code.trim();
    if (!name.trim() || !trimmedCode) {
      const msg = t("customFields.errNameCodeRequired");
      setErrors({
        ...(!name.trim() ? { name: msg } : {}),
        ...(!trimmedCode ? { code: msg } : {}),
      });
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(trimmedCode)) {
      setErrors({ code: t("customFields.errCodeFormat") });
      return;
    }
    let options: string[] | undefined;
    if (type === "select") {
      options = parseOptions(optionsText);
      if (options.length === 0) {
        setErrors({ options: t("customFields.errOptionsRequired") });
        return;
      }
    }
    try {
      await onCreate({
        name: name.trim(),
        code: trimmedCode,
        type,
        required,
        ...(options ? { options } : {}),
      });
      onClose();
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : t("customFields.errSaveGeneric") });
    }
  };

  return (
    <SettingsFormModal
      titleId="cf-create-title"
      size="lg"
      icon={<Icon name="clipboard" size={18} />}
      title={t("settingsUi.forms.customFields.addTitle", { defaultValue: "Add custom field" })}
      subtitle={t("settingsUi.customFields.addDesc", {
        defaultValue: "The code must be lower-case letters, numbers and underscores. It becomes the Excel column header.",
      })}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <FormFooter
          onCancel={onClose}
          submitLabel={t("customFields.addField")}
          submittingLabel={t("customFields.saving")}
          submitting={creating}
          canSubmit={name.trim() !== "" && code.trim() !== ""}
        />
      }
    >
      {errors.form && <FormNotice tone="danger">{errors.form}</FormNotice>}
      <FormSection
        title={t("settingsUi.forms.customFields.identitySection", { defaultValue: "Field" })}
        description={t("settingsUi.forms.customFields.identitySectionDesc", {
          defaultValue: "The label HR sees and the code used in Excel files.",
        })}
      >
        <Field label={t("customFields.field.name")} htmlFor="cf-new-name" required error={errors.name}>
          <input
            id="cf-new-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("customFields.field.namePlaceholder")}
          />
        </Field>
        <Field label={t("customFields.field.code")} htmlFor="cf-new-code" required error={errors.code}>
          <input
            id="cf-new-code"
            className="input mono"
            value={code}
            onChange={(e) => setCode(e.target.value.toLowerCase())}
            placeholder="badge_number"
          />
        </Field>
      </FormSection>
      <FormSection
        title={t("customFields.field.type")}
        description={t("settingsUi.forms.customFields.typeSectionDesc", {
          defaultValue: "The type can't be changed after the field is created.",
        })}
      >
        <ChoiceCards<CustomFieldType>
          label={t("customFields.field.type")}
          value={type}
          onChange={setType}
          options={CUSTOM_FIELD_TYPES.map((opt) => ({
            value: opt,
            title: <span className="cf-cap">{t(`customFields.types.${opt}`)}</span>,
            description: typeDesc[opt],
            icon: <Icon name={TYPE_ICON[opt]} size={15} />,
          }))}
        />
        {type === "select" && (
          <OptionsField
            id="cf-new-options"
            label={t("customFields.field.options")}
            value={optionsText}
            onChange={setOptionsText}
            error={errors.options}
            placeholder={t("customFields.field.optionsPlaceholder")}
          />
        )}
        <SwitchField
          id="cf-new-required"
          label={t("customFields.required")}
          description={t("settingsUi.forms.customFields.requiredDesc", {
            defaultValue: "HR must fill this in when saving an employee.",
          })}
          checked={required}
          onChange={setRequired}
        />
      </FormSection>
    </SettingsFormModal>
  );
}

// ---------------------------------------------------------------------------
// Per-row
// ---------------------------------------------------------------------------

interface FieldRowProps {
  field: CustomField;
  onStartEdit: () => void;
  onAskDelete: () => void;
  draggingOver: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}

function FieldRow({
  field,
  onStartEdit,
  onAskDelete,
  draggingOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: FieldRowProps) {
  const { t } = useTranslation();
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`st-drag-row${draggingOver ? " is-over" : ""}`}
    >
      <div className="st-inline cf-row">
        <span
          title={t("customFields.dragHandle")}
          aria-label={t("customFields.dragHandle")}
          className="st-drag-handle"
        >
          <Icon name="moreVertical" size={16} />
        </span>
        <div className="cf-row-main">
          <div className="cf-row-name">{field.name}</div>
          <div className="text-xs text-dim mono">{field.code}</div>
        </div>
        <div className="st-inline cf-row-meta">
          <SoftPill tone="info" dot={false}>{t(`customFields.types.${field.type}`)}</SoftPill>
          {field.required && (
            <SoftPill tone="warning">{t("customFields.requiredPill")}</SoftPill>
          )}
          {field.type === "select" && field.options && (
            <span className="text-xs text-dim">
              {t("customFields.optionCount", { count: field.options.length })}
            </span>
          )}
        </div>
        <div className="st-row-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onStartEdit}>
            <Icon name="edit" size={11} /> {t("customFields.edit")}
          </button>
          <button type="button" className="btn btn-sm btn-ghost st-danger" onClick={onAskDelete}>
            <Icon name="trash" size={12} /> {t("customFields.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditForm({
  field,
  onClose,
}: {
  field: CustomField;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const patch = usePatchCustomField(field.id);
  const [name, setName] = useState(field.name);
  const [required, setRequired] = useState(field.required);
  const [optionsText, setOptionsText] = useState(
    field.options ? field.options.join("\n") : "",
  );
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setOptionsError(null);
    const body: {
      name?: string;
      required?: boolean;
      options?: string[];
    } = {};
    if (name.trim() !== field.name) body.name = name.trim();
    if (required !== field.required) body.required = required;
    if (field.type === "select") {
      const opts = parseOptions(optionsText);
      if (opts.length === 0) {
        setOptionsError(t("customFields.errOptionsRequired"));
        return;
      }
      const sameLength =
        field.options && field.options.length === opts.length;
      const sameOrder =
        sameLength &&
        field.options!.every((o, i) => o === opts[i]);
      if (!sameOrder) body.options = opts;
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    try {
      await patch.mutateAsync(body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customFields.errSaveChanges"));
    }
  };

  return (
    <SettingsFormModal
      titleId="cf-edit-title"
      size={field.type === "select" ? "lg" : "md"}
      icon={<Icon name="edit" size={18} />}
      title={t("settingsUi.forms.customFields.editTitle", { defaultValue: "Edit custom field" })}
      subtitle={t("settingsUi.forms.customFields.editSub", {
        defaultValue: "Rename the field or change whether it's required. The code and type stay fixed.",
      })}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <FormFooter
          onCancel={onClose}
          submitLabel={t("settingsUi.forms.saveChanges", { defaultValue: "Save changes" })}
          submittingLabel={t("customFields.saving")}
          submitting={patch.isPending}
        />
      }
    >
      {error && <FormNotice tone="danger">{error}</FormNotice>}
      <FormSection
        title={t("settingsUi.forms.customFields.identitySection", { defaultValue: "Field" })}
        description={t("settingsUi.forms.customFields.identitySectionDesc", {
          defaultValue: "The label HR sees and the code used in Excel files.",
        })}
      >
        <Field label={t("customFields.field.name")} htmlFor={`cf-edit-name-${field.id}`}>
          <input
            id={`cf-edit-name-${field.id}`}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t("customFields.field.code")} htmlFor={`cf-edit-code-${field.id}`}>
          <input id={`cf-edit-code-${field.id}`} className="input mono" value={field.code} disabled readOnly />
        </Field>
        <Field label={t("customFields.field.type")} htmlFor={`cf-edit-type-${field.id}`} span={2}>
          <input
            id={`cf-edit-type-${field.id}`}
            className="input cf-cap"
            value={t(`customFields.types.${field.type}`)}
            disabled
            readOnly
          />
        </Field>
        {field.type === "select" && (
          <OptionsField
            id={`cf-edit-options-${field.id}`}
            label={t("customFields.field.optionsOnePerLine")}
            value={optionsText}
            onChange={setOptionsText}
            error={optionsError}
          />
        )}
        <SwitchField
          id={`cf-edit-required-${field.id}`}
          label={t("customFields.required")}
          description={t("settingsUi.forms.customFields.requiredDesc", {
            defaultValue: "HR must fill this in when saving an employee.",
          })}
          checked={required}
          onChange={setRequired}
        />
      </FormSection>
    </SettingsFormModal>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm modal
// ---------------------------------------------------------------------------

function DeleteConfirmModal({
  field,
  onClose,
}: {
  field: CustomField;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const del = useDeleteCustomField();
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    try {
      await del.mutateAsync(field.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customFields.errDelete"));
    }
  };

  return (
    <ConfirmModal
      titleId="cf-delete-title"
      title={
        <>
          {t("customFields.deleteTitle")} <span className="mono">{field.code}</span>?
        </>
      }
      subtitle={field.name}
      confirmLabel={del.isPending ? t("customFields.deleting") : t("customFields.deleteCta")}
      busy={del.isPending}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <FormNotice tone={error ? "danger" : "warning"}>{error ?? t("customFields.deleteBody")}</FormNotice>
    </ConfirmModal>
  );
}
