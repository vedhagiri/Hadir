// Leave & Calendar page (Admin + HR — replaces the pilot's
// "leave-policy" placeholder). Three tabs:
//
//   1. Leave Types — CRUD for leave_types.
//   2. Holidays — list + bulk add + xlsx import for the year.
//   3. Approved Leaves — ledger view (the submission + approval
//      workflow lands in P14/P15; this is the storage view).
//
// The Tenant Settings panel at the top of the page exposes
// weekend_days + timezone — the load-bearing inputs the engine
// reads at recompute time.

import { useState } from "react";

import { ApiError } from "../api/client";
import {
  useApprovedLeaves,
  useCreateApprovedLeave,
  useCreateHoliday,
  useCreateLeaveType,
  useDeleteApprovedLeave,
  useDeleteHoliday,
  useHolidays,
  useImportHolidaysXlsx,
  useLeaveTypes,
  usePatchLeaveType,
  usePatchTenantSettings,
  useTenantSettings,
} from "./hooks";
import type {
  ApprovedLeave,
  Holiday,
  LeaveType,
} from "./types";


type Tab = "types" | "holidays" | "leaves";

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];


export function LeaveCalendarPage() {
  const [tab, setTab] = useState<Tab>("types");
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
          Leave &amp; Calendar
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          Configure leave types, the holiday calendar, and the approved-leave
          ledger. Submission + approval workflow ships in P14–P15.
        </p>
      </header>

      <TenantSettingsPanel />

      <div style={{ display: "flex", gap: 4 }}>
        <TabButton tab={tab} value="types" onClick={setTab}>
          Leave types
        </TabButton>
        <TabButton tab={tab} value="holidays" onClick={setTab}>
          Holidays
        </TabButton>
        <TabButton tab={tab} value="leaves" onClick={setTab}>
          Approved leaves
        </TabButton>
      </div>

      {tab === "types" && <LeaveTypesTab />}
      {tab === "holidays" && <HolidaysTab />}
      {tab === "leaves" && <ApprovedLeavesTab />}
    </div>
  );
}


function TabButton({
  tab,
  value,
  onClick,
  children,
}: {
  tab: Tab;
  value: Tab;
  onClick: (t: Tab) => void;
  children: React.ReactNode;
}) {
  const active = tab === value;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      style={{
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent-text)" : "var(--text)",
        border: "1px solid var(--border)",
        borderBottom: active ? "1px solid var(--accent-border)" : "1px solid var(--border)",
        padding: "6px 14px",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: active ? 600 : 500,
      }}
    >
      {children}
    </button>
  );
}


// ---- Tenant settings ----------------------------------------------------


function TenantSettingsPanel() {
  const settings = useTenantSettings();
  const patch = usePatchTenantSettings();
  const [error, setError] = useState<string | null>(null);

  if (settings.isLoading) return <p>Loading tenant settings…</p>;
  if (settings.error || !settings.data)
    return (
      <p style={{ color: "var(--danger-text)" }}>
        Couldn’t load tenant settings.
      </p>
    );

  const onToggleDay = async (day: string) => {
    setError(null);
    const current = new Set(settings.data!.weekend_days);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    try {
      await patch.mutateAsync({ weekend_days: Array.from(current) });
    } catch (err) {
      handleApi(err, setError, "Save failed");
    }
  };

  const onTimezoneChange = async (tz: string) => {
    setError(null);
    try {
      await patch.mutateAsync({ timezone: tz });
    } catch (err) {
      handleApi(err, setError, "Save failed");
    }
  };

  return (
    <section
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <header>
        <h2
          style={{
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--text-tertiary)",
            margin: 0,
          }}
        >
          Tenant settings
        </h2>
        <p
          style={{
            margin: "2px 0 0 0",
            color: "var(--text-secondary)",
            fontSize: 12,
          }}
        >
          Timezone is tenant-scoped — every attendance comparison runs in
          this tenant&apos;s timezone, not the server&apos;s.
        </p>
      </header>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>Timezone (IANA)</span>
          <input
            type="text"
            defaultValue={settings.data.timezone}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== settings.data!.timezone) {
                void onTimezoneChange(v);
              }
            }}
            style={{ ...inputStyle, minWidth: 200 }}
          />
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>Weekend days</span>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {WEEKDAYS.map((d) => {
              const on = settings.data!.weekend_days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => void onToggleDay(d)}
                  disabled={patch.isPending}
                  style={{
                    fontSize: 11.5,
                    padding: "3px 10px",
                    borderRadius: 999,
                    border: on
                      ? "1px solid var(--accent-border)"
                      : "1px solid var(--border)",
                    background: on ? "var(--accent-soft)" : "var(--bg)",
                    color: on ? "var(--accent-text)" : "var(--text)",
                    cursor: "pointer",
                  }}
                >
                  {d.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {error && (
        <div style={errorBox}>{error}</div>
      )}
    </section>
  );
}


// ---- Leave types tab -----------------------------------------------------


function LeaveTypesTab() {
  const list = useLeaveTypes();
  const create = useCreateLeaveType();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isPaid, setIsPaid] = useState(true);

  if (list.isLoading) return <p>Loading leave types…</p>;
  if (list.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>Couldn’t load leave types.</p>
    );
  const rows = list.data ?? [];

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        is_paid: isPaid,
      });
      setCode("");
      setName("");
      setIsPaid(true);
      setShowForm(false);
    } catch (err) {
      handleApi(err, setError, "Save failed");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          style={btnPrimary}
        >
          {showForm ? "Cancel" : "+ New leave type"}
        </button>
      </div>
      {showForm && (
        <form onSubmit={onCreate} style={formStyle}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 10 }}>
            <Field label="Code">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                style={inputStyle}
              />
            </Field>
            <Field label="Name">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                style={inputStyle}
              />
            </Field>
            <Field label="Paid?">
              <select
                value={isPaid ? "yes" : "no"}
                onChange={(e) => setIsPaid(e.target.value === "yes")}
                style={inputStyle}
              >
                <option value="yes">Paid</option>
                <option value="no">Unpaid</option>
              </select>
            </Field>
          </div>
          {error && <div style={errorBox}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" disabled={create.isPending} style={btnPrimary}>
              {create.isPending ? "Saving…" : "Create"}
            </button>
          </div>
        </form>
      )}
      <table style={tableStyle}>
        <thead>
          <tr style={{ background: "var(--bg)" }}>
            <th style={th}>Code</th>
            <th style={th}>Name</th>
            <th style={th}>Paid</th>
            <th style={th}>Active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <LeaveTypeRow key={r.id} row={r} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} style={{ ...td, color: "var(--text-tertiary)", textAlign: "center" }}>
                None yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function LeaveTypeRow({ row }: { row: LeaveType }) {
  const patch = usePatchLeaveType(row.id);
  const onToggle = async (field: "is_paid" | "active") => {
    try {
      await patch.mutateAsync({ [field]: !row[field] });
    } catch {
      // surfaced lazily in the toggle below
    }
  };
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={{ ...td, fontFamily: "var(--font-mono)", fontSize: 12 }}>
        {row.code}
      </td>
      <td style={td}>{row.name}</td>
      <td style={td}>
        <button
          type="button"
          onClick={() => void onToggle("is_paid")}
          disabled={patch.isPending}
          style={chipStyle(row.is_paid)}
        >
          {row.is_paid ? "Paid" : "Unpaid"}
        </button>
      </td>
      <td style={td}>
        <button
          type="button"
          onClick={() => void onToggle("active")}
          disabled={patch.isPending}
          style={chipStyle(row.active)}
        >
          {row.active ? "active" : "inactive"}
        </button>
      </td>
    </tr>
  );
}


// ---- Holidays tab --------------------------------------------------------


function HolidaysTab() {
  const today = new Date();
  const [year, setYear] = useState<number>(today.getFullYear());
  const list = useHolidays(year);
  const create = useCreateHoliday();
  const del = useDeleteHoliday();
  const importer = useImportHolidaysXlsx();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState("");
  const [name, setName] = useState("");

  if (list.isLoading) return <p>Loading holidays…</p>;
  if (list.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>Couldn’t load holidays.</p>
    );
  const rows = list.data ?? [];

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({ date, name: name.trim() });
      setDate("");
      setName("");
    } catch (err) {
      handleApi(err, setError, "Save failed");
    }
  };

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError(null);
    try {
      await importer.mutateAsync(f);
    } catch (err) {
      handleApi(err, setError, "Import failed");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12 }}>
          Year{" "}
          <input
            type="number"
            value={year}
            onChange={(e) =>
              setYear(Number.parseInt(e.target.value, 10) || today.getFullYear())
            }
            min={2020}
            max={2100}
            style={{ ...inputStyle, width: 80 }}
          />
        </label>
        <label
          style={{
            ...btnPrimary,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          Import .xlsx
          <input type="file" accept=".xlsx" hidden onChange={onImport} />
        </label>
      </div>

      <form onSubmit={onAdd} style={formStyle}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 10 }}>
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
              style={inputStyle}
            />
          </Field>
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={inputStyle}
            />
          </Field>
          <Field label=" ">
            <button type="submit" disabled={create.isPending} style={btnPrimary}>
              {create.isPending ? "Saving…" : "Add"}
            </button>
          </Field>
        </div>
        {error && <div style={errorBox}>{error}</div>}
      </form>

      <table style={tableStyle}>
        <thead>
          <tr style={{ background: "var(--bg)" }}>
            <th style={th}>Date</th>
            <th style={th}>Day</th>
            <th style={th}>Name</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <HolidayRow
              key={r.id}
              row={r}
              onDelete={() => void del.mutateAsync(r.id)}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={4}
                style={{ ...td, color: "var(--text-tertiary)", textAlign: "center" }}
              >
                None yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function HolidayRow({
  row,
  onDelete,
}: {
  row: Holiday;
  onDelete: () => void;
}) {
  // Build a UTC date so the rendered weekday isn't browser-tz dependent.
  const d = new Date(row.date + "T00:00:00Z");
  const weekday = d.toLocaleDateString(undefined, {
    weekday: "long",
    timeZone: "UTC",
  });
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={td}>{row.date}</td>
      <td style={td}>{weekday}</td>
      <td style={td}>{row.name}</td>
      <td style={{ ...td, textAlign: "right" }}>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete holiday "${row.name}"?`)) onDelete();
          }}
          style={btnGhost}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}


// ---- Approved leaves tab -------------------------------------------------


function ApprovedLeavesTab() {
  const leaves = useApprovedLeaves();
  const types = useLeaveTypes();
  const create = useCreateApprovedLeave();
  const del = useDeleteApprovedLeave();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [employeeId, setEmployeeId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");

  if (leaves.isLoading || types.isLoading) return <p>Loading leaves…</p>;
  if (leaves.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>Couldn’t load leaves.</p>
    );
  const rows = leaves.data ?? [];
  const typeOptions = (types.data ?? []).filter((t) => t.active);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        employee_id: Number.parseInt(employeeId, 10),
        leave_type_id: Number.parseInt(leaveTypeId, 10),
        start_date: startDate,
        end_date: endDate,
        notes: notes.trim() || null,
      });
      setEmployeeId("");
      setLeaveTypeId("");
      setStartDate("");
      setEndDate("");
      setNotes("");
      setShowForm(false);
    } catch (err) {
      handleApi(err, setError, "Save failed");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          style={btnPrimary}
        >
          {showForm ? "Cancel" : "+ New approved leave"}
        </button>
      </div>
      {showForm && (
        <form onSubmit={onCreate} style={formStyle}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: 10,
            }}
          >
            <Field label="Employee id">
              <input
                type="number"
                min={1}
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                required
                style={inputStyle}
              />
            </Field>
            <Field label="Leave type">
              <select
                value={leaveTypeId}
                onChange={(e) => setLeaveTypeId(e.target.value)}
                required
                style={inputStyle}
              >
                <option value="">Select…</option>
                {typeOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                style={inputStyle}
              />
            </Field>
            <Field label="End">
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                style={inputStyle}
              />
            </Field>
          </div>
          <Field label="Notes">
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={inputStyle}
            />
          </Field>
          {error && <div style={errorBox}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" disabled={create.isPending} style={btnPrimary}>
              {create.isPending ? "Saving…" : "Create"}
            </button>
          </div>
        </form>
      )}
      <table style={tableStyle}>
        <thead>
          <tr style={{ background: "var(--bg)" }}>
            <th style={th}>Employee</th>
            <th style={th}>Type</th>
            <th style={th}>Start</th>
            <th style={th}>End</th>
            <th style={th}>Notes</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <ApprovedLeaveRow
              key={r.id}
              row={r}
              onDelete={() => void del.mutateAsync(r.id)}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={6}
                style={{ ...td, color: "var(--text-tertiary)", textAlign: "center" }}
              >
                None yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function ApprovedLeaveRow({
  row,
  onDelete,
}: {
  row: ApprovedLeave;
  onDelete: () => void;
}) {
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={td}>{row.employee_id}</td>
      <td style={td}>{row.leave_type_name}</td>
      <td style={td}>{row.start_date}</td>
      <td style={td}>{row.end_date}</td>
      <td style={{ ...td, color: "var(--text-secondary)", fontSize: 12.5 }}>
        {row.notes ?? "—"}
      </td>
      <td style={{ ...td, textAlign: "right" }}>
        <button
          type="button"
          onClick={() => {
            if (confirm("Delete this approved leave?")) onDelete();
          }}
          style={btnGhost}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}


// ---- Shared bits ---------------------------------------------------------


function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}


function handleApi(
  err: unknown,
  setError: (s: string | null) => void,
  fallback: string,
) {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: unknown } | null;
    if (typeof body?.detail === "string") {
      setError(body.detail);
      return;
    }
    setError(`${fallback} (${err.status}).`);
    return;
  }
  setError(fallback);
}


const labelStyle = {
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-tertiary)",
};

const inputStyle = {
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
  outline: "none",
} as const;

const btnPrimary = {
  background: "var(--accent)",
  color: "white",
  border: "none",
  padding: "6px 12px",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
} as const;

const btnGhost = {
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: "4px 10px",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  fontSize: 12.5,
} as const;

const formStyle = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  padding: 14,
  display: "flex" as const,
  flexDirection: "column" as const,
  gap: 8,
};

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: 13,
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  overflow: "hidden",
};

const th = {
  padding: "10px 12px",
  textAlign: "left" as const,
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-tertiary)",
};

const td = { padding: "10px 12px" };

const errorBox = {
  background: "var(--danger-soft)",
  color: "var(--danger-text)",
  border: "1px solid var(--border)",
  padding: "6px 10px",
  borderRadius: "var(--radius-sm)",
  fontSize: 12.5,
} as const;

function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    border: active
      ? "1px solid var(--accent-border)"
      : "1px solid var(--border)",
    background: active ? "var(--accent-soft)" : "var(--bg)",
    color: active ? "var(--accent-text)" : "var(--text)",
    cursor: "pointer",
  };
}
