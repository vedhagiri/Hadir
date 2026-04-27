// Settings → Custom Fields. Admin-only field definition editor.
//
// Three jobs in one page:
//   1. List existing fields with drag-handle reorder.
//   2. Inline create form for a new field (text/number/date/select).
//   3. Per-row edit (rename, toggle required, edit options for select)
//      and delete-with-confirmation (warns the value cascade).
//
// Drag and drop uses native HTML5 — no new dependencies. Same approach
// as the P8 manager-assignments page.

import { useEffect, useMemo, useState } from "react";

import { ModalShell } from "../components/DrawerShell";
import { SettingsTabs } from "../settings/SettingsTabs";
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

export function CustomFieldsPage() {
  const fields = useCustomFields();
  const create = useCreateCustomField();
  const reorder = useReorderCustomFields();

  const [pendingDelete, setPendingDelete] = useState<CustomField | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

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
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsTabs />
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          Custom fields
        </h1>
        <p
          style={{
            margin: 0,
            color: "var(--text-secondary)",
            fontSize: 13,
          }}
        >
          Add extra columns to every employee record. Field codes match the
          column headers in employee Excel imports and exports — so a code
          like <span className="mono">badge_number</span> imports cleanly
          when the spreadsheet has a "Badge Number" column.
        </p>
      </header>

      <CreateForm
        onCreate={(input) => create.mutateAsync(input)}
        creating={create.isPending}
      />

      {fields.isLoading ? (
        <p>Loading fields…</p>
      ) : fields.error ? (
        <p style={{ color: "var(--danger-text)" }}>
          Couldn’t load custom fields.
        </p>
      ) : orderedFields.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--border-strong)",
            borderRadius: "var(--radius)",
            padding: 24,
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: 13,
          }}
        >
          No custom fields yet. Add one above.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {orderedFields.map((field, idx) => (
            <FieldRow
              key={field.id}
              field={field}
              isEditing={editingId === field.id}
              onStartEdit={() => setEditingId(field.id)}
              onCancelEdit={() => setEditingId(null)}
              onAfterSave={() => setEditingId(null)}
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

      {pendingDelete && (
        <DeleteConfirmModal
          field={pendingDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

function CreateForm({
  onCreate,
  creating,
}: {
  onCreate: (input: CustomFieldCreateInput) => Promise<unknown>;
  creating: boolean;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [required, setRequired] = useState(false);
  const [optionsText, setOptionsText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setCode("");
    setType("text");
    setRequired(false);
    setOptionsText("");
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedCode = code.trim();
    if (!name.trim() || !trimmedCode) {
      setError("Name and code are required.");
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(trimmedCode)) {
      setError("Code must be lowercase with underscores (e.g. badge_number).");
      return;
    }
    let options: string[] | undefined;
    if (type === "select") {
      options = optionsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (options.length === 0) {
        setError("Select fields need at least one option.");
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
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save field");
    }
  };

  return (
    <form
      onSubmit={submit}
      style={{
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 12,
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr 0.9fr auto auto",
        gap: 8,
        alignItems: "end",
      }}
    >
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Badge Number"
        />
      </Field>
      <Field label="Code (Excel header)">
        <input
          className="input mono"
          value={code}
          onChange={(e) => setCode(e.target.value.toLowerCase())}
          placeholder="badge_number"
        />
      </Field>
      <Field label="Type">
        <select
          className="input"
          value={type}
          onChange={(e) => setType(e.target.value as CustomFieldType)}
        >
          {CUSTOM_FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <label
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          fontSize: 13,
          paddingBottom: 6,
        }}
      >
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
        Required
      </label>
      <button
        type="submit"
        className="btn btn-primary btn-sm"
        disabled={creating}
      >
        {creating ? "Saving…" : "Add field"}
      </button>
      {type === "select" && (
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Options (comma or newline separated)">
            <textarea
              className="input"
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder="Permanent, Contract, Intern"
              rows={2}
            />
          </Field>
        </div>
      )}
      {error && (
        <div
          style={{
            gridColumn: "1 / -1",
            color: "var(--danger-text)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Per-row
// ---------------------------------------------------------------------------

interface FieldRowProps {
  field: CustomField;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onAfterSave: () => void;
  onAskDelete: () => void;
  draggingOver: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}

function FieldRow({
  field,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onAfterSave,
  onAskDelete,
  draggingOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: FieldRowProps) {
  return (
    <div
      draggable={!isEditing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        background: "var(--bg)",
        border: `1px solid ${draggingOver ? "var(--accent-border)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        padding: 10,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1.4fr 1fr 0.7fr auto auto",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          title="Drag to reorder"
          style={{
            cursor: "grab",
            color: "var(--text-tertiary)",
            fontSize: 14,
            userSelect: "none",
          }}
        >
          ⋮⋮
        </span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{field.name}</div>
          <div className="text-xs text-dim mono">{field.code}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span className="pill pill-neutral">{field.type}</span>
          {field.required && (
            <span className="pill pill-warning">required</span>
          )}
        </div>
        <div className="text-xs text-dim">
          {field.type === "select" && field.options
            ? `${field.options.length} options`
            : ""}
        </div>
        {!isEditing ? (
          <button className="btn btn-sm" onClick={onStartEdit}>
            Edit
          </button>
        ) : (
          <button className="btn btn-sm" onClick={onCancelEdit}>
            Cancel
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={onAskDelete}
          style={{ color: "var(--danger-text)" }}
        >
          <Icon name="trash" size={12} /> Delete
        </button>
      </div>

      {isEditing && (
        <EditForm field={field} onAfterSave={onAfterSave} />
      )}
    </div>
  );
}

function EditForm({
  field,
  onAfterSave,
}: {
  field: CustomField;
  onAfterSave: () => void;
}) {
  const patch = usePatchCustomField(field.id);
  const [name, setName] = useState(field.name);
  const [required, setRequired] = useState(field.required);
  const [optionsText, setOptionsText] = useState(
    field.options ? field.options.join("\n") : "",
  );
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body: {
      name?: string;
      required?: boolean;
      options?: string[];
    } = {};
    if (name.trim() !== field.name) body.name = name.trim();
    if (required !== field.required) body.required = required;
    if (field.type === "select") {
      const opts = optionsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.length === 0) {
        setError("Select fields need at least one option.");
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
      onAfterSave();
      return;
    }
    try {
      await patch.mutateAsync(body);
      onAfterSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes");
    }
  };

  return (
    <form
      onSubmit={submit}
      style={{
        marginTop: 10,
        padding: 10,
        background: "var(--bg-sunken)",
        borderRadius: "var(--radius-sm)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <label
        style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}
      >
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
        Required
      </label>
      {field.type === "select" && (
        <Field label="Options (one per line)">
          <textarea
            className="input"
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            rows={3}
          />
        </Field>
      )}
      {error && (
        <div style={{ color: "var(--danger-text)", fontSize: 12 }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={patch.isPending}
        >
          {patch.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
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
  const del = useDeleteCustomField();
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    try {
      await del.mutateAsync(field.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete field");
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius)",
          padding: 20,
          width: 420,
          zIndex: 60,
          boxShadow: "var(--shadow-lg)",
        }}
        role="dialog"
        aria-labelledby="cf-delete-title"
      >
        <h2
          id="cf-delete-title"
          style={{ margin: "0 0 8px 0", fontSize: 16 }}
        >
          Delete <span className="mono">{field.code}</span>?
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          This removes the field for every employee. All values stored in
          this field will be permanently deleted. This cannot be undone.
        </p>
        {error && (
          <div
            style={{
              color: "var(--danger-text)",
              fontSize: 12,
              margin: "8px 0",
            }}
          >
            {error}
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 12,
            justifyContent: "flex-end",
          }}
        >
          <button className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-sm"
            style={{
              background: "var(--danger-bg)",
              color: "var(--danger-text)",
              borderColor: "var(--danger-border)",
            }}
            onClick={confirm}
            disabled={del.isPending}
          >
            {del.isPending ? "Deleting…" : "Delete field & values"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: "var(--text-secondary)",
      }}
    >
      <span
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
          fontSize: 11,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
