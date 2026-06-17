// Excel / CSV import modal — three-step flow:
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

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
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

  return (
    <ModalShell onClose={onClose}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          display: "grid",
          placeItems: "center",
        }}
      >
        <div
          className="card"
          style={{
            width:
              step === "preview" ? "min(960px, 96vw)" : "min(560px, 92vw)",
            maxHeight: "86vh",
            overflow: "auto",
          }}
        >
          <div className="card-head">
            <div>
              <h3 className="card-title">
                {step === "preview"
                  ? t("importEmployees.titlePreview")
                  : step === "result"
                    ? t("importEmployees.titleComplete")
                    : t("importEmployees.title")}
              </h3>
              <p className="card-sub">
                {step === "select" && (
                  <>
                    {t("importEmployees.subSelect.required")}{" "}
                    <span className="mono">employee_code</span>,{" "}
                    <span className="mono">full_name</span>,{" "}
                    <span className="mono">department</span> (
                    {t("importEmployees.subSelect.or")}{" "}
                    <span className="mono">department_code</span>).{" "}
                    {t("importEmployees.subSelect.optional")}{" "}
                    <span className="mono">email</span>,{" "}
                    <span className="mono">designation</span>,{" "}
                    <span className="mono">phone</span>,{" "}
                    <span className="mono">division</span>,{" "}
                    <span className="mono">section</span>,{" "}
                    <span className="mono">joining_date</span>,{" "}
                    <span className="mono">relieving_date</span>.
                    {" "}
                    <a
                      href="/api/employees/import-template"
                      style={{
                        color: "var(--accent)",
                        textDecoration: "underline",
                      }}
                    >
                      {t("importEmployees.subSelect.downloadLink")}
                    </a>
                    {" "}{t("importEmployees.subSelect.withRowsAndGuide")}
                  </>
                )}
                {step === "preview" && preview && (
                  <>
                    {t("importEmployees.subPreview", {
                      rows: preview.rows.length,
                      errors: preview.errors.length,
                    })}
                  </>
                )}
                {step === "result" && (
                  <>{t("importEmployees.subResult")}</>
                )}
              </p>
            </div>
            <button
              className="icon-btn"
              onClick={onClose}
              disabled={
                previewMutation.isPending || importMutation.isPending
              }
              title={t("importEmployees.close")}
              aria-label={t("importEmployees.close")}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <div
            className="card-body"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            {step === "select" && (
              <>
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  style={{
                    border: `1px dashed ${
                      dragOver
                        ? "var(--accent-border)"
                        : "var(--border-strong)"
                    }`,
                    background: dragOver
                      ? "var(--accent-soft)"
                      : "var(--bg-sunken)",
                    borderRadius: "var(--radius)",
                    padding: 24,
                    textAlign: "center",
                    fontSize: 13,
                    color: "var(--text-secondary)",
                  }}
                >
                  <div style={{ marginBottom: 8 }}>
                    <Icon name="upload" size={20} />
                  </div>
                  <div>
                    {t("importEmployees.dropPrompt")}{" "}
                    <label
                      style={{
                        textDecoration: "underline",
                        cursor: "pointer",
                        color: "var(--text)",
                      }}
                    >
                      {t("importEmployees.chooseFile")}
                      <input
                        type="file"
                        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv"
                        onChange={(e) =>
                          setFile(e.target.files?.[0] ?? null)
                        }
                        style={{ display: "none" }}
                      />
                    </label>
                  </div>
                  {file && (
                    <div
                      className="mono text-sm"
                      style={{ marginTop: 10, color: "var(--text)" }}
                    >
                      {file.name} · {Math.round(file.size / 1024)} KB
                    </div>
                  )}
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "10px 12px",
                    background: "var(--bg-sunken)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12.5,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span>
                    {t("importEmployees.formatHint")}
                  </span>
                  <a
                    className="btn btn-sm"
                    href="/api/employees/import-template"
                    style={{ flexShrink: 0 }}
                  >
                    <Icon name="download" size={11} />
                    {t("importEmployees.downloadTemplate")}
                  </a>
                </div>

                {previewMutation.error && (
                  <div
                    role="alert"
                    style={{
                      background: "var(--danger-soft)",
                      color: "var(--danger-text)",
                      padding: "8px 10px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 12.5,
                    }}
                  >
                    {importErrorMessage(previewMutation.error, t)}
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                  }}
                >
                  <button
                    className="btn"
                    onClick={onClose}
                    disabled={previewMutation.isPending}
                  >
                    {t("importEmployees.cancel")}
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={runPreview}
                    disabled={!file || previewMutation.isPending}
                  >
                    <Icon name="eye" size={12} />
                    {previewMutation.isPending
                      ? t("importEmployees.parsing")
                      : t("importEmployees.previewRows")}
                  </button>
                </div>
              </>
            )}

            {step === "preview" && preview && (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="pill pill-info">
                    {t("importEmployees.pillReady", {
                      count: editRows.filter((r) => !r.error).length,
                    })}
                  </span>
                  {editRows.some((r) => r.error) && (
                    <span className="pill pill-warning">
                      {t("importEmployees.pillErrors", {
                        count: editRows.filter((r) => r.error).length,
                      })}
                    </span>
                  )}
                  {editRows.some((r) => r.defaulted_joining_date) && (
                    <span className="pill pill-neutral">
                      {t("importEmployees.pillDefaultedJoining", {
                        count: editRows.filter((r) => r.defaulted_joining_date).length,
                      })}
                    </span>
                  )}
                  {dirty && (
                    <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                      {t("importEmployees.editedRecheckHint")}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  {t("importEmployees.editHint")}
                </div>

                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    overflow: "auto",
                    maxHeight: 420,
                  }}
                >
                  <table className="table" style={{ minWidth: 1280 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 44 }}>{t("importEmployees.col.row")}</th>
                        <th style={{ width: 28 }} aria-label="status" />
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
                        <tr
                          key={r.row}
                          style={
                            r.error
                              ? { background: "var(--danger-soft)" }
                              : undefined
                          }
                        >
                          <td className="mono text-xs">{r.row}</td>
                          <td style={{ textAlign: "center" }}>
                            {r.error ? (
                              <span
                                title={r.error}
                                style={{ color: "var(--danger-text)", cursor: "help" }}
                              >
                                ⚠
                              </span>
                            ) : (
                              <span style={{ color: "var(--success-text)" }}>✓</span>
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
                          <td
                            colSpan={13}
                            className="text-sm text-dim"
                            style={{ padding: 16 }}
                          >
                            {t("importEmployees.noImportable")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {importMutation.error && (
                  <div
                    role="alert"
                    style={{
                      background: "var(--danger-soft)",
                      color: "var(--danger-text)",
                      padding: "8px 10px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 12.5,
                    }}
                  >
                    {importErrorMessage(importMutation.error, t)}
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <button
                    className="btn"
                    onClick={back}
                    disabled={importMutation.isPending}
                  >
                    <Icon name="chevronLeft" size={11} />
                    {t("importEmployees.back")}
                  </button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn"
                      onClick={onClose}
                      disabled={importMutation.isPending}
                    >
                      {t("importEmployees.cancel")}
                    </button>
                    <button
                      className={`btn${dirty ? " btn-primary" : ""}`}
                      onClick={recheck}
                      disabled={previewMutation.isPending || importMutation.isPending}
                    >
                      <Icon name="refresh" size={12} />
                      {previewMutation.isPending
                        ? t("importEmployees.rechecking")
                        : t("importEmployees.recheck")}
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={runImport}
                      disabled={
                        importMutation.isPending ||
                        previewMutation.isPending ||
                        editRows.filter((r) => !r.error).length === 0
                      }
                    >
                      <Icon name="upload" size={12} />
                      {importMutation.isPending
                        ? t("importEmployees.importing")
                        : t("importEmployees.confirmImport", {
                            count: editRows.filter((r) => !r.error).length,
                          })}
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "result" && result && (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <span className="pill pill-success">
                    {t("importEmployees.resultCreated", { count: result.created })}
                  </span>
                  <span className="pill pill-info">
                    {t("importEmployees.resultUpdated", { count: result.updated })}
                  </span>
                  <span
                    className={`pill ${
                      result.errors.length > 0
                        ? "pill-warning"
                        : "pill-neutral"
                    }`}
                  >
                    {t("importEmployees.resultErrors", { count: result.errors.length })}
                  </span>
                </div>
                {result.errors.length > 0 && (() => {
                  const { managerGroups, other } = groupImportErrors(result.errors);
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {managerGroups.length > 0 && (
                        <div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              justifyContent: "space-between",
                              gap: 8,
                              margin: "4px 0 8px",
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11,
                                textTransform: "uppercase",
                                letterSpacing: "0.05em",
                                fontWeight: 600,
                                color: "var(--text-tertiary)",
                              }}
                            >
                              {t("importEmployees.managersMissingTitle")}
                            </span>
                            <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
                              {t("importEmployees.managersMissingCount", {
                                managers: managerGroups.length,
                                rows: managerGroups.reduce((n, g) => n + g.rows.length, 0),
                              })}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: 11.5,
                              color: "var(--text-secondary)",
                              background: "var(--warning-soft, var(--bg-sunken))",
                              border: "1px solid var(--border)",
                              borderRadius: "var(--radius-sm)",
                              padding: "8px 10px",
                              marginBottom: 8,
                              lineHeight: 1.5,
                            }}
                          >
                            {t("importEmployees.managersMissingHint")}
                          </div>
                          <div
                            style={{
                              border: "1px solid var(--border)",
                              borderRadius: "var(--radius-sm)",
                              overflow: "hidden",
                            }}
                          >
                            <table className="table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th>{t("importEmployees.col.manager")}</th>
                                  <th style={{ width: 70, textAlign: "end" }}>
                                    {t("importEmployees.col.count")}
                                  </th>
                                  <th>{t("importEmployees.col.affectedRows")}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {managerGroups.map((g) => (
                                  <tr key={g.manager}>
                                    <td className="text-sm" style={{ fontWeight: 500 }}>
                                      {g.manager}
                                    </td>
                                    <td
                                      className="mono text-sm"
                                      style={{ textAlign: "end" }}
                                    >
                                      {g.rows.length}
                                    </td>
                                    <td
                                      className="mono text-xs"
                                      style={{ color: "var(--text-secondary)" }}
                                    >
                                      {g.rows.join(", ")}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {other.length > 0 && (
                        <div>
                          <div
                            style={{
                              fontSize: 11,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                              fontWeight: 600,
                              color: "var(--text-tertiary)",
                              margin: "4px 0 8px",
                            }}
                          >
                            {t("importEmployees.otherErrorsTitle")}
                          </div>
                          <div
                            style={{
                              border: "1px solid var(--border)",
                              borderRadius: "var(--radius-sm)",
                              overflow: "hidden",
                            }}
                          >
                            <table className="table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th style={{ width: 70 }}>{t("importEmployees.col.row")}</th>
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
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div
                  style={{
                    display: "flex",
                    justifyContent: result.errors.length > 0 ? "space-between" : "flex-end",
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  {result.errors.length > 0 && (
                    <button
                      className="btn"
                      onClick={() => downloadErrorsCsv(result.errors)}
                    >
                      <Icon name="download" size={12} />
                      {t("importEmployees.downloadErrors")}
                    </button>
                  )}
                  <button className="btn btn-primary" onClick={onClose}>
                    <Icon name="check" size={12} />
                    {t("importEmployees.done")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
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
      value={value}
      onChange={(e) => onChange(r.row, field, e.target.value)}
      spellCheck={false}
      style={{
        width: "100%",
        minWidth: 96,
        fontSize: 12,
        padding: "3px 6px",
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: "var(--bg-elev)",
        color: "var(--text)",
      }}
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
