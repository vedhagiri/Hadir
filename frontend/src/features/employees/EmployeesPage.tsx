// Employees list page — Admin + HR.
// P28.7 adds: Add Employee button, pencil/eye/trash row icons, pending-
// deletion badge, Active/Inactive filter chip, greyed-out styling for
// inactive rows.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { EmployeeDrawer } from "./EmployeeDrawer";
import { ImportModal } from "./ImportModal";
import {
  useDeleteRequestList,
  useEmployeeList,
} from "./hooks";
import type { Department } from "./types";

const PILOT_DEPARTMENTS: Department[] = [
  { id: 1, code: "ENG", name: "Engineering" },
  { id: 2, code: "OPS", name: "Operations" },
  { id: 3, code: "ADM", name: "Administration" },
];

type StatusFilter = "active" | "inactive" | "all";

export function EmployeesPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [importOpen, setImportOpen] = useState(false);
  // ``drawerId`` semantics:
  //   undefined → no drawer
  //   null      → Add mode
  //   number    → Edit mode for that id
  const [drawerId, setDrawerId] = useState<number | null | undefined>(undefined);

  const filters = useMemo(
    () => ({
      q,
      department_id: departmentId,
      include_inactive: statusFilter !== "active",
      page: 1,
      page_size: 100,
    }),
    [q, departmentId, statusFilter],
  );

  const list = useEmployeeList(filters);
  const pendingDeletes = useDeleteRequestList();
  // Map employee_id → pending request id for the badge.
  const pendingByEmployee = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of pendingDeletes.data?.items ?? []) {
      m.set(r.employee_id, r.id);
    }
    return m;
  }, [pendingDeletes.data]);

  // Apply the inactive-only filter client-side (the backend's
  // include_inactive returns BOTH active+inactive when true).
  const visibleItems = useMemo(() => {
    const items = list.data?.items ?? [];
    if (statusFilter === "inactive") {
      return items.filter((e) => e.status === "inactive");
    }
    return items;
  }, [list.data, statusFilter]);

  const onExport = () => {
    window.location.assign("/api/employees/export");
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
          <button className="btn" onClick={onExport}>
            <Icon name="download" size={12} />
            {t("common.export") as string}
          </button>
          <button
            className="btn"
            onClick={() => setImportOpen(true)}
          >
            <Icon name="upload" size={12} />
            {t("common.import") as string}
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
        <div className="card-head">
          <h3 className="card-title">{t("employees.allEmployees") as string}</h3>
          <div className="flex gap-2" style={{ alignItems: "center" }}>
            <div className="topbar-search" style={{ width: 240 }}>
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
              style={selectStyle}
            >
              <option value="">{t("employees.allDepartments") as string}</option>
              {PILOT_DEPARTMENTS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {/* Active/Inactive segmented chip */}
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
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>{t("employees.col.employee") as string}</th>
              <th>{t("employees.col.id") as string}</th>
              <th>{t("employees.col.email") as string}</th>
              <th>{t("employees.col.department") as string}</th>
              <th>{t("employees.col.status") as string}</th>
              <th style={{ width: 80 }}>{t("employees.col.photos") as string}</th>
              <th style={{ width: 110, textAlign: "end" }}>
                {t("employees.col.actions") as string}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("common.loading") as string}
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td
                  colSpan={7}
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
              return (
                <tr
                  key={e.id}
                  onClick={() => setDrawerId(e.id)}
                  style={{
                    cursor: "pointer",
                    opacity: inactive ? 0.6 : 1,
                  }}
                >
                  <td>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <div className="avatar">{initials(e.full_name)}</div>
                      <div>
                        <div style={{ fontWeight: 500 }}>{e.full_name}</div>
                        <div className="text-xs text-dim">
                          {e.designation ?? e.department.name}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="mono text-sm">{e.employee_code}</td>
                  <td className="text-sm">{e.email ?? "—"}</td>
                  <td className="text-sm">
                    <span className="pill pill-neutral">{e.department.code}</span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <span
                        className={`pill ${
                          e.status === "active" ? "pill-success" : "pill-warning"
                        }`}
                      >
                        {t(`employees.statusValue.${e.status}`) as string}
                      </span>
                      {pendingDeleteId !== undefined && (
                        <span
                          className="pill pill-danger"
                          title={t("employees.delete.pendingTooltip") as string}
                        >
                          {t("employees.delete.pendingBadge") as string}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        e.photo_count > 0 ? "pill-accent" : "pill-neutral"
                      }`}
                    >
                      {e.photo_count}
                    </span>
                  </td>
                  <td
                    onClick={(ev) => ev.stopPropagation()}
                    style={{ textAlign: "end" }}
                  >
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setDrawerId(e.id)}
                      aria-label={t("employees.action.edit") as string}
                      title={t("employees.action.edit") as string}
                    >
                      <Icon name="edit" size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {!list.isLoading && visibleItems.length === 0 && (
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("employees.empty") as string}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
      {drawerId !== undefined && (
        <EmployeeDrawer
          employeeId={drawerId}
          onClose={() => setDrawerId(undefined)}
        />
      )}
    </>
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

function fullyEnrolledPercentage(
  items: readonly { photo_count: number }[] | undefined,
): string {
  if (!items || items.length === 0) return "0%";
  const enrolled = items.filter((e) => e.photo_count > 0).length;
  return `${Math.round((enrolled / items.length) * 100)}%`;
}
