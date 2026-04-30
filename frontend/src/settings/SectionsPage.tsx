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
import { ModalShell } from "../components/DrawerShell";
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
import { SettingsTabs } from "./SettingsTabs";

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

  const onDelete = (s: Section) => {
    if (!confirm(`Delete section "${s.name}"? Employees assigned to it must be reassigned first.`)) return;
    del.mutate(s.id, {
      onSuccess: () => toast.success("Section deleted."),
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
          <h1 className="page-title">Sections</h1>
          <p className="page-sub">
            Finest tier · Division → Department → Section. Section managers
            see only employees assigned to that specific section.
          </p>
        </div>
        <div className="page-actions">
          <select
            value={filterDept}
            onChange={(e) =>
              setFilterDept(e.target.value === "" ? "" : Number(e.target.value))
            }
            style={pickerStyle}
            aria-label="Filter by department"
          >
            <option value="">All departments</option>
            {departments.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} · {d.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            onClick={() => setShowAdd(true)}
            disabled={!departments.data || departments.data.items.length === 0}
            title={
              !departments.data || departments.data.items.length === 0
                ? "Create at least one department first"
                : ""
            }
          >
            <Icon name="plus" size={11} />
            Add section
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
              <th style={{ width: 220 }}>Department</th>
              <th style={{ width: 120 }}>Employees</th>
              <th style={{ minWidth: 220 }}>Managers</th>
              <th style={{ width: 240, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("common.loading") as string}…
                </td>
              </tr>
            )}
            {list.data?.items.length === 0 && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  {filterDept === ""
                    ? "No sections yet. Click \"Add section\" to create one."
                    : "No sections in this department yet."}
                </td>
              </tr>
            )}
            {list.data?.items.map((s) => (
              <tr key={s.id}>
                <td className="mono text-sm">{s.code}</td>
                <td className="text-sm">{s.name}</td>
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
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => setManaging(s)}
                      title="Assign or remove section managers"
                    >
                      <Icon name="users" size={11} />
                      Managers
                    </button>
                    <button className="btn btn-sm" onClick={() => setEditing(s)}>
                      <Icon name="settings" size={11} />
                      {t("common.edit") as string}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => onDelete(s)}
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
        <SectionFormModal
          onClose={() => setShowAdd(false)}
          departments={departments.data?.items ?? []}
          defaultDepartmentId={
            filterDept === "" ? null : Number(filterDept)
          }
          onSubmit={(data) => {
            create.mutate(data, {
              onSuccess: () => {
                toast.success("Section created.");
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
        <SectionFormModal
          initial={editing}
          departments={departments.data?.items ?? []}
          onClose={() => setEditing(null)}
          onSubmit={(data) => {
            update.mutate(
              { id: editing.id, name: data.name },
              {
                onSuccess: () => {
                  toast.success("Section updated.");
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
        <SectionManagersModal
          section={managing}
          onClose={() => setManaging(null)}
        />
      )}
    </>
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
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [departmentId, setDepartmentId] = useState<number | "">(
    initial?.department_id ?? defaultDepartmentId ?? "",
  );
  const isEdit = !!initial;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim() || departmentId === "") return;
    onSubmit({
      code: code.trim().toUpperCase(),
      name: name.trim(),
      department_id: Number(departmentId),
    });
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
            {isEdit ? "Edit section" : "Add section"}
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

        <Field label="Department" hint="The parent department this section belongs to. Cannot be changed after create — delete + recreate to move.">
          <select
            value={departmentId}
            onChange={(e) =>
              setDepartmentId(e.target.value === "" ? "" : Number(e.target.value))
            }
            disabled={isEdit}
            style={inputStyle}
            required
          >
            <option value="">— Pick a department —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} · {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Code" hint="Uppercase letters, digits, underscore (1-16 chars). Unique within its parent department.">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={isEdit}
            placeholder="QA"
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
            placeholder="Quality Assurance"
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
// Manager chips + assignment modal
// ---------------------------------------------------------------------------

function SectionManagerChips({ sectionId }: { sectionId: number }) {
  const list = useSectionManagers(sectionId);
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

function SectionManagersModal({
  section,
  onClose,
}: {
  section: Section;
  onClose: () => void;
}) {
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
          toast.success("Manager assigned to section.");
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

  const onRemove = (m: SectionManager) => {
    remove.mutate(
      { sectionId: section.id, userId: m.user_id },
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
              {section.department_code}/{section.code} · {section.name}
            </h2>
            <p
              className="text-xs text-dim"
              style={{ margin: "4px 0 0", maxWidth: 440 }}
            >
              Section managers see only employees assigned to this specific
              section — narrower than department-tier visibility. Use this
              when one team-lead inside a department should see only their
              own team.
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
              title="Remove from this section"
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
