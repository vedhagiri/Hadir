// Leave & Calendar page (Admin + HR — replaces the pilot's
// "leave-policy" placeholder). Three tabs:
//
//   1. Leave Types — CRUD for leave_types.
//   2. Holidays — list + bulk add + xlsx import for the year.
//   3. Approved Leaves — ledger view (the submission + approval
//      workflow lands in P14/P15; this is the storage view).
//
// Tenant timezone + weekend-day controls live at /settings/workspace.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import type { Employee } from "../features/employees/types";
import { DatePicker } from "../components/DatePicker";
import { Field, FormFooter, FormNotice, FormSection, SwitchField } from "../components/FormKit";
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
import { SkeletonTable } from "../components/Skeleton";
import { EmptyPanel } from "../components/ListPageUi";
import {
  Alert,
  FormFootBar,
  FormModal,
  SectionHead,
  TabButton,
  TabStrip,
  TableCard,
  WF_ICON,
  WfSvg,
  errorDetail,
} from "../requests/workflowUi";


type Tab = "types" | "holidays" | "leaves";


export function LeaveCalendarPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("types");
  return (
    <div className="wf-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("leaveCalendar.title")}</h1>
          <p className="page-sub">{t("leaveCalendar.subtitle")}</p>
        </div>
      </div>

      <TabStrip label={t("leaveCalendar.title")}>
        <TabButton active={tab === "types"} onClick={() => setTab("types")}>
          {t("leaveCalendar.tabs.types")}
        </TabButton>
        <TabButton active={tab === "holidays"} onClick={() => setTab("holidays")}>
          {t("leaveCalendar.tabs.holidays")}
        </TabButton>
        <TabButton active={tab === "leaves"} onClick={() => setTab("leaves")}>
          {t("leaveCalendar.tabs.leaves")}
        </TabButton>
      </TabStrip>

      {tab === "types" && <LeaveTypesTab />}
      {tab === "holidays" && <HolidaysTab />}
      {tab === "leaves" && <ApprovedLeavesTab />}
    </div>
  );
}


// ---- Shared: load-error panel --------------------------------------------


function LoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <EmptyPanel
        tone="danger"
        icon={<WfSvg>{WF_ICON.alert}</WfSvg>}
        title={title}
        body={errorDetail(error, t("common.errorGeneric"))}
        actions={
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="refresh" size={12} /> {t("common.retry", { defaultValue: "Retry" })}
          </button>
        }
      />
    </div>
  );
}


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

  if (list.isLoading) return <SkeletonTable rows={5} cols={5} />;
  if (list.error)
    return <LoadError title={t("leaveCalendar.loadFailedTypes")} error={list.error} onRetry={() => void list.refetch()} />;
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

  const newBtn = (
    <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
      {t("leaveCalendar.newType")}
    </button>
  );

  return (
    <div className="wf-stack">
      {rows.length > 0 && (
        <SectionHead
          title={t("leaveCalendar.tabs.types")}
          sub={t("leaveCalendar.typesSub", {
            defaultValue: "{{total}} types · {{paid}} paid · {{active}} active",
            total: rows.length,
            paid: rows.filter((r) => r.is_paid).length,
            active: rows.filter((r) => r.active).length,
          })}
          actions={newBtn}
        />
      )}
      {showForm && (
        <FormModal
          onClose={closeForm}
          onSubmit={(e) => void onCreate(e)}
          busy={create.isPending}
          size="md"
          icon={<Icon name="clipboard" size={18} />}
          title={t("leaveCalendar.form.newTypeTitle", { defaultValue: "New leave type" })}
          subtitle={t("leaveCalendar.form.typeSubtitle", {
            defaultValue: "A kind of leave employees can request, like Annual or Sick.",
          })}
          footer={
            <FormFooter
              onCancel={closeForm}
              submitLabel={t("leaveCalendar.form.createType", { defaultValue: "Create leave type" })}
              submittingLabel={t("leaveCalendar.actions.saving")}
              submitting={create.isPending}
              canSubmit={canSubmit}
            />
          }
        >
          {error && <FormNotice tone="danger">{error}</FormNotice>}
          <FormSection
            title={t("leaveCalendar.form.typeDetails", { defaultValue: "Leave type details" })}
            description={t("leaveCalendar.form.typeDetailsDesc", { defaultValue: "The code is permanent; the name can be changed later." })}
          >
            <Field label={t("leaveCalendar.fields.code")} htmlFor="lt-code" required help={t("leaveCalendar.form.codeHelp", { defaultValue: "Short and unique. Cannot be changed later." })}>
              <input id="lt-code" type="text" className="input mono" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={32} placeholder={t("leaveCalendar.form.codePlaceholder", { defaultValue: "e.g. ANNUAL" })} />
            </Field>
            <Field label={t("leaveCalendar.fields.name")} htmlFor="lt-name" required>
              <input id="lt-name" type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder={t("leaveCalendar.form.namePlaceholder", { defaultValue: "e.g. Annual leave" })} />
            </Field>
            <SwitchField
              id="lt-paid"
              checked={isPaid}
              onChange={setIsPaid}
              label={t("leaveCalendar.form.paidLabel", { defaultValue: "Paid leave" })}
              description={t("leaveCalendar.form.paidDesc", { defaultValue: "Days taken on this leave are paid." })}
            />
          </FormSection>
        </FormModal>
      )}
      {rows.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<WfSvg>{WF_ICON.file}</WfSvg>}
            title={t("leaveCalendar.emptyTypes.title", { defaultValue: "No leave types yet" })}
            body={t("leaveCalendar.emptyTypes.body", { defaultValue: "Add the kinds of leave your company offers, like Annual or Sick, so they can be used on requests." })}
            actions={newBtn}
          />
        </div>
      ) : (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th>{t("leaveCalendar.cols.code")}</th>
                <th>{t("leaveCalendar.cols.name")}</th>
                <th>{t("leaveCalendar.cols.paid")}</th>
                <th>{t("leaveCalendar.cols.active")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <LeaveTypeRow key={r.id} row={r} />
              ))}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  );
}


function ChipToggle({ on, onLabel, offLabel, onClick, disabled }: { on: boolean; onLabel: string; offLabel: string; onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={on} className={`wf-chip-btn${on ? " is-on" : ""}`}>
      <span aria-hidden className="pill-dot" />
      {on ? onLabel : offLabel}
    </button>
  );
}


function ConfirmDeleteModal({
  titleId,
  title,
  body,
  error,
  busy,
  onClose,
  onConfirm,
}: {
  titleId: string;
  title: React.ReactNode;
  body: string;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <FormModal
      onClose={onClose}
      onSubmit={() => onConfirm()}
      busy={busy}
      size="sm"
      icon={<Icon name="trash" size={18} />}
      title={title}
      subtitle={t("leaveCalendar.form.deleteSubtitle", { defaultValue: "Check the details below before deleting." })}
      footer={
        <FormFooter
          onCancel={onClose}
          danger
          showRequiredNote={false}
          submitLabel={t("leaveCalendar.actions.delete")}
          submittingLabel={t("leaveCalendar.actions.deleting")}
          submitting={busy}
        />
      }
    >
      {error && <FormNotice tone="danger">{error}</FormNotice>}
      <p className="wf-fk-lead" id={titleId}>{body}</p>
    </FormModal>
  );
}


function RowActions({
  onEdit,
  onDelete,
  editAria,
  deleteAria,
  editDisabled,
  deleteDisabled,
}: {
  onEdit: () => void;
  onDelete: () => void;
  editAria: string;
  deleteAria: string;
  editDisabled: boolean;
  deleteDisabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="wf-row wf-row-end" style={{ flexWrap: "nowrap" }}>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onEdit} disabled={editDisabled} aria-label={editAria}>
        <Icon name="edit" size={12} /> {t("leaveCalendar.actions.edit")}
      </button>
      <button type="button" className="btn btn-sm btn-ghost wf-danger-text" onClick={onDelete} disabled={deleteDisabled} aria-label={deleteAria}>
        <Icon name="trash" size={12} /> {t("leaveCalendar.actions.delete")}
      </button>
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
  // True when ``editError`` is the name-required message (shown inline).
  const [editNameError, setEditNameError] = useState(false);
  const openEdit = () => {
    setEditName(row.name);
    setEditPaid(row.is_paid);
    setEditError(null);
    setEditNameError(false);
    setEditOpen(true);
  };
  const canSaveEdit = editName.trim() !== "";
  const onSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditError(null);
    setEditNameError(false);
    if (!canSaveEdit) {
      setEditError(t("leaveCalendar.errors.nameRequired"));
      setEditNameError(true);
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
    <tr>
      <td className="mono text-sm">{row.code}</td>
      <td>{row.name}</td>
      <td>
        <ChipToggle
          on={row.is_paid}
          onLabel={t("leaveCalendar.fields.paid")}
          offLabel={t("leaveCalendar.fields.unpaid")}
          onClick={() => void onToggle("is_paid")}
          disabled={patch.isPending}
        />
      </td>
      <td>
        <ChipToggle
          on={row.active}
          onLabel={t("leaveCalendar.fields.activeLower")}
          offLabel={t("leaveCalendar.fields.inactiveLower")}
          onClick={() => void onToggle("active")}
          disabled={patch.isPending}
        />
      </td>
      <td className="wf-nowrap" style={{ textAlign: "end" }}>
        <RowActions
          onEdit={openEdit}
          onDelete={askDelete}
          editAria={t("leaveCalendar.actions.editTypeAria", { name: row.name })}
          deleteAria={t("leaveCalendar.actions.deleteTypeAria", { name: row.name })}
          editDisabled={patch.isPending}
          deleteDisabled={del.isPending}
        />
        {confirmOpen && (
          <ConfirmDeleteModal
            titleId="lt-delete-title"
            title={
              <>
                {t("leaveCalendar.deleteTypeTitle")} <span className="mono">{row.code}</span>?
              </>
            }
            body={t("leaveCalendar.deleteTypeBody", { name: row.name })}
            error={delError}
            busy={del.isPending}
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => void onConfirmDelete()}
          />
        )}
        {editOpen && (
          <FormModal
            onClose={() => setEditOpen(false)}
            onSubmit={(e) => void onSaveEdit(e)}
            busy={patch.isPending}
            size="md"
            icon={<Icon name="clipboard" size={18} />}
            title={t("leaveCalendar.editType")}
            subtitle={t("leaveCalendar.form.editTypeSubtitle", { defaultValue: "Rename this leave type or change whether it is paid." })}
            footer={
              <FormFooter
                onCancel={() => setEditOpen(false)}
                submitLabel={t("leaveCalendar.actions.saveChanges")}
                submittingLabel={t("leaveCalendar.actions.saving")}
                submitting={patch.isPending}
                canSubmit={canSaveEdit}
              />
            }
          >
            {editError && !editNameError && <FormNotice tone="danger">{editError}</FormNotice>}
            <FormSection
              title={t("leaveCalendar.form.typeDetails", { defaultValue: "Leave type details" })}
              description={t("leaveCalendar.form.typeDetailsDesc", { defaultValue: "The code is permanent; the name can be changed later." })}
            >
              <Field label={t("leaveCalendar.fields.code")} htmlFor="lt-edit-code" help={t("leaveCalendar.codeLocked")}>
                <input id="lt-edit-code" type="text" className="input mono" value={row.code} disabled title={t("leaveCalendar.codeLocked")} />
              </Field>
              <Field label={t("leaveCalendar.fields.name")} htmlFor="lt-edit-name" required error={editNameError ? editError : null}>
                <input
                  id="lt-edit-name"
                  type="text"
                  className="input"
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    if (editNameError) {
                      setEditNameError(false);
                      setEditError(null);
                    }
                  }}
                  required
                  maxLength={80}
                />
              </Field>
              <SwitchField
                id="lt-edit-paid"
                checked={editPaid}
                onChange={setEditPaid}
                label={t("leaveCalendar.form.paidLabel", { defaultValue: "Paid leave" })}
                description={t("leaveCalendar.form.paidDesc", { defaultValue: "Days taken on this leave are paid." })}
              />
            </FormSection>
          </FormModal>
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

  if (list.isLoading) return <SkeletonTable rows={5} cols={4} />;
  if (list.error)
    return <LoadError title={t("leaveCalendar.loadFailedHolidays")} error={list.error} onRetry={() => void list.refetch()} />;
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

  const openAdd = () => {
    setError(null);
    setShowAdd(true);
  };
  const addBtn = (
    <button type="button" className="btn btn-primary" onClick={openAdd}>
      {t("leaveCalendar.addHoliday")}
    </button>
  );

  return (
    <div className="wf-stack">
      <div className="wf-row wf-row-between">
        <label className="wf-year-field">
          <span>{t("leaveCalendar.year")}</span>
          <input
            type="number"
            className="input"
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
          />
          <datalist id="holiday-year-options">
            {yearOptions.map((y) => (
              <option key={y} value={y} />
            ))}
          </datalist>
        </label>
        <div className="wf-row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(null);
              setImportSummary(null);
              setShowImport(true);
            }}
          >
            <Icon name="upload" size={13} /> {t("leaveCalendar.import.button")}
          </button>
          {addBtn}
        </div>
      </div>
      {/* BUG-025 — explicit import summary banner, replaces the old
          silent same-date no-op. */}
      {importSummary && <Alert tone="success" role="status">{importSummary}</Alert>}

      {rows.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<WfSvg>{WF_ICON.calendar}</WfSvg>}
            title={t("leaveCalendar.emptyHolidays.title", { defaultValue: "No holidays for {{year}}", year })}
            body={t("leaveCalendar.emptyHolidays.body", { defaultValue: "Add public holidays one by one or import them from an Excel file. Attendance on these days counts as overtime." })}
            actions={addBtn}
          />
        </div>
      ) : (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th>{t("leaveCalendar.cols.date")}</th>
                <th>{t("leaveCalendar.cols.day")}</th>
                <th>{t("leaveCalendar.cols.name")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <HolidayRow key={r.id} row={r} />
              ))}
            </tbody>
          </table>
        </TableCard>
      )}

      {showAdd && (
        <FormModal
          onClose={closeAdd}
          onSubmit={(e) => void onAdd(e)}
          busy={create.isPending}
          size="md"
          icon={<Icon name="calendar" size={18} />}
          title={t("leaveCalendar.newHoliday").replace(/^\+\s*/, "")}
          subtitle={t("leaveCalendar.form.holidaySubtitle", {
            defaultValue: "A public holiday. Attendance on this day counts as overtime.",
          })}
          footer={
            <FormFooter
              onCancel={closeAdd}
              submitLabel={t("leaveCalendar.addHoliday")}
              submittingLabel={t("leaveCalendar.actions.saving")}
              submitting={create.isPending}
              canSubmit={canAddHoliday}
            />
          }
        >
          {error && <FormNotice tone="danger">{error}</FormNotice>}
          <FormSection
            title={t("leaveCalendar.form.holidayDetails", { defaultValue: "Holiday details" })}
            description={t("leaveCalendar.form.holidayDetailsDesc", { defaultValue: "The date and the name shown on the calendar." })}
          >
            <Field label={t("leaveCalendar.fields.date")} required>
              <DatePicker value={date} onChange={setDate} ariaLabel={t("leaveCalendar.fields.holidayDateAria")} triggerStyle={{ width: "100%" }} />
            </Field>
            <Field label={t("leaveCalendar.fields.name")} htmlFor="hol-name" required>
              <input id="hol-name" type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder={t("leaveCalendar.form.holidayPlaceholder", { defaultValue: "e.g. National Day" })} />
            </Field>
          </FormSection>
        </FormModal>
      )}

      {showImport && (
        <FormModal
          onClose={() => setShowImport(false)}
          busy={importer.isPending}
          size="md"
          icon={<Icon name="upload" size={18} />}
          title={t("leaveCalendar.import.title")}
          subtitle={t("leaveCalendar.form.importSubtitle", {
            defaultValue: "Add a year's holidays at once from an Excel file.",
          })}
          footer={
            <FormFootBar>
              <button type="button" className="btn" onClick={() => setShowImport(false)} disabled={importer.isPending}>
                {t("leaveCalendar.actions.done")}
              </button>
            </FormFootBar>
          }
        >
          {error && <FormNotice tone="danger">{error}</FormNotice>}
          {importSummary && <FormNotice tone="success">{importSummary}</FormNotice>}
          <p className="wf-fk-lead">
            {t("leaveCalendar.import.instructionsLead")}{" "}
            <strong>.xlsx</strong>{" "}
            {t("leaveCalendar.import.instructionsCols")}{" "}
            <span className="mono">date</span> (YYYY-MM-DD),{" "}
            <span className="mono">name</span>,{" "}
            {t("leaveCalendar.import.instructionsOptional")}{" "}
            <span className="mono">description</span>.{" "}
            {t("leaveCalendar.import.instructionsSkip")}
          </p>
          <Field label={t("leaveCalendar.form.importFile", { defaultValue: "Holiday workbook" })}>
            <label className={`wf-fk-dropzone${importer.isPending ? " is-busy" : ""}`}>
              <span className="wf-fk-dropzone-icon" aria-hidden>
                <Icon name="upload" size={16} />
              </span>
              <span>
                {importer.isPending
                  ? t("leaveCalendar.import.importing")
                  : t("leaveCalendar.import.choosePrompt")}
              </span>
              <span className="wf-fk-dropzone-hint">.xlsx</span>
              <input
                type="file"
                accept=".xlsx"
                className="wf-file-input"
                disabled={importer.isPending}
                onChange={onImport}
              />
            </label>
          </Field>
          <div>
            <a href="/api/holidays/import-template" className="btn btn-sm">
              <Icon name="download" size={13} /> {t("leaveCalendar.import.template")}
            </a>
          </div>
        </FormModal>
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
    <tr>
      <td className="mono">{row.date}</td>
      <td className="wf-muted">{weekday}</td>
      <td>{row.name}</td>
      <td className="wf-nowrap" style={{ textAlign: "end" }}>
        <RowActions
          onEdit={openEdit}
          onDelete={() => {
            setDelError(null);
            setConfirmOpen(true);
          }}
          editAria={t("leaveCalendar.actions.editHolidayAria", { name: row.name })}
          deleteAria={t("leaveCalendar.actions.deleteHolidayAria", { name: row.name })}
          editDisabled={patch.isPending}
          deleteDisabled={del.isPending}
        />
        {confirmOpen && (
          <ConfirmDeleteModal
            titleId="holiday-delete-title"
            title={t("leaveCalendar.deleteHolidayTitle")}
            body={t("leaveCalendar.deleteHolidayBody", { name: row.name, date: row.date })}
            error={delError}
            busy={del.isPending}
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => void onConfirmDelete()}
          />
        )}
        {editOpen && (
          <FormModal
            onClose={() => setEditOpen(false)}
            onSubmit={(e) => void onSaveEdit(e)}
            busy={patch.isPending}
            size="md"
            icon={<Icon name="calendar" size={18} />}
            title={t("leaveCalendar.editHoliday")}
            subtitle={t("leaveCalendar.form.editHolidaySubtitle", { defaultValue: "Move this holiday to another date or rename it." })}
            footer={
              <FormFooter
                onCancel={() => setEditOpen(false)}
                submitLabel={t("leaveCalendar.actions.saveChanges")}
                submittingLabel={t("leaveCalendar.actions.saving")}
                submitting={patch.isPending}
                canSubmit={canSaveEdit}
              />
            }
          >
            {editError && <FormNotice tone="danger">{editError}</FormNotice>}
            <FormSection
              title={t("leaveCalendar.form.holidayDetails", { defaultValue: "Holiday details" })}
              description={t("leaveCalendar.form.holidayDetailsDesc", { defaultValue: "The date and the name shown on the calendar." })}
            >
              <Field label={t("leaveCalendar.fields.date")} required>
                <DatePicker value={editDate} onChange={setEditDate} ariaLabel={t("leaveCalendar.fields.holidayDateAria")} triggerStyle={{ width: "100%" }} />
              </Field>
              <Field label={t("leaveCalendar.fields.name")} htmlFor={`hol-edit-name-${row.id}`} required>
                <input id={`hol-edit-name-${row.id}`} type="text" className="input" value={editName} onChange={(e) => setEditName(e.target.value)} required maxLength={120} />
              </Field>
            </FormSection>
          </FormModal>
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
  const [fieldErrors, setFieldErrors] = useState<LeaveFieldErrors>({});

  if (leaves.isLoading || types.isLoading || employees.isLoading)
    return <SkeletonTable rows={5} cols={6} />;
  if (leaves.error)
    return <LoadError title={t("leaveCalendar.loadFailedLeaves")} error={leaves.error} onRetry={() => void leaves.refetch()} />;
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
    setFieldErrors({});
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (!employeeId) {
      setFieldErrors({ employee: t("leaveCalendar.errors.selectEmployee") });
      return;
    }
    if (!leaveTypeId) {
      setFieldErrors({ type: t("leaveCalendar.errors.selectLeaveType") });
      return;
    }
    if (!startDate) {
      setFieldErrors({ start: t("leaveCalendar.errors.chooseStart") });
      return;
    }
    if (!endDate) {
      setFieldErrors({ end: t("leaveCalendar.errors.chooseEnd") });
      return;
    }
    if (endDate < startDate) {
      setFieldErrors({ end: t("leaveCalendar.errors.endBeforeStart") });
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

  const newBtn = (
    <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
      {t("leaveCalendar.newLeave")}
    </button>
  );

  return (
    <div className="wf-stack">
      {rows.length > 0 && (
        <SectionHead
          title={t("leaveCalendar.tabs.leaves")}
          sub={t("leaveCalendar.leavesSub", {
            defaultValue: "{{n}} approved leave records",
            n: rows.length,
          })}
          actions={newBtn}
        />
      )}
      {showForm && (
        <FormModal
          onClose={closeForm}
          onSubmit={(e) => void onCreate(e)}
          busy={create.isPending}
          size="lg"
          icon={<Icon name="calendar" size={18} />}
          title={t("leaveCalendar.newLeave").replace(/^\+\s*/, "")}
          subtitle={t("leaveCalendar.form.leaveSubtitle", {
            defaultValue: "Record leave that was approved outside the request flow.",
          })}
          footer={
            <FormFooter
              onCancel={closeForm}
              submitLabel={t("leaveCalendar.form.createLeave", { defaultValue: "Record leave" })}
              submittingLabel={t("leaveCalendar.actions.saving")}
              submitting={create.isPending}
              canSubmit={canSubmit}
            />
          }
        >
          <LeaveForm
            idPrefix="al-new"
            employeeOptions={employeeOptions}
            typeOptions={typeOptions}
            employeeId={employeeId}
            setEmployeeId={setEmployeeId}
            leaveTypeId={leaveTypeId}
            setLeaveTypeId={setLeaveTypeId}
            startDate={startDate}
            setStartDate={setStartDate}
            endDate={endDate}
            setEndDate={setEndDate}
            notes={notes}
            setNotes={setNotes}
            serverError={error}
            fieldErrors={fieldErrors}
          />
        </FormModal>
      )}
      {rows.length === 0 ? (
        <div className="card">
          <EmptyPanel
            tone="accent"
            icon={<WfSvg>{WF_ICON.calendar}</WfSvg>}
            title={t("leaveCalendar.emptyLeaves.title", { defaultValue: "No approved leave on record" })}
            body={t("leaveCalendar.emptyLeaves.body", { defaultValue: "Leave approved through requests appears here automatically. You can also record leave for an employee directly." })}
            actions={newBtn}
          />
        </div>
      ) : (
        <TableCard>
          <table className="table">
            <thead>
              <tr>
                <th>{t("leaveCalendar.cols.employee")}</th>
                <th>{t("leaveCalendar.cols.type")}</th>
                <th>{t("leaveCalendar.cols.start")}</th>
                <th>{t("leaveCalendar.cols.end")}</th>
                <th>{t("leaveCalendar.cols.notes")}</th>
                <th />
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
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  );
}


type LeaveFieldErrors = {
  employee?: string | undefined;
  type?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
};

/** Shared body of the New / Edit approved-leave modals. */
function LeaveForm({
  idPrefix,
  employeeOptions,
  typeOptions,
  employeeId,
  setEmployeeId,
  leaveTypeId,
  setLeaveTypeId,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  notes,
  setNotes,
  serverError,
  fieldErrors,
}: {
  idPrefix: string;
  employeeOptions: Employee[];
  typeOptions: LeaveType[];
  employeeId: string;
  setEmployeeId: (v: string) => void;
  leaveTypeId: string;
  setLeaveTypeId: (v: string) => void;
  startDate: string;
  setStartDate: (v: string) => void;
  endDate: string;
  setEndDate: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  serverError: string | null;
  fieldErrors: LeaveFieldErrors;
}) {
  const { t } = useTranslation();
  // Live order check so the reason the submit button is disabled is visible.
  const endError =
    fieldErrors.end ??
    (startDate && endDate && endDate < startDate ? t("leaveCalendar.errors.endBeforeStart") : undefined);
  return (
    <>
      {serverError && <FormNotice tone="danger">{serverError}</FormNotice>}
      <FormSection
        step={1}
        title={t("leaveCalendar.form.whoTitle", { defaultValue: "Employee and type" })}
        description={t("leaveCalendar.form.whoDesc", { defaultValue: "Who is on leave and which kind of leave it is." })}
      >
        <Field label={t("leaveCalendar.fields.employee")} htmlFor={`${idPrefix}-employee`} required error={fieldErrors.employee}>
          <EmployeeSearchSelect
            id={`${idPrefix}-employee`}
            options={employeeOptions}
            value={employeeId}
            onChange={setEmployeeId}
            placeholder={t("leaveCalendar.fields.employeeSearchPlaceholder")}
          />
        </Field>
        <Field label={t("leaveCalendar.fields.leaveType")} htmlFor={`${idPrefix}-type`} required error={fieldErrors.type}>
          <select id={`${idPrefix}-type`} className="select" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} required>
            <option value="">{t("leaveCalendar.fields.selectPlaceholder")}</option>
            {typeOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name}
              </option>
            ))}
          </select>
        </Field>
      </FormSection>
      <FormSection
        step={2}
        title={t("leaveCalendar.form.datesTitle", { defaultValue: "Dates" })}
        description={t("leaveCalendar.form.datesDesc", { defaultValue: "First and last day of the leave, inclusive." })}
      >
        <Field label={t("leaveCalendar.fields.start")} required error={fieldErrors.start}>
          <DatePicker value={startDate} onChange={setStartDate} ariaLabel={t("leaveCalendar.fields.startDateAria")} triggerStyle={{ width: "100%" }} />
        </Field>
        <Field label={t("leaveCalendar.fields.end")} required error={endError}>
          <DatePicker value={endDate} onChange={setEndDate} min={startDate} ariaLabel={t("leaveCalendar.fields.endDateAria")} triggerStyle={{ width: "100%" }} />
        </Field>
        <Field label={t("leaveCalendar.fields.notes")} htmlFor={`${idPrefix}-notes`} span={2} help={t("common.optional")}>
          <input
            id={`${idPrefix}-notes`}
            type="text"
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            placeholder={t("leaveCalendar.form.notesPlaceholder", { defaultValue: "e.g. Approved by email on 3 March" })}
          />
        </Field>
      </FormSection>
    </>
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
  const [editFieldErrors, setEditFieldErrors] = useState<LeaveFieldErrors>({});
  const openEdit = () => {
    setEditFieldErrors({});
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
    setEditFieldErrors({});
    if (!eEmployee) {
      setEditFieldErrors({ employee: t("leaveCalendar.errors.selectEmployee") });
      return;
    }
    if (!eType) {
      setEditFieldErrors({ type: t("leaveCalendar.errors.selectLeaveType") });
      return;
    }
    if (!eStart) {
      setEditFieldErrors({ start: t("leaveCalendar.errors.chooseStart") });
      return;
    }
    if (!eEnd) {
      setEditFieldErrors({ end: t("leaveCalendar.errors.chooseEnd") });
      return;
    }
    if (eEnd < eStart) {
      setEditFieldErrors({ end: t("leaveCalendar.errors.endBeforeStart") });
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
    <tr>
      <td>{employeeLabel}</td>
      <td>{row.leave_type_name}</td>
      <td className="mono">{row.start_date}</td>
      <td className="mono">{row.end_date}</td>
      <td className="wf-muted text-sm">{row.notes ?? "—"}</td>
      <td className="wf-nowrap" style={{ textAlign: "end" }}>
        <RowActions
          onEdit={openEdit}
          onDelete={() => {
            setDelError(null);
            setConfirmOpen(true);
          }}
          editAria={t("leaveCalendar.actions.editLeaveAria", { name: employeeLabel })}
          deleteAria={t("leaveCalendar.actions.deleteLeaveAria", { name: employeeLabel })}
          editDisabled={patch.isPending}
          deleteDisabled={del.isPending}
        />
        {confirmOpen && (
          <ConfirmDeleteModal
            titleId="leave-delete-title"
            title={t("leaveCalendar.deleteLeaveTitle")}
            body={t("leaveCalendar.deleteLeaveBody", {
              type: row.leave_type_name,
              name: employeeLabel,
              start: row.start_date,
              end: row.end_date,
            })}
            error={delError}
            busy={del.isPending}
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => void onConfirmDelete()}
          />
        )}
        {editOpen && (
          <FormModal
            onClose={() => setEditOpen(false)}
            onSubmit={(e) => void onSaveEdit(e)}
            busy={patch.isPending}
            size="lg"
            icon={<Icon name="calendar" size={18} />}
            title={t("leaveCalendar.editLeave")}
            subtitle={t("leaveCalendar.form.editLeaveSubtitle", { defaultValue: "Correct the employee, type, dates or notes of this leave." })}
            footer={
              <FormFooter
                onCancel={() => setEditOpen(false)}
                submitLabel={t("leaveCalendar.actions.saveChanges")}
                submittingLabel={t("leaveCalendar.actions.saving")}
                submitting={patch.isPending}
                canSubmit={canSaveEdit}
              />
            }
          >
            <LeaveForm
              idPrefix={`al-edit-${row.id}`}
              employeeOptions={employeeOptions}
              typeOptions={typeOptions}
              employeeId={eEmployee}
              setEmployeeId={setEEmployee}
              leaveTypeId={eType}
              setLeaveTypeId={setEType}
              startDate={eStart}
              setStartDate={setEStart}
              endDate={eEnd}
              setEndDate={setEEnd}
              notes={eNotes}
              setNotes={setENotes}
              serverError={editError}
              fieldErrors={editFieldErrors}
            />
          </FormModal>
        )}
      </td>
    </tr>
  );
}


// ---- Shared bits ---------------------------------------------------------


function EmployeeSearchSelect({
  id,
  options,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
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
    <div ref={wrapRef} className="wf-combo">
      <input
        ref={inputRef}
        id={id}
        type="text"
        className="input"
        style={{ width: "100%" }}
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
        aria-haspopup="listbox"
        aria-expanded={open}
      />
      {selected && !open && (
        <button
          type="button"
          className="wf-combo-clear"
          onClick={() => {
            onChange("");
            setQuery("");
            setOpen(true);
          }}
          aria-label={t("leaveCalendar.clearSelectionAria")}
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
            className="wf-combo-pop"
            style={{
              top: pos.flipUp ? undefined : pos.top,
              bottom: pos.flipUp
                ? window.innerHeight - pos.top
                : undefined,
              left: pos.left,
              width: pos.width,
            }}
          >
            {filtered.length === 0 ? (
              <div className="wf-combo-empty">{t("leaveCalendar.noMatches")}</div>
            ) : (
              filtered.map((e) => {
                const isSel = selected?.id === e.id;
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className="wf-combo-opt"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      onChange(String(e.id));
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <span className="mono" style={{ fontWeight: 600 }}>
                      {e.employee_code}
                    </span>
                    <span className="wf-muted">
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
