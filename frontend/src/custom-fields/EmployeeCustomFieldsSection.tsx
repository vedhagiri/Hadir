// Drawer sub-section: render custom fields below the standard fields
// and let the operator edit each one inline.
//
// Mirrors the editor look-and-feel: each field is a row with label +
// input. ``select`` becomes a real <select>, ``date`` a <input
// type="date">, ``number`` an <input type="number">, ``text`` a plain
// input. Saving sends a PATCH and the values invalidate.

import { useEffect, useMemo, useState } from "react";

import {
  useCustomFields,
  useEmployeeCustomFieldValues,
  usePatchEmployeeCustomFieldValues,
} from "./hooks";
import type {
  CustomField,
  CustomFieldType,
  CustomFieldValuePatchItem,
} from "./types";

interface Props {
  employeeId: number;
}

export function EmployeeCustomFieldsSection({ employeeId }: Props) {
  const fields = useCustomFields();
  const values = useEmployeeCustomFieldValues(employeeId);
  const patch = usePatchEmployeeCustomFieldValues(employeeId);

  const [draft, setDraft] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!values.data) return;
    const next: Record<number, string> = {};
    for (const v of values.data) {
      next[v.field_id] = v.raw ?? "";
    }
    setDraft(next);
  }, [values.data]);

  const fieldsById = useMemo(() => {
    const map: Record<number, CustomField> = {};
    if (fields.data) for (const f of fields.data) map[f.id] = f;
    return map;
  }, [fields.data]);

  if (values.isLoading || fields.isLoading) {
    return <div className="text-sm text-dim">Loading custom fields…</div>;
  }
  if (values.error) {
    return (
      <div style={{ color: "var(--danger-text)", fontSize: 12 }}>
        Couldn’t load custom fields.
      </div>
    );
  }
  if (!values.data || values.data.length === 0) {
    return (
      <div className="text-sm text-dim" style={{ marginBottom: 8 }}>
        No custom fields defined yet. Add some in Settings → Custom Fields.
      </div>
    );
  }

  const dirty =
    values.data.some(
      (v) => (draft[v.field_id] ?? "") !== (v.raw ?? ""),
    );

  const submit = async () => {
    setError(null);
    const items: CustomFieldValuePatchItem[] = values.data!
      .filter((v) => (draft[v.field_id] ?? "") !== (v.raw ?? ""))
      .map((v) => {
        const raw = draft[v.field_id] ?? "";
        return { field_id: v.field_id, value: raw === "" ? null : raw };
      });
    if (items.length === 0) return;
    try {
      await patch.mutateAsync(items);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes");
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginBottom: 16,
      }}
    >
      {values.data.map((v) => {
        const def = fieldsById[v.field_id];
        return (
          <div
            key={v.field_id}
            style={{
              background: "var(--bg-sunken)",
              borderRadius: 8,
              padding: "8px 10px",
            }}
          >
            <div
              className="text-xs text-dim"
              style={{
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 500,
                marginBottom: 2,
              }}
            >
              {v.name}
              {def?.required && (
                <span
                  className="pill pill-warning"
                  style={{ marginLeft: 6, padding: "0 6px" }}
                >
                  required
                </span>
              )}
              <span
                className="mono"
                style={{ marginLeft: 6, color: "var(--text-tertiary)" }}
              >
                ({v.type})
              </span>
            </div>
            <ValueInput
              type={v.type}
              options={def?.options ?? null}
              value={draft[v.field_id] ?? ""}
              onChange={(next) =>
                setDraft((prev) => ({ ...prev, [v.field_id]: next }))
              }
            />
          </div>
        );
      })}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          className="btn btn-primary btn-sm"
          onClick={submit}
          disabled={!dirty || patch.isPending}
        >
          {patch.isPending ? "Saving…" : "Save custom fields"}
        </button>
        {savedAt !== null && !dirty && (
          <span className="text-xs text-dim">Saved.</span>
        )}
        {error && (
          <span style={{ color: "var(--danger-text)", fontSize: 12 }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

interface ValueInputProps {
  type: CustomFieldType;
  options: string[] | null;
  value: string;
  onChange: (next: string) => void;
}

function ValueInput({ type, options, value, onChange }: ValueInputProps) {
  if (type === "select" && options) {
    return (
      <select
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (type === "date") {
    return (
      <input
        type="date"
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (type === "number") {
    return (
      <input
        type="number"
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      type="text"
      className="input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
