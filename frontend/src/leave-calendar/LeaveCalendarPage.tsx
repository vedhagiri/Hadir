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
import { DatePicker } from "../components/DatePicker";
import {
  useApprovedLeaves,
  useCreateApprovedLeave,
  useCreateHoliday,
  useCreateLeaveType,
  useDeleteApprovedLeave,
  useDeleteHoliday,
  useDeleteLeaveType,
  useHolidays,
  useImportHolidaysXlsx,
  useLeaveTypes,
  usePatchLeaveType,
} from "./hooks";
import type {
  ApprovedLeave,
  Holiday,
  LeaveType,
} from "./types";


type Tab = "types" | "holidays" | "leaves";


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

      {/* Tenant timezone + weekend-day controls moved to
          Settings → Workspace so they live alongside the other
          tenant-wide configuration knobs. */}

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


// Tenant timezone + weekend-day controls live at
// ``/settings/workspace`` now. The hooks
// (``useTenantSettings``, ``usePatchTenantSettings``) are still
// imported here because other panels on this page consume them.


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
      {/* BUG-020 — title + button aligned in a header row instead of a
          bare button stuck against the left edge. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 700,
            color: "var(--text)",
          }}
        >
          Leave types
        </h3>
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
                maxLength={32}
                style={inputStyle}
              />
            </Field>
            <Field label="Name">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
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
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
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
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <LeaveTypeRow key={r.id} row={r} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} style={{ ...td, color: "var(--text-tertiary)", textAlign: "center" }}>
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
  const del = useDeleteLeaveType();
  const [delError, setDelError] = useState<string | null>(null);
  const onToggle = async (field: "is_paid" | "active") => {
    try {
      await patch.mutateAsync({ [field]: !row[field] });
    } catch {
      // surfaced lazily in the toggle below
    }
  };
  // BUG-043 — leave types had no delete. Confirm then DELETE; on 409
  // (still referenced by approved_leaves) we surface the backend's
  // friendly "deactivate instead" message inline.
  const onDelete = async () => {
    if (!confirm(`Delete leave type "${row.name}"? This cannot be undone.`)) {
      return;
    }
    setDelError(null);
    try {
      await del.mutateAsync(row.id);
    } catch (err) {
      handleApi(err, setDelError, "Delete failed");
    }
  };
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={{ ...td, fontFamily: "var(--font-mono)", fontSize: 12 }}>
        {row.code}
      </td>
      <td style={td}>
        {row.name}
        {delError && (
          <div style={{ marginTop: 4, color: "var(--danger-text)", fontSize: 11 }}>
            {delError}
          </div>
        )}
      </td>
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
      <td style={{ ...td, textAlign: "right" }}>
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={del.isPending}
          style={btnGhost}
          aria-label={`Delete leave type ${row.name}`}
        >
          {del.isPending ? "Deleting…" : "Delete"}
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
  // BUG-025 — surface the imported / skipped counts so the operator
  // sees whether a same-date file actually inserted anything. Must be
  // declared BEFORE the early-return guards below — otherwise the
  // hook count differs between first paint (still loading) and the
  // post-load render, which breaks the Rules of Hooks and blanks the
  // whole page.
  const [importSummary, setImportSummary] = useState<string | null>(null);

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
    setImportSummary(null);
    try {
      const res = await importer.mutateAsync(f);
      const parts: string[] = [];
      parts.push(
        `${res.imported_count} imported`,
      );
      if (res.skipped_count > 0) {
        const dates = res.skipped
          .slice(0, 3)
          .map((s) => s.date)
          .join(", ");
        const more = res.skipped_count > 3 ? `, +${res.skipped_count - 3} more` : "";
        parts.push(
          `${res.skipped_count} skipped (already exist: ${dates}${more})`,
        );
      }
      setImportSummary(parts.join(" · "));
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
      {/* BUG-025 — explicit import summary banner, replaces the old
          silent same-date no-op. */}
      {importSummary && (
        <div
          style={{
            padding: "8px 12px",
            border: "1px solid #0b6e4f55",
            background: "#0b6e4f0d",
            color: "#0b6e4f",
            borderRadius: 8,
            fontSize: 12.5,
          }}
        >
          {importSummary}
        </div>
      )}

      {/* BUG-022 / BUG-045 — Add button alignment. Place the button in
          its own row, right-aligned, instead of wrapping it in a
          <Field label=" ">. The phantom-label was pushing the button
          below the inputs and made the form look uneven. */}
      <form onSubmit={onAdd} style={formStyle}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
          <Field label="Date">
            <DatePicker
              value={date}
              onChange={setDate}
              ariaLabel="Holiday date"
              triggerStyle={{ width: "100%" }}
            />
          </Field>
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              style={inputStyle}
            />
          </Field>
        </div>
        {error && <div style={errorBox}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button type="submit" disabled={create.isPending} style={btnPrimary}>
            {create.isPending ? "Saving…" : "+ Add holiday"}
          </button>
        </div>
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
              <DatePicker
                value={startDate}
                onChange={setStartDate}
                ariaLabel="Start date"
                triggerStyle={{ width: "100%" }}
              />
            </Field>
            <Field label="End">
              <DatePicker
                value={endDate}
                onChange={setEndDate}
                min={startDate}
                ariaLabel="End date"
                triggerStyle={{ width: "100%" }}
              />
            </Field>
          </div>
          <Field label="Notes">
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
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
