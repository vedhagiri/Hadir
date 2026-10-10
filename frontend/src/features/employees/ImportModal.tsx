// Excel / CSV import modal — Upload → Review & import (+ result):
//   1. Pick a file.
//   2. Server parses (no DB writes); preview table renders the rows
//      with defaults applied (e.g. ``joining_date=today`` when blank).
//   3. Operator clicks Confirm → second request to the real import
//      endpoint, which actually upserts the rows.
//
// The two-call shape is intentional: the actual import endpoint
// stays stateless and idempotent, no temp-file storage needed
// between preview and confirm.

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { FormFooter, FormHeader, FormNotice, FormSection } from "../../components/FormKit";
import { FormStepper } from "./peopleUi";
import {
  useImportEmployees,
  usePreviewImport,
  type ImportPreviewResult,
  type ImportPreviewRow,
} from "./hooks";
import type { ImportResult } from "./types";

interface Props {
  onClose: () => void;
}

type Step = "select" | "preview" | "result";

export function ImportModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("select");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  // Editable copy of the preview rows — the operator fixes cells inline,
  // presses Re-check to re-validate, then imports the corrected rows.
  const [editRows, setEditRows] = useState<ImportPreviewRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const previewMutation = usePreviewImport();
  const importMutation = useImportEmployees();

  const onDrop = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }, []);

  const runPreview = async () => {
    if (!file) return;
    try {
      const r = await previewMutation.mutateAsync(file);
      setPreview(r);
      setEditRows(r.rows);
      setDirty(false);
      setStep("preview");
    } catch {
      // previewMutation.error renders below
    }
  };

  // Re-validate the operator's edited rows (serialised to CSV) without
  // leaving the preview — surfaces remaining errors (e.g. manager still
  // not found) before import.
  const recheck = async () => {
    try {
      const r = await previewMutation.mutateAsync(rowsToCsvFile(editRows));
      setPreview(r);
      setEditRows(r.rows);
      setDirty(false);
    } catch {
      // previewMutation.error renders below
    }
  };

  const runImport = async () => {
    // Import the edited rows (CSV), so inline fixes are applied. Falls
    // back to the original file only if nothing was loaded into the grid.
    const payload = editRows.length > 0 ? rowsToCsvFile(editRows) : file;
    if (!payload) return;
    try {
      const r = await importMutation.mutateAsync(payload);
      setResult(r);
      setStep("result");
    } catch {
      // importMutation.error renders below
    }
  };

  const updateCell = (
    rowNum: number,
    field: EditableField,
    value: string,
  ) => {
    setEditRows((prev) =>
      prev.map((r) => (r.row === rowNum ? { ...r, [field]: value } : r)),
    );
    setDirty(true);
  };

  const back = () => {
    setStep("select");
    previewMutation.reset();
  };

  const busy = previewMutation.isPending || importMutation.isPending;
  const readyCount = editRows.filter((r) => !r.error).length;
  const errorCount = editRows.filter((r) => r.error).length;
  const defaultedCount = editRows.filter((r) => r.defaulted_joining_date).length;
  const titleId = "import-employees-title";

  const header = (
    <>
      <FormHeader
        titleId={titleId}
        icon={<Icon name={step === "result" ? "check" : "upload"} size={18} />}
        title={
          step === "preview"
            ? t("importEmployees.titlePreview")
            : step === "result"
              ? t("importEmployees.titleComplete")
              : t("importEmployees.title")
        }
        subtitle={
          step === "select"
            ? t("importEmployees.form.subtitle", {
                defaultValue: "Upload an Excel or CSV file, review every row, then confirm the import.",
              })
            : step === "preview" && preview
              ? t("importEmployees.subPreview", {
                  rows: preview.rows.length,
                  errors: preview.errors.length,
                })
              : t("importEmployees.subResult")
        }
        // Closing mid-request would orphan the result — hide the X while busy.
        {...(busy ? {} : { onClose })}
      />
      <FormStepper
        label={t("importEmployees.form.stepsLabel", { defaultValue: "Import steps" })}
        steps={[
          t("importEmployees.form.stepUpload", { defaultValue: "Upload file" }),
          t("importEmployees.form.stepReview", { defaultValue: "Review & import" }),
        ]}
        current={step === "select" ? 1 : step === "preview" ? 2 : 3}
      />
    </>
  );

  return (
    <ModalShell onClose={onClose}>
      <div className="pp-modal-host">
        {step === "select" && (
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="modal fk-modal pp-fk-wide"
            onSubmit={(e) => {
              e.preventDefault();
              if (file && !previewMutation.isPending) void runPreview();
            }}
          >
            {header}
            <div className="fk-body">
              {previewMutation.error && (
                <FormNotice tone="danger" title={importErrorMessage(previewMutation.error, t)} />
              )}

              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`pp-import-drop${dragOver ? " is-over" : ""}${file ? " has-file" : ""}`}
              >
                <input
                  type="file"
                  className="pp-visually-hidden"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <span className="pp-import-drop-icon" aria-hidden>
                  <Icon name={file ? "excel" : "upload"} size={22} />
                </span>
                {file ? (
                  <>
                    <span className="pp-import-drop-title mono">{file.name}</span>
                    <span className="pp-import-drop-sub">
                      {Math.round(file.size / 1024)} KB ·{" "}
                      {t("importEmployees.form.replaceFile", { defaultValue: "click or drop to replace" })}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="pp-import-drop-title">
                      {t("importEmployees.dropPrompt")}{" "}
                      <span className="pp-link">{t("importEmployees.chooseFile")}</span>
                    </span>
                    <span className="pp-import-drop-sub">
                      {t("importEmployees.form.fileTypes", { defaultValue: ".xlsx or .csv · first sheet is read" })}
                    </span>
                  </>
                )}
              </label>

              <div className="pp-import-cols">
                <div className="pp-import-cols-row">
                  <span className="pp-import-cols-label">
                    {t("importEmployees.form.requiredCols", { defaultValue: "Required columns" })}
                  </span>
                  <span className="pp-import-cols-list">
                    {["employee_code", "full_name", "department"].map((c) => (
                      <code key={c} className="pp-col-chip is-required">{c}</code>
                    ))}
                    <span className="fk-help">
                      ({t("importEmployees.subSelect.or")} <code className="pp-col-chip">department_code</code>)
                    </span>
                  </span>
                </div>
                <div className="pp-import-cols-row">
                  <span className="pp-import-cols-label">
                    {t("importEmployees.form.optionalCols", { defaultValue: "Optional columns" })}
                  </span>
                  <span className="pp-import-cols-list">
                    {[
                      "email",
                      "designation",
                      "phone",
                      "division",
                      "section",
                      "joining_date",
                      "relieving_date",
                    ].map((c) => (
                      <code key={c} className="pp-col-chip">{c}</code>
                    ))}
                  </span>
                </div>
              </div>

              <div className="pp-template-card">
                <span className="pp-login-empty-icon" aria-hidden>
                  <Icon name="excel" size={16} />
                </span>
                <span className="pp-grow fk-help">{t("importEmployees.formatHint")}</span>
                <a className="btn btn-sm" href="/api/employees/import-template">
                  <Icon name="download" size={11} />
                  {t("importEmployees.downloadTemplate")}
                </a>
              </div>
            </div>
            <FormFooter
              onCancel={onClose}
              submitLabel={
                <>
                  {t("importEmployees.previewRows")}
                  <Icon name="chevronRight" size={12} />
                </>
              }
              submitting={previewMutation.isPending}
              submittingLabel={t("importEmployees.parsing")}
              canSubmit={!!file}
              showRequiredNote={false}
              note={t("importEmployees.form.noWritesYet", {
                defaultValue: "Nothing is saved until you confirm on the next step.",
              })}
            />
          </form>
        )}

        {step === "preview" && preview && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="modal fk-modal pp-fk-xwide"
          >
            {header}
            <div className="fk-body pp-import-body">
              <div className="pp-import-summary">
                <span className="pill pill-success">
                  <Icon name="check" size={11} />
                  {t("importEmployees.pillReady", { count: readyCount })}
                </span>
                {errorCount > 0 && (
                  <span className="pill pill-warning">
                    <Icon name="info" size={11} />
                    {t("importEmployees.pillErrors", { count: errorCount })}
                  </span>
                )}
                {defaultedCount > 0 && (
                  <span className="pill pill-neutral">
                    {t("importEmployees.pillDefaultedJoining", { count: defaultedCount })}
                  </span>
                )}
                {dirty && (
                  <span className="pill pill-info">{t("importEmployees.editedRecheckHint")}</span>
                )}
              </div>
              <p className="fk-help pp-m0">{t("importEmployees.editHint")}</p>

              {importMutation.error && (
                <FormNotice tone="danger" title={importErrorMessage(importMutation.error, t)} />
              )}

              <div className="card pp-import-grid">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="pp-col-row">{t("importEmployees.col.row")}</th>
                      <th className="pp-col-status" aria-label="status" />
                      <th>{t("importEmployees.col.code")}</th>
                      <th>{t("importEmployees.col.name")}</th>
                      <th>{t("importEmployees.col.email")}</th>
                      <th>{t("importEmployees.col.phone")}</th>
                      <th>{t("importEmployees.col.designation")}</th>
                      <th>{t("importEmployees.col.department")}</th>
                      <th>{t("importEmployees.col.division")}</th>
                      <th>{t("importEmployees.col.section")}</th>
                      <th>{t("importEmployees.col.reportsTo")}</th>
                      <th>{t("importEmployees.col.joining")}</th>
                      <th>{t("importEmployees.col.relieving")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editRows.map((r) => (
                      <tr key={r.row} className={r.error ? "pp-row-error" : undefined}>
                        <td className="mono text-xs">{r.row}</td>
                        <td className="pp-col-status">
                          {r.error ? (
                            <span title={r.error} className="pp-row-flag is-error" aria-label={r.error}>
                              <Icon name="info" size={13} />
                            </span>
                          ) : (
                            <span className="pp-row-flag is-ok" aria-hidden>
                              <Icon name="check" size={13} />
                            </span>
                          )}
                        </td>
                        <td>{importCell(r, "employee_code", updateCell)}</td>
                        <td>{importCell(r, "full_name", updateCell)}</td>
                        <td>{importCell(r, "email", updateCell)}</td>
                        <td>{importCell(r, "phone", updateCell)}</td>
                        <td>{importCell(r, "designation", updateCell)}</td>
                        <td>{importCell(r, "department", updateCell)}</td>
                        <td>{importCell(r, "division", updateCell)}</td>
                        <td>{importCell(r, "section", updateCell)}</td>
                        <td>{importCell(r, "reports_to_email", updateCell)}</td>
                        <td>{importCell(r, "joining_date", updateCell)}</td>
                        <td>{importCell(r, "relieving_date", updateCell)}</td>
                      </tr>
                    ))}
                    {editRows.length === 0 && (
                      <tr>
                        <td colSpan={13} className="text-sm text-dim pp-cell-pad">
                          {t("importEmployees.noImportable")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="drawer-foot fk-foot">
              <div className="fk-foot-note">
                <button type="button" className="btn btn-ghost" onClick={back} disabled={importMutation.isPending}>
                  <Icon name="chevronLeft" size={11} />
                  {t("importEmployees.back")}
                </button>
              </div>
              <div className="fk-foot-actions">
                <button type="button" className="btn" onClick={onClose} disabled={importMutation.isPending}>
                  {t("importEmployees.cancel")}
                </button>
                <button type="button" className="btn" onClick={recheck} disabled={busy}>
                  {previewMutation.isPending ? (
                    <span className="fk-spinner" aria-hidden />
                  ) : (
                    <Icon name="refresh" size={12} />
                  )}
                  {previewMutation.isPending
                    ? t("importEmployees.rechecking")
                    : t("importEmployees.recheck")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={runImport}
                  disabled={busy || readyCount === 0}
                >
                  {importMutation.isPending ? (
                    <span className="fk-spinner" aria-hidden />
                  ) : (
                    <Icon name="upload" size={12} />
                  )}
                  {importMutation.isPending
                    ? t("importEmployees.importing")
                    : t("importEmployees.confirmImport", { count: readyCount })}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="modal fk-modal pp-fk-wide"
          >
            {header}
            <div className="fk-body">
              <div className="pp-result-tiles">
                <div className="pp-result-tile tone-success">
                  <span className="pp-result-value">{result.created}</span>
                  <span className="pp-result-label">
                    {t("importEmployees.form.created", { defaultValue: "Created" })}
                  </span>
                </div>
                <div className="pp-result-tile tone-info">
                  <span className="pp-result-value">{result.updated}</span>
                  <span className="pp-result-label">
                    {t("importEmployees.form.updated", { defaultValue: "Updated" })}
                  </span>
                </div>
                <div className={`pp-result-tile ${result.errors.length > 0 ? "tone-warning" : "tone-neutral"}`}>
                  <span className="pp-result-value">{result.errors.length}</span>
                  <span className="pp-result-label">
                    {t("importEmployees.form.skipped", { defaultValue: "Skipped (errors)" })}
                  </span>
                </div>
              </div>
              {/* Keep the original count copy for screen readers / tests. */}
              <span className="pp-visually-hidden">
                {t("importEmployees.resultCreated", { count: result.created })},{" "}
                {t("importEmployees.resultUpdated", { count: result.updated })},{" "}
                {t("importEmployees.resultErrors", { count: result.errors.length })}
              </span>

              {result.errors.length === 0 && (
                <FormNotice
                  tone="success"
                  title={t("importEmployees.form.allGood", { defaultValue: "Every row was imported." })}
                />
              )}

              {result.errors.length > 0 && (() => {
                const { managerGroups, other } = groupImportErrors(result.errors);
                return (
                  <>
                    {managerGroups.length > 0 && (
                      <FormSection
                        columns={1}
                        title={t("importEmployees.managersMissingTitle")}
                        description={t("importEmployees.managersMissingCount", {
                          managers: managerGroups.length,
                          rows: managerGroups.reduce((n, g) => n + g.rows.length, 0),
                        })}
                      >
                        <FormNotice tone="warning">{t("importEmployees.managersMissingHint")}</FormNotice>
                        <div className="card pp-clip">
                          <table className="table pp-m0">
                            <thead>
                              <tr>
                                <th>{t("importEmployees.col.manager")}</th>
                                <th className="pp-th-end pp-col-count">{t("importEmployees.col.count")}</th>
                                <th>{t("importEmployees.col.affectedRows")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {managerGroups.map((g) => (
                                <tr key={g.manager}>
                                  <td className="text-sm pp-strong">{g.manager}</td>
                                  <td className="mono text-sm pp-th-end">{g.rows.length}</td>
                                  <td className="mono text-xs text-dim">{g.rows.join(", ")}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </FormSection>
                    )}

                    {other.length > 0 && (
                      <FormSection columns={1} title={t("importEmployees.otherErrorsTitle")}>
                        <div className="card pp-clip">
                          <table className="table pp-m0">
                            <thead>
                              <tr>
                                <th className="pp-col-count">{t("importEmployees.col.row")}</th>
                                <th>{t("importEmployees.col.message")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {other
                                .slice()
                                .sort((a, b) => a.row - b.row)
                                .map((e) => (
                                  <tr key={e.row}>
                                    <td className="mono text-sm">{e.row}</td>
                                    <td className="text-sm">{e.message}</td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </FormSection>
                    )}
                  </>
                );
              })()}
            </div>
            <div className="drawer-foot fk-foot">
              <div className="fk-foot-note">
                {result.errors.length > 0 && (
                  <button type="button" className="btn" onClick={() => downloadErrorsCsv(result.errors)}>
                    <Icon name="download" size={12} />
                    {t("importEmployees.downloadErrors")}
                  </button>
                )}
              </div>
              <div className="fk-foot-actions">
                <button type="button" className="btn btn-primary" onClick={onClose}>
                  <Icon name="check" size={12} />
                  {t("importEmployees.done")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

// Serialise edited preview rows back to a CSV File so the existing
// CSV-capable preview/import endpoints can re-validate + import the
// operator's inline fixes. Headers are the canonical column names the
// import parser accepts.
function rowsToCsvFile(rows: ImportPreviewRow[]): File {
  const headers = [
    "employee_code",
    "full_name",
    "email",
    "department_code",
    "reports_to_email",
    "designation",
    "phone",
    "division_code",
    "section_code",
    "joining_date",
    "relieving_date",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.employee_code,
        r.full_name,
        r.email,
        r.department,
        r.reports_to_email,
        r.designation,
        r.phone,
        r.division,
        r.section,
        r.joining_date,
        r.relieving_date,
      ]
        .map(esc)
        .join(","),
    );
  }
  const csv = "﻿" + lines.join("\r\n");
  return new File([csv], "edited-import.csv", { type: "text/csv" });
}

// Columns the operator can edit inline (all string-typed fields). Kept
// off ``row`` / ``defaulted_joining_date`` / ``error`` which are derived.
type EditableField =
  | "employee_code"
  | "full_name"
  | "email"
  | "phone"
  | "designation"
  | "department"
  | "division"
  | "section"
  | "reports_to_email"
  | "joining_date"
  | "relieving_date";

// One editable cell in the preview grid. Renders an input bound to the
// row's field; the CSV serialiser writes "" for blanks.
function importCell(
  r: ImportPreviewRow,
  field: EditableField,
  onChange: (rowNum: number, field: EditableField, value: string) => void,
) {
  const raw = r[field];
  const value = raw == null ? "" : String(raw);
  return (
    <input
      className="pp-import-cell unstyled"
      value={value}
      onChange={(e) => onChange(r.row, field, e.target.value)}
      // Enter must never fire the import from inside a cell.
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
      spellCheck={false}
      aria-label={`${field} · row ${r.row}`}
    />
  );
}

interface ManagerGroup {
  manager: string;
  rows: number[];
}

// "Manager not found: 'Khalid Mohamed Mirza' — …" → group by manager name
// so the same missing manager isn't repeated once per row.
function groupImportErrors(errors: { row: number; message: string }[]): {
  managerGroups: ManagerGroup[];
  other: { row: number; message: string }[];
} {
  const re = /manager not found:\s*'(.+?)'/i;
  const byManager = new Map<string, number[]>();
  const other: { row: number; message: string }[] = [];
  for (const e of errors) {
    const m = e.message.match(re);
    if (m && m[1]) {
      const arr = byManager.get(m[1]) ?? [];
      arr.push(e.row);
      byManager.set(m[1], arr);
    } else {
      other.push(e);
    }
  }
  const managerGroups: ManagerGroup[] = [...byManager.entries()]
    .map(([manager, rows]) => ({
      manager,
      rows: [...rows].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.rows.length - a.rows.length);
  return { managerGroups, other };
}

function downloadErrorsCsv(errors: { row: number; message: string }[]): void {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [
    ["Row", "Message"],
    ...errors
      .slice()
      .sort((a, b) => a.row - b.row)
      .map((e) => [String(e.row), e.message]),
  ];
  const csv = lines.map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "import-errors.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importErrorMessage(
  err: unknown,
  t: (key: string) => string,
): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
    if (err.status === 413) return t("importEmployees.errTooLarge");
    if (err.status === 415) return t("importEmployees.errNotXlsxCsv");
  }
  return t("importEmployees.errGeneric");
}
