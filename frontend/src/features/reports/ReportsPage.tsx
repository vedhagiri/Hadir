// Admin / HR / Manager reports page (P13).
// Date range, employee filter, department filter (Admin/HR-only).
// "Generate Excel" POSTs to /api/reports/attendance.xlsx and triggers a
// browser download via blob + anchor.

import { useEffect, useState } from "react";

import { useMe } from "../../auth/AuthProvider";
import { Icon } from "../../shell/Icon";
import { primaryRole } from "../../types";

const PILOT_DEPARTMENTS = [
  { id: 1, code: "ENG", name: "Engineering" },
  { id: 2, code: "OPS", name: "Operations" },
  { id: 3, code: "ADM", name: "Administration" },
];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isoNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ReportsPage() {
  const me = useMe();
  const role = me.data ? primaryRole(me.data.roles) : "Employee";
  const isAdminLike = role === "Admin" || role === "HR";

  const [start, setStart] = useState<string>(isoNDaysAgo(6));
  const [end, setEnd] = useState<string>(todayIso());
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [employeeId, setEmployeeId] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setInfo(null);
  }, [start, end, departmentId, employeeId]);

  const generate = async () => {
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const body: Record<string, unknown> = { start, end };
      if (isAdminLike && departmentId !== null) body.department_id = departmentId;
      const trimmedEmp = employeeId.trim();
      if (trimmedEmp) body.employee_id = Number(trimmedEmp);

      const resp = await fetch("/api/reports/attendance.xlsx", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        if (resp.status === 403) {
          setError("Forbidden. You don't have access to those rows.");
        } else if (resp.status === 400) {
          const detail = (await resp.json()).detail ?? "Invalid request.";
          setError(detail);
        } else {
          setError(`Report failed (${resp.status}).`);
        }
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        deriveFilenameFromContentDisposition(resp.headers.get("content-disposition")) ??
        `attendance_${start}_to_${end}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setInfo(`Downloaded ${a.download}.`);
    } catch {
      setError("Network error generating the report.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">
            On-demand attendance Excel · scheduled delivery is deferred to v1.0
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Attendance · range</h3>
        </div>
        <div
          className="card-body"
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isAdminLike ? "1fr 1fr 1fr 1fr" : "1fr 1fr 1fr",
              gap: 12,
            }}
          >
            <Field label="From">
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                style={inputStyle}
              />
            </Field>
            {isAdminLike && (
              <Field label="Department">
                <select
                  value={departmentId ?? ""}
                  onChange={(e) =>
                    setDepartmentId(
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  style={inputStyle}
                >
                  <option value="">All departments</option>
                  {PILOT_DEPARTMENTS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Employee id (optional)">
              <input
                type="number"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                placeholder="e.g. 42"
                style={inputStyle}
              />
            </Field>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            {error && (
              <span
                role="alert"
                style={{ color: "var(--danger-text)", fontSize: 12.5 }}
              >
                {error}
              </span>
            )}
            {info && (
              <span style={{ color: "var(--success-text)", fontSize: 12.5 }}>
                {info}
              </span>
            )}
            <button
              className="btn btn-primary"
              onClick={generate}
              disabled={loading}
            >
              <Icon name="download" size={12} />
              {loading ? "Generating…" : "Generate Excel"}
            </button>
          </div>

          <div
            className="text-xs text-dim"
            style={{
              borderTop: "1px solid var(--border)",
              paddingTop: 10,
              lineHeight: 1.5,
            }}
          >
            One sheet per ISO calendar week. Columns:{" "}
            <span className="mono">
              employee_code, name, date, in_time, out_time, total_hours, late,
              early_out, short, overtime_minutes, policy
            </span>
            . Manager exports are auto-scoped to your department(s).
          </div>
        </div>
      </div>
    </>
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

function deriveFilenameFromContentDisposition(
  header: string | null,
): string | null {
  if (!header) return null;
  const m = /filename="([^"]+)"/.exec(header);
  return m ? (m[1] ?? null) : null;
}

const inputStyle = {
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  background: "var(--bg-elev)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;
