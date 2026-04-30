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

import { ApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import {
  useImportEmployees,
  usePreviewImport,
  type ImportPreviewResult,
} from "./hooks";
import type { ImportResult } from "./types";

interface Props {
  onClose: () => void;
}

type Step = "select" | "preview" | "result";

export function ImportModal({ onClose }: Props) {
  const [step, setStep] = useState<Step>("select");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
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
      setStep("preview");
    } catch {
      // previewMutation.error renders below
    }
  };

  const runImport = async () => {
    if (!file) return;
    try {
      const r = await importMutation.mutateAsync(file);
      setResult(r);
      setStep("result");
    } catch {
      // importMutation.error renders below
    }
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
                  ? "Review and confirm import"
                  : step === "result"
                    ? "Import complete"
                    : "Import employees"}
              </h3>
              <p className="card-sub">
                {step === "select" && (
                  <>
                    Required columns:{" "}
                    <span className="mono">employee_code</span>,{" "}
                    <span className="mono">full_name</span>,{" "}
                    <span className="mono">department</span> (or{" "}
                    <span className="mono">department_code</span>). Optional:{" "}
                    <span className="mono">email</span>,{" "}
                    <span className="mono">designation</span>,{" "}
                    <span className="mono">phone</span>,{" "}
                    <span className="mono">division</span>,{" "}
                    <span className="mono">section</span>,{" "}
                    <span className="mono">joining_date</span>,{" "}
                    <span className="mono">relieving_date</span>.
                  </>
                )}
                {step === "preview" && preview && (
                  <>
                    {preview.rows.length} row(s) ready,{" "}
                    {preview.errors.length} error(s). Defaults are
                    highlighted — joining date will fall back to today
                    when the cell is blank.
                  </>
                )}
                {step === "result" && (
                  <>The import has finished. Review the counts below.</>
                )}
              </p>
            </div>
            <button
              className="icon-btn"
              onClick={onClose}
              disabled={
                previewMutation.isPending || importMutation.isPending
              }
              title="Close"
              aria-label="Close"
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
                    Drop an .xlsx or .csv here, or{" "}
                    <label
                      style={{
                        textDecoration: "underline",
                        cursor: "pointer",
                        color: "var(--text)",
                      }}
                    >
                      choose a file
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
                    {importErrorMessage(previewMutation.error)}
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
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={runPreview}
                    disabled={!file || previewMutation.isPending}
                  >
                    <Icon name="eye" size={12} />
                    {previewMutation.isPending
                      ? "Parsing…"
                      : "Preview rows"}
                  </button>
                </div>
              </>
            )}

            {step === "preview" && preview && (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="pill pill-info">
                    {preview.rows.length} ready
                  </span>
                  {preview.errors.length > 0 && (
                    <span className="pill pill-warning">
                      {preview.errors.length} error(s)
                    </span>
                  )}
                  {preview.rows.some((r) => r.defaulted_joining_date) && (
                    <span className="pill pill-neutral">
                      joining_date defaulted to today on{" "}
                      {
                        preview.rows.filter((r) => r.defaulted_joining_date)
                          .length
                      }{" "}
                      row(s)
                    </span>
                  )}
                </div>

                {preview.errors.length > 0 && (
                  <div
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        padding: "6px 10px",
                        background: "var(--bg-sunken)",
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}
                    >
                      Row errors (these will be skipped)
                    </div>
                    <div style={{ maxHeight: 120, overflowY: "auto" }}>
                      {preview.errors.map((e) => (
                        <div
                          key={e.row}
                          style={{
                            padding: "6px 10px",
                            fontSize: 12,
                            borderTop: "1px solid var(--border)",
                          }}
                        >
                          <span className="mono">#{e.row}</span> · {e.message}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    overflow: "auto",
                    maxHeight: 380,
                  }}
                >
                  <table className="table" style={{ minWidth: 880 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 50 }}>Row</th>
                        <th>Code</th>
                        <th>Name</th>
                        <th>Designation</th>
                        <th>Department</th>
                        <th>Division</th>
                        <th>Section</th>
                        <th>Joining</th>
                        <th>Relieving</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.row}>
                          <td className="mono text-xs">{r.row}</td>
                          <td className="mono text-sm">{r.employee_code}</td>
                          <td className="text-sm">{r.full_name}</td>
                          <td className="text-sm">{r.designation ?? "—"}</td>
                          <td className="text-sm">{r.department}</td>
                          <td className="text-sm">{r.division ?? "—"}</td>
                          <td className="text-sm">{r.section ?? "—"}</td>
                          <td
                            className="mono text-xs"
                            style={
                              r.defaulted_joining_date
                                ? {
                                    color: "var(--accent)",
                                    fontWeight: 600,
                                  }
                                : undefined
                            }
                            title={
                              r.defaulted_joining_date
                                ? "Defaulted to today"
                                : undefined
                            }
                          >
                            {r.joining_date ?? "—"}
                            {r.defaulted_joining_date && " *"}
                          </td>
                          <td className="mono text-xs">
                            {r.relieving_date ?? "—"}
                          </td>
                        </tr>
                      ))}
                      {preview.rows.length === 0 && (
                        <tr>
                          <td
                            colSpan={9}
                            className="text-sm text-dim"
                            style={{ padding: 16 }}
                          >
                            No importable rows — check the errors above.
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
                    {importErrorMessage(importMutation.error)}
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
                    Back
                  </button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn"
                      onClick={onClose}
                      disabled={importMutation.isPending}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={runImport}
                      disabled={
                        importMutation.isPending || preview.rows.length === 0
                      }
                    >
                      <Icon name="upload" size={12} />
                      {importMutation.isPending
                        ? "Importing…"
                        : `Confirm import (${preview.rows.length})`}
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "result" && result && (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <span className="pill pill-success">
                    created {result.created}
                  </span>
                  <span className="pill pill-info">
                    updated {result.updated}
                  </span>
                  <span
                    className={`pill ${
                      result.errors.length > 0
                        ? "pill-warning"
                        : "pill-neutral"
                    }`}
                  >
                    errors {result.errors.length}
                  </span>
                </div>
                {result.errors.length > 0 && (
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        fontWeight: 500,
                        color: "var(--text-tertiary)",
                        margin: "6px 0",
                      }}
                    >
                      Row-level errors
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 80 }}>Row</th>
                          <th>Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.errors.map((e) => (
                          <tr key={e.row}>
                            <td className="mono text-sm">{e.row}</td>
                            <td className="text-sm">{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  <button className="btn btn-primary" onClick={onClose}>
                    <Icon name="check" size={12} />
                    Done
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

function importErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
    if (err.status === 413) return "File is too large.";
    if (err.status === 415) return "Only .xlsx and .csv files are accepted.";
  }
  return "Import failed. Check the file and try again.";
}
