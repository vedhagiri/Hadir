// Settings → Divisions (P29 #3b).
//
// Top tier of the org hierarchy. A division contains many
// departments; a division manager (assigned via user_divisions) sees
// every employee in every department under that division — picked up
// automatically by the existing get_manager_visible_employee_ids
// scope helper. Symmetric with DepartmentsPage's manager-modal flow.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { ApiError, api } from "../api/client";
import { ModalShell } from "../components/DrawerShell";
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
import { SettingsTabs } from "./SettingsTabs";

export function DivisionsPage() {
  const { t } = useTranslation();
  const list = useDivisions();
  const create = useCreateDivision();
  const update = useUpdateDivision();
  const del = useDeleteDivision();

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Division | null>(null);
  const [managing, setManaging] = useState<Division | null>(null);

  const onDelete = (d: Division) => {
    if (!confirm(`Delete division "${d.name}"? Departments under it must be reassigned first.`)) return;
    del.mutate(d.id, {
      onSuccess: () => toast.success("Division deleted."),
      onError: (err) => {
        const detail =
          err instanceof ApiError
            ? (err.body as { detail?: { message?: string } })?.detail?.message
            : null;
        toast.error(detail ?? "Delete failed.");
      },
    });
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Divisions</h1>
          <p className="page-sub">
            Top tier of the org hierarchy · Division → Department → Section.
            Division managers see every employee under every department in
            their division.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={11} />
            Add division
          </button>
        </div>
      </div>

      <SettingsTabs />

      <div className="card" style={{ marginTop: 12 }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Code</th>
              <th>Name</th>
              <th style={{ width: 130 }}>Departments</th>
              <th style={{ minWidth: 220 }}>Managers</th>
              <th style={{ width: 240, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={5} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("common.loading") as string}…
                </td>
              </tr>
            )}
            {list.data?.items.length === 0 && (
              <tr>
                <td colSpan={5} className="text-sm text-dim" style={{ padding: 16 }}>
                  No divisions yet. Click "Add division" to create one.
                </td>
              </tr>
            )}
            {list.data?.items.map((d) => (
              <tr key={d.id}>
                <td className="mono text-sm">{d.code}</td>
                <td className="text-sm">{d.name}</td>
                <td className="mono text-sm">{d.department_count}</td>
                <td className="text-sm">
                  <DivisionManagerChips divisionId={d.id} />
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => setManaging(d)}
                      title="Assign or remove division managers"
                    >
                      <Icon name="users" size={11} />
                      Managers
                    </button>
                    <button className="btn btn-sm" onClick={() => setEditing(d)}>
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
        <DivisionFormModal
          onClose={() => setShowAdd(false)}
          onSubmit={(data) => {
            create.mutate(data, {
              onSuccess: () => {
                toast.success("Division created.");
                setShowAdd(false);
              },
              onError: (err) => {
                const detail =
                  err instanceof ApiError
                    ? (err.body as { detail?: { message?: string } })?.detail?.message
                    : null;
                toast.error(detail ?? "Create failed.");
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
                  toast.success("Division updated.");
                  setEditing(null);
                },
                onError: () => toast.error("Update failed."),
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
    </>
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
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const isEdit = !!initial;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) return;
    onSubmit({ code: code.trim().toUpperCase(), name: name.trim() });
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
      >
      <form
        onSubmit={handleSubmit}
        className="card"
        style={{ width: "min(440px, 92vw)", padding: 22 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {isEdit ? "Edit division" : "Add division"}
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <Field label="Code" hint="Uppercase letters, digits, underscore (1-16 chars). Used in Excel imports.">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={isEdit}
            placeholder="DIV-A"
            className="input"
            style={inputStyle}
            required
            maxLength={16}
            pattern="[A-Z0-9_]{1,16}"
          />
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Operations Division"
            className="input"
            style={inputStyle}
            required
            maxLength={120}
          />
        </Field>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={submitting}>
            <Icon name="check" size={11} />
            {submitting ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </form>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Manager chips + assignment modal — mirror of department-managers UX
// ---------------------------------------------------------------------------

function DivisionManagerChips({ divisionId }: { divisionId: number }) {
  const list = useDivisionManagers(divisionId);
  if (list.isLoading) return <span className="text-xs text-dim">Loading…</span>;
  if (list.isError)
    return (
      <span className="text-xs" style={{ color: "var(--danger-text)" }}>
        Failed to load
      </span>
    );
  const items = list.data?.items ?? [];
  if (items.length === 0)
    return <span className="text-xs text-dim">— No managers assigned —</span>;
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

function DivisionManagersModal({
  division,
  onClose,
}: {
  division: Division;
  onClose: () => void;
}) {
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
          toast.success("Manager assigned to division.");
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

  const onRemove = (m: DivisionManager) => {
    remove.mutate(
      { divisionId: division.id, userId: m.user_id },
      {
        onSuccess: () => toast.success(`${m.full_name} removed.`),
        onError: () => toast.error("Remove failed."),
      },
    );
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
      >
      <div className="card" style={{ width: "min(540px, 92vw)", padding: 22 }}>
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
              {division.code} · {division.name}
            </h2>
            <p
              className="text-xs text-dim"
              style={{ margin: "4px 0 0", maxWidth: 440 }}
            >
              Managers added here can see every employee in every department
              under this division on the dashboard, attendance, calendar,
              approvals, and reports — automatically, regardless of
              designation.
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

        <div style={sectionLabel}>Add a manager</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <select
            value={pickedId}
            onChange={(e) =>
              setPickedId(e.target.value === "" ? "" : Number(e.target.value))
            }
            disabled={candidates.isLoading || assign.isPending}
            style={pickerStyle}
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

        <div style={sectionLabel}>Currently assigned</div>
        {assigned.isLoading && <div className="text-sm text-dim">Loading…</div>}
        {!assigned.isLoading && (assigned.data?.items.length ?? 0) === 0 && (
          <div className="text-sm text-dim">No managers assigned. Pick one above.</div>
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
              title="Remove from this division"
            >
              <Icon name="x" size={11} />
              Remove
            </button>
          </div>
        ))}
      </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Local style + tiny Field helper
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  fontSize: 13,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
};

const pickerStyle: React.CSSProperties = {
  flex: 1,
  padding: "7px 10px",
  fontSize: 13,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-tertiary)",
  marginBottom: 6,
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)" }}>
        {label}
      </label>
      {children}
      {hint && (
        <span className="text-xs text-dim" style={{ marginTop: 2 }}>
          {hint}
        </span>
      )}
    </div>
  );
}
