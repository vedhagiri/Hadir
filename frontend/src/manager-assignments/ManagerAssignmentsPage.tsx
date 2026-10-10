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
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import {
  EmptyPanel,
  ResetButton,
  SearchField,
  StatGrid,
  Toolbar,
} from "../components/ListPageUi";
import { SkeletonCards, SkeletonPanel } from "../components/Skeleton";
import { avatarBg, initials } from "../features/employees/EmployeesPage";
import { Banner, LoadErrorPanel, PEOPLE_ICON, StatTile } from "../features/employees/peopleUi";
import { Icon } from "../shell/Icon";
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

const MIME = "application/x-maugood-manager-chip";

export function ManagerAssignmentsPage() {
  const { t } = useTranslation();
  const list = useAssignments();
  const [q, setQ] = useState("");
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
      handleApiError(err, t("managerAssignments.errors.assign", { defaultValue: "Assign failed" }));
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
      handleApiError(err, t("managerAssignments.errors.unassign", { defaultValue: "Unassign failed" }));
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
      handleApiError(err, t("managerAssignments.errors.primary", { defaultValue: "Primary toggle failed" }));
    }
  };

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">
          {t("managerAssignments.title", { defaultValue: "Manager assignments" })}
        </h1>
        <p className="page-sub">
          {t("managerAssignments.sub", {
            defaultValue:
              "Drag an employee onto a manager to assign them. Drop on “Unassigned” to remove the assignment. Use the star to mark one manager as the primary contact.",
          })}
        </p>
      </div>
    </div>
  );

  if (list.isLoading)
    return (
      <>
        {header}
        <SkeletonCards count={4} minWidth={220} />
        <div style={{ marginTop: 20 }}>
          <SkeletonPanel lines={8} />
        </div>
      </>
    );
  if (list.error)
    return (
      <>
        {header}
        <div className="card">
          <LoadErrorPanel
            title={t("managerAssignments.loadFailed", {
              defaultValue: "Couldn’t load manager assignments.",
            })}
            onRetry={() => void list.refetch()}
          />
        </div>
      </>
    );
  const data = list.data;
  if (!data) return null;

  const assignedIds = new Set<number>();
  let primaryCount = 0;
  for (const m of data.managers) {
    for (const c of m.employees) {
      assignedIds.add(c.employee_id);
      if (c.is_primary) primaryCount += 1;
    }
  }

  // No records at all: nobody to assign and nobody to assign to.
  if (data.managers.length === 0 && data.unassigned.length === 0) {
    return (
      <>
        {header}
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<Icon name="users" size={30} />}
            title={t("managerAssignments.noPeopleTitle", { defaultValue: "Nothing to assign yet" })}
            body={t("managerAssignments.noPeopleBody", {
              defaultValue:
                "Add employees and give at least one user the Manager role, then come back here to pair them up.",
            })}
          />
        </div>
      </>
    );
  }

  // Client-side search: narrows chips (both columns) and managers.
  const needle = q.trim().toLowerCase();
  const chipMatches = (c: EmployeeChip) =>
    !needle ||
    [c.full_name, c.employee_code, c.department_code, c.department_name]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  const unassignedShown = data.unassigned.filter(chipMatches);
  const managersShown: ManagerGroup[] = needle
    ? data.managers
        .map((m) => {
          const managerHit = [m.full_name, m.email].join(" ").toLowerCase().includes(needle);
          return managerHit ? m : { ...m, employees: m.employees.filter(chipMatches) };
        })
        .filter(
          (m) =>
            m.employees.length > 0 ||
            [m.full_name, m.email].join(" ").toLowerCase().includes(needle),
        )
    : data.managers;

  return (
    <div>
      {header}

      <StatGrid>
        <StatTile
          tone="info"
          icon={PEOPLE_ICON.people}
          label={t("managerAssignments.stats.managers", { defaultValue: "Managers" })}
          value={data.managers.length}
          sub={t("managerAssignments.stats.managersSub", { defaultValue: "Users with the Manager role" })}
        />
        <StatTile
          tone="success"
          icon={PEOPLE_ICON.check}
          label={t("managerAssignments.stats.assigned", { defaultValue: "Assigned" })}
          value={assignedIds.size}
          sub={t("managerAssignments.stats.assignedSub", { defaultValue: "Employees with a manager" })}
        />
        <StatTile
          tone="warning"
          icon={PEOPLE_ICON.clock}
          label={t("managerAssignments.stats.unassigned", { defaultValue: "Unassigned" })}
          value={data.unassigned.length}
          sub={t("managerAssignments.stats.unassignedSub", { defaultValue: "Waiting for a manager" })}
        />
        <StatTile
          tone="neutral"
          icon={PEOPLE_ICON.star}
          label={t("managerAssignments.stats.primary", { defaultValue: "Primary set" })}
          value={primaryCount}
          sub={t("managerAssignments.stats.primarySub", { defaultValue: "Starred primary contacts" })}
        />
      </StatGrid>

      <Toolbar>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={t("managerAssignments.search", {
            defaultValue: "Search employees or managers by name, ID or department…",
          })}
          clearLabel={t("managerAssignments.clearSearch", { defaultValue: "Clear search" })}
        />
        <ResetButton
          active={q.trim() !== ""}
          label={t("managerAssignments.reset", { defaultValue: "Reset" })}
          onClick={() => setQ("")}
        />
      </Toolbar>

      {error && <Banner tone="danger" role="alert" title={error} />}

      <div className="pp-assign-layout">
        <UnassignedColumn
          chips={unassignedShown}
          total={data.unassigned.length}
          onDrop={onDropToUnassigned}
        />
        {data.managers.length === 0 ? (
          <div className="card">
            <EmptyPanel
              tone="accent"
              icon={<Icon name="users" size={30} />}
              title={t("managerAssignments.noManagersTitle", { defaultValue: "No managers yet" })}
              body={t("managerAssignments.noManagersBody", {
                defaultValue: "Give a user the Manager role on the Users page and they will appear here.",
              })}
            />
          </div>
        ) : managersShown.length === 0 ? (
          <div className="card">
            <EmptyPanel
              icon={<Icon name="search" size={28} />}
              title={t("managerAssignments.noMatchTitle", { defaultValue: "No managers match your search" })}
              body={t("managerAssignments.noMatchBody", { defaultValue: "Try another name, or clear the search." })}
              actions={
                <button type="button" className="btn" onClick={() => setQ("")}>
                  <Icon name="refresh" size={12} />
                  {t("managerAssignments.clearSearch", { defaultValue: "Clear search" })}
                </button>
              }
            />
          </div>
        ) : (
          <ManagerGrid
            managers={managersShown}
            onDropToManager={onDropToManager}
            onTogglePrimary={onTogglePrimary}
          />
        )}
      </div>
    </div>
  );
}

function readPayload(e: React.DragEvent): DragPayload | null {
  const raw = e.dataTransfer.getData(MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

function UnassignedColumn({
  chips,
  total,
  onDrop,
}: {
  chips: EmployeeChip[];
  total: number;
  onDrop: (payload: DragPayload) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  return (
    <div
      className={`pp-dropzone pp-unassigned${hover ? " is-over" : ""}`}
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
        const payload = readPayload(e);
        if (payload) void onDrop(payload);
      }}
    >
      <div className="pp-dropzone-title">
        <span>{t("managerAssignments.unassignedTitle", { defaultValue: "Unassigned employees" })}</span>
        <span className="pp-count-badge tone-warning">
          {chips.length === total ? total : `${chips.length} / ${total}`}
        </span>
      </div>
      <div className="pp-dropzone-hint">
        {t("managerAssignments.unassignedHint", {
          defaultValue: "Drag onto a manager to assign. Drop a chip here to unassign it.",
        })}
      </div>

      {chips.length === 0 ? (
        <p className="pp-mgr-empty">
          {t("managerAssignments.unassignedEmpty", {
            defaultValue: "No unassigned employees — drop here to remove an assignment.",
          })}
        </p>
      ) : (
        <div className="pp-chip-list">
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
    <div className="pp-mgr-grid">
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
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  return (
    <div
      className={`pp-dropzone pp-mgr-card${hover ? " is-over" : ""}`}
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
        const payload = readPayload(e);
        if (payload) void onDrop(payload);
      }}
    >
      <div className="pp-mgr-head">
        <span
          className="avatar pp-avatar"
          aria-hidden
          style={{ background: avatarBg(manager.full_name) }}
        >
          {initials(manager.full_name)}
        </span>
        <div className="pp-mgr-head-text">
          <span className="pp-mgr-name pp-truncate" title={manager.full_name}>
            {manager.full_name}
          </span>
          <span className="pp-mgr-email pp-truncate" title={manager.email}>
            {manager.email}
          </span>
        </div>
        <span
          className="pp-count-badge"
          title={t("managerAssignments.countTitle", { defaultValue: "Assigned employees" })}
        >
          {manager.employees.length}
        </span>
      </div>
      <div className="pp-mgr-depts">
        {manager.department_codes.length === 0 && (
          <span className="text-xs text-dim">
            {t("managerAssignments.noDepartments", { defaultValue: "No departments" })}
          </span>
        )}
        {manager.department_codes.map((c) => (
          <span key={c} className="pp-dept-tag">
            {c}
          </span>
        ))}
      </div>

      <div className="pp-mgr-list">
        {manager.employees.length === 0 ? (
          <p className="pp-mgr-empty">
            {t("managerAssignments.cardEmpty", {
              defaultValue: "No employees assigned. Drop a chip here to assign.",
            })}
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
  // BUG-034 — better drag affordance: chip fades + flips cursor to
  // "grabbing" while a drag is in flight; subtle hover lift so the
  // operator sees the chip is interactive (people.css .pp-chip).
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  return (
    <div
      draggable
      className={`pp-chip${chip.is_primary ? " is-primary" : ""}${dragging ? " is-dragging" : ""}`}
      onDragStart={(e) => {
        const payload: DragPayload = {
          employee_id: chip.employee_id,
          source,
          source_manager_id,
          source_assignment_id: chip.assignment_id,
        };
        e.dataTransfer.setData(MIME, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      title={`${chip.employee_code} • ${chip.department_code}`}
    >
      <span className="pp-chip-code">{chip.employee_code}</span>
      <span className="pp-chip-name">{chip.full_name}</span>
      <span className="pp-chip-dept">{chip.department_code}</span>
      {source === "manager" && onTogglePrimary && (
        <button
          type="button"
          className="pp-chip-star"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePrimary();
          }}
          aria-label={
            chip.is_primary
              ? t("managerAssignments.unsetPrimary", { defaultValue: "Unset primary" })
              : t("managerAssignments.markPrimary", { defaultValue: "Mark primary" })
          }
          aria-pressed={chip.is_primary}
          title={
            chip.is_primary
              ? t("managerAssignments.primaryTitle", { defaultValue: "Primary manager" })
              : t("managerAssignments.markPrimaryTitle", { defaultValue: "Mark as primary manager" })
          }
        >
          {chip.is_primary ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}
