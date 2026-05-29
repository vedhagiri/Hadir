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

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
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

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
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
                    : "Import cameras"}
              </h3>
              <p className="card-sub">
                {step === "select" && (
                  <>
                    Upload a camera export (<span className="mono">.json</span>).
                    New cameras are created; rows that match an existing
                    camera code are handled by the option below; duplicate
                    RTSP streams are skipped.
                  </>
                )}
                {step === "preview" && preview && (
                  <>
                    {preview.summary.create} to create, {preview.summary.update}{" "}
                    to update, {preview.summary.skip} skipped,{" "}
                    {preview.summary.error} error(s). Nothing is written until
                    you confirm.
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
              disabled={busy}
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
                      dragOver ? "var(--accent-border)" : "var(--border-strong)"
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
                    Drop a .json export here, or{" "}
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
                        accept=".json,application/json"
                        onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
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

                <div>
                  <div
                    className="text-xs"
                    style={{
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--text-tertiary)",
                      marginBottom: 6,
                    }}
                  >
                    When a camera code already exists
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <ModeButton
                      active={onExisting === "update"}
                      label="Update existing"
                      hint="Overwrite the matching camera"
                      onClick={() => setOnExisting("update")}
                    />
                    <ModeButton
                      active={onExisting === "skip"}
                      label="Skip existing"
                      hint="Leave the matching camera untouched"
                      onClick={() => setOnExisting("skip")}
                    />
                  </div>
                </div>

                {(parseError || previewMutation.error) && (
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
                    {parseError ??
                      extractApiError(
                        previewMutation.error,
                        "Could not preview the import.",
                      )}
                  </div>
                )}

                <div
                  style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
                >
                  <button className="btn" onClick={onClose} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={runPreview}
                    disabled={!file || busy}
                  >
                    <Icon name="eye" size={12} />
                    {previewMutation.isPending ? "Parsing…" : "Preview rows"}
                  </button>
                </div>
              </>
            )}

            {step === "preview" && preview && (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="pill pill-success">
                    {preview.summary.create} create
                  </span>
                  <span className="pill pill-info">
                    {preview.summary.update} update
                  </span>
                  <span className="pill pill-neutral">
                    {preview.summary.skip} skip
                  </span>
                  {preview.summary.error > 0 && (
                    <span className="pill pill-warning">
                      {preview.summary.error} error(s)
                    </span>
                  )}
                </div>

                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    overflow: "auto",
                    maxHeight: 420,
                  }}
                >
                  <table className="table" style={{ minWidth: 820 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 50 }}>#</th>
                        <th style={{ width: 90 }}>Action</th>
                        <th>Code</th>
                        <th>Name</th>
                        <th>Host</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.index}>
                          <td className="mono text-xs">{r.index}</td>
                          <td>
                            <span className={`pill ${ACTION_PILL[r.action]}`}>
                              {r.action}
                            </span>
                          </td>
                          <td className="mono text-sm">
                            {r.camera_code ?? "—"}
                          </td>
                          <td className="text-sm">{r.name ?? "—"}</td>
                          <td className="mono text-xs">{r.rtsp_host ?? "—"}</td>
                          <td
                            className="text-sm text-dim"
                            style={{ maxWidth: 280 }}
                          >
                            {r.message}
                          </td>
                        </tr>
                      ))}
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
                    {extractApiError(
                      importMutation.error,
                      "Could not apply the import.",
                    )}
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <button className="btn" onClick={back} disabled={busy}>
                    <Icon name="chevronLeft" size={11} />
                    Back
                  </button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn" onClick={onClose} disabled={busy}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={runImport}
                      disabled={busy || applyCount === 0}
                    >
                      <Icon name="upload" size={12} />
                      {importMutation.isPending
                        ? "Importing…"
                        : `Confirm import (${applyCount})`}
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "result" && result && (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="pill pill-success">
                    created {result.created}
                  </span>
                  <span className="pill pill-info">
                    updated {result.updated}
                  </span>
                  <span className="pill pill-neutral">
                    skipped {result.skipped}
                  </span>
                  <span
                    className={`pill ${
                      result.errors > 0 ? "pill-warning" : "pill-neutral"
                    }`}
                  >
                    errors {result.errors}
                  </span>
                </div>

                {result.rows.some(
                  (r) => r.action === "error" || r.action === "skipped",
                ) && (
                  <div
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      overflow: "auto",
                      maxHeight: 300,
                    }}
                  >
                    <table className="table" style={{ minWidth: 620 }}>
                      <thead>
                        <tr>
                          <th style={{ width: 50 }}>#</th>
                          <th style={{ width: 90 }}>Action</th>
                          <th>Code</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows
                          .filter(
                            (r) =>
                              r.action === "error" || r.action === "skipped",
                          )
                          .map((r) => (
                            <tr key={r.index}>
                              <td className="mono text-xs">{r.index}</td>
                              <td>
                                <span
                                  className={`pill ${
                                    r.action === "error"
                                      ? "pill-warning"
                                      : "pill-neutral"
                                  }`}
                                >
                                  {r.action}
                                </span>
                              </td>
                              <td className="mono text-sm">
                                {r.camera_code ?? "—"}
                              </td>
                              <td className="text-sm text-dim">{r.message}</td>
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

function ModeButton({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: 1,
        textAlign: "start",
        padding: "8px 10px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${active ? "var(--accent-border)" : "var(--border)"}`,
        background: active ? "var(--accent-soft)" : "var(--bg-sunken)",
        cursor: "pointer",
        color: "var(--text)",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      <div className="text-xs text-dim" style={{ marginTop: 2 }}>
        {hint}
      </div>
    </button>
  );
}
