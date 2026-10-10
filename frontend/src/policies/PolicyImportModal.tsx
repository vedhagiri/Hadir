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
import { Field, FormFooter, FormNotice } from "../components/FormKit";
import { FormFootBar, FormModal, FormSteps, SoftPill } from "../requests/workflowUi";
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

  const onDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
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

  const busy = previewMutation.isPending || importMutation.isPending;

  const stepIndex = step === "select" ? 0 : step === "preview" ? 1 : 2;
  const stepLabels = [
    t("formWizard.upload", { defaultValue: "Upload" }),
    t("formWizard.review", { defaultValue: "Review" }),
    t("formWizard.done", { defaultValue: "Done" }),
  ];

  const foot =
    step === "select" ? (
      <FormFooter
        onCancel={onClose}
        showRequiredNote={false}
        submitLabel={
          <>
            <Icon name="eye" size={12} />
            {t("policies.importModal.previewRows")}
          </>
        }
        submittingLabel={t("policies.importModal.parsing")}
        submitting={previewMutation.isPending}
        canSubmit={!!file}
      />
    ) : step === "preview" ? (
      <FormFooter
        onCancel={onClose}
        note={
          <button type="button" className="btn btn-ghost" onClick={back} disabled={importMutation.isPending}>
            <Icon name="chevronLeft" size={11} />
            {t("policies.importModal.back")}
          </button>
        }
        submitLabel={
          <>
            <Icon name="upload" size={12} />
            {t("policies.importModal.confirmImport", { n: importableRows })}
          </>
        }
        submittingLabel={t("policies.importModal.importing")}
        submitting={importMutation.isPending}
        canSubmit={importableRows > 0}
      />
    ) : (
      <FormFootBar>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          <Icon name="check" size={12} />
          {t("common.done")}
        </button>
      </FormFootBar>
    );

  return (
    <FormModal
      onClose={onClose}
      onSubmit={() => {
        if (step === "select") void runPreview();
        else if (step === "preview") void runImport();
      }}
      busy={busy}
      size={step === "preview" ? "xl" : "md"}
      icon={<Icon name="upload" size={18} />}
      title={
        step === "preview"
          ? t("policies.importModal.titlePreview")
          : step === "result"
            ? t("policies.importModal.titleResult")
            : t("policies.importModal.titleSelect")
      }
      subtitle={
        step === "select"
          ? t("policies.importModal.subtitleShort", {
              defaultValue: "Create several shift policies at once from an Excel workbook.",
            })
          : step === "preview" && preview
            ? t("policies.importModal.subPreview", {
                rows: preview.rows.length,
                errors: preview.errors.length,
                ready: importableRows,
              })
            : t("policies.importModal.subResult")
      }
      steps={<FormSteps steps={stepLabels} current={stepIndex} />}
      footer={foot}
    >
      {step === "select" && (
        <>
          <p className="wf-fk-lead">
            {t("policies.importModal.columnsLead", { defaultValue: "Required column:" })}{" "}
            <span className="mono">name</span>. {t("policies.importModal.columnsOptional", { defaultValue: "Optional:" })}{" "}
            <span className="mono">type</span>,{" "}
            <span className="mono">start</span>,{" "}
            <span className="mono">end</span>,{" "}
            <span className="mono">grace_minutes</span>,{" "}
            <span className="mono">required_hours</span>,{" "}
            <span className="mono">active_from</span>.{" "}
            <a href="/api/policies/import-template" className="wf-link-btn">
              {t("policies.importModal.subSelectTemplate")}
            </a>{" "}
            {t("policies.importModal.subSelectSuffix")}
          </p>

          {previewMutation.error && (
            <FormNotice tone="danger">{importErrorMessage(previewMutation.error, t)}</FormNotice>
          )}

          <Field label={t("policies.importModal.fileLabel", { defaultValue: "Workbook (.xlsx)" })} required>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`wf-fk-dropzone${dragOver ? " is-over" : ""}`}
            >
              <span className="wf-fk-dropzone-icon" aria-hidden>
                <Icon name="upload" size={16} />
              </span>
              <span>
                {t("policies.importModal.dropZone")}{" "}
                <span className="wf-link-btn">{t("policies.importModal.chooseFile")}</span>
              </span>
              <span className="wf-fk-dropzone-hint">.xlsx</span>
              <input
                type="file"
                className="wf-file-input"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </Field>
          {file && (
            <div className="wf-fk-file">
              <span className="wf-fk-file-icon" aria-hidden>
                <Icon name="excel" size={16} />
              </span>
              <span className="wf-fk-file-text">
                <span className="wf-fk-file-name mono">{file.name}</span>
                <span className="wf-fk-file-meta">{Math.round(file.size / 1024)} KB</span>
              </span>
            </div>
          )}

          <div className="wf-hint-box">
            <span>{t("policies.importModal.formatHint")}</span>
            <a className="btn btn-sm wf-no-shrink" href="/api/policies/import-template">
              <Icon name="download" size={11} />
              {t("policies.importModal.downloadTemplate")}
            </a>
          </div>
        </>
      )}

      {step === "preview" && preview && (
        <>
          {importMutation.error && (
            <FormNotice tone="danger">{importErrorMessage(importMutation.error, t)}</FormNotice>
          )}
          <div className="wf-row">
            <SoftPill tone="info" dot={false}>
              {t("policies.importModal.pillReady", { n: importableRows })}
            </SoftPill>
            {preview.errors.length > 0 && (
              <SoftPill tone="warning" dot={false}>
                {t("policies.importModal.pillErrors", { n: preview.errors.length })}
              </SoftPill>
            )}
            {preview.rows.some((r) => r.will_skip) && (
              <SoftPill tone="neutral" dot={false}>
                {t("policies.importModal.pillWillSkip", {
                  n: preview.rows.filter((r) => r.will_skip).length,
                })}
              </SoftPill>
            )}
          </div>

          {preview.errors.length > 0 && (
            <div className="wf-err-list">
              <div className="wf-err-list-head">{t("policies.importModal.rowErrorsHeader")}</div>
              <div className="wf-err-list-body">
                {preview.errors.map((e) => (
                  <div key={e.row} className="wf-err-list-row">
                    <span className="mono">#{e.row}</span> · {e.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="wf-scroll-table wf-import-table">
            <table className="table">
              <thead>
                <tr>
                  <th className="wf-col-row">{t("policies.importModal.colRow")}</th>
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
                  <tr key={r.row} className={r.will_skip ? "wf-muted" : undefined}>
                    <td className="mono text-xs">{r.row}</td>
                    <td className="text-sm">{r.name}</td>
                    <td className="text-sm">{r.type}</td>
                    <td className="mono text-xs">{r.start ?? "—"}</td>
                    <td className="mono text-xs">{r.end ?? "—"}</td>
                    <td className="mono text-xs">{r.grace_minutes ?? "—"}</td>
                    <td className="mono text-xs">{r.required_hours}</td>
                    <td className="mono text-xs">{r.active_from}</td>
                    <td className="text-sm">
                      {r.will_skip ? (
                        <SoftPill tone="neutral" dot={false} {...(r.skip_reason ? { title: r.skip_reason } : {})}>
                          {t("policies.importModal.statusSkip")}
                        </SoftPill>
                      ) : (
                        <SoftPill tone="info" dot={false}>
                          {t("policies.importModal.statusNew")}
                        </SoftPill>
                      )}
                    </td>
                  </tr>
                ))}
                {preview.rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-sm text-dim wf-empty-cell">
                      {t("policies.importModal.noImportableRows")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {step === "result" && result && (
        <>
          <div className="wf-row">
            <SoftPill tone="success" dot={false}>
              {t("policies.importModal.pillImported", { n: result.imported_count })}
            </SoftPill>
            <SoftPill tone={result.skipped_count > 0 ? "warning" : "neutral"} dot={false}>
              {t("policies.importModal.pillSkipped", { n: result.skipped_count })}
            </SoftPill>
          </div>
          {result.skipped.length > 0 && (
            <div className="wf-scroll-table">
              <table className="table">
                <thead>
                  <tr>
                    <th className="wf-col-row">{t("policies.importModal.colRow")}</th>
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
        </>
      )}
    </FormModal>
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
