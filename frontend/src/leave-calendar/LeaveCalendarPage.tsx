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

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import type { Employee } from "../features/employees/types";
import { DatePicker } from "../components/DatePicker";
import { ModalShell } from "../components/DrawerShell";
import { Icon } from "../shell/Icon";
import { useEmployeeList } from "../features/employees/hooks";
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
  usePatchApprovedLeave,
  usePatchHoliday,
  usePatchLeaveType,
} from "./hooks";
import type {
  ApprovedLeave,
  Holiday,
  LeaveType,
} from "./types";


type Tab = "types" | "holidays" | "leaves";


export function LeaveCalendarPage() {
  const { t } = useTranslation();
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
          {t("leaveCalendar.title")}
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          {t("leaveCalendar.subtitle")}
        </p>
      </header>

      {/* Tenant timezone + weekend-day controls moved to
          Settings → Workspace so they live alongside the other
          tenant-wide configuration knobs. */}

      <div style={{ display: "flex", gap: 4 }}>
        <TabButton tab={tab} value="types" onClick={setTab}>
          {t("leaveCalendar.tabs.types")}
        </TabButton>
        <TabButton tab={tab} value="holidays" onClick={setTab}>
          {t("leaveCalendar.tabs.holidays")}
        </TabButton>
        <TabButton tab={tab} value="leaves" onClick={setTab}>
          {t("leaveCalendar.tabs.leaves")}
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
  const { t } = useTranslation();
  const list = useLeaveTypes();
  const create = useCreateLeaveType();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isPaid, setIsPaid] = useState(true);

  if (list.isLoading) return <p>{t("leaveCalendar.loadingTypes")}</p>;
  if (list.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>{t("leaveCalendar.loadFailedTypes")}</p>
    );
  const rows = list.data ?? [];

  const canSubmit = code.trim() !== "" && name.trim() !== "";

  const closeForm = () => {
    setShowForm(false);
    setError(null);
    setCode("");
    setName("");
    setIsPaid(true);
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!canSubmit) {
      setError(t("leaveCalendar.errors.fillCodeName"));
      return;
    }
    try {
      await create.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        is_paid: isPaid,
      });
      closeForm();
    } catch (err) {
      handleApi(err, setError, t("leaveCalendar.errors.saveFailed"));
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
          {t("leaveCalendar.tabs.types")}
        </h3>
        <button type="button" onClick={() => setShowForm(true)} style={btnPrimary}>
          {t("leaveCalendar.newType")}
        </button>
      </div>
      {showForm && (
        <ModalShell onClose={closeForm}>
          <div
            role="dialog"
            aria-labelledby="new-leave-type-title"
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 480,
              maxWidth: "90vw",
              background: "var(--bg)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius)",
              padding: 20,
              zIndex: 60,
              boxShadow: "var(--shadow-lg)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <header
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
              }}
            >
              <h2 id="new-leave-type-title" style={{ margin: 0, fontSize: 18 }}>
                {t("leaveCalendar.newType")}
              </h2>
              <button
                className="icon-btn"
                type="button"
                onClick={closeForm}
                aria-label={t("leaveCalendar.actions.close")}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <form
              onSubmit={onCreate}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                <Field label={t("leaveCalendar.fields.code")} required>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    maxLength={32}
                    style={inputStyle}
                  />
                </Field>
                <Field label={t("leaveCalendar.fields.paidQ")}>
                  <select
                    value={isPaid ? "yes" : "no"}
                    onChange={(e) => setIsPaid(e.target.value === "yes")}
                    style={inputStyle}
                  >
                    <option value="yes">{t("leaveCalendar.fields.paid")}</option>
                    <option value="no">{t("leaveCalendar.fields.unpaid")}</option>
                  </select>
                </Field>
              </div>
              <Field label={t("leaveCalendar.fields.name")} required>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  style={inputStyle}
                />
              </Field>
              {error && <div style={errorBox}>{error}</div>}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={closeForm}
                  disabled={create.isPending}
                >
                  {t("leaveCalendar.actions.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit || create.isPending}
                  style={{ ...btnPrimary, opacity: canSubmit ? 1 : 0.5 }}
                >
                  {create.isPending ? t("leaveCalendar.actions.saving") : t("leaveCalendar.actions.create")}
                </button>
              </div>
            </form>
          </div>
        </ModalShell>
      )}
      <table style={tableStyle}>
        <thead>
          <tr style={{ background: "var(--bg)" }}>
            <th style={th}>{t("leaveCalendar.cols.code")}</th>
            <th style={th}>{t("leaveCalendar.cols.name")}</th>
            <th style={th}>{t("leaveCalendar.cols.paid")}</th>
            <th style={th}>{t("leaveCalendar.cols.active")}</th>
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
                {t("leaveCalendar.empty")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function LeaveTypeRow({ row }: { row: LeaveType }) {
  const { t } = useTranslation();
  const patch = usePatchLeaveType(row.id);
  const del = useDeleteLeaveType();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const onToggle = async (field: "is_paid" | "active") => {
    try {
      await patch.mutateAsync({ [field]: !row[field] });
    } catch {
      // surfaced lazily in the toggle below
    }
  };
  const askDelete = () => {
    setDelError(null);
    setConfirmOpen(true);
  };
  // BUG-043 — leave types had no delete. Confirm then DELETE; on 409
  // (still referenced by approved_leaves) we surface the backend's
  // friendly "deactivate instead" message inside the modal so the
  // operator can fall back to the inactive toggle without losing it.
  const onConfirmDelete = async () => {
    setDelError(null);
    try {
      await del.mutateAsync(row.id);
      setConfirmOpen(false);
    } catch (err) {
      handleApi(err, setDelError, t("leaveCalendar.errors.deleteFailed"));
    }
  };

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState(row.name);
  const [editPaid, setEditPaid] = useState(row.is_paid);
  const [editError, setEditError] = useState<string | null>(null);
  const openEdit = () => {
    setEditName(row.name);
    setEditPaid(row.is_paid);
    setEditError(null);
    setEditOpen(true);
  };
  const canSaveEdit = editName.trim() !== "";
  const onSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditError(null);
    if (!canSaveEdit) {
      setEditError(t("leaveCalendar.errors.nameRequired"));
      return;
    }
    try {
      await patch.mutateAsync({ name: editName.trim(), is_paid: editPaid });
      setEditOpen(false);
    } catch (err) {
      handleApi(err, setEditError, t("leaveCalendar.errors.saveFailed"));
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
          {row.is_paid ? t("leaveCalendar.fields.paid") : t("leaveCalendar.fields.unpaid")}
        </button>
      </td>
      <td style={td}>
        <button
          type="button"
          onClick={() => void onToggle("active")}
          disabled={patch.isPending}
          style={chipStyle(row.active)}
        >
          {row.active ? t("leaveCalendar.fields.activeLower") : t("leaveCalendar.fields.inactiveLower")}
        </button>
      </td>
      <td style={{ ...td, textAlign: "right" }}>
        <div
          style={{
            display: "inline-flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <button
            type="button"
            onClick={openEdit}
            disabled={patch.isPending}
            style={{
              ...btnGhost,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
            aria-label={t("leaveCalendar.actions.editTypeAria", { name: row.name })}
          >
            <Icon name="edit" size={12} /> {t("leaveCalendar.actions.edit")}
          </button>
          <button
            type="button"
            onClick={askDelete}
            disabled={del.isPending}
            style={{
              ...btnGhost,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "var(--danger-text)",
            }}
            aria-label={t("leaveCalendar.actions.deleteTypeAria", { name: row.name })}
          >
            <Icon name="trash" size={12} /> {t("leaveCalendar.actions.delete")}
          </button>
        </div>
        {confirmOpen && (
          <ModalShell onClose={() => setConfirmOpen(false)}>
            <div
              role="dialog"
              aria-labelledby="lt-delete-title"
              style={{
                position: "fixed",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: 420,
                maxWidth: "90vw",
                background: "var(--bg)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius)",
                padding: 20,
                zIndex: 60,
                boxShadow: "var(--shadow-lg)",
                textAlign: "left",
              }}
            >
              <h2 id="lt-delete-title" style={{ margin: "0 0 8px 0", fontSize: 16 }}>
                {t("leaveCalendar.deleteTypeTitle")}{" "}
                <span className="mono">{row.code}</span>?
              </h2>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
                {t("leaveCalendar.deleteTypeBody", { name: row.name })}
              </p>
              {delError && (
                <div
                  style={{
                    color: "var(--danger-text)",
                    fontSize: 12,
                    margin: "10px 0 0 0",
                  }}
                >
                  {delError}
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 16,
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setConfirmOpen(false)}
                  disabled={del.isPending}
                >
                  {t("leaveCalendar.actions.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void onConfirmDelete()}
                  disabled={del.isPending}
                  style={{
                    background: "var(--danger-bg)",
                    color: "var(--danger-text)",
                    borderColor: "var(--danger-border)",
                  }}
                >
                  {del.isPending ? t("leaveCalendar.actions.deleting") : t("leaveCalendar.actions.delete")}
                </button>
              </div>
            </div>
          </ModalShell>
        )}
        {editOpen && (
          <ModalShell onClose={() => setEditOpen(false)}>
            <div
              role="dialog"
              aria-labelledby="lt-edit-title"
              style={{ ...modalPanel, width: 460, textAlign: "left" }}
            >
              <header style={modalHeader}>
                <h2 id="lt-edit-title" style={{ margin: 0, fontSize: 18 }}>
                  {t("leaveCalendar.editType")}
                </h2>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={() => setEditOpen(false)}
                  aria-label={t("leaveCalendar.actions.close")}
                >
                  <Icon name="x" size={14} />
                </button>
              </header>
              <form
                onSubmit={onSaveEdit}
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  }}
                >
                  <Field label={t("leaveCalendar.fields.code")}>
                    <input
                      type="text"
                      value={row.code}
                      disabled
                      title={t("leaveCalendar.codeLocked")}
                      style={{ ...inputStyle, opacity: 0.7 }}
                    />
                  </Field>
                  <Field label={t("leaveCalendar.fields.paidQ")}>
                    <select
                      value={editPaid ? "yes" : "no"}
                      onChange={(e) => setEditPaid(e.target.value === "yes")}
                      style={inputStyle}
                    >
                      <option value="yes">{t("leaveCalendar.fields.paid")}</option>
                      <option value="no">{t("leaveCalendar.fields.unpaid")}</option>
                    </select>
                  </Field>
                </div>
                <Field label={t("leaveCalendar.fields.name")} required>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    required
                    maxLength={80}
                    style={inputStyle}
                  />
                </Field>
                {editError && <div style={errorBox}>{editError}</div>}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                    marginTop: 4,
                  }}
                >
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setEditOpen(false)}
                    disabled={patch.isPending}
                  >
                    {t("leaveCalendar.actions.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={!canSaveEdit || patch.isPending}
                    style={{ ...btnPrimary, opacity: canSaveEdit ? 1 : 0.5 }}
                  >
                    {patch.isPending ? t("leaveCalendar.actions.saving") : t("leaveCalendar.actions.saveChanges")}
                  </button>
                </div>
              </form>
            </div>
          </ModalShell>
        )}
      </td>
    </tr>
  );
}


// ---- Holidays tab --------------------------------------------------------


function HolidaysTab() {
  const { t } = useTranslation();
  const today = new Date();
  const [year, setYear] = useState<number>(today.getFullYear());
  const [yearText, setYearText] = useState<string>(String(today.getFullYear()));
  const list = useHolidays(year);
  const create = useCreateHoliday();
  const importer = useImportHolidaysXlsx();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // BUG-025 — surface the imported / skipped counts so the operator
  // sees whether a same-date file actually inserted anything. Must be
  // declared BEFORE the early-return guards below — otherwise the
  // hook count differs between first paint (still loading) and the
  // post-load render, which breaks the Rules of Hooks and blanks the
  // whole page.
  const [importSummary, setImportSummary] = useState<string | null>(null);

  if (list.isLoading) return <p>{t("leaveCalendar.loadingHolidays")}</p>;
  if (list.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>{t("leaveCalendar.loadFailedHolidays")}</p>
    );
  const rows = list.data ?? [];
  const thisYear = today.getFullYear();
  const yearOptions = Array.from({ length: 9 }, (_, i) => thisYear - 3 + i);
  const canAddHoliday = date !== "" && name.trim() !== "";

  const closeAdd = () => {
    setShowAdd(false);
    setError(null);
    setDate("");
    setName("");
  };

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!canAddHoliday) {
      setError(t("leaveCalendar.errors.chooseDateName"));
      return;
    }
    try {
      await create.mutateAsync({ date, name: name.trim() });
      closeAdd();
    } catch (err) {
      handleApi(err, setError, t("leaveCalendar.errors.saveFailed"));
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
      parts.push(t("leaveCalendar.import.imported", { count: res.imported_count }));
      if (res.skipped_count > 0) {
        const dates = res.skipped
          .slice(0, 3)
          .map((s) => s.date)
          .join(", ");
        const more = res.skipped_count > 3 ? t("leaveCalendar.import.more", { count: res.skipped_count - 3 }) : "";
        parts.push(
          t("leaveCalendar.import.skipped", { count: res.skipped_count, dates: `${dates}${more}` }),
        );
      }
      setImportSummary(parts.join(" · "));
    } catch (err) {
      handleApi(err, setError, t("leaveCalendar.errors.importFailed"));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ fontWeight: 600 }}>{t("leaveCalendar.year")}</span>
          <input
            type="number"
            value={yearText}
            list="holiday-year-options"
            min={2000}
            max={2100}
            aria-label={t("leaveCalendar.filterYearAria")}
            placeholder={t("leaveCalendar.yearPlaceholder")}
            onChange={(e) => {
              const raw = e.target.value;
              setYearText(raw);
              const n = Number.parseInt(raw, 10);
              if (Number.isInteger(n) && n >= 2000 && n <= 2100) {
                setYear(n);
              }
            }}
            onBlur={() => setYearText(String(year))}
            style={{ ...inputStyle, width: 120 }}
          />
          <datalist id="holiday-year-options">
            {yearOptions.map((y) => (
              <option key={y} value={y} />
            ))}
          </datalist>
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(null);
              setImportSummary(null);
              setShowImport(true);
            }}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Icon name="upload" size={13} /> {t("leaveCalendar.import.button")}
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setShowAdd(true);
            }}
            style={btnPrimary}
          >
            {t("leaveCalendar.addHoliday")}
          </button>
        </div>
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

      <table style={tableStyle}>
        <thead>
          <tr style={{ background: "var(--bg)" }}>
            <th style={th}>{t("leaveCalendar.cols.date")}</th>
            <th style={th}>{t("leaveCalendar.cols.day")}</th>
            <th style={th}>{t("leaveCalendar.cols.name")}</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <HolidayRow key={r.id} row={r} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={4}
                style={{ ...td, color: "var(--text-tertiary)", textAlign: "center" }}
              >
                {t("leaveCalendar.empty")}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {showAdd && (
        <ModalShell onClose={closeAdd}>
          <div
            role="dialog"
            aria-labelledby="new-holiday-title"
            style={modalPanel}
          >
            <header style={modalHeader}>
              <h2 id="new-holiday-title" style={{ margin: 0, fontSize: 18 }}>
                {t("leaveCalendar.newHoliday")}
              </h2>
              <button
                className="icon-btn"
                type="button"
                onClick={closeAdd}
                aria-label={t("leaveCalendar.actions.close")}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <form
              onSubmit={onAdd}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <Field label={t("leaveCalendar.fields.date")} required>
                <DatePicker
                  value={date}
                  onChange={setDate}
                  ariaLabel={t("leaveCalendar.fields.holidayDateAria")}
                  triggerStyle={{ width: "100%" }}
                />
              </Field>
              <Field label={t("leaveCalendar.fields.name")} required>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={120}
                  style={inputStyle}
                />
              </Field>
              {error && <div style={errorBox}>{error}</div>}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={closeAdd}
                  disabled={create.isPending}
                >
                  {t("leaveCalendar.actions.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!canAddHoliday || create.isPending}
                  style={{ ...btnPrimary, opacity: canAddHoliday ? 1 : 0.5 }}
                >
                  {create.isPending ? t("leaveCalendar.actions.saving") : t("leaveCalendar.addHoliday")}
                </button>
              </div>
            </form>
          </div>
        </ModalShell>
      )}

      {showImport && (
        <ModalShell onClose={() => setShowImport(false)}>
          <div
            role="dialog"
            aria-labelledby="import-holidays-title"
            style={modalPanel}
          >
            <header style={modalHeader}>
              <h2
                id="import-holidays-title"
                style={{ margin: 0, fontSize: 18 }}
              >
                {t("leaveCalendar.import.title")}
              </h2>
              <button
                className="icon-btn"
                type="button"
                onClick={() => setShowImport(false)}
                aria-label={t("leaveCalendar.actions.close")}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
              }}
            >
              {t("leaveCalendar.import.instructionsLead")}{" "}
              <strong>.xlsx</strong>{" "}
              {t("leaveCalendar.import.instructionsCols")}{" "}
              <span className="mono">date</span> (YYYY-MM-DD),{" "}
              <span className="mono">name</span>,{" "}
              {t("leaveCalendar.import.instructionsOptional")}{" "}
              <span className="mono">description</span>.{" "}
              {t("leaveCalendar.import.instructionsSkip")}
            </p>
            <a
              href="/api/holidays/import-template"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "var(--accent-strong, var(--accent))",
                textDecoration: "none",
              }}
            >
              <Icon name="download" size={13} /> {t("leaveCalendar.import.template")}
            </a>
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "22px 16px",
                border: "1.5px dashed var(--border-strong)",
                borderRadius: "var(--radius)",
                cursor: importer.isPending ? "wait" : "pointer",
                color: "var(--text-secondary)",
                fontSize: 13,
                textAlign: "center",
              }}
            >
              <Icon name="upload" size={18} />
              {importer.isPending
                ? t("leaveCalendar.import.importing")
                : t("leaveCalendar.import.choosePrompt")}
              <input
                type="file"
                accept=".xlsx"
                hidden
                disabled={importer.isPending}
                onChange={onImport}
              />
            </label>
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
            {error && <div style={errorBox}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn"
                onClick={() => setShowImport(false)}
                disabled={importer.isPending}
              >
                {t("leaveCalendar.actions.done")}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}


function HolidayRow({ row }: { row: Holiday }) {
  const { t } = useTranslation();
  const del = useDeleteHoliday();
  const patch = usePatchHoliday(row.id);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  const onConfirmDelete = async () => {
    setDelError(null);
    try {
      await del.mutateAsync(row.id);
      setConfirmOpen(false);
    } catch (err) {
      handleApi(err, setDelError, t("leaveCalendar.errors.deleteFailed"));
    }
  };

  const [editOpen, setEditOpen] = useState(false);
  const [editDate, setEditDate] = useState(row.date);
  const [editName, setEditName] = useState(row.name);
  const [editError, setEditError] = useState<string | null>(null);
  const openEdit = () => {
    setEditDate(row.date);
    setEditName(row.name);
    setEditError(null);
    setEditOpen(true);
  };
  const canSaveEdit = editDate !== "" && editName.trim() !== "";
  const onSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditError(null);
    if (!canSaveEdit) {
      setEditError(t("leaveCalendar.errors.chooseDateName"));
      return;
    }
    try {
      await patch.mutateAsync({ date: editDate, name: editName.trim() });
      setEditOpen(false);
    } catch (err) {
      handleApi(err, setEditError, t("leaveCalendar.errors.saveFailed"));
    }
  };

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
          onClick={openEdit}
          disabled={patch.isPending}
          style={{
            ...btnGhost,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginInlineEnd: 6,
          }}
          aria-label={t("leaveCalendar.actions.editHolidayAria", { name: row.name })}
        >
          <Icon name="edit" size={12} /> {t("leaveCalendar.actions.edit")}
        </button>
        <button
          type="button"
          onClick={() => {
            setDelError(null);
            setConfirmOpen(true);
          }}
          disabled={del.isPending}
          style={{
            ...btnGhost,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "var(--danger-text)",
          }}
          aria-label={t("leaveCalendar.actions.deleteHolidayAria", { name: row.name })}
        >
          <Icon name="trash" size={12} /> {t("leaveCalendar.actions.delete")}
        </button>
        {confirmOpen && (
          <ModalShell onClose={() => setConfirmOpen(false)}>
            <div
              role="dialog"
              aria-labelledby="holiday-delete-title"
              style={{ ...modalPanel, width: 420, gap: 0, textAlign: "left" }}
            >
              <h2
                id="holiday-delete-title"
                style={{ margin: "0 0 8px 0", fontSize: 16 }}
              >
                {t("leaveCalendar.deleteHolidayTitle")}
              </h2>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  margin: 0,
                }}
              >
                {t("leaveCalendar.deleteHolidayBody", { name: row.name, date: row.date })}
              </p>
              {delError && (
                <div
                  style={{
                    color: "var(--danger-text)",
                    fontSize: 12,
                    margin: "10px 0 0 0",
                  }}
                >
                  {delError}
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 16,
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setConfirmOpen(false)}
                  disabled={del.isPending}
                >
                  {t("leaveCalendar.actions.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void onConfirmDelete()}
                  disabled={del.isPending}
                  style={{
                    background: "var(--danger-bg)",
                    color: "var(--danger-text)",
                    borderColor: "var(--danger-border)",
                  }}
                >
                  {del.isPending ? t("leaveCalendar.actions.deleting") : t("leaveCalendar.actions.delete")}
                </button>
              </div>
            </div>
          </ModalShell>
        )}
        {editOpen && (
          <ModalShell onClose={() => setEditOpen(false)}>
            <div
              role="dialog"
              aria-labelledby="holiday-edit-title"
              style={{ ...modalPanel, width: 460, textAlign: "left" }}
            >
              <header style={modalHeader}>
                <h2 id="holiday-edit-title" style={{ margin: 0, fontSize: 18 }}>
                  {t("leaveCalendar.editHoliday")}
                </h2>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={() => setEditOpen(false)}
                  aria-label={t("leaveCalendar.actions.close")}
                >
                  <Icon name="x" size={14} />
                </button>
              </header>
              <form
                onSubmit={onSaveEdit}
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <Field label={t("leaveCalendar.fields.date")} required>
                  <DatePicker
                    value={editDate}
                    onChange={setEditDate}
                    ariaLabel={t("leaveCalendar.fields.holidayDateAria")}
                    triggerStyle={{ width: "100%" }}
                  />
                </Field>
                <Field label={t("leaveCalendar.fields.name")} required>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    required
                    maxLength={120}
                    style={inputStyle}
                  />
                </Field>
                {editError && <div style={errorBox}>{editError}</div>}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                    marginTop: 4,
                  }}
                >
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setEditOpen(false)}
                    disabled={patch.isPending}
                  >
                    {t("leaveCalendar.actions.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={!canSaveEdit || patch.isPending}
                    style={{ ...btnPrimary, opacity: canSaveEdit ? 1 : 0.5 }}
                  >
                    {patch.isPending ? t("leaveCalendar.actions.saving") : t("leaveCalendar.actions.saveChanges")}
                  </button>
                </div>
              </form>
            </div>
          </ModalShell>
        )}
      </td>
    </tr>
  );
}


// ---- Approved leaves tab -------------------------------------------------


function ApprovedLeavesTab() {
  const { t } = useTranslation();
  const leaves = useApprovedLeaves();
  const types = useLeaveTypes();
  const employees = useEmployeeList({
    q: "",
    department_id: null,
    include_inactive: false,
    page: 1,
    page_size: 200,
  });
  const create = useCreateApprovedLeave();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [employeeId, setEmployeeId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");

  if (leaves.isLoading || types.isLoading || employees.isLoading)
    return <p>{t("leaveCalendar.loadingLeaves")}</p>;
  if (leaves.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>{t("leaveCalendar.loadFailedLeaves")}</p>
    );
  const rows = leaves.data ?? [];
  const typeOptions = (types.data ?? []).filter((t) => t.active);
  const employeeOptions = (employees.data?.items ?? []).slice().sort((a, b) =>
    a.employee_code.localeCompare(b.employee_code),
  );
  const employeeLookup = new Map(
    employeeOptions.map((e) => [e.id, e] as const),
  );

  const canSubmit =
    employeeId !== "" &&
    leaveTypeId !== "" &&
    startDate !== "" &&
    endDate !== "" &&
    endDate >= startDate;

  const closeForm = () => {
    setShowForm(false);
    setError(null);
    setEmployeeId("");
    setLeaveTypeId("");
    setStartDate("");
    setEndDate("");
    setNotes("");
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!employeeId) {
      setError(t("leaveCalendar.errors.selectEmployee"));
      return;
    }
    if (!leaveTypeId) {
      setError(t("leaveCalendar.errors.selectLeaveType"));
      return;
    }
    if (!startDate) {
      setError(t("leaveCalendar.errors.chooseStart"));
      return;
    }
    if (!endDate) {
      setError(t("leaveCalendar.errors.chooseEnd"));
      return;
    }
    if (endDate < startDate) {
      setError(t("leaveCalendar.errors.endBeforeStart"));
      return;
    }
    try {
      await create.mutateAsync({
        employee_id: Number.parseInt(employeeId, 10),
        leave_type_id: Number.parseInt(leaveTypeId, 10),
        start_date: startDate,
        end_date: endDate,
        notes: notes.trim() || null,
      });
      closeForm();
    } catch (err) {
      handleApi(err, setError, t("leaveCalendar.errors.saveFailed"));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={() => setShowForm(true)} style={btnPrimary}>
          {t("leaveCalendar.newLeave")}
        </button>
      </div>
      {showForm && (
        <ModalShell onClose={closeForm}>
          <div
            role="dialog"
            aria-labelledby="new-leave-title"
            style={{ ...modalPanel, width: 640 }}
          >
            <header style={modalHeader}>
              <h2 id="new-leave-title" style={{ margin: 0, fontSize: 18 }}>
                {t("leaveCalendar.newLeave")}
              </h2>
              <button
                className="icon-btn"
                type="button"
                onClick={closeForm}
                aria-label={t("leaveCalendar.actions.close")}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <form
              onSubmit={onCreate}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                <Field label={t("leaveCalendar.fields.employee")} required>
                  <EmployeeSearchSelect
                    options={employeeOptions}
                    value={employeeId}
                    onChange={setEmployeeId}
                    placeholder={t("leaveCalendar.fields.employeeSearchPlaceholder")}
                  />
                </Field>
                <Field label={t("leaveCalendar.fields.leaveType")} required>
                  <select
                    value={leaveTypeId}
                    onChange={(e) => setLeaveTypeId(e.target.value)}
                    required
                    style={inputStyle}
                  >
                    <option value="">{t("leaveCalendar.fields.selectPlaceholder")}</option>
                    {typeOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("leaveCalendar.fields.start")} required>
                  <DatePicker
                    value={startDate}
                    onChange={setStartDate}
                    ariaLabel={t("leaveCalendar.fields.startDateAria")}
                    triggerStyle={{ width: "100%" }}
                  />
                </Field>
                <Field label={t("leaveCalendar.fields.end")} required>
                  <DatePicker
                    value={endDate}
                    onChange={setEndDate}
                    min={startDate}
                    ariaLabel={t("leaveCalendar.fields.endDateAria")}
                    triggerStyle={{ width: "100%" }}
                  />
                </Field>
              </div>
              <Field label={t("leaveCalendar.fields.notes")}>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={500}
                  style={inputStyle}
                />
              </Field>
              {error && <div style={errorBox}>{error}</div>}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={closeForm}
                  disabled={create.isPending}
                >
                  {t("leaveCalendar.actions.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit || create.isPending}
                  style={{ ...btnPrimary, opacity: canSubmit ? 1 : 0.5 }}
                >
                  {create.isPending ? t("leaveCalendar.actions.saving") : t("leaveCalendar.actions.create")}
                </button>
              </div>
            </form>
          </div>
        </ModalShell>
      )}
      <table style={tableStyle}>
        <thead>
          <tr style={{ background: "var(--bg)" }}>
            <th style={th}>{t("leaveCalendar.cols.employee")}</th>
            <th style={th}>{t("leaveCalendar.cols.type")}</th>
            <th style={th}>{t("leaveCalendar.cols.start")}</th>
            <th style={th}>{t("leaveCalendar.cols.end")}</th>
            <th style={th}>{t("leaveCalendar.cols.notes")}</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const emp = employeeLookup.get(r.employee_id);
            return (
              <ApprovedLeaveRow
                key={r.id}
                row={r}
                employeeLabel={
                  emp
                    ? `${emp.employee_code} — ${emp.full_name}`
                    : `#${r.employee_id}`
                }
                typeOptions={typeOptions}
                employeeOptions={employeeOptions}
              />
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={6}
                style={{ ...td, color: "var(--text-tertiary)", textAlign: "center" }}
              >
                {t("leaveCalendar.empty")}
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
  employeeLabel,
  typeOptions,
  employeeOptions,
}: {
  row: ApprovedLeave;
  employeeLabel: string;
  typeOptions: LeaveType[];
  employeeOptions: Employee[];
}) {
  const { t } = useTranslation();
  const del = useDeleteApprovedLeave();
  const patch = usePatchApprovedLeave(row.id);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  const onConfirmDelete = async () => {
    setDelError(null);
    try {
      await del.mutateAsync(row.id);
      setConfirmOpen(false);
    } catch (err) {
      handleApi(err, setDelError, t("leaveCalendar.errors.deleteFailed"));
    }
  };

  const [editOpen, setEditOpen] = useState(false);
  const [eEmployee, setEEmployee] = useState(String(row.employee_id));
  const [eType, setEType] = useState(String(row.leave_type_id));
  const [eStart, setEStart] = useState(row.start_date);
  const [eEnd, setEEnd] = useState(row.end_date);
  const [eNotes, setENotes] = useState(row.notes ?? "");
  const [editError, setEditError] = useState<string | null>(null);
  const openEdit = () => {
    setEEmployee(String(row.employee_id));
    setEType(String(row.leave_type_id));
    setEStart(row.start_date);
    setEEnd(row.end_date);
    setENotes(row.notes ?? "");
    setEditError(null);
    setEditOpen(true);
  };
  const canSaveEdit =
    eEmployee !== "" &&
    eType !== "" &&
    eStart !== "" &&
    eEnd !== "" &&
    eEnd >= eStart;
  const onSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditError(null);
    if (!eEmployee) {
      setEditError(t("leaveCalendar.errors.selectEmployee"));
      return;
    }
    if (!eType) {
      setEditError(t("leaveCalendar.errors.selectLeaveType"));
      return;
    }
    if (!eStart) {
      setEditError(t("leaveCalendar.errors.chooseStart"));
      return;
    }
    if (!eEnd) {
      setEditError(t("leaveCalendar.errors.chooseEnd"));
      return;
    }
    if (eEnd < eStart) {
      setEditError(t("leaveCalendar.errors.endBeforeStart"));
      return;
    }
    try {
      await patch.mutateAsync({
        employee_id: Number.parseInt(eEmployee, 10),
        leave_type_id: Number.parseInt(eType, 10),
        start_date: eStart,
        end_date: eEnd,
        notes: eNotes.trim() || null,
      });
      setEditOpen(false);
    } catch (err) {
      handleApi(err, setEditError, t("leaveCalendar.errors.saveFailed"));
    }
  };

  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={td}>{employeeLabel}</td>
      <td style={td}>{row.leave_type_name}</td>
      <td style={td}>{row.start_date}</td>
      <td style={td}>{row.end_date}</td>
      <td style={{ ...td, color: "var(--text-secondary)", fontSize: 12.5 }}>
        {row.notes ?? "—"}
      </td>
      <td style={{ ...td, textAlign: "right" }}>
        <button
          type="button"
          onClick={openEdit}
          disabled={patch.isPending}
          style={{
            ...btnGhost,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginInlineEnd: 6,
          }}
          aria-label={t("leaveCalendar.actions.editLeaveAria", { name: employeeLabel })}
        >
          <Icon name="edit" size={12} /> {t("leaveCalendar.actions.edit")}
        </button>
        <button
          type="button"
          onClick={() => {
            setDelError(null);
            setConfirmOpen(true);
          }}
          disabled={del.isPending}
          style={{
            ...btnGhost,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "var(--danger-text)",
          }}
          aria-label={t("leaveCalendar.actions.deleteLeaveAria", { name: employeeLabel })}
        >
          <Icon name="trash" size={12} /> {t("leaveCalendar.actions.delete")}
        </button>
        {confirmOpen && (
          <ModalShell onClose={() => setConfirmOpen(false)}>
            <div
              role="dialog"
              aria-labelledby="leave-delete-title"
              style={{ ...modalPanel, width: 420, gap: 0, textAlign: "left" }}
            >
              <h2
                id="leave-delete-title"
                style={{ margin: "0 0 8px 0", fontSize: 16 }}
              >
                {t("leaveCalendar.deleteLeaveTitle")}
              </h2>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  margin: 0,
                }}
              >
                {t("leaveCalendar.deleteLeaveBody", {
                  type: row.leave_type_name,
                  name: employeeLabel,
                  start: row.start_date,
                  end: row.end_date,
                })}
              </p>
              {delError && (
                <div
                  style={{
                    color: "var(--danger-text)",
                    fontSize: 12,
                    margin: "10px 0 0 0",
                  }}
                >
                  {delError}
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 16,
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setConfirmOpen(false)}
                  disabled={del.isPending}
                >
                  {t("leaveCalendar.actions.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void onConfirmDelete()}
                  disabled={del.isPending}
                  style={{
                    background: "var(--danger-bg)",
                    color: "var(--danger-text)",
                    borderColor: "var(--danger-border)",
                  }}
                >
                  {del.isPending ? t("leaveCalendar.actions.deleting") : t("leaveCalendar.actions.delete")}
                </button>
              </div>
            </div>
          </ModalShell>
        )}
        {editOpen && (
          <ModalShell onClose={() => setEditOpen(false)}>
            <div
              role="dialog"
              aria-labelledby="leave-edit-title"
              style={{ ...modalPanel, width: 640, textAlign: "left" }}
            >
              <header style={modalHeader}>
                <h2 id="leave-edit-title" style={{ margin: 0, fontSize: 18 }}>
                  {t("leaveCalendar.editLeave")}
                </h2>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={() => setEditOpen(false)}
                  aria-label={t("leaveCalendar.actions.close")}
                >
                  <Icon name="x" size={14} />
                </button>
              </header>
              <form
                onSubmit={onSaveEdit}
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  }}
                >
                  <Field label={t("leaveCalendar.fields.employee")} required>
                    <EmployeeSearchSelect
                      options={employeeOptions}
                      value={eEmployee}
                      onChange={setEEmployee}
                      placeholder={t("leaveCalendar.fields.employeeSearchPlaceholder")}
                    />
                  </Field>
                  <Field label={t("leaveCalendar.fields.leaveType")} required>
                    <select
                      value={eType}
                      onChange={(e) => setEType(e.target.value)}
                      required
                      style={inputStyle}
                    >
                      <option value="">{t("leaveCalendar.fields.selectPlaceholder")}</option>
                      {typeOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("leaveCalendar.fields.start")} required>
                    <DatePicker
                      value={eStart}
                      onChange={setEStart}
                      ariaLabel={t("leaveCalendar.fields.startDateAria")}
                      triggerStyle={{ width: "100%" }}
                    />
                  </Field>
                  <Field label={t("leaveCalendar.fields.end")} required>
                    <DatePicker
                      value={eEnd}
                      onChange={setEEnd}
                      min={eStart}
                      ariaLabel={t("leaveCalendar.fields.endDateAria")}
                      triggerStyle={{ width: "100%" }}
                    />
                  </Field>
                </div>
                <Field label={t("leaveCalendar.fields.notes")}>
                  <input
                    type="text"
                    value={eNotes}
                    onChange={(e) => setENotes(e.target.value)}
                    maxLength={500}
                    style={inputStyle}
                  />
                </Field>
                {editError && <div style={errorBox}>{editError}</div>}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                    marginTop: 4,
                  }}
                >
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setEditOpen(false)}
                    disabled={patch.isPending}
                  >
                    {t("leaveCalendar.actions.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={!canSaveEdit || patch.isPending}
                    style={{ ...btnPrimary, opacity: canSaveEdit ? 1 : 0.5 }}
                  >
                    {patch.isPending ? t("leaveCalendar.actions.saving") : t("leaveCalendar.actions.saveChanges")}
                  </button>
                </div>
              </form>
            </div>
          </ModalShell>
        )}
      </td>
    </tr>
  );
}


// ---- Shared bits ---------------------------------------------------------


function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={labelStyle}>
        {label}
        {required && (
          <span
            aria-hidden="true"
            style={{ color: "var(--danger-text)", marginInlineStart: 4 }}
          >
            *
          </span>
        )}
      </span>
      {children}
    </label>
  );
}


function EmployeeSearchSelect({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: Employee[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    flipUp: boolean;
  } | null>(null);

  const selected = useMemo(() => {
    const id = Number.parseInt(value, 10);
    if (!Number.isFinite(id)) return null;
    return options.find((e) => e.id === id) ?? null;
  }, [value, options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 50);
    return options
      .filter((e) => {
        const code = e.employee_code.toLowerCase();
        const name = e.full_name.toLowerCase();
        return code.includes(q) || name.includes(q);
      })
      .slice(0, 50);
  }, [query, options]);

  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const POPOVER_H = 260;
      const spaceBelow = window.innerHeight - r.bottom;
      const flipUp = spaceBelow < POPOVER_H && r.top > spaceBelow;
      setPos({
        top: flipUp ? r.top - 4 : r.bottom + 4,
        left: r.left,
        width: r.width,
        flipUp,
      });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const triggerLabel = selected
    ? `${selected.employee_code} — ${selected.full_name}`
    : "";

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        ref={inputRef}
        type="text"
        value={open ? query : triggerLabel}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        placeholder={placeholder ?? t("leaveCalendar.searchPlaceholder")}
        autoComplete="off"
        style={inputStyle}
        aria-haspopup="listbox"
        aria-expanded={open}
      />
      {selected && !open && (
        <button
          type="button"
          onClick={() => {
            onChange("");
            setQuery("");
            setOpen(true);
          }}
          aria-label={t("leaveCalendar.clearSelectionAria")}
          style={{
            position: "absolute",
            insetInlineEnd: 6,
            top: "50%",
            transform: "translateY(-50%)",
            border: "none",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            padding: "2px 6px",
          }}
        >
          ×
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            style={{
              position: "fixed",
              top: pos.flipUp ? undefined : pos.top,
              bottom: pos.flipUp
                ? window.innerHeight - pos.top
                : undefined,
              left: pos.left,
              width: pos.width,
              zIndex: 1000,
              // ``--surface`` is not defined in the design CSS, which
              // made the popover transparent and let the form fields +
              // table behind it bleed through. Use the elevated bg var.
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
              maxHeight: 260,
              overflowY: "auto",
            }}
          >
            {filtered.length === 0 ? (
              <div
                style={{
                  padding: "8px 10px",
                  color: "var(--text-tertiary)",
                  fontSize: 12.5,
                }}
              >
                {t("leaveCalendar.noMatches")}
              </div>
            ) : (
              filtered.map((e) => {
                const isSel = selected?.id === e.id;
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      onChange(String(e.id));
                      setOpen(false);
                      setQuery("");
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "start",
                      padding: "6px 10px",
                      border: "none",
                      background: isSel ? "var(--bg-sunken)" : "transparent",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {e.employee_code}
                    </span>
                    <span style={{ color: "var(--text-secondary)" }}>
                      {" "}
                      — {e.full_name}
                    </span>
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </div>
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

const modalPanel: React.CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 480,
  maxWidth: "90vw",
  background: "var(--bg)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius)",
  padding: 20,
  zIndex: 60,
  boxShadow: "var(--shadow-lg)",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const modalHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
};

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
