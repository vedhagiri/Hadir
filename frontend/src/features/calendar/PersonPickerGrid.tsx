// Card-grid picker for the calendar's per-person tab. Replaces the
// previous "search + dropdown" combo. Shows every employee as a card
// (avatar, name, ID), with a search box (≥3 chars debounced) + a
// department filter, paged at 24/page. Click a card to load that
// employee's monthly calendar.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../../shell/Icon";
import { useDepartments } from "../departments/hooks";
import { useEmployeeList } from "../employees/hooks";
import type { Employee } from "../employees/types";

const PAGE_SIZE = 24;
const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 350;

export function PersonPickerGrid({
  onPickEmployee,
}: {
  onPickEmployee: (employee: Employee) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  // Debounce + 3-char minimum, mirroring the Employees list page.
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length > 0 && trimmed.length < SEARCH_MIN_CHARS) return;
    const handle = setTimeout(() => setDebouncedQ(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [q]);

  // Reset page when filters change.
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, departmentId]);

  const filters = useMemo(
    () => ({
      q: debouncedQ,
      department_id: departmentId,
      include_inactive: false,
      page,
      page_size: PAGE_SIZE,
    }),
    [debouncedQ, departmentId, page],
  );

  const employees = useEmployeeList(filters);
  const departments = useDepartments();

  const totalPages = useMemo(() => {
    if (!employees.data) return 1;
    return Math.max(1, Math.ceil(employees.data.total / employees.data.page_size));
  }, [employees.data]);

  const items = employees.data?.items ?? [];

  return (
    <div className="card" style={{ padding: 14 }}>
      {/* Filter row */}
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div className="topbar-search" style={{ flex: 1 }}>
          <Icon name="search" size={13} />
          <input
            placeholder={t("calendar.picker.searchPlaceholder", {
              defaultValue: "Search employees…",
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
            {t("calendar.picker.allDepartments", {
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
          {employees.data?.items.length ?? 0} / {employees.data?.total ?? 0}
        </span>
      </div>

      {/* Grid */}
      {employees.isLoading && (
        <div className="text-sm text-dim" style={{ padding: 14 }}>
          {t("common.loading") as string}…
        </div>
      )}
      {employees.isError && (
        <div
          className="text-sm"
          style={{ padding: 14, color: "var(--danger-text)" }}
        >
          {t("calendar.picker.loadFailed", {
            defaultValue: "Could not load employees.",
          }) as string}
        </div>
      )}
      {employees.data && items.length === 0 && (
        <div className="text-sm text-dim" style={{ padding: 14 }}>
          {t("calendar.picker.empty", {
            defaultValue: "No employees match. Try widening filters.",
          }) as string}
        </div>
      )}
      {items.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
            gap: 12,
          }}
        >
          {items.map((e) => (
            <EmployeeCard
              key={e.id}
              employee={e}
              onClick={() => onPickEmployee(e)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 12,
          fontSize: 12,
        }}
      >
        <span className="text-dim">
          {t("calendar.picker.pageNumber", {
            page,
            totalPages,
            defaultValue: `Page ${page} of ${totalPages}`,
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
  );
}

function EmployeeCard({
  employee,
  onClick,
}: {
  employee: Employee;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 12,
        textAlign: "center",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        font: "inherit",
        transition: "border-color 0.08s, transform 0.08s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--accent)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <Avatar employee={employee} />
      <div style={{ minHeight: 32 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--text)",
            lineHeight: 1.25,
          }}
        >
          {employee.full_name}
        </div>
        <div
          className="mono text-xs text-dim"
          style={{ marginTop: 2, fontSize: 11 }}
        >
          {employee.employee_code}
        </div>
      </div>
    </button>
  );
}

function Avatar({ employee }: { employee: Employee }) {
  // Initials avatar with a stable per-name tinted background — same
  // palette as the Employees list page. Surfaces the photo_count as
  // a small ring color when the employee has at least one reference
  // photo (cheaper than fetching a thumbnail per card).
  const enrolled = employee.photo_count > 0;
  return (
    <div
      style={{
        position: "relative",
        width: 68,
        height: 68,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          background: avatarBg(employee.full_name),
          color: "white",
          display: "grid",
          placeItems: "center",
          fontSize: 20,
          fontWeight: 600,
          margin: 2,
          boxShadow: enrolled
            ? "0 0 0 2px var(--success)"
            : "0 0 0 2px var(--border)",
        }}
      >
        {initials(employee.full_name)}
      </div>
    </div>
  );
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return (
    (parts[0] ?? "")[0]! + (parts[parts.length - 1] ?? "")[0]!
  ).toUpperCase();
}

function avatarBg(fullName: string): string {
  const palette = [
    "#7c3aed",
    "#2563eb",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#06b6d4",
    "#8b5cf6",
    "#f97316",
  ];
  let hash = 0;
  for (let i = 0; i < fullName.length; i++) {
    hash = (hash * 31 + fullName.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] as string;
}
