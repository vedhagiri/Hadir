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
          </p>
        </div>
      </div>

      <div className="card">
        {/* Filter row */}
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: 14,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div className="topbar-search" style={{ flex: 1 }}>
            <Icon name="search" size={13} />
            <input
              placeholder={t("myTeam.searchPlaceholder", {
                defaultValue: "Search by name, code, or email…",
              }) as string}
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
            style={{
              padding: "6px 10px",
              fontSize: 12.5,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-elev)",
              color: "var(--text)",
              minWidth: 200,
            }}
          >
            <option value="">
              {t("myTeam.allDepartments", {
                defaultValue: "All departments",
              }) as string}
            </option>
            {(departments.data?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <span
            className="mono text-xs text-dim"
            style={{ whiteSpace: "nowrap" }}
          >
            {total === 0 ? "0" : `${rangeStart}–${rangeEnd}`} / {total}
          </span>
        </div>

        {/* Table — mirrors EmployeesPage's row layout. */}
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
            {list.isLoading && (
              <tr>
                <td
                  colSpan={5}
                  className="text-sm text-dim"
                  style={{ padding: 14, textAlign: "center" }}
                >
                  {t("common.loading") as string}…
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={5}
                  className="text-sm"
                  style={{
                    padding: 14,
                    textAlign: "center",
                    color: "var(--danger-text)",
                  }}
                >
                  {t("myTeam.loadFailed", {
                    defaultValue: "Could not load your team.",
                  }) as string}
                </td>
              </tr>
            )}
            {!list.isLoading && !list.isError && items.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="text-sm text-dim"
                  style={{ padding: 14, textAlign: "center" }}
                >
                  {t("myTeam.empty", {
                    defaultValue:
                      "No team members assigned to you yet. Ask an Admin to set up your division / department / section so the team-rules can resolve a team.",
                  }) as string}
                </td>
              </tr>
            )}
            {items.map((e) => {
              const role = primaryRoleFromCodes(e.role_codes ?? []);
              const inactive = e.status !== "active";
              return (
                <tr
                  key={e.id}
                  onClick={() => setViewId(e.id)}
                  style={{ cursor: "pointer", opacity: inactive ? 0.6 : 1 }}
                >
                  <td className="mono text-sm">{e.employee_code}</td>
                  <td>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
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
                        {t("employees.photos.none", {
                          defaultValue: "No photos",
                        }) as string}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Pager */}
        {total > 0 && (
          <div
            style={{
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "1px solid var(--border)",
              fontSize: 12.5,
              color: "var(--text-secondary)",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <span>
              {rangeStart}–{rangeEnd} of {total}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn btn-sm"
                onClick={() => setPage(1)}
                disabled={page <= 1}
                aria-label="First page"
              >
                «
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <Icon name="chevronLeft" size={11} />
                {t("common.previous") as string}
              </button>
              <span
                className="mono text-xs"
                style={{
                  minWidth: 80,
                  textAlign: "center",
                  alignSelf: "center",
                }}
              >
                {page} / {totalPages}
              </span>
              <button
                className="btn btn-sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                {t("common.next") as string}
                <Icon name="chevronRight" size={11} />
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setPage(totalPages)}
                disabled={page >= totalPages}
                aria-label="Last page"
              >
                »
              </button>
            </div>
          </div>
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
