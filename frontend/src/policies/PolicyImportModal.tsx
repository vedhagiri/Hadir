// Shift Policies XLSX import — three-step flow mirroring the
// employees ImportModal:
//   1. select  — drag-and-drop / picker + template download
//   2. preview — server parses (no DB writes); rows + per-row errors
//      rendered in a preview table; rows already taken by name are
//      flagged as "will skip"
//   3. result  — final counts + per-row errors / skips
//
// The two-call shape (preview + commit) keeps ``POST /api/policies/import``
// stateless. The file is re-uploaded on confirm — no temp storage.

import { useCallback, useState } from "react";

import { ApiError } from "../api/client";
import { ModalShell } from "../components/DrawerShell";
import { Icon } from "../shell/Icon";
import {
  useImportPoliciesXlsx,
  usePreviewPoliciesImport,
  type PolicyImportPreviewResult,
  type PolicyImportResponse,
} from "./hooks";

interface Props {
  onClose: () => void;
}

type Step = "select" | "preview" | "result";

export function PolicyImportModal({ onClose }: Props) {
  const [step, setStep] = useState<Step>("select");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PolicyImportPreviewResult | null>(null);
  const [result, setResult] = useState<PolicyImportResponse | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const previewMutation = usePreviewPoliciesImport();
  const importMutation = useImportPoliciesXlsx();

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

  const importableRows =
    preview?.rows.filter((r) => !r.will_skip).length ?? 0;

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
                    : "Import shift policies"}
              </h3>
              <p className="card-sub">
                {step === "select" && (
                  <>
                    Required column:{" "}
                    <span className="mono">name</span>. Optional:{" "}
                    <span className="mono">type</span>,{" "}
                    <span className="mono">start</span>,{" "}
                    <span className="mono">end</span>,{" "}
                    <span className="mono">grace_minutes</span>,{" "}
                    <span className="mono">required_hours</span>,{" "}
                    <span className="mono">active_from</span>.
                    {" "}
                    <a
                      href="/api/policies/import-template"
                      style={{
                        color: "var(--accent)",
                        textDecoration: "underline",
                      }}
                    >
                      Download sample template
                    </a>
                    {" "}with one example row per policy type + a Field
                    guide sheet.
                  </>
                )}
                {step === "preview" && preview && (
                  <>
                    {preview.rows.length} row(s) parsed,{" "}
                    {preview.errors.length} error(s),{" "}
                    {importableRows} ready to import. Rows whose name
                    is already taken are flagged and will be skipped.
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
                    Drop an .xlsx here, or{" "}
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
                        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
                    Not sure about the format? Grab the sample workbook —
                    one example row per policy type plus a Field guide
                    sheet documenting every column.
                  </span>
                  <a
                    className="btn btn-sm"
                    href="/api/policies/import-template"
                    style={{ flexShrink: 0 }}
                  >
                    <Icon name="download" size={11} />
                    Download template
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
                    {importableRows} ready
                  </span>
                  {preview.errors.length > 0 && (
                    <span className="pill pill-warning">
                      {preview.errors.length} error(s)
                    </span>
                  )}
                  {preview.rows.some((r) => r.will_skip) && (
                    <span className="pill pill-neutral">
                      {preview.rows.filter((r) => r.will_skip).length}{" "}
                      will skip (name exists)
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
                          <span className="mono">#{e.row}</span> ·{" "}
                          {e.message}
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
                  <table className="table" style={{ minWidth: 820 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 50 }}>Row</th>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Start</th>
                        <th>End</th>
                        <th>Grace</th>
                        <th>Hours</th>
                        <th>Active from</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr
                          key={r.row}
                          style={
                            r.will_skip
                              ? { color: "var(--text-secondary)" }
                              : undefined
                          }
                        >
                          <td className="mono text-xs">{r.row}</td>
                          <td className="text-sm">{r.name}</td>
                          <td className="text-sm">{r.type}</td>
                          <td className="mono text-xs">{r.start ?? "—"}</td>
                          <td className="mono text-xs">{r.end ?? "—"}</td>
                          <td className="mono text-xs">
                            {r.grace_minutes ?? "—"}
                          </td>
                          <td className="mono text-xs">{r.required_hours}</td>
                          <td className="mono text-xs">{r.active_from}</td>
                          <td className="text-sm">
                            {r.will_skip ? (
                              <span
                                className="pill pill-neutral"
                                title={r.skip_reason ?? undefined}
                                style={{ fontSize: 10 }}
                              >
                                skip
                              </span>
                            ) : (
                              <span
                                className="pill pill-info"
                                style={{ fontSize: 10 }}
                              >
                                new
                              </span>
                            )}
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
                        importMutation.isPending || importableRows === 0
                      }
                    >
                      <Icon name="upload" size={12} />
                      {importMutation.isPending
                        ? "Importing…"
                        : `Confirm import (${importableRows})`}
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "result" && result && (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <span className="pill pill-success">
                    imported {result.imported_count}
                  </span>
                  <span
                    className={`pill ${
                      result.skipped_count > 0
                        ? "pill-warning"
                        : "pill-neutral"
                    }`}
                  >
                    skipped {result.skipped_count}
                  </span>
                </div>
                {result.skipped.length > 0 && (
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
                      Skipped rows
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 60 }}>Row</th>
                          <th>Name</th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.skipped.map((s) => (
                          <tr key={`${s.row_number}-${s.submitted_name}`}>
                            <td className="mono text-sm">{s.row_number}</td>
                            <td className="text-sm">{s.submitted_name}</td>
                            <td className="text-sm">{s.reason}</td>
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
    if (err.status === 415) return "Only .xlsx files are accepted.";
  }
  return "Import failed. Check the file and try again.";
}
