// Camera JSON import modal — three-step flow, mirroring the employees
// ImportModal shape:
//   1. Pick a .json file + choose how existing cameras are handled.
//   2. Server classifies every row (no DB writes); preview shows the
//      per-row verdict (create / update / skip / error).
//   3. Operator confirms → second request actually applies the import.
//
// The file is parsed client-side (we extract the ``cameras`` array from
// an export file, or accept a bare JSON array) and forwarded verbatim;
// the backend owns all validation so the preview and commit agree.

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ChoiceCards, Field, FormFooter, FormNotice } from "../../components/FormKit";
import { FormFootBar, FormModal, FormSteps } from "../../requests/workflowUi";
import { Icon } from "../../shell/Icon";
import { useImportCameras, usePreviewCameraImport } from "./hooks";
import type {
  CameraImportAction,
  CameraImportPreview,
  CameraImportResult,
  OnExisting,
} from "./types";

interface Props {
  onClose: () => void;
}

type Step = "select" | "preview" | "result";

function extractCameras(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { cameras?: unknown }).cameras)
  ) {
    return (data as { cameras: unknown[] }).cameras;
  }
  throw new Error(
    "File must be a camera export (an object with a \"cameras\" array) or a JSON array of cameras.",
  );
}

const ACTION_PILL: Record<CameraImportAction, string> = {
  create: "pill-success",
  update: "pill-info",
  skip: "pill-neutral",
  error: "pill-warning",
};

export function CameraImportModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("select");
  const [file, setFile] = useState<File | null>(null);
  const [onExisting, setOnExisting] = useState<OnExisting>("update");
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsedCameras, setParsedCameras] = useState<unknown[] | null>(null);
  const [preview, setPreview] = useState<CameraImportPreview | null>(null);
  const [result, setResult] = useState<CameraImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const previewMutation = usePreviewCameraImport();
  const importMutation = useImportCameras();

  const pickFile = (f: File | null) => {
    setFile(f);
    setParseError(null);
  };

  const onDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  }, []);

  const runPreview = async () => {
    if (!file) return;
    setParseError(null);
    let cameras: unknown[];
    try {
      cameras = extractCameras(JSON.parse(await file.text()));
    } catch (e) {
      setParseError(
        e instanceof Error ? e.message : "Could not read this file as JSON.",
      );
      return;
    }
    if (cameras.length === 0) {
      setParseError("No cameras found in the file.");
      return;
    }
    try {
      const r = await previewMutation.mutateAsync({
        cameras,
        on_existing: onExisting,
      });
      setParsedCameras(cameras);
      setPreview(r);
      setStep("preview");
    } catch {
      // previewMutation.error renders below
    }
  };

  const runImport = async () => {
    if (!parsedCameras) return;
    try {
      const r = await importMutation.mutateAsync({
        cameras: parsedCameras,
        on_existing: onExisting,
      });
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

  const applyCount = preview
    ? preview.summary.create + preview.summary.update
    : 0;
  const busy = previewMutation.isPending || importMutation.isPending;

  const stepIndex = step === "select" ? 0 : step === "preview" ? 1 : 2;
  const stepLabels = [
    t("formWizard.upload", { defaultValue: "Upload" }),
    t("formWizard.review", { defaultValue: "Review" }),
    t("formWizard.done", { defaultValue: "Done" }),
  ];

  const footer =
    step === "select" ? (
      <FormFooter
        onCancel={onClose}
        showRequiredNote={false}
        submitLabel={
          <>
            <Icon name="eye" size={12} />
            {t("cameras.importModal.previewRows")}
          </>
        }
        submittingLabel={t("cameras.importModal.parsing")}
        submitting={previewMutation.isPending}
        canSubmit={!!file && !busy}
      />
    ) : step === "preview" ? (
      <FormFooter
        onCancel={onClose}
        note={
          <button type="button" className="btn btn-ghost" onClick={back} disabled={busy}>
            <Icon name="chevronLeft" size={11} />
            {t("cameras.importModal.back")}
          </button>
        }
        submitLabel={
          <>
            <Icon name="upload" size={12} />
            {t("cameras.importModal.confirmImport", { n: applyCount })}
          </>
        }
        submittingLabel={t("cameras.importModal.importing")}
        submitting={importMutation.isPending}
        canSubmit={!busy && applyCount > 0}
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
          ? t("cameras.importModal.titlePreview")
          : step === "result"
            ? t("cameras.importModal.titleResult")
            : t("cameras.importModal.titleSelect")
      }
      subtitle={
        step === "select"
          ? t("cameras.importModal.subtitleShort", {
              defaultValue: "Bring cameras in from a Maugood camera export (.json).",
            })
          : step === "preview" && preview
            ? t("cameras.importModal.subPreview", {
                create: preview.summary.create,
                update: preview.summary.update,
                skip: preview.summary.skip,
                error: preview.summary.error,
              })
            : t("cameras.importModal.subResult")
      }
      steps={<FormSteps steps={stepLabels} current={stepIndex} />}
      footer={footer}
    >
      {step === "select" && (
        <>
          <p className="wf-fk-lead">{t("cameras.importModal.subSelect")}</p>
          {(parseError || previewMutation.error) && (
            <FormNotice tone="danger">
              {parseError ??
                extractApiError(previewMutation.error, t("cameras.importModal.previewError"))}
            </FormNotice>
          )}
          <Field label={t("cameras.importModal.fileLabel", { defaultValue: "Export file" })} required>
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
                {t("cameras.importModal.dropZone")}{" "}
                <span className="wf-link-btn">{t("cameras.importModal.chooseFile")}</span>
              </span>
              <span className="wf-fk-dropzone-hint">.json</span>
              <input
                type="file"
                className="wf-file-input"
                accept=".json,application/json"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </Field>
          {file && (
            <div className="wf-fk-file">
              <span className="wf-fk-file-icon" aria-hidden>
                <Icon name="fileText" size={16} />
              </span>
              <span className="wf-fk-file-text">
                <span className="wf-fk-file-name mono">{file.name}</span>
                <span className="wf-fk-file-meta">{Math.round(file.size / 1024)} KB</span>
              </span>
            </div>
          )}
          <Field label={t("cameras.importModal.existingLabel")}>
            <ChoiceCards<OnExisting>
              label={t("cameras.importModal.existingLabel")}
              value={onExisting}
              onChange={setOnExisting}
              options={[
                {
                  value: "update",
                  title: t("cameras.importModal.modeUpdate"),
                  description: t("cameras.importModal.modeUpdateHint"),
                  icon: <Icon name="refresh" size={16} />,
                },
                {
                  value: "skip",
                  title: t("cameras.importModal.modeSkip"),
                  description: t("cameras.importModal.modeSkipHint"),
                  icon: <Icon name="chevronRight" size={16} />,
                },
              ]}
            />
          </Field>
        </>
      )}

      {step === "preview" && preview && (
        <>
          {importMutation.error && (
            <FormNotice tone="danger">
              {extractApiError(importMutation.error, t("cameras.importModal.importError"))}
            </FormNotice>
          )}
          <div className="wf-row">
            <span className="pill pill-success">{preview.summary.create} create</span>
            <span className="pill pill-info">{preview.summary.update} update</span>
            <span className="pill pill-neutral">{preview.summary.skip} skip</span>
            {preview.summary.error > 0 && (
              <span className="pill pill-warning">{preview.summary.error} error(s)</span>
            )}
          </div>

          <div className="wf-scroll-table co-import-table">
            <table className="table">
              <thead>
                <tr>
                  <th className="co-col-num">{t("cameras.importModal.colNum")}</th>
                  <th className="co-col-action">{t("cameras.importModal.colAction")}</th>
                  <th>{t("cameras.importModal.colCode")}</th>
                  <th>{t("cameras.importModal.colName")}</th>
                  <th>{t("cameras.importModal.colHost")}</th>
                  <th>{t("cameras.importModal.colDetails")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.index}>
                    <td className="mono text-xs">{r.index}</td>
                    <td>
                      <span className={`pill ${ACTION_PILL[r.action]}`}>{r.action}</span>
                    </td>
                    <td className="mono text-sm">{r.camera_code ?? "—"}</td>
                    <td className="text-sm">{r.name ?? "—"}</td>
                    <td className="mono text-xs">{r.rtsp_host ?? "—"}</td>
                    <td className="text-sm text-dim co-col-details">{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {step === "result" && result && (
        <>
          <div className="wf-row">
            <span className="pill pill-success">{t("cameras.importModal.pillCreated", { n: result.created })}</span>
            <span className="pill pill-info">{t("cameras.importModal.pillUpdated", { n: result.updated })}</span>
            <span className="pill pill-neutral">{t("cameras.importModal.pillSkipped", { n: result.skipped })}</span>
            <span className={`pill ${result.errors > 0 ? "pill-warning" : "pill-neutral"}`}>
              {t("cameras.importModal.pillErrors", { n: result.errors })}
            </span>
          </div>

          {result.rows.some((r) => r.action === "error" || r.action === "skipped") && (
            <div className="wf-scroll-table">
              <table className="table">
                <thead>
                  <tr>
                    <th className="co-col-num">{t("cameras.importModal.colNum")}</th>
                    <th className="co-col-action">{t("cameras.importModal.colAction")}</th>
                    <th>{t("cameras.importModal.colCode")}</th>
                    <th>{t("cameras.importModal.colDetails")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows
                    .filter((r) => r.action === "error" || r.action === "skipped")
                    .map((r) => (
                      <tr key={r.index}>
                        <td className="mono text-xs">{r.index}</td>
                        <td>
                          <span className={`pill ${r.action === "error" ? "pill-warning" : "pill-neutral"}`}>
                            {r.action}
                          </span>
                        </td>
                        <td className="mono text-sm">{r.camera_code ?? "—"}</td>
                        <td className="text-sm text-dim">{r.message}</td>
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
