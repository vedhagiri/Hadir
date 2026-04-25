// Shift Policies page (Admin + HR — replaces the pilot placeholder).
// Lists existing policies with type badge + active range + assignment
// count, and offers a Create form that switches fields per type.
//
// Assignments are managed via a tenant-default toggle (the simplest
// case the prompt calls out) plus a small chip list per policy showing
// existing assignments with a remove action. Per-employee assignment
// is reachable via the same UI; the picker just takes a numeric id
// for now (a richer employee-search UI is a v1.0+ refinement).

import { useState } from "react";

import { ApiError } from "../api/client";
import {
  useAssignments,
  useCreateAssignment,
  useCreatePolicy,
  useDeleteAssignment,
  useDeletePolicy,
  usePolicies,
} from "./hooks";
import type {
  AssignmentResponse,
  PolicyConfig,
  PolicyResponse,
  PolicyType,
  ScopeType,
} from "./types";

export function PoliciesPage() {
  const policies = usePolicies();
  const assignments = useAssignments();
  const create = useCreatePolicy();
  const del = useDeletePolicy();
  const createAsg = useCreateAssignment();
  const delAsg = useDeleteAssignment();

  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (policies.isLoading || assignments.isLoading)
    return <p>Loading shift policies…</p>;
  if (policies.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>
        Couldn’t load shift policies.
      </p>
    );

  const policyList = policies.data ?? [];
  const assignmentList = assignments.data ?? [];

  const assignmentsByPolicy: Record<number, AssignmentResponse[]> = {};
  for (const a of assignmentList) {
    (assignmentsByPolicy[a.policy_id] ??= []).push(a);
  }

  const onSubmit = async (input: {
    name: string;
    type: PolicyType;
    config: PolicyConfig;
    active_from: string;
  }) => {
    setError(null);
    try {
      await create.mutateAsync(input);
      setShowForm(false);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setError(
          typeof body?.detail === "string"
            ? body.detail
            : `Save failed (${err.status}).`,
        );
      } else {
        setError("Save failed.");
      }
    }
  };

  const onDeletePolicy = async (p: PolicyResponse) => {
    if (
      !confirm(
        `Soft-delete "${p.name}"? Existing attendance rows keep their original policy reference; resolution will skip this row from now on.`,
      )
    )
      return;
    setError(null);
    try {
      await del.mutateAsync(p.id);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`Delete failed (${err.status}).`);
      } else {
        setError("Delete failed.");
      }
    }
  };

  const onAssign = async (
    policyId: number,
    scope_type: ScopeType,
    scope_id: number | null,
  ) => {
    setError(null);
    try {
      await createAsg.mutateAsync({
        policy_id: policyId,
        scope_type,
        scope_id,
        active_from: new Date().toISOString().slice(0, 10),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: unknown } | null;
        setError(
          typeof body?.detail === "string"
            ? body.detail
            : `Assign failed (${err.status}).`,
        );
      } else {
        setError("Assign failed.");
      }
    }
  };

  const onUnassign = async (id: number) => {
    setError(null);
    try {
      await delAsg.mutateAsync(id);
    } catch (err) {
      setError("Unassign failed.");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: 0,
            fontWeight: 400,
          }}
        >
          Shift Policies
        </h1>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          style={btnPrimary}
        >
          {showForm ? "Cancel" : "+ New policy"}
        </button>
      </header>
      <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
        Fixed and Flex are the two policy types in v1.0 P9. Resolution per
        employee follows the cascade <code>employee → department → tenant</code>;
        an employee with no assignment falls back to the tenant default and
        finally to any active policy in the tenant.
      </p>

      {error && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            border: "1px solid var(--border)",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      {showForm && <PolicyForm onSubmit={onSubmit} busy={create.isPending} />}

      <div
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg)" }}>
              <th style={th}>Name</th>
              <th style={th}>Type</th>
              <th style={th}>Window</th>
              <th style={th}>Required</th>
              <th style={th}>Active</th>
              <th style={th}>Assignments</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {policyList.map((p) => (
              <tr key={p.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--text-tertiary)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    #{p.id}
                  </div>
                </td>
                <td style={td}>
                  <TypeBadge type={p.type} />
                </td>
                <td style={td}>{describeWindow(p)}</td>
                <td style={td}>{p.config.required_hours ?? 8}h</td>
                <td style={td}>
                  <div>{p.active_from}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                    {p.active_until ?? "open"}
                  </div>
                </td>
                <td style={td}>
                  <AssignmentCell
                    policyId={p.id}
                    rows={assignmentsByPolicy[p.id] ?? []}
                    onAssignTenant={() => onAssign(p.id, "tenant", null)}
                    onAssignDepartment={(deptId) =>
                      onAssign(p.id, "department", deptId)
                    }
                    onAssignEmployee={(empId) =>
                      onAssign(p.id, "employee", empId)
                    }
                    onUnassign={onUnassign}
                  />
                </td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button
                    type="button"
                    onClick={() => void onDeletePolicy(p)}
                    style={btnGhost}
                  >
                    Soft-delete
                  </button>
                </td>
              </tr>
            ))}
            {policyList.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{ ...td, textAlign: "center", color: "var(--text-tertiary)" }}
                >
                  No policies yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function TypeBadge({ type }: { type: PolicyType }) {
  const colour =
    type === "Flex"
      ? { bg: "var(--accent-soft)", fg: "var(--accent-text)" }
      : { bg: "var(--bg)", fg: "var(--text)" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: colour.bg,
        color: colour.fg,
        border: "1px solid var(--border)",
      }}
    >
      {type}
    </span>
  );
}


function describeWindow(p: PolicyResponse): string {
  if (p.type === "Fixed") {
    return `${p.config.start ?? "??"} – ${p.config.end ?? "??"} (grace ${p.config.grace_minutes ?? 15}m)`;
  }
  if (p.type === "Flex") {
    return `IN ${p.config.in_window_start ?? "??"}–${p.config.in_window_end ?? "??"}; OUT ${p.config.out_window_start ?? "??"}–${p.config.out_window_end ?? "??"}`;
  }
  return "—";
}


function AssignmentCell({
  rows,
  onAssignTenant,
  onAssignDepartment,
  onAssignEmployee,
  onUnassign,
}: {
  policyId: number;
  rows: AssignmentResponse[];
  onAssignTenant: () => void;
  onAssignDepartment: (id: number) => void;
  onAssignEmployee: (id: number) => void;
  onUnassign: (assignmentId: number) => void;
}) {
  const [showInput, setShowInput] = useState<"department" | "employee" | null>(
    null,
  );
  const [scopeId, setScopeId] = useState("");
  const tenantWide = rows.some((r) => r.scope_type === "tenant");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {rows.length === 0 && (
          <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
            (no assignments)
          </span>
        )}
        {rows.map((a) => (
          <span
            key={a.id}
            style={{
              fontSize: 11.5,
              padding: "1px 6px",
              borderRadius: 999,
              background:
                a.scope_type === "tenant"
                  ? "var(--accent-soft)"
                  : "var(--bg)",
              color:
                a.scope_type === "tenant"
                  ? "var(--accent-text)"
                  : "var(--text)",
              border: "1px solid var(--border)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {a.scope_type === "tenant"
              ? "tenant default"
              : `${a.scope_type} #${a.scope_id}`}
            <button
              type="button"
              onClick={() => onUnassign(a.id)}
              aria-label="Remove assignment"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-tertiary)",
                cursor: "pointer",
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {!tenantWide && (
          <button
            type="button"
            onClick={onAssignTenant}
            style={{ ...btnGhost, fontSize: 11.5 }}
          >
            Tenant default
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowInput((s) => (s === "department" ? null : "department"))}
          style={{ ...btnGhost, fontSize: 11.5 }}
        >
          Dept…
        </button>
        <button
          type="button"
          onClick={() => setShowInput((s) => (s === "employee" ? null : "employee"))}
          style={{ ...btnGhost, fontSize: 11.5 }}
        >
          Employee…
        </button>
      </div>
      {showInput && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const id = Number.parseInt(scopeId, 10);
            if (!Number.isFinite(id) || id < 1) return;
            if (showInput === "department") onAssignDepartment(id);
            else onAssignEmployee(id);
            setScopeId("");
            setShowInput(null);
          }}
          style={{ display: "flex", gap: 4 }}
        >
          <input
            type="number"
            min={1}
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            placeholder={`${showInput} id`}
            style={{
              fontSize: 12,
              padding: "2px 6px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              width: 100,
            }}
          />
          <button type="submit" style={{ ...btnGhost, fontSize: 11.5 }}>
            Assign
          </button>
        </form>
      )}
    </div>
  );
}


function PolicyForm({
  onSubmit,
  busy,
}: {
  onSubmit: (input: {
    name: string;
    type: PolicyType;
    config: PolicyConfig;
    active_from: string;
  }) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<PolicyType>("Fixed");
  const [activeFrom, setActiveFrom] = useState(
    new Date().toISOString().slice(0, 10),
  );
  // Fixed
  const [start, setStart] = useState("07:30");
  const [end, setEnd] = useState("15:30");
  const [grace, setGrace] = useState(15);
  // Flex
  const [inStart, setInStart] = useState("07:30");
  const [inEnd, setInEnd] = useState("08:30");
  const [outStart, setOutStart] = useState("15:30");
  const [outEnd, setOutEnd] = useState("16:30");
  // Common
  const [requiredHours, setRequiredHours] = useState(8);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const config: PolicyConfig =
      type === "Fixed"
        ? {
            start,
            end,
            grace_minutes: grace,
            required_hours: requiredHours,
          }
        : {
            in_window_start: inStart,
            in_window_end: inEnd,
            out_window_start: outStart,
            out_window_end: outEnd,
            required_hours: requiredHours,
          };
    void onSubmit({
      name: name.trim(),
      type,
      config,
      active_from: activeFrom,
    });
  };

  return (
    <form
      onSubmit={submit}
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxWidth: 640,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={inputStyle}
          />
        </Field>
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as PolicyType)}
            style={inputStyle}
          >
            <option value="Fixed">Fixed</option>
            <option value="Flex">Flex</option>
          </select>
        </Field>
        <Field label="Active from">
          <input
            type="date"
            value={activeFrom}
            onChange={(e) => setActiveFrom(e.target.value)}
            required
            style={inputStyle}
          />
        </Field>
      </div>

      {type === "Fixed" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          <Field label="Start">
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
              style={inputStyle}
            />
          </Field>
          <Field label="End">
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </Field>
          <Field label="Grace (min)">
            <input
              type="number"
              min={0}
              max={180}
              value={grace}
              onChange={(e) => setGrace(Number.parseInt(e.target.value, 10) || 0)}
              style={inputStyle}
            />
          </Field>
          <Field label="Required hours">
            <input
              type="number"
              min={1}
              max={24}
              value={requiredHours}
              onChange={(e) =>
                setRequiredHours(Number.parseInt(e.target.value, 10) || 1)
              }
              style={inputStyle}
            />
          </Field>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 10 }}>
          <Field label="In window start">
            <input
              type="time"
              value={inStart}
              onChange={(e) => setInStart(e.target.value)}
              required
              style={inputStyle}
            />
          </Field>
          <Field label="In window end">
            <input
              type="time"
              value={inEnd}
              onChange={(e) => setInEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </Field>
          <Field label="Out window start">
            <input
              type="time"
              value={outStart}
              onChange={(e) => setOutStart(e.target.value)}
              required
              style={inputStyle}
            />
          </Field>
          <Field label="Out window end">
            <input
              type="time"
              value={outEnd}
              onChange={(e) => setOutEnd(e.target.value)}
              required
              style={inputStyle}
            />
          </Field>
          <Field label="Required hours">
            <input
              type="number"
              min={1}
              max={24}
              value={requiredHours}
              onChange={(e) =>
                setRequiredHours(Number.parseInt(e.target.value, 10) || 1)
              }
              style={inputStyle}
            />
          </Field>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" disabled={busy} style={btnPrimary}>
          {busy ? "Saving…" : "Create policy"}
        </button>
      </div>
    </form>
  );
}


function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}


const inputStyle = {
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;

const btnPrimary = {
  background: "var(--accent)",
  color: "white",
  border: "none",
  padding: "6px 12px",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
} as const;

const btnGhost = {
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: "4px 10px",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  fontSize: 12.5,
} as const;

const th = {
  padding: "10px 12px",
  textAlign: "left" as const,
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-tertiary)",
};

const td = { padding: "10px 12px", verticalAlign: "top" as const };
