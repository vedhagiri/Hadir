// Manager Assignments page (P8). Admin-only.
//
// Layout: left column "Unassigned employees" + right grid of manager
// cards with employees as chips. Drag a chip from one column / card to
// another to call POST. Drop on the Unassigned column to call DELETE.
// Star icon on a chip toggles is_primary.
//
// Drag-and-drop is plain HTML5 native — the chips set ``draggable``,
// the targets handle ``onDragOver`` + ``onDrop``. No new dependency.
// ``dataTransfer`` carries the JSON payload {employee_id, source}.

import { useState } from "react";

import { ApiError } from "../api/client";
import {
  useAssignments,
  useCreateAssignment,
  useDeleteAssignment,
} from "./hooks";
import type { EmployeeChip, ManagerGroup } from "./types";

interface DragPayload {
  employee_id: number;
  source: "unassigned" | "manager";
  source_manager_id: number | null;
  source_assignment_id: number | null;
}

const MIME = "application/x-hadir-manager-chip";

export function ManagerAssignmentsPage() {
  const list = useAssignments();
  const create = useCreateAssignment();
  const del = useDeleteAssignment();
  const [error, setError] = useState<string | null>(null);

  const handleApiError = (err: unknown, fallback: string) => {
    if (err instanceof ApiError) {
      const body = err.body as { detail?: unknown } | null;
      setError(
        typeof body?.detail === "string"
          ? body.detail
          : `${fallback} (${err.status}).`,
      );
    } else {
      setError(fallback);
    }
  };

  const onDropToManager = async (
    target_manager_id: number,
    payload: DragPayload,
  ) => {
    setError(null);
    if (
      payload.source === "manager" &&
      payload.source_manager_id === target_manager_id
    ) {
      return; // no-op drop on the same card
    }
    try {
      // POST creates or refreshes the assignment under the target
      // manager. We DON'T DELETE the source row first — operators
      // are usually adding a second assignment, not moving. The
      // explicit way to remove is to drop on Unassigned.
      await create.mutateAsync({
        manager_user_id: target_manager_id,
        employee_id: payload.employee_id,
        is_primary: false,
      });
      // If the drag came from another manager card, also drop the
      // old assignment so the chip visually moves rather than
      // duplicating.
      if (
        payload.source === "manager" &&
        payload.source_assignment_id != null
      ) {
        await del.mutateAsync(payload.source_assignment_id);
      }
    } catch (err) {
      handleApiError(err, "Assign failed");
    }
  };

  const onDropToUnassigned = async (payload: DragPayload) => {
    setError(null);
    if (payload.source !== "manager" || payload.source_assignment_id == null) {
      return;
    }
    try {
      await del.mutateAsync(payload.source_assignment_id);
    } catch (err) {
      handleApiError(err, "Unassign failed");
    }
  };

  const onTogglePrimary = async (chip: EmployeeChip, mgr: ManagerGroup) => {
    setError(null);
    try {
      // Send the same manager_user_id + employee_id pair back through
      // POST. The backend's set_assignment will demote any prior
      // primary inside the same transaction.
      await create.mutateAsync({
        manager_user_id: mgr.manager_user_id,
        employee_id: chip.employee_id,
        is_primary: !chip.is_primary,
      });
    } catch (err) {
      handleApiError(err, "Primary toggle failed");
    }
  };

  if (list.isLoading) return <p>Loading manager assignments…</p>;
  if (list.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>
        Couldn’t load manager assignments.
      </p>
    );
  const data = list.data;
  if (!data) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          Manager assignments
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          Drag an employee chip to assign them to a manager. Drop on
          &ldquo;Unassigned&rdquo; to remove the assignment. Use the star to
          mark one manager as the primary contact for an employee.
        </p>
      </header>

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

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 1fr) 3fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <UnassignedColumn
          chips={data.unassigned}
          onDrop={onDropToUnassigned}
        />
        <ManagerGrid
          managers={data.managers}
          onDropToManager={onDropToManager}
          onTogglePrimary={onTogglePrimary}
        />
      </div>
    </div>
  );
}


function UnassignedColumn({
  chips,
  onDrop,
}: {
  chips: EmployeeChip[];
  onDrop: (payload: DragPayload) => Promise<void>;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setHover(true);
        }
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const raw = e.dataTransfer.getData(MIME);
        if (!raw) return;
        try {
          const payload = JSON.parse(raw) as DragPayload;
          void onDrop(payload);
        } catch {
          /* ignore */
        }
      }}
      style={{
        background: hover ? "var(--accent-soft)" : "var(--bg-elev)",
        border: hover
          ? "1px dashed var(--accent-border)"
          : "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: 12,
        minHeight: 240,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-tertiary)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>Unassigned employees</span>
        <span
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "1px 6px",
            fontSize: 10.5,
            color: "var(--text-secondary)",
          }}
        >
          {chips.length}
        </span>
      </div>

      {chips.length === 0 ? (
        <p
          style={{
            color: "var(--text-tertiary)",
            fontSize: 12.5,
            margin: "16px 0",
          }}
        >
          No unassigned employees — drop here to remove an assignment.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {chips.map((c) => (
            <Chip
              key={c.employee_id}
              chip={c}
              source="unassigned"
              source_manager_id={null}
            />
          ))}
        </div>
      )}
    </div>
  );
}


function ManagerGrid({
  managers,
  onDropToManager,
  onTogglePrimary,
}: {
  managers: ManagerGroup[];
  onDropToManager: (mid: number, payload: DragPayload) => Promise<void>;
  onTogglePrimary: (chip: EmployeeChip, mgr: ManagerGroup) => Promise<void>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 12,
      }}
    >
      {managers.map((m) => (
        <ManagerCard
          key={m.manager_user_id}
          manager={m}
          onDrop={(p) => onDropToManager(m.manager_user_id, p)}
          onTogglePrimary={(chip) => onTogglePrimary(chip, m)}
        />
      ))}
    </div>
  );
}


function ManagerCard({
  manager,
  onDrop,
  onTogglePrimary,
}: {
  manager: ManagerGroup;
  onDrop: (payload: DragPayload) => Promise<void>;
  onTogglePrimary: (chip: EmployeeChip) => Promise<void>;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setHover(true);
        }
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const raw = e.dataTransfer.getData(MIME);
        if (!raw) return;
        try {
          const payload = JSON.parse(raw) as DragPayload;
          void onDrop(payload);
        } catch {
          /* ignore */
        }
      }}
      style={{
        background: hover ? "var(--accent-soft)" : "var(--bg-elev)",
        border: hover
          ? "1px dashed var(--accent-border)"
          : "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 160,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          {manager.full_name}
        </span>
        <span
          style={{
            fontSize: 11.5,
            color: "var(--text-tertiary)",
          }}
          title={manager.email}
        >
          {manager.email}
        </span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
          {manager.department_codes.length === 0 && (
            <span
              style={{
                fontSize: 10.5,
                color: "var(--text-tertiary)",
              }}
            >
              no departments
            </span>
          )}
          {manager.department_codes.map((c) => (
            <span
              key={c}
              style={{
                fontSize: 10.5,
                background: "var(--bg)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
                padding: "1px 6px",
                borderRadius: 999,
                fontFamily: "var(--font-mono)",
              }}
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginTop: 8,
        }}
      >
        {manager.employees.length === 0 ? (
          <p
            style={{
              color: "var(--text-tertiary)",
              fontSize: 12.5,
              margin: 0,
            }}
          >
            No employees assigned. Drop a chip here to assign.
          </p>
        ) : (
          manager.employees.map((c) => (
            <Chip
              key={c.employee_id}
              chip={c}
              source="manager"
              source_manager_id={manager.manager_user_id}
              onTogglePrimary={() => void onTogglePrimary(c)}
            />
          ))
        )}
      </div>
    </div>
  );
}


function Chip({
  chip,
  source,
  source_manager_id,
  onTogglePrimary,
}: {
  chip: EmployeeChip;
  source: "unassigned" | "manager";
  source_manager_id: number | null;
  onTogglePrimary?: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        const payload: DragPayload = {
          employee_id: chip.employee_id,
          source,
          source_manager_id,
          source_assignment_id: chip.assignment_id,
        };
        e.dataTransfer.setData(MIME, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "move";
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        background: chip.is_primary ? "var(--accent-soft)" : "var(--bg)",
        border: chip.is_primary
          ? "1px solid var(--accent-border)"
          : "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        cursor: "grab",
        userSelect: "none",
      }}
      title={`${chip.employee_code} • ${chip.department_code}`}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          color: "var(--text-secondary)",
        }}
      >
        {chip.employee_code}
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{chip.full_name}</span>
      <span
        style={{
          fontSize: 10.5,
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          marginInlineStart: "auto",
        }}
      >
        {chip.department_code}
      </span>
      {source === "manager" && onTogglePrimary && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePrimary();
          }}
          aria-label={chip.is_primary ? "Unset primary" : "Mark primary"}
          title={chip.is_primary ? "Primary manager" : "Mark as primary manager"}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "0 2px",
            color: chip.is_primary
              ? "var(--accent-text)"
              : "var(--text-tertiary)",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          {chip.is_primary ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}
