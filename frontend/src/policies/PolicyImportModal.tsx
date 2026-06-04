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
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
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
                  ? t("policies.importModal.titlePreview")
                  : step === "result"
                    ? t("policies.importModal.titleResult")
                    : t("policies.importModal.titleSelect")}
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
                      {t("policies.importModal.subSelectTemplate")}
                    </a>
                    {" "}{t("policies.importModal.subSelectSuffix")}
                  </>
                )}
                {step === "preview" && preview && (
                  t("policies.importModal.subPreview", {
                    rows: preview.rows.length,
                    errors: preview.errors.length,
                    ready: importableRows,
                  })
                )}
                {step === "result" && t("policies.importModal.subResult")}
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
                    {t("policies.importModal.dropZone")}{" "}
                    <label
                      style={{
                        textDecoration: "underline",
                        cursor: "pointer",
                        color: "var(--text)",
                      }}
                    >
                      {t("policies.importModal.chooseFile")}
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
                  <span>{t("policies.importModal.formatHint")}</span>
                  <a
                    className="btn btn-sm"
                    href="/api/policies/import-template"
                    style={{ flexShrink: 0 }}
                  >
                    <Icon name="download" size={11} />
                    {t("policies.importModal.downloadTemplate")}
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
                    {t("common.cancel")}
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={runPreview}
                    disabled={!file || previewMutation.isPending}
                  >
                    <Icon name="eye" size={12} />
                    {previewMutation.isPending
                      ? t("policies.importModal.parsing")
                      : t("policies.importModal.previewRows")}
                  </button>
                </div>
              </>
            )}

            {step === "preview" && preview && (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="pill pill-info">
                    {t("policies.importModal.pillReady", { n: importableRows })}
                  </span>
                  {preview.errors.length > 0 && (
                    <span className="pill pill-warning">
                      {t("policies.importModal.pillErrors", { n: preview.errors.length })}
                    </span>
                  )}
                  {preview.rows.some((r) => r.will_skip) && (
                    <span className="pill pill-neutral">
                      {t("policies.importModal.pillWillSkip", {
                        n: preview.rows.filter((r) => r.will_skip).length,
                      })}
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
                      {t("policies.importModal.rowErrorsHeader")}
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
                        <th style={{ width: 50 }}>{t("policies.importModal.colRow")}</th>
                        <th>{t("policies.importModal.colName")}</th>
                        <th>{t("policies.importModal.colType")}</th>
                        <th>{t("policies.importModal.colStart")}</th>
                        <th>{t("policies.importModal.colEnd")}</th>
                        <th>{t("policies.importModal.colGrace")}</th>
                        <th>{t("policies.importModal.colHours")}</th>
                        <th>{t("policies.importModal.colActiveFrom")}</th>
                        <th>{t("policies.importModal.colStatus")}</th>
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
                                {t("policies.importModal.statusSkip")}
                              </span>
                            ) : (
                              <span
                                className="pill pill-info"
                                style={{ fontSize: 10 }}
                              >
                                {t("policies.importModal.statusNew")}
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
                            {t("policies.importModal.noImportableRows")}
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
                    {t("policies.importModal.back")}
                  </button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn"
                      onClick={onClose}
                      disabled={importMutation.isPending}
                    >
                      {t("common.cancel")}
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
                        ? t("policies.importModal.importing")
                        : t("policies.importModal.confirmImport", { n: importableRows })}
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "result" && result && (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <span className="pill pill-success">
                    {t("policies.importModal.pillImported", { n: result.imported_count })}
                  </span>
                  <span
                    className={`pill ${
                      result.skipped_count > 0
                        ? "pill-warning"
                        : "pill-neutral"
                    }`}
                  >
                    {t("policies.importModal.pillSkipped", { n: result.skipped_count })}
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
                      {t("policies.importModal.skippedRows")}
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 60 }}>{t("policies.importModal.colRow")}</th>
                          <th>{t("policies.importModal.colName")}</th>
                          <th>{t("policies.importModal.colReason")}</th>
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
                    {t("common.done")}
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


function importErrorMessage(err: unknown, t: (key: string) => string): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
    if (err.status === 413) return t("policies.importModal.errTooLarge");
    if (err.status === 415) return t("policies.importModal.errNotXlsx");
  }
  return t("policies.importModal.errGeneric");
}
