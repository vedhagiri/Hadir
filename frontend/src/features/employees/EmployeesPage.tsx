// Employees list page — Admin only.
// Layout ported from frontend/src/design/pages.jsx (EmployeesPage) — page
// header with Import/Export, card-wrapped table with search + department
// filter in the card head. Rows are clickable and open the detail drawer.

import { useMemo, useState } from "react";

import { Icon } from "../../shell/Icon";
import { EmployeeDrawer } from "./EmployeeDrawer";
import { ImportModal } from "./ImportModal";
import { useEmployeeList } from "./hooks";
import type { Department } from "./types";

// Department codes come from the migration seed — keep them in one place
// so the filter chip list is stable without a /api/departments endpoint
// (not yet exposed; will land with P11's settings surface).
const PILOT_DEPARTMENTS: Department[] = [
  { id: 1, code: "ENG", name: "Engineering" },
  { id: 2, code: "OPS", name: "Operations" },
  { id: 3, code: "ADM", name: "Administration" },
];

export function EmployeesPage() {
  const [q, setQ] = useState("");
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [drawerId, setDrawerId] = useState<number | null>(null);

  const filters = useMemo(
    () => ({
      q,
      department_id: departmentId,
      include_inactive: includeInactive,
      page: 1,
      page_size: 100,
    }),
    [q, departmentId, includeInactive],
  );

  const list = useEmployeeList(filters);

  const onExport = () => {
    // Plain link — the browser downloads the XLSX; cookie auth flows via
    // same-origin so no fetch() wrapper needed.
    window.location.assign("/api/employees/export");
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-sub">
            {list.data
              ? `${list.data.total} ${list.data.total === 1 ? "person" : "people"}`
              : "—"}
            {" · "}
            <span className="mono">{fullyEnrolledPercentage(list.data?.items)}</span>
            {" fully enrolled with reference photos"}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={onExport}>
            <Icon name="download" size={12} />
            Export
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setImportOpen(true)}
          >
            <Icon name="upload" size={12} />
            Import
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">All employees</h3>
          <div className="flex gap-2" style={{ alignItems: "center" }}>
            <div className="topbar-search" style={{ width: 220 }}>
              <Icon name="search" size={13} />
              <input
                placeholder="Search by id, name, email, department"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <select
              value={departmentId ?? ""}
              onChange={(e) =>
                setDepartmentId(e.target.value === "" ? null : Number(e.target.value))
              }
              style={selectStyle}
            >
              <option value="">All departments</option>
              {PILOT_DEPARTMENTS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <label
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
              />
              Include inactive
            </label>
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>ID</th>
              <th>Email</th>
              <th>Department</th>
              <th>Status</th>
              <th style={{ width: 80 }}>Photos</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  Loading…
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td colSpan={6} className="text-sm" style={{ padding: 16, color: "var(--danger-text)" }}>
                  Could not load employees.
                </td>
              </tr>
            )}
            {list.data &&
              list.data.items.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setDrawerId(e.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <div className="avatar">{initials(e.full_name)}</div>
                      <div>
                        <div style={{ fontWeight: 500 }}>{e.full_name}</div>
                        <div className="text-xs text-dim">{e.department.name}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono text-sm">{e.employee_code}</td>
                  <td className="text-sm">{e.email ?? "—"}</td>
                  <td className="text-sm">
                    <span className="pill pill-neutral">{e.department.code}</span>
                  </td>
                  <td>
                    <span
                      className={`pill ${e.status === "active" ? "pill-success" : "pill-warning"}`}
                    >
                      {e.status}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`pill ${e.photo_count > 0 ? "pill-accent" : "pill-neutral"}`}
                    >
                      {e.photo_count}
                    </span>
                  </td>
                </tr>
              ))}
            {list.data && list.data.items.length === 0 && !list.isLoading && (
              <tr>
                <td colSpan={6} className="text-sm text-dim" style={{ padding: 16 }}>
                  No employees match. Try clearing filters or import from Excel.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
      {drawerId !== null && (
        <EmployeeDrawer employeeId={drawerId} onClose={() => setDrawerId(null)} />
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
