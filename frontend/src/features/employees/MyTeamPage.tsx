// Manager-scoped team list. Mirrors the structure of EmployeesPage —
// avatar + photo-count column + click-to-open EmployeeViewDrawer with
// Details / Attendance / Camera events / Team Members tabs — but
// strips the admin-only actions (Add / Edit / Delete / Import /
// Export / Re-match). Backed by ``GET /api/employees/my-team`` so the
// rows are already narrowed to the manager's team via the team-rule
// resolver applied to the manager's own employee record.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { Icon } from "../../shell/Icon";
import { useDepartments } from "../departments/hooks";
import { EmployeeViewDrawer } from "./EmployeeViewDrawer";
import {
  avatarBg,
  initials,
  primaryRoleFromCodes,
  rolePillClass,
} from "./EmployeesPage";
import type { EmployeeListResponse } from "./types";
import { SkeletonCards, SkeletonGrid, SkeletonRows } from "../../components/Skeleton";
import { Pagination } from "../../components/Pagination";
import {
  CardFact,
  CardGrid,
  EmptyPanel,
  FilterSelect,
  ResetButton,
  SearchField,
  StatCard,
  StatGrid,
  Toolbar,
  ViewToggle,
  gridCardStyle,
  pct,
  useViewMode,
} from "../../components/ListPageUi";
import { DotPill, LoadErrorPanel, PEOPLE_ICON, StatTile } from "./peopleUi";

const PAGE_SIZE = 50;
const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 350;

export function MyTeamPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [viewId, setViewId] = useState<number | null>(null);
  const [view, setView] = useViewMode("maugood.myTeam.view");

  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length > 0 && trimmed.length < SEARCH_MIN_CHARS) return;
    const handle = setTimeout(() => setDebouncedQ(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, departmentId]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set("q", debouncedQ);
    if (departmentId !== null) p.set("department_id", String(departmentId));
    p.set("page", String(page));
    p.set("page_size", String(PAGE_SIZE));
    p.set("sort_by", "full_name");
    p.set("sort_dir", "asc");
    return p.toString();
  }, [debouncedQ, departmentId, page]);

  const list = useQuery({
    queryKey: ["employees", "my-team", params],
    queryFn: () =>
      api<EmployeeListResponse>(`/api/employees/my-team?${params}`),
    staleTime: 30_000,
  });

  const departments = useDepartments();
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, page * PAGE_SIZE);

  const enrolledOnPage = items.filter((e) => e.photo_count > 0).length;
  const missingOnPage = items.length - enrolledOnPage;
  const inactiveOnPage = items.filter((e) => e.status !== "active").length;
  const filtersActive = q.trim() !== "" || departmentId !== null;
  const resetFilters = () => {
    setQ("");
    setDebouncedQ("");
    setDepartmentId(null);
  };

  // Five-state rendering: stats + toolbar hide when the manager has no
  // team at all (nothing to filter) or the request failed.
  const noRecords = !list.isLoading && !list.isError && !filtersActive && total === 0;
  const showStats = !list.isError && !noRecords;

  const openOnKey = (id: number) => (ev: React.KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      setViewId(id);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("nav.items.my-team", { defaultValue: "My Team" }) as string}
          </h1>
          <p className="page-sub">
            {t("myTeam.subtitle", {
              count: total,
              defaultValue:
                total === 1
                  ? "1 team member assigned to you"
                  : `${total} team members assigned to you`,
            }) as string}
            {" · "}
            {t("myTeam.subHint", {
              defaultValue: "Open anyone to see their attendance and camera events.",
            }) as string}
          </p>
        </div>
      </div>

      {list.isLoading ? (
        <SkeletonCards count={4} minWidth={220} />
      ) : showStats ? (
        <StatGrid>
          <StatCard
            tone="info"
            icon={PEOPLE_ICON.people}
            label={t("myTeam.stats.members", { defaultValue: "Team members" }) as string}
            value={total}
            sub={
              filtersActive
                ? (t("employees.stats.peopleFilteredSub", {
                    defaultValue: "Matching your filters · click to clear",
                  }) as string)
                : (t("myTeam.stats.membersSub", { defaultValue: "Assigned to you" }) as string)
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
              pct: pct(enrolledOnPage, items.length),
            }) as string}
          />
          <StatTile
            tone="warning"
            icon={PEOPLE_ICON.cameraOff}
            label={t("employees.stats.needPhotos", { defaultValue: "Need photos" }) as string}
            value={missingOnPage}
            sub={t("employees.stats.needPhotosSub", { defaultValue: "Not recognisable yet" }) as string}
          />
          <StatTile
            tone="neutral"
            icon={PEOPLE_ICON.clock}
            label={t("employees.statusValue.inactive") as string}
            value={inactiveOnPage}
            sub={t("myTeam.stats.inactiveSub", { defaultValue: "Deactivated or relieved" }) as string}
          />
        </StatGrid>
      ) : null}

      {showStats && !list.isLoading && (
      <Toolbar>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={t("myTeam.searchPlaceholder", {
            defaultValue: "Search by name, code, or email…",
          }) as string}
          clearLabel={t("employees.filters.clearSearch", { defaultValue: "Clear search" }) as string}
        />
        <FilterSelect
          label={t("employees.filters.department", { defaultValue: "Department" }) as string}
          value={departmentId === null ? "" : String(departmentId)}
          onChange={(v) => setDepartmentId(v === "" ? null : Number(v))}
          options={[
            [
              "",
              t("myTeam.allDepartments", { defaultValue: "All departments" }) as string,
            ],
            ...(departments.data?.items ?? []).map(
              (d) => [String(d.id), d.name] as [string, string],
            ),
          ]}
        />
        <span className="pp-count">
          {total === 0 ? "0" : `${rangeStart}–${rangeEnd}`} / {total}
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
            title={t("myTeam.loadFailed", { defaultValue: "Could not load your team." }) as string}
            onRetry={() => void list.refetch()}
          />
        ) : !list.isLoading && items.length === 0 ? (
          filtersActive ? (
            <EmptyPanel
              icon={<Icon name={debouncedQ ? "search" : "filter"} size={28} />}
              title={t("employees.emptyState.filtersTitle", {
                defaultValue: "No employees match these filters",
              }) as string}
              body={t("employees.emptyState.filtersBody", {
                defaultValue:
                  "Try a different name, ID or email, or clear the filters to see everyone.",
              }) as string}
              actions={
                <button type="button" className="btn" onClick={resetFilters}>
                  <Icon name="refresh" size={12} />
                  {t("employees.emptyState.clearFilters", { defaultValue: "Clear filters" }) as string}
                </button>
              }
            />
          ) : (
            <EmptyPanel
              tone="accent"
              icon={<Icon name="users" size={30} />}
              title={t("myTeam.emptyTitle", { defaultValue: "No team members yet" }) as string}
              body={t("myTeam.empty", {
                defaultValue:
                  "No team members assigned to you yet. Ask an Admin to set up your division / department / section so the team-rules can resolve a team.",
              }) as string}
            />
          )
        ) : view === "grid" ? (
          list.isLoading ? (
            <SkeletonGrid count={6} avatar minWidth={260} />
          ) : (
            <CardGrid minWidth={260}>
              {items.map((e) => {
                const role = primaryRoleFromCodes(e.role_codes ?? []);
                const inactive = e.status !== "active";
                return (
                  <div
                    key={e.id}
                    role="button"
                    tabIndex={0}
                    aria-label={t("employees.grid.openAria", {
                      defaultValue: "Open {{name}}",
                      name: e.full_name,
                    }) as string}
                    onClick={() => setViewId(e.id)}
                    onKeyDown={openOnKey(e.id)}
                    className={`card clickable${inactive ? " pp-card-muted" : ""}`}
                    style={{ ...gridCardStyle, cursor: "pointer" }}
                  >
                    <div className="pp-card-top">
                      <div className="avatar pp-avatar pp-avatar-md" style={{ background: avatarBg(e.full_name) }}>
                        {initials(e.full_name)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="pp-truncate" title={e.full_name} style={{ fontWeight: 600, fontSize: 14.5 }}>
                          {e.full_name}
                        </span>
                        <span className="pp-truncate text-xs text-dim" style={{ marginTop: 2 }}>
                          {e.designation ?? e.department.name}
                        </span>
                      </div>
                    </div>
                    <div className="pp-card-pills">
                      {role && (
                        <span className={`pill ${rolePillClass(role)}`}>
                          {t(`role.${role}` as const, { defaultValue: role }) as string}
                        </span>
                      )}
                      <DotPill tone={inactive ? "neutral" : "success"}>
                        {t(inactive ? "employees.statusValue.inactive" : "employees.statusValue.active") as string}
                      </DotPill>
                    </div>
                    <div className="pp-card-facts">
                      <CardFact label={t("employees.col.code", { defaultValue: "Employee ID" }) as string}>
                        <span className="mono pp-nowrap">{e.employee_code}</span>
                      </CardFact>
                      <CardFact label={t("employees.col.department", { defaultValue: "Department" }) as string}>
                        {e.department.name}
                      </CardFact>
                      <CardFact label={t("employees.col.photos", { defaultValue: "Photos" }) as string}>
                        <TeamPhotoPill count={e.photo_count} />
                      </CardFact>
                    </div>
                  </div>
                );
              })}
            </CardGrid>
          )
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>
                  {t("employees.col.code", {
                    defaultValue: "Employee ID",
                  }) as string}
                </th>
                <th>
                  {t("employees.col.employee", {
                    defaultValue: "Employee",
                  }) as string}
                </th>
                <th>
                  {t("employees.col.department", {
                    defaultValue: "Department",
                  }) as string}
                </th>
                <th>
                  {t("employees.col.role", {
                    defaultValue: "Role",
                  }) as string}
                </th>
                <th style={{ width: 130 }}>
                  {t("employees.col.photos", {
                    defaultValue: "Photos",
                  }) as string}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && <SkeletonRows cols={5} />}
              {items.map((e) => {
                const role = primaryRoleFromCodes(e.role_codes ?? []);
                const inactive = e.status !== "active";
                return (
                  <tr
                    key={e.id}
                    tabIndex={0}
                    onClick={() => setViewId(e.id)}
                    onKeyDown={openOnKey(e.id)}
                    className={`pp-row-link${inactive ? " pp-row-muted" : ""}`}
                  >
                    <td className="mono text-sm pp-nowrap">{e.employee_code}</td>
                    <td>
                      <div className="pp-person">
                        <div className="avatar pp-avatar" style={{ background: avatarBg(e.full_name) }}>
                          {initials(e.full_name)}
                        </div>
                        <div>
                          <div className="pp-person-name">{e.full_name}</div>
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
                    <td>
                      <TeamPhotoPill count={e.photo_count} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {total > 0 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            disabled={list.isFetching}
            summary={
              <>
                {rangeStart}–{rangeEnd} / {total}
              </>
            }
          />
        )}
      </div>

      {/* Read-only drawer — Manager isn't authorised for the Edit
          path so we pass a no-op onEdit (the drawer shows the
          button, but Manager has no Edit drawer to open). */}
      {viewId !== null && (
        <EmployeeViewDrawer
          employeeId={viewId}
          onClose={() => setViewId(null)}
          onEdit={() => {
            // no-op for Manager — Edit lives on the Admin/HR drawer
          }}
        />
      )}
    </>
  );
}

function TeamPhotoPill({ count }: { count: number }) {
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
      {t("employees.photos.none", { defaultValue: "No photos" }) as string}
    </span>
  );
}
