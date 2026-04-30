// Employees list — Admin + HR. Visual: docs/scripts/issues-screenshots/02-Employee_listing_screen.png.
//
// Columns: avatar+name+designation, ID, department (name), role pill,
// manager name, action icons. The screenshot's POLICY column is
// intentionally skipped per the operator's brief.
//
// New behaviours layered on the v0.1 page:
//   * Pagination — 50/page (configurable in the page bar).
//   * Department filter pulled live from /api/departments (was a
//     hardcoded PILOT_DEPARTMENTS array).
//   * Search debounced to 350 ms; only fires the server query when
//     the operator typed ≥3 chars (or cleared the box).
//   * Per-row checkboxes feed an "Export selected" path that POSTs
//     the chosen ids to /api/employees/export.
//   * Import accepts XLSX OR CSV. Department codes in the file MUST
//     match an existing /api/departments row — otherwise the row
//     errors with a per-row message.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMe } from "../../auth/AuthProvider";
import { Icon } from "../../shell/Icon";
import { useDepartments } from "../departments/hooks";
import { BulkDeleteModal } from "./BulkDeleteModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { EmployeeDrawer } from "./EmployeeDrawer";
import { EmployeeViewDrawer } from "./EmployeeViewDrawer";
import { ImportModal } from "./ImportModal";
import {
  useDeleteRequestList,
  useEmployeeList,
  type EmployeeSortBy,
  type EmployeeSortDir,
} from "./hooks";
import type { Employee } from "./types";

const PAGE_SIZE = 50;
const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 350;

type StatusFilter = "active" | "inactive" | "all";

export function EmployeesPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [importOpen, setImportOpen] = useState(false);
  const [drawerId, setDrawerId] = useState<number | null | undefined>(undefined);
  const [viewId, setViewId] = useState<number | null>(null);
  const [deletingEmployee, setDeletingEmployee] = useState<Employee | null>(null);
  const [bulkDeleteScope, setBulkDeleteScope] = useState<
    "selected" | "all" | null
  >(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [sortBy, setSortBy] = useState<EmployeeSortBy>("employee_code");
  const [sortDir, setSortDir] = useState<EmployeeSortDir>("asc");

  const { data: me } = useMe();
  const isAdmin = !!me?.roles?.includes("Admin");

  const onSortClick = (column: EmployeeSortBy) => {
    setPage(1);
    setSortBy((prevBy) => {
      if (prevBy === column) {
        // Same column → flip direction
        setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
        return prevBy;
      }
      // Different column → reset to asc
      setSortDir("asc");
      return column;
    });
  };

  // Search debounce — only fire the server query when the input is
  // empty (show all) or has ≥3 chars (avoid noisy hits on every key
  // press).
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length > 0 && trimmed.length < SEARCH_MIN_CHARS) {
      // Skip — keep the previous debouncedQ so the table doesn't
      // flicker between "all" and "filtered" while the operator is
      // typing the first 1-2 chars.
      return;
    }
    const handle = setTimeout(() => setDebouncedQ(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [q]);

  // Reset to page 1 whenever the active filters change.
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, departmentId, statusFilter]);

  const filters = useMemo(
    () => ({
      q: debouncedQ,
      department_id: departmentId,
      include_inactive: statusFilter !== "active",
      page,
      page_size: PAGE_SIZE,
      sort_by: sortBy,
      sort_dir: sortDir,
    }),
    [debouncedQ, departmentId, statusFilter, page, sortBy, sortDir],
  );

  const list = useEmployeeList(filters);
  const departmentsQuery = useDepartments();
  const pendingDeletes = useDeleteRequestList();
  const pendingByEmployee = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of pendingDeletes.data?.items ?? []) {
      m.set(r.employee_id, r.id);
    }
    return m;
  }, [pendingDeletes.data]);

  const visibleItems = useMemo(() => {
    const items = list.data?.items ?? [];
    if (statusFilter === "inactive") {
      return items.filter((e) => e.status === "inactive");
    }
    return items;
  }, [list.data, statusFilter]);

  const totalPages = useMemo(() => {
    if (!list.data) return 1;
    return Math.max(1, Math.ceil(list.data.total / list.data.page_size));
  }, [list.data]);

  const allOnPageSelected =
    visibleItems.length > 0 &&
    visibleItems.every((e) => selected.has(e.id));

  const toggleSelectAllOnPage = () => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allOnPageSelected) {
        for (const e of visibleItems) next.delete(e.id);
      } else {
        for (const e of visibleItems) next.add(e.id);
      }
      return next;
    });
  };

  const toggleOne = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Export — when nothing is selected, exports the full filtered
  // result. When 1+ are selected, scopes to those ids via the
  // ?ids= query param.
  const onExport = () => {
    if (selected.size === 0) {
      window.location.assign("/api/employees/export");
      return;
    }
    const params = new URLSearchParams({
      ids: Array.from(selected).join(","),
    });
    window.location.assign(`/api/employees/export?${params.toString()}`);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("employees.title") as string}</h1>
          <p className="page-sub">
            {list.data
              ? `${list.data.total} ${list.data.total === 1 ? "person" : "people"}`
              : "—"}
            {" · "}
            <span className="mono">
              {fullyEnrolledPercentage(list.data?.items)}
            </span>
            {" "}
            {t("employees.fullyEnrolledSuffix") as string}
          </p>
        </div>
        <div className="page-actions">
          {isAdmin && selected.size > 0 && (
            <button
              className="btn btn-danger"
              onClick={() => setBulkDeleteScope("selected")}
            >
              <Icon name="trash" size={12} />
              {t("employees.bulkDelete.selectedButton", {
                count: selected.size,
              }) as string}
            </button>
          )}
          {isAdmin && selected.size === 0 && (
            <button
              className="btn"
              onClick={() => setBulkDeleteScope("all")}
              title={t("employees.bulkDelete.allTooltip") as string}
            >
              <Icon name="trash" size={12} />
              {t("employees.bulkDelete.allButton") as string}
            </button>
          )}
          <button className="btn" onClick={onExport}>
            <Icon name="download" size={12} />
            {selected.size > 0
              ? (t("employees.exportSelected", {
                  count: selected.size,
                }) as string)
              : (t("common.export") as string)}
          </button>
          <button className="btn" onClick={() => setImportOpen(true)}>
            <Icon name="upload" size={12} />
            {t("employees.importButton") as string}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setDrawerId(null)}
          >
            <Icon name="plus" size={12} />
            {t("employees.addButton") as string}
          </button>
        </div>
      </div>

      <div className="card">
        {/* Unified filter row — search + dept dropdown + status chip
            + page count, mirroring the design screenshot. */}
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div className="topbar-search" style={{ flex: 1 }}>
            <Icon name="search" size={13} />
            <input
              placeholder={t("employees.searchPlaceholder") as string}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select
            value={departmentId ?? ""}
            onChange={(e) =>
              setDepartmentId(
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
            style={{ ...selectStyle, minWidth: 200 }}
          >
            <option value="">{t("employees.allDepartments") as string}</option>
            {(departmentsQuery.data?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <div
            style={{
              display: "inline-flex",
              gap: 0,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: 2,
              background: "var(--bg-sunken)",
            }}
          >
            {(["active", "inactive", "all"] as StatusFilter[]).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setStatusFilter(opt)}
                aria-pressed={statusFilter === opt}
                style={{
                  padding: "4px 8px",
                  fontSize: 11.5,
                  border: "none",
                  background:
                    statusFilter === opt ? "var(--bg-elev)" : "transparent",
                  color:
                    statusFilter === opt
                      ? "var(--text)"
                      : "var(--text-secondary)",
                  fontWeight: statusFilter === opt ? 600 : 500,
                  cursor: "pointer",
                  borderRadius: 3,
                }}
              >
                {t(`employees.statusFilter.${opt}`) as string}
              </button>
            ))}
          </div>
          <div
            className="mono text-xs text-dim"
            style={{ marginInlineStart: 8, whiteSpace: "nowrap" }}
            title={t("employees.pageOfTotal") as string}
          >
            {list.data?.items.length ?? 0} / {list.data?.total ?? 0}
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleSelectAllOnPage}
                  aria-label={t("employees.selectAllOnPage") as string}
                />
              </th>
              <SortableHeader
                column="employee_code"
                label={t("employees.col.id") as string}
                width={110}
                activeColumn={sortBy}
                direction={sortDir}
                onClick={onSortClick}
              />
              <SortableHeader
                column="full_name"
                label={t("employees.col.employee") as string}
                activeColumn={sortBy}
                direction={sortDir}
                onClick={onSortClick}
              />
              <SortableHeader
                column="department"
                label={t("employees.col.department") as string}
                activeColumn={sortBy}
                direction={sortDir}
                onClick={onSortClick}
              />
              <th>{t("employees.col.role") as string}</th>
              <th>{t("employees.col.manager") as string}</th>
              <th style={{ width: 130 }}>
                {t("employees.col.photos") as string}
              </th>
              <th style={{ width: 110, textAlign: "end" }}>
                {t("employees.col.actions") as string}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={8} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("common.loading") as string}
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={8}
                  className="text-sm"
                  style={{ padding: 16, color: "var(--danger-text)" }}
                >
                  {t("employees.loadFailed") as string}
                </td>
              </tr>
            )}
            {visibleItems.map((e) => {
              const pendingDeleteId = pendingByEmployee.get(e.id);
              const inactive = e.status !== "active";
              const isSelected = selected.has(e.id);
              const role = primaryRoleFromCodes(e.role_codes ?? []);
              return (
                <tr
                  key={e.id}
                  onClick={() => setViewId(e.id)}
                  style={{
                    cursor: "pointer",
                    opacity: inactive ? 0.6 : 1,
                    background: isSelected ? "var(--accent-soft)" : undefined,
                  }}
                >
                  <td onClick={(ev) => ev.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(e.id)}
                      aria-label={t("employees.selectRow") as string}
                    />
                  </td>
                  <td className="mono text-sm">{e.employee_code}</td>
                  <td>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <div
                        className="avatar"
                        style={{
                          background: avatarBg(e.full_name),
                          color: "var(--text-on-accent, #fff)",
                          fontWeight: 600,
                        }}
                      >
                        {initials(e.full_name)}
                      </div>
                      <div>
                        <div style={{ fontWeight: 500 }}>{e.full_name}</div>
                        <div className="text-xs text-dim">
                          {e.designation ?? e.department.name}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="text-sm">{e.department.name}</td>
                  <td>
                    {role ? (
                      <span className={`pill ${rolePillClass(role)}`}>
                        {t(`role.${role}` as const, {
                          defaultValue: role,
                        }) as string}
                      </span>
                    ) : (
                      <span className="text-xs text-dim">—</span>
                    )}
                  </td>
                  <td className="text-sm">
                    {e.reports_to_full_name ?? "—"}
                  </td>
                  <td>
                    {e.photo_count > 0 ? (
                      <span
                        className="pill pill-accent"
                        title={t("employees.photos.tooltip", {
                          count: e.photo_count,
                        }) as string}
                      >
                        <Icon name="camera" size={11} />
                        <span style={{ marginInlineStart: 4 }}>
                          {t("employees.photos.count", {
                            count: e.photo_count,
                          }) as string}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-dim">
                        {t("employees.photos.none") as string}
                      </span>
                    )}
                  </td>
                  <td
                    onClick={(ev) => ev.stopPropagation()}
                    style={{ textAlign: "end" }}
                  >
                    {pendingDeleteId !== undefined && (
                      <span
                        className="pill pill-danger"
                        title={t("employees.delete.pendingTooltip") as string}
                        style={{ marginInlineEnd: 6 }}
                      >
                        {t("employees.delete.pendingBadge") as string}
                      </span>
                    )}
                    <RowActionsMenu
                      onView={() => setViewId(e.id)}
                      onEdit={() => setDrawerId(e.id)}
                      onDelete={() => setDeletingEmployee(e)}
                    />
                  </td>
                </tr>
              );
            })}
            {!list.isLoading && visibleItems.length === 0 && (
              <tr>
                <td colSpan={8} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("employees.empty") as string}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Pagination strip */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            fontSize: 12,
          }}
        >
          <span className="text-dim">
            {t("employees.pageNumber", {
              page,
              totalPages,
            }) as string}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <Icon name="chevronLeft" size={11} />
              {t("common.previous") as string}
            </button>
            <button
              className="btn btn-sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t("common.next") as string}
              <Icon name="chevronRight" size={11} />
            </button>
          </div>
        </div>
      </div>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
      {viewId !== null && (
        <EmployeeViewDrawer
          employeeId={viewId}
          onClose={() => setViewId(null)}
          onEdit={() => setDrawerId(viewId)}
        />
      )}
      {drawerId !== undefined && (
        <EmployeeDrawer
          employeeId={drawerId}
          onClose={() => setDrawerId(undefined)}
        />
      )}
      {deletingEmployee && (
        <DeleteConfirmModal
          employee={deletingEmployee}
          onClose={() => setDeletingEmployee(null)}
          onSubmitted={() => {
            setDeletingEmployee(null);
            list.refetch();
            pendingDeletes.refetch();
          }}
        />
      )}
      {bulkDeleteScope !== null && (
        <BulkDeleteModal
          scope={bulkDeleteScope}
          selectedIds={Array.from(selected)}
          selectedCount={selected.size}
          onClose={() => setBulkDeleteScope(null)}
          onSubmitted={() => {
            setSelected(new Set());
            list.refetch();
            pendingDeletes.refetch();
          }}
        />
      )}
    </>
  );
}

/**
 * Per-row kebab menu: vertical 3-dots trigger that opens a small
 * dropdown of View / Edit / Delete actions. Click-outside + Esc
 * dismiss; the trigger and menu both stop event propagation so
 * neither bubbles up to the row click handler (which opens the
 * drawer).
 */
/**
 * Clickable column header. Click cycles asc → desc → asc on the
 * same column; clicking a different column resets to asc on the
 * new column. Active column shows the chevron icon; inactive
 * columns show a dim "both directions" hint so the operator
 * knows they can sort.
 */
function SortableHeader({
  column,
  label,
  width,
  activeColumn,
  direction,
  onClick,
}: {
  column: EmployeeSortBy;
  label: string;
  width?: number;
  activeColumn: EmployeeSortBy;
  direction: EmployeeSortDir;
  onClick: (column: EmployeeSortBy) => void;
}) {
  const active = activeColumn === column;
  return (
    <th style={width != null ? { width } : undefined}>
      <button
        type="button"
        onClick={() => onClick(column)}
        aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "inherit",
          font: "inherit",
          fontWeight: "inherit",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {label}
        {active ? (
          <Icon
            name={direction === "asc" ? "chevronUp" : "chevronDown"}
            size={11}
          />
        ) : (
          // Stacked tiny chevrons hint the column is sortable
          // without picking a direction.
          <span
            aria-hidden
            className="text-dim"
            style={{
              display: "inline-flex",
              flexDirection: "column",
              lineHeight: 0.6,
              fontSize: 9,
              opacity: 0.55,
            }}
          >
            <span>▲</span>
            <span>▼</span>
          </span>
        )}
      </button>
    </th>
  );
}

function RowActionsMenu({
  onView,
  onEdit,
  onDelete,
}: {
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        wrapRef.current &&
        !wrapRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className="icon-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((s) => !s);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("employees.action.openMenu") as string}
        title={t("employees.action.openMenu") as string}
      >
        <Icon name="moreVertical" size={14} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "100%",
            insetInlineEnd: 0,
            marginTop: 4,
            minWidth: 160,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 30,
            padding: 4,
          }}
        >
          <MenuItem
            icon="eye"
            label={t("employees.action.view") as string}
            onClick={pick(onView)}
          />
          <MenuItem
            icon="edit"
            label={t("employees.action.edit") as string}
            onClick={pick(onEdit)}
          />
          <MenuItem
            icon="trash"
            label={t("employees.action.delete") as string}
            onClick={pick(onDelete)}
            danger
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: "eye" | "edit" | "trash";
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        textAlign: "start",
        background: "transparent",
        color: danger ? "var(--danger-text)" : "var(--text)",
        border: "none",
        cursor: "pointer",
        borderRadius: "var(--radius-sm)",
        fontSize: 12.5,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-sunken)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}

const selectStyle = {
  padding: "6px 10px",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}

// Stable per-name avatar color — pick from a small palette by hashing
// the full name. Mirrors the design screenshot's tinted circles.
function avatarBg(fullName: string): string {
  const palette = [
    "#7c3aed", // violet
    "#2563eb", // blue
    "#10b981", // emerald
    "#f59e0b", // amber
    "#ef4444", // red
    "#06b6d4", // cyan
    "#8b5cf6", // purple
    "#f97316", // orange
  ];
  let hash = 0;
  for (let i = 0; i < fullName.length; i++) {
    hash = (hash * 31 + fullName.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] as string;
}

// Pick the most-privileged role for the pill, mirroring the
// frontend's primaryRole() helper for the auth context. Order:
// Admin > HR > Manager > Employee.
function primaryRoleFromCodes(codes: string[]): string | null {
  const order = ["Admin", "HR", "Manager", "Employee"];
  for (const r of order) {
    if (codes.includes(r)) return r;
  }
  return codes[0] ?? null;
}

function rolePillClass(role: string): string {
  switch (role) {
    case "Admin":
      return "pill-danger";
    case "HR":
      return "pill-accent";
    case "Manager":
      return "pill-warning";
    default:
      return "pill-neutral";
  }
}

function fullyEnrolledPercentage(
  items: readonly { photo_count: number }[] | undefined,
): string {
  if (!items || items.length === 0) return "0%";
  const enrolled = items.filter((e) => e.photo_count > 0).length;
  return `${Math.round((enrolled / items.length) * 100)}%`;
}
