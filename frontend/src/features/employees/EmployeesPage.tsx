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

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useMe } from "../../auth/AuthProvider";
import { Icon } from "../../shell/Icon";
import { Pagination } from "../../components/Pagination";
import { useDepartments } from "../departments/hooks";
import { BulkDeleteModal } from "./BulkDeleteModal";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { EmployeeDrawer } from "./EmployeeDrawer";
import { ImportModal } from "./ImportModal";
import {
  useDeleteRequestList,
  useEmployeeList,
  type EmployeeSortBy,
  type EmployeeSortDir,
} from "./hooks";
import type { Employee } from "./types";
import { SkeletonCards, SkeletonGrid, SkeletonRows } from "../../components/Skeleton";
import {
  EmptyPanel,
  FilterSelect,
  KebabMenu,
  ResetButton,
  SearchField,
  StatCard,
  StatGrid,
  Toolbar,
  ViewToggle,
  pct,
  useViewMode,
} from "../../components/ListPageUi";
import { DotPill, LoadErrorPanel, PEOPLE_ICON, StatTile } from "./peopleUi";

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
  const [deletingEmployee, setDeletingEmployee] = useState<Employee | null>(null);
  const [bulkDeleteScope, setBulkDeleteScope] = useState<
    "selected" | "all" | null
  >(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [sortBy, setSortBy] = useState<EmployeeSortBy>("created_at");
  const [sortDir, setSortDir] = useState<EmployeeSortDir>("desc");
  const [view, setView] = useViewMode("maugood.employees.view");

  // The profile now lives on its own route (/employees/:id), so the
  // legacy ``?employee=ID`` deep link simply redirects there.
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const openProfile = (id: number) => navigate(`/employees/${id}`);
  useEffect(() => {
    const raw = searchParams.get("employee");
    if (raw === null) return;
    const id = Number.parseInt(raw, 10);
    if (Number.isFinite(id) && id > 0) navigate(`/employees/${id}`, { replace: true });
  }, [searchParams, navigate]);

  const { data: me } = useMe();
  const isAdmin = !!me?.roles?.includes("Admin");
  // BUG-053 — HR also gets the bulk-delete affordance now.
  const isHr = !!me?.roles?.includes("HR");

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
      // BUG-015 / BUG-018 — pass status_filter server-side so the
      // 'Inactive' chip returns only inactive rows and the
      // pagination total is exact. The legacy include_inactive flag
      // is kept for backwards-compat (server honors status_filter
      // first).
      include_inactive: statusFilter !== "active",
      status_filter: statusFilter as "active" | "inactive" | "all",
      page,
      page_size: PAGE_SIZE,
      sort_by: sortBy,
      sort_dir: sortDir,
    }),
    [debouncedQ, departmentId, statusFilter, page, sortBy, sortDir],
  );

  const list = useEmployeeList(filters);
  const departmentsQuery = useDepartments();
  // Backend gates this at ADMIN_OR_HR — skip the request for any
  // other role to avoid a 403 + noisy network tab on initial setup.
  const pendingDeletes = useDeleteRequestList({ enabled: isAdmin || isHr });
  const pendingByEmployee = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of pendingDeletes.data?.items ?? []) {
      m.set(r.employee_id, r.id);
    }
    return m;
  }, [pendingDeletes.data]);

  // BUG-015 — server already filters by status, no client post-filter
  // needed. Removing the post-filter also makes ``total`` match what
  // the user sees (BUG-018).
  const visibleItems = list.data?.items ?? [];

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

  const enrolledOnPage = visibleItems.filter((e) => e.photo_count > 0).length;
  const missingOnPage = visibleItems.length - enrolledOnPage;
  const pendingDeleteCount = (pendingDeletes.data?.items ?? []).filter(
    (r) => r.status === "pending",
  ).length;
  const filtersActive =
    q.trim() !== "" || departmentId !== null || statusFilter !== "active";
  const resetFilters = () => {
    setQ("");
    setDebouncedQ("");
    setDepartmentId(null);
    setStatusFilter("active");
  };

  // Five-state rendering (brief addendum): loading / error / no records
  // at all / filters match nothing / data. "No records at all" is only
  // claimable when no filter narrows the result.
  const noRecords =
    !list.isLoading && !list.isError && !filtersActive && (list.data?.total ?? 0) === 0;
  const showStats = !list.isError && !noRecords;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("employees.title") as string}</h1>
          <p className="page-sub">
            {t("employees.page.sub", {
              defaultValue:
                "Everyone the cameras can recognise — add people, keep their details current and upload reference photos.",
            }) as string}
          </p>
        </div>
        <div className="page-actions">
          {(isAdmin || isHr) && selected.size > 0 && (
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
          {(isAdmin || isHr) && selected.size === 0 && (
            <button
              className="btn btn-danger"
              onClick={() => setBulkDeleteScope("all")}
              title={t("employees.bulkDelete.allTooltip") as string}
            >
              <Icon name="trash" size={12} />
              {t("employees.bulkDelete.allButton") as string}
            </button>
          )}
          {(() => {
            const noData =
              selected.size === 0 &&
              list.data !== undefined &&
              list.data.total === 0;
            return (
              <button
                className="btn"
                onClick={onExport}
                disabled={noData}
                aria-disabled={noData}
                title={
                  noData
                    ? (t("employees.exportNoData", {
                        defaultValue:
                          "No employee data available to export",
                      }) as string)
                    : undefined
                }
              >
                <Icon name="download" size={12} />
                {selected.size > 0
                  ? (t("employees.exportSelected", {
                      count: selected.size,
                    }) as string)
                  : (t("common.export") as string)}
              </button>
            );
          })()}
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

      {list.isLoading ? (
        <SkeletonCards count={4} minWidth={220} />
      ) : showStats ? (
        <StatGrid>
          <StatCard
            tone="info"
            icon={PEOPLE_ICON.people}
            label={t("employees.stats.people", { defaultValue: "People" }) as string}
            value={list.data?.total ?? 0}
            sub={
              filtersActive
                ? (t("employees.stats.peopleFilteredSub", {
                    defaultValue: "Matching your filters · click to clear",
                  }) as string)
                : (t("employees.stats.peopleActiveSub", { defaultValue: "Currently active" }) as string)
            }
            active={!filtersActive}
            onClick={resetFilters}
          />
          <StatTile
            tone="success"
            icon={PEOPLE_ICON.camera}
            label={t("employees.stats.enrolled", { defaultValue: "Enrolled" }) as string}
            value={enrolledOnPage}
            sub={t("employees.stats.enrolledSub", {
              defaultValue: "{{pct}}% of this page",
              pct: pct(enrolledOnPage, visibleItems.length),
            }) as string}
          />
          <StatTile
            tone="warning"
            icon={PEOPLE_ICON.cameraOff}
            label={t("employees.stats.needPhotos", { defaultValue: "Need photos" }) as string}
            value={missingOnPage}
            sub={t("employees.stats.needPhotosSub", {
              defaultValue: "Not recognisable yet",
            }) as string}
          />
          <StatTile
            tone="danger"
            icon={PEOPLE_ICON.trash}
            label={t("employees.stats.pendingDelete", { defaultValue: "Pending deletion" }) as string}
            value={pendingDeleteCount}
            sub={t("employees.stats.pendingDeleteSub", {
              defaultValue: "Awaiting a decision",
            }) as string}
          />
        </StatGrid>
      ) : null}

      {showStats && !list.isLoading && (
      <Toolbar>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={t("employees.searchPlaceholder") as string}
          clearLabel={t("employees.filters.clearSearch", { defaultValue: "Clear search" }) as string}
        />
        <FilterSelect
          label={t("employees.filters.department", { defaultValue: "Department" }) as string}
          value={departmentId === null ? "" : String(departmentId)}
          onChange={(v) => setDepartmentId(v === "" ? null : Number(v))}
          options={[
            ["", t("employees.allDepartments") as string],
            ...(departmentsQuery.data?.items ?? []).map(
              (d) => [String(d.id), d.name] as [string, string],
            ),
          ]}
        />
        <FilterSelect
          label={t("employees.filters.status", { defaultValue: "Status" }) as string}
          value={statusFilter === "active" ? "" : statusFilter}
          onChange={(v) => setStatusFilter(v === "" ? "active" : (v as StatusFilter))}
          options={[
            ["", t("employees.statusFilter.active") as string],
            ["inactive", t("employees.statusFilter.inactive") as string],
            ["all", t("employees.statusFilter.all") as string],
          ]}
        />
        <span className="pp-count" title={t("employees.pageOfTotal") as string}>
          {list.data?.items.length ?? 0} / {list.data?.total ?? 0}
        </span>
        <ResetButton
          active={filtersActive}
          label={t("employees.filters.reset", { defaultValue: "Reset" }) as string}
          onClick={resetFilters}
        />
        <ViewToggle
          value={view}
          onChange={setView}
          listLabel={t("employees.view.list", { defaultValue: "List view" }) as string}
          gridLabel={t("employees.view.grid", { defaultValue: "Grid view" }) as string}
        />
      </Toolbar>
      )}

      <div className="card">
        {list.isError ? (
          <LoadErrorPanel
            title={t("employees.loadFailed") as string}
            onRetry={() => void list.refetch()}
          />
        ) : !list.isLoading && visibleItems.length === 0 ? (
          <EmployeesEmptyState
            filtered={filtersActive}
            searched={debouncedQ !== ""}
            q={debouncedQ}
            onClear={resetFilters}
            onAdd={() => setDrawerId(null)}
            onImport={() => setImportOpen(true)}
          />
        ) : view === "grid" ? (
          list.isLoading ? (
            <SkeletonGrid count={8} avatar minWidth={280} />
          ) : (
            <div className={`pp-ecard-grid${selected.size > 0 ? " has-selection" : ""}`}>
              {visibleItems.map((e) => {
                const pendingDeleteId = pendingByEmployee.get(e.id);
                const inactive = e.status !== "active";
                const isSelected = selected.has(e.id);
                const role = primaryRoleFromCodes(e.role_codes ?? []);
                return (
                  <div
                    key={e.id}
                    role="button"
                    tabIndex={0}
                    aria-label={t("employees.grid.openAria", {
                      defaultValue: "Open {{name}}",
                      name: e.full_name,
                    }) as string}
                    onClick={() => openProfile(e.id)}
                    onKeyDown={(ev) => {
                      if (ev.target !== ev.currentTarget) return;
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        openProfile(e.id);
                      }
                    }}
                    className={`pp-ecard${isSelected ? " is-selected" : ""}${inactive ? " is-inactive" : ""}`}
                  >
                    {/* Top row: select + actions */}
                    <div className="pp-ecard-top">
                      <span onClick={(ev) => ev.stopPropagation()} className="pp-ecard-check">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(e.id)}
                          aria-label={t("employees.selectRow") as string}
                        />
                      </span>
                      {pendingDeleteId !== undefined && (
                        <span className="pill pill-danger" title={t("employees.delete.pendingTooltip") as string}>
                          {t("employees.delete.pendingBadge") as string}
                        </span>
                      )}
                      <span onClick={(ev) => ev.stopPropagation()} className="pp-ecard-menu">
                        <RowActionsMenu
                          onView={() => openProfile(e.id)}
                          onEdit={() => setDrawerId(e.id)}
                          onDelete={() => setDeletingEmployee(e)}
                        />
                      </span>
                    </div>

                    {/* Identity: photo / initials with status dot, name, title, role */}
                    <div className="pp-ecard-identity">
                      <span className="pp-ecard-avatar">
                        <EmployeeAvatar employee={e} size="lg" />
                        <span
                          className={`pp-ecard-dot${inactive ? " is-off" : ""}`}
                          aria-hidden
                        />
                      </span>
                      <span className="pp-ecard-name" title={e.full_name}>
                        {e.full_name}
                      </span>
                      <span className="pp-ecard-title" title={e.designation ?? e.department.name}>
                        {e.designation ?? e.department.name}
                      </span>
                      {role && (
                        <span className={`pill ${rolePillClass(role)} pp-ecard-role`}>
                          {t(`role.${role}` as const, { defaultValue: role }) as string}
                        </span>
                      )}
                    </div>

                    {/* Facts */}
                    <dl className="pp-ecard-facts">
                      <div className="pp-ecard-fact">
                        <dt>
                          <Icon name="clipboard" size={13} />
                          {t("employees.col.id") as string}
                        </dt>
                        <dd className="mono">{e.employee_code}</dd>
                      </div>
                      <div className="pp-ecard-fact">
                        <dt>
                          <Icon name="users" size={13} />
                          {t("employees.col.department") as string}
                        </dt>
                        <dd title={e.department.name}>{e.department.name}</dd>
                      </div>
                      <div className="pp-ecard-fact">
                        <dt>
                          <Icon name="mail" size={13} />
                          {t("employees.col.email") as string}
                        </dt>
                        <dd title={e.email ?? undefined}>{e.email ?? "—"}</dd>
                      </div>
                    </dl>

                    {/* Footer: status + photo readiness */}
                    <div className="pp-ecard-foot">
                      {inactive ? (
                        <DotPill tone="neutral">{t("employees.statusFilter.inactive") as string}</DotPill>
                      ) : (
                        <DotPill tone="success">{t("employees.statusValue.active") as string}</DotPill>
                      )}
                      {e.photo_count > 0 ? (
                        <PhotoCountPill count={e.photo_count} />
                      ) : (
                        <span
                          className="pill pill-warning pp-nowrap"
                          title={t("employees.card.needsPhotosTitle", {
                            defaultValue: "No reference photo yet — the cameras can't recognise this person.",
                          }) as string}
                        >
                          <Icon name="camera" size={11} />
                          {t("employees.card.needsPhotos", { defaultValue: "Needs photos" }) as string}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          /* BUG-014 — sticky header. The page itself scrolls (the
             table doesn't have its own scroll container), so we pin
             the <thead> rows to the viewport top via position: sticky.
             Each <th> needs an opaque background so the underlying
             row content doesn't bleed through during scroll. */
          <table className="table">
            <thead className="pp-sticky-thead">
              <tr>
                <th className="pp-th-check">
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
                <th>{t("employees.col.email") as string}</th>
                <SortableHeader
                  column="department"
                  label={t("employees.col.department") as string}
                  activeColumn={sortBy}
                  direction={sortDir}
                  onClick={onSortClick}
                />
                <th>{t("employees.col.role") as string}</th>
                <th style={{ width: 130 }}>{t("employees.col.photos") as string}</th>
                <th className="pp-th-end" style={{ width: 64 }}>
                  {t("employees.col.actions") as string}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && <SkeletonRows cols={8} />}
              {visibleItems.map((e) => {
                const pendingDeleteId = pendingByEmployee.get(e.id);
                const inactive = e.status !== "active";
                const isSelected = selected.has(e.id);
                const role = primaryRoleFromCodes(e.role_codes ?? []);
                return (
                  <tr
                    key={e.id}
                    onClick={() => openProfile(e.id)}
                    className={`pp-row-link${isSelected ? " pp-row-selected" : ""}${inactive ? " pp-row-muted" : ""}`}
                  >
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(e.id)}
                        aria-label={t("employees.selectRow") as string}
                      />
                    </td>
                    <td className="mono text-sm pp-nowrap">{e.employee_code}</td>
                    <td>
                      <div className="pp-person">
                        <EmployeeAvatar employee={e} />
                        <div style={{ minWidth: 0 }}>
                          <div className="pp-person-name">
                            {e.full_name}
                            {inactive && (
                              <DotPill tone="neutral">
                                {t("employees.statusFilter.inactive") as string}
                              </DotPill>
                            )}
                          </div>
                          <div className="text-xs text-dim">
                            {e.designation ?? e.department.name}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="text-sm">
                      {e.email ? (
                        <span className="pp-truncate pp-email" title={e.email}>{e.email}</span>
                      ) : (
                        <span className="text-xs text-dim">—</span>
                      )}
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
                    <td>
                      <PhotoCountPill count={e.photo_count} />
                    </td>
                    <td onClick={(ev) => ev.stopPropagation()} className="pp-th-end pp-nowrap">
                      <span className="pp-actions-end" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {pendingDeleteId !== undefined && (
                          <span
                            className="pill pill-danger"
                            title={t("employees.delete.pendingTooltip") as string}
                          >
                            {t("employees.delete.pendingBadge") as string}
                          </span>
                        )}
                        <RowActionsMenu
                          onView={() => openProfile(e.id)}
                          onEdit={() => setDrawerId(e.id)}
                          onDelete={() => setDeletingEmployee(e)}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Pagination strip — BUG-016 / BUG-017 / BUG-018: hide the
            strip entirely when there's no data. Empty state shouldn't
            advertise pages 1-3 with clickable Prev/Next buttons. */}
        {(list.data?.total ?? 0) > 0 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            disabled={list.isFetching}
            summary={
              <>
                {t("employees.pageNumber", { page, totalPages }) as string}
                {" · "}
                {(list.data?.total ?? 0).toLocaleString()} total
              </>
            }
          />
        )}
      </div>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
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
        className="pp-sort-btn"
      >
        {label}
        {active ? (
          <Icon
            name={direction === "asc" ? "chevronUp" : "chevronDown"}
            size={11}
          />
        ) : (
          <span aria-hidden className="pp-sort-hint">
            <Icon name="chevronsUpDown" size={11} />
          </span>
        )}
      </button>
    </th>
  );
}

/** Per-row ⋮ menu (View / Edit / Delete) — the shared KebabMenu. */
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
  return (
    <KebabMenu
      label={t("employees.action.openMenu") as string}
      items={[
        { label: t("employees.action.view") as string, icon: <Icon name="eye" size={13} />, onClick: onView },
        { label: t("employees.action.edit") as string, icon: <Icon name="edit" size={13} />, onClick: onEdit },
        { label: t("employees.action.delete") as string, icon: <Icon name="trash" size={13} />, onClick: onDelete, danger: true },
      ]}
    />
  );
}

function PhotoCountPill({ count }: { count: number }) {
  const { t } = useTranslation();
  return count > 0 ? (
    <span
      className="pill pill-accent pp-nowrap"
      title={t("employees.photos.tooltip", { count }) as string}
    >
      <Icon name="camera" size={11} />
      <span style={{ marginInlineStart: 4 }}>
        {t("employees.photos.count", { count }) as string}
      </span>
    </span>
  ) : (
    <span className="text-xs text-dim pp-nowrap">
      {t("employees.photos.none") as string}
    </span>
  );
}

/** Empty state — no employees at all vs. a search / filter with no hits. */
function EmployeesEmptyState({
  filtered,
  searched,
  q,
  onClear,
  onAdd,
  onImport,
}: {
  filtered: boolean;
  searched: boolean;
  q: string;
  onClear: () => void;
  onAdd: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  if (!filtered) {
    return (
      <EmptyPanel
        tone="accent"
        icon={<Icon name="users" size={30} />}
        title={t("employees.emptyState.noneTitle", { defaultValue: "No employees yet" }) as string}
        body={t("employees.emptyState.noneBody", {
          defaultValue:
            "Add people one at a time or import a spreadsheet. Once they have reference photos the cameras can recognise them.",
        }) as string}
        actions={
          <>
            <button type="button" className="btn" onClick={onImport}>
              <Icon name="upload" size={12} />
              {t("employees.importButton") as string}
            </button>
            <button type="button" className="btn btn-primary" onClick={onAdd}>
              <Icon name="plus" size={12} />
              {t("employees.addButton") as string}
            </button>
          </>
        }
      />
    );
  }
  return (
    <EmptyPanel
      icon={<Icon name={searched ? "search" : "filter"} size={28} />}
      title={
        searched
          ? (t("employees.emptyState.searchTitle", {
              defaultValue: "No one matches “{{q}}”",
              q,
            }) as string)
          : (t("employees.emptyState.filtersTitle", {
              defaultValue: "No employees match these filters",
            }) as string)
      }
      body={t("employees.emptyState.filtersBody", {
        defaultValue:
          "Try a different name, ID or email, or clear the filters to see everyone.",
      }) as string}
      actions={
        <button type="button" className="btn" onClick={onClear}>
          <Icon name="refresh" size={12} />
          {t("employees.emptyState.clearFilters", { defaultValue: "Clear filters" }) as string}
        </button>
      }
    />
  );
}

/** Small, un-audited list thumbnail (see backend get_photo_thumb_endpoint). */
export function employeeThumbUrl(employeeId: number, photoId: number): string {
  return `/api/employees/${employeeId}/photos/${photoId}/thumb`;
}

/**
 * List / grid avatar: the employee's reference-photo thumbnail when one
 * is approved, otherwise coloured initials. Initials render first and
 * the photo fades in only once it has loaded; a failed load keeps the
 * initials, so a row never shows a broken image.
 */
export function EmployeeAvatar({ employee, size }: { employee: Employee; size?: "md" | "lg" }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const photoId = employee.primary_photo_id ?? null;
  const src = photoId != null ? employeeThumbUrl(employee.id, photoId) : null;
  return (
    <div
      className={`avatar pp-avatar${size ? ` pp-avatar-${size}` : ""} pp-avatar-photo`}
      style={{ background: avatarBg(employee.full_name) }}
      aria-hidden
    >
      {initials(employee.full_name)}
      {src && state !== "failed" && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className={state === "loaded" ? "is-loaded" : undefined}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      )}
    </div>
  );
}

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!).toUpperCase();
}

// Stable per-name avatar color — pick from a small palette by hashing
// the full name. Mirrors the design screenshot's tinted circles.
export function avatarBg(fullName: string): string {
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
export function primaryRoleFromCodes(codes: string[]): string | null {
  const order = ["Admin", "HR", "Manager", "Employee"];
  for (const r of order) {
    if (codes.includes(r)) return r;
  }
  return codes[0] ?? null;
}

export function rolePillClass(role: string): string {
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
